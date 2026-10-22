'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

let fengari;
try { fengari = require('fengari'); }
catch (e) {
    console.error('[FATAL] fengari missing:', e.message);
    process.exit(1);
}
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const pushcfunction = lua.lua_pushcfunction || lua.lua_pushjsfunction;
if (typeof pushcfunction !== 'function') {
    console.error('[FATAL] fengari: no pushcfunction');
    process.exit(1);
}

const PORT        = process.env.PORT || 3000;
const EXPECT_MAIN = 86467;
const EXPECT_DATA = 144620;

// ─────────────────────────────────────────────────────────────
// Luau buffer → Node Buffer mock
// ─────────────────────────────────────────────────────────────
function makeBufferLib(L) {
    const buffers = new Map();
    let nextId = 1;
    const wrap = (b) => { const id = nextId++; buffers.set(id, b); return id; };
    const get  = (L, idx) => {
        const t = lua.lua_type(L, idx);
        if (t === lua.LUA_TNUMBER) {
            const id = Number(lua.lua_tointeger(L, idx));
            const b  = buffers.get(id);
            if (!b) throw new Error('invalid buffer id ' + id);
            return b;
        }
        if (t === lua.LUA_TSTRING) {
            const u8 = lua.lua_tolstring(L, idx, null);
            return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
        }
        throw new Error('bad buffer arg type=' + t);
    };
    function reg(name, fn) {
        pushcfunction(L, fn);
        lua.lua_setfield(L, -2, to_luastring(name));
    }
    lua.lua_createtable(L, 0, 16);
    reg('fromstring', (L) => {
        const u8 = lua.lua_tolstring(L, 1, null);
        lua.lua_pushinteger(L, wrap(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)));
        return 1;
    });
    reg('tostring', (L) => {
        if (lua.lua_type(L, 1) === lua.LUA_TSTRING) { lua.lua_pushvalue(L, 1); return 1; }
        const b = get(L, 1);
        const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        lua.lua_pushlstring(L, u8, u8.length); return 1;
    });
    reg('readu8',  (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)); lua.lua_pushinteger(L, b[p]); return 1; });
    reg('readu16', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)); lua.lua_pushinteger(L, b.readUInt16LE(p)); return 1; });
    reg('readu32', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)); lua.lua_pushinteger(L, b.readUInt32LE(p)); return 1; });
    reg('readf64', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)); lua.lua_pushnumber(L, b.readDoubleLE(p)); return 1; });
    reg('writeu8',  (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)), v=Number(lua.lua_tointeger(L,3)); b[p] = v & 0xFF; return 0; });
    reg('writeu16', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)), v=Number(lua.lua_tointeger(L,3)); b.writeUInt16LE(v & 0xFFFF, p); return 0; });
    reg('writeu32', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)), v=Number(lua.lua_tointeger(L,3))>>>0; b.writeUInt32LE(v, p); return 0; });
    reg('writef64', (L) => { const b=get(L,1), p=Number(lua.lua_tointeger(L,2)), v=lua.lua_tonumber(L,3); b.writeDoubleLE(v, p); return 0; });
    reg('create',   (L) => { const n=Number(lua.lua_tointeger(L,1)); lua.lua_pushinteger(L, wrap(Buffer.alloc(n))); return 1; });
    reg('copy', (L) => {
        const dst=get(L,1), di=Number(lua.lua_tointeger(L,2));
        const src=get(L,3), si=Number(lua.lua_tointeger(L,4)), n=Number(lua.lua_tointeger(L,5));
        src.copy(dst, di, si, si + n); return 0;
    });
    reg('len', (L) => { lua.lua_pushinteger(L, get(L,1).length); return 1; });
    lua.lua_setglobal(L, to_luastring('buffer'));
    return { get };
}

// ─────────────────────────────────────────────────────────────
// 추출기 (파일은 원본 바이트 그대로, x[61]은 Lua shim으로 처리)
// ─────────────────────────────────────────────────────────────
function extract(srcBytes) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);

    const log  = [];
    const info = (s) => { log.push(s); console.log(s); };

    const bufLib = makeBufferLib(L);

    // 1) table.create shim
    let st = lauxlib.luaL_dostring(L, to_luastring(`
        table.create = function(n, v)
            local t = {}
            for i = 1, n do t[i] = v end
            return t
        end
    `));
    if (st !== lua.LUA_OK) {
        const e = 'shim: ' + to_jsstring(lua.lua_tostring(L, -1));
        info('[!] ' + e);
        return { main: null, data: null, error: e, log };
    }

    // 2) ★ x[61] shim — 파일은 건드리지 않고, 로더 실행 전에
    //    전역 테이블에 접근할 수 없으므로 로더 내부 x 테이블을 못 고침.
    //    대신 x[61]이 nil일 때 assert(nil)을 우회하는 안전장치는
    //    원본 코드에서 "Luraph Decompression Error: "..A(y) 형식이므로
    //    A가 nil이면 호출 시 에러. → 이 에러를 pcall로 감싸서 main만 캡처.

    // 3) loadstring mock (main/data 캡처)
    let capturedMain = null;
    let capturedData = null;

    pushcfunction(L, (L) => {
        const u8 = lua.lua_tolstring(L, 1, null);
        const code = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
        info(`[mock] loadstring arg1: ${code.length} bytes`);
        if (code.length > 1000 && !capturedMain) {
            capturedMain = code;
            info(`[+] main captured: ${code.length} bytes`);
        }
        pushcfunction(L, (L) => {
            const t = lua.lua_type(L, 1);
            if (t === lua.LUA_TNUMBER) {
                try {
                    const b = bufLib.get(Number(lua.lua_tointeger(L, 1)));
                    capturedData = b;
                    info(`[+] data captured (buffer): ${b.length} bytes`);
                } catch (e) { info('[!] buffer get failed: ' + e.message); }
            } else if (t === lua.LUA_TSTRING) {
                const u8 = lua.lua_tolstring(L, 1, null);
                capturedData = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
                info(`[+] data captured (string): ${capturedData.length} bytes`);
            } else {
                info('[mock-data] got ' + lua.lua_typename(L, t));
            }
            pushcfunction(L, () => 0);
            return 1;
        });
        return 1;
    });
    lua.lua_setglobal(L, to_luastring('loadstring'));

    // 4) 원본 바이트 그대로 loadbuffer — 문자열 변환 X
    info(`[*] loadbuffer (${srcBytes.length} bytes, original bytes)`);
    st = lauxlib.luaL_loadbuffer(L, srcBytes, srcBytes.length, to_luastring('@input.lua'));
    if (st !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1));
        info('[!] parse: ' + err);
        return { main: capturedMain, data: capturedData, error: 'parse: ' + err, log };
    }

    info('[*] pcall loader');
    const callStatus = lua.lua_pcall(L, 0, 0, 0);
    if (callStatus !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1));
        info('[!] runtime: ' + err);
        // ★ main 캡처가 성공했으면(즉 loadstring mock이 먼저 호출됨), data 캡처가 실패해도 반환
        if (capturedMain) {
            info('[i] main captured before error — partial success');
        }
        return { main: capturedMain, data: capturedData, error: 'runtime: ' + err, log };
    }

    info('[+] loader done');
    return { main: capturedMain, data: capturedData, error: null, log };
}

// ─────────────────────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────────────────────
let lastResult = { main: null, data: null, error: 'not run', log: ['(no file)'] };

function tryAutoExtract() {
    const candidates = [
        'unknown-obfuscated.lua',
        'unknown-obfuscated.lua (4).txt',
        'input.lua',
    ];
    for (const name of candidates) {
        const p = path.join(__dirname, name);
        if (fs.existsSync(p)) {
            console.log(`[*] auto-extract: ${p}`);
            const src = fs.readFileSync(p);
            console.log(`[*] source: ${src.length} bytes (binary)`);
            try {
                lastResult = extract(src);
            } catch (e) {
                console.error('[!] exception:', e);
                lastResult = { main: null, data: null, error: String(e), log: [] };
            }
            return true;
        }
    }
    return false;
}

if (!tryAutoExtract()) {
    console.log('[!] no input file. Upload via web UI.');
}

// ─────────────────────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.raw({ type: 'application/octet-stream', limit: '20mb' }));

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');

function page() {
    const r = lastResult;
    const okM = r.main && r.main.length === EXPECT_MAIN;
    const okD = r.data && r.data.length === EXPECT_DATA;
    const st = (ok, lbl, sz, exp) => ok
        ? `<span style="color:#4f4">✓ ${lbl}: ${sz} bytes</span>`
        : `<span style="color:#f44">✗ ${lbl}: ${sz ?? 'null'} bytes (기대 ${exp})</span>`;
    const logHtml = r.log.map(l => `<div>${esc(l)}</div>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Luraph Extractor</title>
<style>
body{font-family:monospace;max-width:900px;margin:2em auto;padding:1em;background:#1e1e1e;color:#ddd}
a{color:#4af} pre{background:#111;padding:1em;overflow:auto;max-height:500px;white-space:pre-wrap}
h1,h2{color:#4af} .box{background:#111;padding:1em;border-radius:6px;margin:1em 0}
button{padding:.5em 1em;background:#4af;color:#111;border:0;border-radius:4px;cursor:pointer;font-weight:bold}
</style></head><body>
<h1>Luraph v15.1 Extractor</h1>

<div class="box">
<h2>파일 업로드</h2>
<form id="up">
  <input type="file" id="f" accept=".lua,.txt" required />
  <button type="submit" id="btn">Extract</button>
</form>
<p id="status" style="color:#fa4"></p>
</div>

<div class="box">
<p>${st(okM, 'main', r.main?.length, EXPECT_MAIN)}</p>
<p>${st(okD, 'data', r.data?.length, EXPECT_DATA)}</p>
${r.error ? `<p style="color:#f44">error: ${esc(r.error)}</p>` : ''}
</div>

${(r.main || r.data) ? `<div class="box">
<p>
  <a href="/download/main">↓ decompressed_main.lua</a> &nbsp;|&nbsp;
  <a href="/download/data">↓ decompressed_data.bin</a>
</p>
</div>` : ''}

<h2>Log</h2>
<pre>${logHtml || '(empty)'}</pre>

<script>
document.getElementById('up').onsubmit = async (e) => {
    e.preventDefault();
    const file = document.getElementById('f').files[0];
    if (!file) return;
    const status = document.getElementById('status');
    const btn = document.getElementById('btn');
    status.textContent = '업로드 중... (' + file.size + ' bytes)';
    btn.disabled = true;
    try {
        const buf = await file.arrayBuffer();
        const res = await fetch('/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        status.textContent = '완료 — 새로고침 중...';
        location.reload();
    } catch (err) {
        status.textContent = '실패: ' + err.message;
        btn.disabled = false;
    }
};
</script>
</body></html>`;
}

app.get('/', (req, res) => res.type('html').send(page()));

app.post('/upload', (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
        return res.status(400).send('invalid body');
    }
    console.log(`[*] upload: ${req.body.length} bytes (binary)`);
    try {
        lastResult = extract(req.body);
        res.send('ok');
    } catch (e) {
        console.error('[!] exception:', e);
        lastResult = { main: null, data: null, error: String(e), log: [] };
        res.status(500).send('error');
    }
});

app.get('/retry', (req, res) => { tryAutoExtract(); res.redirect('/'); });

app.get('/download/main', (req, res) => {
    if (!lastResult.main) return res.status(404).send('not extracted');
    res.setHeader('Content-Disposition', 'attachment; filename="decompressed_main.lua"');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lastResult.main);
});

app.get('/download/data', (req, res) => {
    if (!lastResult.data) return res.status(404).send('not extracted');
    res.setHeader('Content-Disposition', 'attachment; filename="decompressed_data.bin"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(lastResult.data);
});

app.listen(PORT, () => console.log(`[*] listening on :${PORT}`));
