// remote.js 和真的 vendor/supabase.js（2.117.2）接在一起时，发出的请求长什么样（9.2 remote.contract.test.js）。
// 用 node:vm 加载 UMD 单文件，配假 fetch 和内存里的 localStorage；不连网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRemote, AUTH_STORAGE_KEY } from '../src/store/remote.js';
import { classifyError } from '../src/store/errors.js';
import { memoryStorage } from './fake-supabase.js';

const code = readFileSync(new URL('../vendor/supabase.js', import.meta.url), 'utf8');
const URL_BASE = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'sb_publishable_contracttest';
const UID = '11111111-2222-3333-4444-555555555555';

function loadLib() {
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Headers, Request, Response, fetch, TextEncoder, TextDecoder, AbortController, AbortSignal, Blob, FormData, crypto, atob, btoa, structuredClone, queueMicrotask, WebSocket: globalThis.WebSocket || class FakeWebSocket {} };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.supabase;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(expSec) {
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, exp: expSec, role: 'authenticated', aud: 'authenticated' }) + '.sig';
}
function session(expiresAt) {
  return { access_token: jwt(expiresAt), token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, refresh_token: 'r1', user: { id: UID, email: 'me+tj@x.test', aud: 'authenticated', role: 'authenticated' } };
}

function harness(routes) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    const headers = new Headers(init.headers || (input && input.headers) || {});
    requests.push({ method, url, headers, body: init.body, cache: init.cache, signal: init.signal });
    for (const [pattern, reply] of routes) {
      if (pattern.test(method + ' ' + url)) {
        const r = typeof reply === 'function' ? reply({ method, url, headers, body: init.body }) : reply;
        const body = r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return new Response(r.status === 204 ? null : body, { status: r.status || 200, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
      }
    }
    return new Response(JSON.stringify({ message: 'no route ' + method + ' ' + url }), { status: 404 });
  };
  const storage = memoryStorage();
  const remote = createRemote({ url: URL_BASE, key: KEY, lib: loadLib(), storage, fetch: fetchImpl });
  return { remote, requests, storage };
}

const nowSec = () => Math.floor(Date.now() / 1000);

test('登录：会话只写在 tj-auth 键下；退出只退这个浏览器（/auth/v1/logout?scope=local）', async () => {
  const h = harness([
    [/POST .*\/auth\/v1\/token\?grant_type=password/, { body: session(nowSec() + 3600) }],
    [/POST .*\/auth\/v1\/logout/, { status: 204 }],
  ]);
  const r = await h.remote.signIn('me+tj@x.test', 'pw');
  assert.equal(r.error, null);
  assert.equal(r.userId, UID);
  assert.deepEqual(h.storage.keys(), [AUTH_STORAGE_KEY]);
  assert.equal(h.remote.hasStoredSession(), true);
  const login = h.requests[0];
  assert.equal(login.headers.get('apikey'), KEY);
  await h.remote.signOut();
  const out = h.requests.find((q) => /\/auth\/v1\/logout/.test(q.url));
  assert.ok(out, '发了 logout');
  assert.match(out.url, /\/auth\/v1\/logout\?scope=local$/);
  assert.equal(h.storage.getItem(AUTH_STORAGE_KEY), null);
});

test('查 rev、带版本保存：GET ?select=rev；PATCH /rest/v1/tj_journal?rev=eq.N&select=rev；带登录凭证、不走缓存', async () => {
  const h = harness([
    [/GET .*\/rest\/v1\/tj_journal\?select=rev$/, { body: [{ rev: 3 }] }],
    [/PATCH .*\/rest\/v1\/tj_journal\?rev=eq\.3&select=rev$/, ({ body }) => ({ body: [{ rev: JSON.parse(body).rev }] })],
  ]);
  h.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(nowSec() + 3600)));
  const fr = await h.remote.fetchRev();
  assert.equal(fr.error, null);
  assert.equal(fr.rev, 3);
  const doc = { schemaVersion: 1, zebra: 1, currency: '$', rows: [] };
  const up = await h.remote.updateDoc(doc, 3);
  assert.equal(up.error, null);
  assert.equal(up.rev, 4);
  const patch = h.requests.find((q) => q.method === 'PATCH');
  assert.equal(new URL(patch.url).pathname, '/rest/v1/tj_journal');
  assert.equal(new URL(patch.url).search, '?rev=eq.3&select=rev');
  assert.equal(patch.headers.get('authorization'), 'Bearer ' + JSON.parse(h.storage.getItem(AUTH_STORAGE_KEY)).access_token);
  assert.equal(patch.body, JSON.stringify({ doc, rev: 4 }), '请求体里 doc 的键顺序原样');
  assert.equal(patch.cache, 'no-store');
  assert.ok(patch.signal, '带超时');
});

test('update 返回空数组：rev 为 null 且没有错误（云端已经不是 r）', async () => {
  const h = harness([[/PATCH /, { body: [] }]]);
  h.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(nowSec() + 3600)));
  const up = await h.remote.updateDoc({ rows: [] }, 7);
  assert.equal(up.error, null);
  assert.equal(up.rev, null);
});

test('传截图：POST /storage/v1/object/tj-shots/<uid>/shots/...，不覆盖，带类型；已存在（400 + statusCode 409）认得出', async () => {
  let n = 0;
  const h = harness([[/POST .*\/storage\/v1\/object\/tj-shots\//, () => (++n === 1 ? { body: { Key: 'x' } } : { status: 400, body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } })]]);
  h.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(nowSec() + 3600)));
  const blob = new Blob([new Uint8Array(3)], { type: 'image/webp' });
  const r1 = await h.remote.upload(UID, 'shots/t_1/sh_1.webp', blob);
  assert.equal(r1.error, null);
  const req = h.requests[0];
  assert.equal(new URL(req.url).pathname, `/storage/v1/object/tj-shots/${UID}/shots/t_1/sh_1.webp`);
  assert.equal(req.headers.get('x-upsert'), 'false');
  const r2 = await h.remote.upload(UID, 'shots/t_1/sh_1.webp', blob);
  assert.equal(r2.error.status, 400);
  assert.equal(r2.error.statusCode, '409');
  assert.equal(classifyError(r2.error), 'exists');
});

test('没会话时的 401 加 42501：归一后分类是 auth（不是缺授权）；断网分类是 network', async () => {
  const h = harness([[/GET .*\/rest\/v1\/tj_journal/, { status: 401, body: { code: '42501', message: 'permission denied for table tj_journal' } }]]);
  const fr = await h.remote.fetchRev();
  assert.equal(fr.error.status, 401);
  assert.equal(fr.error.code, '42501');
  assert.equal(classifyError(fr.error), 'auth');

  const off = harness([]);
  off.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(nowSec() + 3600)));
  // 换掉 fetch：直接抛错（断网）
  const r = createRemote({ url: URL_BASE, key: KEY, lib: loadLib(), storage: off.storage, fetch: async () => { throw new TypeError('fetch failed'); } });
  const e = await r.fetchRev();
  assert.equal(classifyError(e.error), 'network');
});

test('access token 过期：先换令牌（grant_type=refresh_token）再发请求', async () => {
  const h = harness([
    [/POST .*\/auth\/v1\/token\?grant_type=refresh_token/, { body: session(nowSec() + 3600) }],
    [/GET .*\/rest\/v1\/tj_journal\?select=rev$/, { body: [] }],
  ]);
  h.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(nowSec() - 60)));
  const fr = await h.remote.fetchRev();
  assert.equal(fr.error, null);
  assert.equal(fr.rev, null, '没有这一行');
  const i = h.requests.findIndex((q) => /grant_type=refresh_token/.test(q.url));
  const j = h.requests.findIndex((q) => /\/rest\/v1\/tj_journal/.test(q.url));
  assert.ok(i >= 0 && j > i, '先换令牌再查');
});
