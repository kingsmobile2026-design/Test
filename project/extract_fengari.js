// extract_fengari.js
// Node.js + fengari로 Luraph v15.1 로더를 실행 → main/data 추출
//
// 준비:
//   npm install fengari
// 실행:
//   node extract_fengari.js unknown-obfuscated.lua
//
// 출력:
//   decompressed_main.lua  (기대: 86467 bytes)
//   decompressed_data.bin  (기대: 144620 bytes)

const fs = require('fs');

let fengari;
try { fengari = require('fengari'); }
catch (e) {
    console.error('[!] fengari 미설치. 다음 실행:');
    console.error('    npm install fengari');
    process.exit(1);
}
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const INPUT      = process.argv[2] || 'unknown-obfuscated.lua';
const OUT_MAIN   = 'decompressed_main.lua';
const OUT_DATA   = 'decompressed_data.bin';
const EXPECT_MAIN = 86467;
const EXPECT_DATA = 144620;

// ══════════════════════════════════════════════════════════════
// Lua state
// ══════════════════════════════════════════════════════════════
const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// ══════════════════════════════════════════════════════════════
// buffer 라이브러리 mock (Luau buffer → Node Buffer)
// ══════════════════════════════════════════════════════════════
const buffers = new Map();
let nextBufId = 1;

function wrapBuf(b) { const id = nextBufId++; buffers.set(id, b); return id; }
function getBuf(L, idx) {
    if (lua.lua_type(L, idx) === lua.LUA_TNUMBER) {
        return buffers.get(lua.lua_tointeger(L, idx));
    }
    if (lua.lua_type(L, idx) === lua.LUA_TSTRING) {
        const p = lua.lua_tolstring(L, idx, null);
        return Buffer.from(p.buffer, p.byteOffset, p.length);
    }
    return null;
}

lua.lua_createtable(L, 0, 16);

const bufFns = {
    fromstring(L) {
        const p = lua.lua_tolstring(L, 1, null);
        const b = Buffer.from(p.buffer, p.byteOffset, p.length);
        lua.lua_pushinteger(L, wrapBuf(b));
        return 1;
    },
    tostring(L) {
        const b = getBuf(L, 1);
        lua.lua_pushlstring(L, b, b.length);
        return 1;
    },
    readu8(L) {
        const b = getBuf(L, 1);
        lua.lua_pushinteger(L, b[lua.lua_tointeger(L, 2)]);
        return 1;
    },
    readu16(L) {
        const b = getBuf(L, 1);
        lua.lua_pushinteger(L, b.readUInt16LE(lua.lua_tointeger(L, 2)));
        return 1;
    },
    readu32(L) {
        const b = getBuf(L, 1);
        lua.lua_pushinteger(L, b.readUInt32LE(lua.lua_tointeger(L, 2)) >>> 0);
        return 1;
    },
    readf64(L) {
        const b = getBuf(L, 1);
        lua.lua_pushnumber(L, b.readDoubleLE(lua.lua_tointeger(L, 2)));
        return 1;
    },
    writeu8(L) {
        const b = getBuf(L, 1);
        b[lua.lua_tointeger(L, 2)] = lua.lua_tointeger(L, 3) & 0xFF;
        return 0;
    },
    writeu16(L) {
        const b = getBuf(L, 1);
        b.writeUInt16LE(lua.lua_tointeger(L, 3) & 0xFFFF, lua.lua_tointeger(L, 2));
        return 0;
    },
    writeu32(L) {
        const b = getBuf(L, 1);
        b.writeUInt32LE(lua.lua_tointeger(L, 3) >>> 0, lua.lua_tointeger(L, 2));
        return 0;
    },
    writef64(L) {
        const b = getBuf(L, 1);
        b.writeDoubleLE(lua.lua_tonumber(L, 3), lua.lua_tointeger(L, 2));
        return 0;
    },
    create(L) {
        lua.lua_pushinteger(L, wrapBuf(Buffer.alloc(lua.lua_tointeger(L, 1))));
        return 1;
    },
    copy(L) {
        const dst = getBuf(L, 1);
        const di  = lua.lua_tointeger(L, 2);
        const src = getBuf(L, 3);
        const si  = lua.lua_tointeger(L, 4);
        const n   = lua.lua_tointeger(L, 5);
        src.copy(dst, di, si, si + n);
        return 0;
    },
    len(L) {
        lua.lua_pushinteger(L, getBuf(L, 1).length);
        return 1;
    },
};
for (const [name, fn] of Object.entries(bufFns)) {
    lauxlib.lua_pushcfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
}
lua.lua_setglobal(L, to_luastring('buffer'));

// ══════════════════════════════════════════════════════════════
// table.create shim (Luau 전용 확장)
// ══════════════════════════════════════════════════════════════
const shimStatus = lauxlib.luaL_dostring(L, to_luastring(`
    table.create = function(n, v)
        local t = {}
        for i = 1, n do t[i] = v end
        return t
    end
`));
if (shimStatus !== lua.LUA_OK) {
    console.error('[!] shim 실패:', to_jsstring(lua.lua_tostring(L, -1)));
    process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// loadstring mock
//  - main 코드(>1000B) 캡처
//  - data-받는 함수 반환 → mock(P)로 data 캡처
// ══════════════════════════════════════════════════════════════
let capturedMain = null;
let capturedData = null;

lauxlib.lua_pushcfunction(L, (L) => {
    const p = lua.lua_tolstring(L, 1, null);
    const code = Buffer.from(p.buffer, p.byteOffset, p.length);
    if (code.length > 1000 && !capturedMain) {
        capturedMain = code;
        console.log(`[+] main captured : ${code.length} bytes`);
    }
    // data-받는 함수
    lauxlib.lua_pushcfunction(L, (L) => {
        const t = lua.lua_type(L, 1);
        if (t === lua.LUA_TNUMBER) {
            capturedData = getBuf(L, 1);
        } else if (t === lua.LUA_TSTRING) {
            const q = lua.lua_tolstring(L, 1, null);
            capturedData = Buffer.from(q.buffer, q.byteOffset, q.length);
        }
        console.log(`[+] data captured : ${capturedData ? capturedData.length : 0} bytes`);
        lauxlib.lua_pushcfunction(L, () => 0);   // 반환 함수
        return 1;
    });
    return 1;
});
lua.lua_setglobal(L, to_luastring('loadstring'));

// ══════════════════════════════════════════════════════════════
// 로더 실행
// ══════════════════════════════════════════════════════════════
console.log(`[*] loading ${INPUT}`);
const srcBytes = fs.readFileSync(INPUT);   // binary 그대로
console.log(`[*] source : ${srcBytes.length} bytes`);

const loadStatus = lauxlib.luaL_loadbuffer(
    L, srcBytes, srcBytes.length, to_luastring('@' + INPUT)
);
if (loadStatus !== lua.LUA_OK) {
    console.error('[!] parse error:', to_jsstring(lua.lua_tostring(L, -1)));
    process.exit(1);
}

console.log('[*] executing ...');
const callStatus = lua.lua_pcall(L, 0, 0, 0);
if (callStatus !== lua.LUA_OK) {
    console.error('[!] runtime error:', to_jsstring(lua.lua_tostring(L, -1)));
    process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// 저장 + 검증
// ══════════════════════════════════════════════════════════════
let ok = true;

if (capturedMain) {
    fs.writeFileSync(OUT_MAIN, capturedMain);
    const sz = fs.statSync(OUT_MAIN).size;
    const valid = sz === EXPECT_MAIN;
    console.log(`[${valid?'+':'!'}] ${OUT_MAIN} : ${sz} bytes  (기대 ${EXPECT_MAIN}) ${valid?'✓':'✗'}`);
    if (!valid) ok = false;
} else {
    console.error('[!] main capture FAILED');
    ok = false;
}

if (capturedData) {
    fs.writeFileSync(OUT_DATA, capturedData);
    const sz = fs.statSync(OUT_DATA).size;
    const valid = sz === EXPECT_DATA;
    console.log(`[${valid?'+':'!'}] ${OUT_DATA} : ${sz} bytes  (기대 ${EXPECT_DATA}) ${valid?'✓':'✗'}`);
    if (!valid) ok = false;
} else {
    console.error('[!] data capture FAILED');
    ok = false;
}

console.log(ok ? '\n[✓] success' : '\n[!] 일부 캡처 실패 — 로그를 붙여주세요');
process.exit(ok ? 0 : 1);
