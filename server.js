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

const PORT         = process.env.PORT || 3000;
const EXPECT_MAIN  = 86467;
const EXPECT_DATA  = 144620;

// ─────────────────────────────────────────────────────────────
// Luau buffer 라이브러리 → Node Buffer mock
// ─────────────────────────────────────────────────────────────
function makeBufferLib(L) {
    const buffers = new Map();
    let nextId = 1;
    const wrap = (b) => { const id = nextId++; buffers.set(id, b); return id; };
    const get  = (L, idx) => {
        const t = lua.lua_type(L, idx);
        if (t === lua.LUA_TNUMBER) {
            const id = lua.lua_tointeger(L, idx);
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
        lauxlib.lua_pushcfunction(L, fn);
        lua.lua_setfield(L, -2, to_luastring(name));
    }

    lua.lua_createtable(L, 0, 16);
    reg('fromstring', (L) => {
        const u8 = lua.lua_tolstring(L, 1, null);
        lua.lua_pushinteger(L, wrap(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)));
        return 1;
    });
    reg('tostring', (L) => {
        if (lua.lua_type(L, 1) === lua.LUA_TSTRING) {
            lua.lua_pushvalue(L, 1); return 1;
        }
        const b = get(L, 1);
        const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        lua.lua_pushlstring(L, u8, u8.length);
        return 1;
    });
    reg('readu8',  (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2); lua.lua_pushinteger(L, b[p]); return 1; });
    reg('readu16', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2); lua.lua_pushinteger(L, b.readUInt16LE(p)); return 1; });
    reg('readu32', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2); lua.lua_pushinteger(L, b.readUInt32LE(p)); return 1; });
    reg('readf64', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2); lua.lua_pushnumber(L, b.readDoubleLE(p)); return 1; });
    reg('writeu8',  (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2), v=lua.lua_tointeger(L,3); b[p] = v & 0xFF; return 0; });
    reg('writeu16', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2), v=lua.lua_tointeger(L,3); b.writeUInt16LE(v & 0xFFFF, p); return 0; });
    reg('writeu32', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2), v=lua.lua_tointeger(L,3)>>>0; b.writeUInt32LE(v, p); return 0; });
    reg('writef64', (L) => { const b=get(L,1), p=lua.lua_tointeger(L,2), v=lua.lua_tonumber(L,3); b.writeDoubleLE(v, p); return 0; });
    reg('create',   (L) => { const n=lua.lua_tointeger(L,1); lua.lua_pushinteger(L, wrap(Buffer.alloc(n))); return 1; });
    reg('copy', (L) => {
        const dst=get(L,1), di=lua.lua_tointeger(L,2);
        const src=get(L,3), si=lua.lua_tointeger(L,4), n=lua.lua_tointeger(L,5);
        src.copy(dst, di, si, si + n); return 0;
    });
    reg('len', (L) => { lua.lua_pushinteger(L, get(L,1).length); return 1; });
    lua.lua_setglobal(L, to_luastring('buffer'));

    return { get };
}

// ─────────────────────────────────────────────────────────────
// 추출기 본체
// ─────────────────────────────────────────────────────────────
function extract(srcBytes) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);

    const log  = [];
    const info = (s) => { log.push(s); console.log(s); };

    const bufLib = makeBufferLib(L);

    // table.create shim
    let st = lauxlib.luaL_dostring(L, to_luastring(`
        table.create = function(n, v)
            local t = {}
            for i = 1, n do t[i] = v end
            return t
        end
    `));
    if (st !== lua.LUA_OK) {
        return { main: null, data: null, error: 'shim: ' + to_jsstring(lua.lua_tostring(L, -1)), log };
    }

    // ★ 원본 소스의 x[61] 결함 보정 (undefined → tostring)
    //   Luraph 디컴파일러가 놓친 참조. 이걸 고치지 않으면 state 5에서 에러.
    let srcStr = srcBytes.toString('latin1');
    if (srcStr.includes('x[61]')) {
        const n = (srcStr.match(/x\[61\]/g) || []).length;
        srcStr = srcStr.replace(/x\[61\]/g, 'tostring');
        info(`[*] source patch: x[61] → tostring (${n}곳)`);
    }
    const srcPatched = Buffer.from(srcStr, 'latin1');

    // ★ loadstring mock
    let capturedMain = null;
    let capturedData = null;
    lauxlib.lua_pushcfunction(L, (L) => {
        const u8 = lua.lua_tolstring(L, 1, null);
        const code = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
        info(`[mock] loadstring(1st arg): ${code.length} bytes`);
        if (code.length > 1000 && !capturedMain) {
            capturedMain = code;
            info(`[+] main captured: ${code.length} bytes`);
        }
        // 두 번째 리턴: data-받는 함수
        lauxlib.lua_pushcfunction(L, (L) => {
            const t = lua.lua_type(L, 1);
            if (t === lua.LUA_TNUMBER) {
                const id = lua.lua_tointeger(L, 1);
                const b = bufLib.get(id);
                if (b) {
                    capturedData = b;
                    info(`[+] data captured (buffer id ${id}): ${b.length} bytes`);
                } else {
                    info(`[!] invalid buffer id ${id}`);
                }
            } else if (t === lua.LUA_TSTRING) {
                const u8 = lua.lua_tolstring(L, 1, null);
                capturedData = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
                info(`[+] data captured (string): ${capturedData.length} bytes`);
            } else if (t === lua.LUA_TTABLE) {
                info('[mock-data] got table (unexpected)');
            } else {
                info('[mock-data] got ' + lua.lua_typename(L, t));
            }
            // 반환은 no-op 함수 (최종 `(...)` 호출 안전)
            lauxlib.lua_pushcfunction(L, () => 0);
            return 1;
        });
        return 1;
    });
    lua.lua_setglobal(L, to_luastring('loadstring'));

    // 로드 & 실행
    info(`[*] loading patched source (${srcPatched.length} bytes)`);
    st = lauxlib.luaL_loadbuffer(L, srcPatched, srcPatched.length, to_luastring('@input.lua'));
    if (st !== lua.LUA_OK) {
        return { main: null, data: null, error: 'parse: ' + to_jsstring(lua.lua_tostring(L, -1)), log };
    }

    info('[*] executing loader');
    const callStatus = lua.lua_pcall(L, 0, 0, 0);
    if (callStatus !== lua.LUA_OK) {
        const err = to_jsstring(lua.lua_tostring(L, -1));
        info('[!] runtime error: ' + err);
        return { main: capturedMain, data: capturedData, error: 'runtime: ' + err, log };
    }

    info('[+] loader returned without error');
    return { main: capturedMain, data: capturedData, error: null, log };
}

// ─────────────────────────────────────────────────────────────
// 상태 + 자동 추출
// ─────────────────────────────────────────────────────────────
let lastResult = { main: null, data: null, error: 'not run', log: [] };

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
            try {
                const src = fs.readFileSync(p);
                console.log(`[*] source: ${src.length} bytes`);
                lastResult = extract(src);
                console.log(`[+] result main=${lastResult.main?.length ?? 'null'} data=${lastResult.data?.length ?? 'null'}`);
                if (lastResult.error) console.log(`[!] error: ${lastResult.error}`);
            } catch (e) {
                console.error('[!] extract exception:', e);
                lastResult = { main: null, data: null, error: String(e), log: [] };
            }
            return;
        }
    }
    console.log('[!] no input file. Add unknown-obfuscated.lua to repo.');
}

tryAutoExtract();

// ─────────────────────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
    const r = lastResult;
    const okM = r.main && r.main.length === EXPECT_MAIN;
    const okD = r.data && r.data.length === EXPECT_DATA;
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const status = (ok, label, size, expect) => ok
        ? `<span style="color:#4f4">✓ ${label}: ${size} bytes</span>`
        : `<span style="color:#f44">✗ ${label}: ${size ?? 'null'} bytes (기대 ${expect})</span>`;
    const logHtml = r.log.map(l => `<div>${esc(l)}</div>`).join('');

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Luraph Extractor</title>
<style>
body{font-family:monospace;max-width:900px;margin:2em auto;padding:1em;background:#1e1e1e;color:#ddd}
a{color:#4af} pre{background:#111;padding:1em;overflow:auto;max-height:500px}
h1{color:#4af} .box{background:#111;padding:1em;border-radius:6px;margin:1em 0}
</style></head><body>
<h1>Luraph v15.1 Extractor</h1>
<div class="box">
<p>${status(okM, 'main', r.main?.length, EXPECT_MAIN)}</p>
<p>${status(okD, 'data', r.data?.length, EXPECT_DATA)}</p>
${r.error ? `<p style="color:#f44">error: ${esc(r.error)}</p>` : ''}
</div>
<div class="box">
<p>
  <a href="/download/main">↓ decompressed_main.lua</a> &nbsp;|&nbsp;
  <a href="/download/data">↓ decompressed_data.bin</a> &nbsp;|&nbsp;
  <a href="/log">extraction log</a> &nbsp;|&nbsp;
  <a href="/retry">재실행</a>
</p>
</div>
<h2>Log</h2>
<pre>${logHtml}</pre>
</body></html>`);
});

app.get('/retry', (req, res) => { tryAutoExtract(); res.redirect('/'); });
app.get('/log',   (req, res) => res.type('text/plain').send(lastResult.log.join('\n')));

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
