// backup.mjs 的测试：全部用假的 fetch，不联网，不碰真 Supabase / GitHub。
// 运行：node --test（备份仓库根目录）或 node --test backup/（网站仓库）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BackupError, checkGate, formatJournal, runBackup, runReport, selfCheck, validateDoc,
} from './backup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = 'https://proj.supabase.co';
const USER = 'u-123';
const ENV = {
  SUPABASE_URL: URL_ + '/',
  SUPABASE_KEY: 'sb_publishable_test',
  TJ_EMAIL: 'me@example.com',
  TJ_PASSWORD: 'secret-pw',
  GITHUB_REPOSITORY: 'Michael-L340/trade-journal-backup',
  GITHUB_TOKEN: 'ghs_test',
};

// ───────── 造数据 ─────────

function shot(tradeId, n, bytes = 10) {
  return {
    id: `sh_${tradeId}_${n}`, label: 'open',
    file: `shots/${tradeId}/sh_${n}.webp`, thumb: `shots/${tradeId}/sh_${n}.thumb.webp`,
    width: 100, height: 50, bytes, addedAt: '2026-09-10T14:32:00Z',
  };
}

function trade(i, shots = []) {
  return {
    type: 'trade', id: `t_${i}`, date: '2026-09-10', symbol: 'XAUUSD', direction: 'long',
    rr: 2, risk: 100, result: 'win', pnlOverride: null, reason: '理由', note: '备注', shots,
  };
}

function makeDoc(nTrades, shotsFor = () => []) {
  const rows = [{ type: 'system', id: 'sys_a', name: '趋势回调', desc: '' }];
  for (let i = 1; i <= nTrades; i++) rows.push(trade(i, shotsFor(i)));
  return { schemaVersion: 1, currency: '$', rows };
}

// ───────── 假 fetch ─────────

function res(status, body, headers = {}) {
  const buf = body instanceof Uint8Array ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(buf.toString('utf8')),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

/**
 * opts.doc：tj_journal 里的 doc；opts.objects：桶里有的文件 { 相对路径: Buffer }；
 * opts.private、opts.rows、opts.range 用来造异常。
 */
function fakeFetch(opts) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    if (url.startsWith('https://api.github.com/repos/')) {
      return res(200, { full_name: ENV.GITHUB_REPOSITORY, private: opts.private ?? true });
    }
    if (url === `${URL_}/auth/v1/token?grant_type=password` && method === 'POST') {
      const b = JSON.parse(init.body);
      if (b.password !== ENV.TJ_PASSWORD) return res(400, { error: 'invalid_grant' });
      return res(200, { access_token: 'jwt-abc', user: { id: USER } });
    }
    if (url === `${URL_}/rest/v1/tj_journal?select=rev,doc,updated_at`) {
      const rows = opts.rows ?? [{ rev: 7, doc: opts.doc, updated_at: '2026-10-05T00:00:00Z' }];
      return res(200, rows, { 'content-range': opts.range ?? `0-${rows.length - 1}/${rows.length}` });
    }
    const prefix = `${URL_}/storage/v1/object/authenticated/tj-shots/${USER}/`;
    if (url.startsWith(prefix)) {
      const path = decodeURIComponent(url.slice(prefix.length));
      const obj = (opts.objects || {})[path];
      if (!obj) return res(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return res(200, obj);
    }
    if (url === `${URL_}/auth/v1/user` && method === 'PUT') return res(200, { id: USER });
    if (url === `${URL_}/auth/v1/logout?scope=local` && method === 'POST') return res(204, '');
    return res(500, { message: `假 fetch 没有这个地址：${method} ${url}` });
  };
  fn.calls = calls;
  return fn;
}

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tj-backup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = { log: () => {}, trackedShots: () => new Set(), now: () => new Date('2026-10-05T18:17:00Z') };
const readState = async (dir) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
const writeState = (dir, s) => writeFile(join(dir, 'state.json'), JSON.stringify(s));
const storageCalls = (f) => f.calls.filter((c) => c.url.includes('/storage/v1/object/'));

// ───────── 固定格式 ─────────

test('固定格式：和规格 5.2 的样例逐字节相同，键顺序打乱也一样', () => {
  selfCheck();
  const doc = {
    rows: [
      { name: '趋势回调', id: 'sys_a', type: 'system', desc: 'x' },
      { shots: [{ file: 'shots/t_1/a.webp', id: 'sh_1', zz: 1, label: '' }], note: '', type: 'trade', id: 't_1', extra: { b: 1, a: 2 }, date: '2026-09-01' },
    ],
    future: true,
    currency: '$',
    appVersion: '20261005093000',
    schemaVersion: 1,
  };
  const text = formatJournal(doc);
  assert.equal(text, [
    '{',
    '  "schemaVersion": 1,',
    '  "appVersion": "20261005093000",',
    '  "currency": "$",',
    '  "rows": [',
    '    {"type":"system","id":"sys_a","name":"趋势回调","desc":"x"},',
    '    {"type":"trade","id":"t_1","date":"2026-09-01","note":"","shots":[{"id":"sh_1","label":"","file":"shots/t_1/a.webp","zz":1}],"extra":{"b":1,"a":2}}',
    '  ],',
    '  "future": true',
    '}',
    '',
  ].join('\n'));
  assert.equal(formatJournal(JSON.parse(text)), text, '读回再写一遍不变');
  assert.equal(formatJournal({ schemaVersion: 1, currency: '$', rows: [] }), '{\n  "schemaVersion": 1,\n  "currency": "$",\n  "rows": []\n}\n');
});

test('固定格式：附录 A 写出来是 4,831 字节（只在网站仓库里有 fixtures 时跑）', async (t) => {
  const sample = join(HERE, '..', 'fixtures', 'sample-journal.json');
  if (!existsSync(sample)) { t.skip('没有 fixtures/sample-journal.json'); return; }
  const doc = JSON.parse(await readFile(sample, 'utf8'));
  assert.deepEqual(validateDoc(doc), []);
  assert.equal(Buffer.byteLength(formatJournal(doc), 'utf8'), 4831);
});

// ───────── 结构检查 ─────────

test('结构检查：第一行不是系统行、id 重复、截图路径不在本交易目录下都拒绝', () => {
  const good = makeDoc(2, (i) => [shot(`t_${i}`, i)]);
  assert.deepEqual(validateDoc(good), []);

  const noSys = makeDoc(1);
  noSys.rows.shift();
  assert.match(validateDoc(noSys).join('\n'), /第一行必须是系统行/);

  const dup = makeDoc(2);
  dup.rows[2].id = 't_1';
  assert.match(validateDoc(dup).join('\n'), /重复/);

  const wrongDir = makeDoc(1, () => [{ ...shot('t_1', 1), file: 'shots/t_9/sh_1.webp' }]);
  assert.match(validateDoc(wrongDir).join('\n'), /shots\/t_1\//);

  const escape = makeDoc(1, () => [{ ...shot('t_1', 1), thumb: 'shots/t_1/../../x' }]);
  assert.notDeepEqual(validateDoc(escape), []);

  assert.match(validateDoc({ ...good, schemaVersion: 2 }).join('\n'), /schemaVersion/);
  const badField = makeDoc(1);
  badField.rows[1].direction = 'up';
  assert.match(validateDoc(badField).join('\n'), /direction/);
});

test('结构检查不通过时什么都不写', async (t) => {
  const dir = await tmp(t);
  const doc = makeDoc(1);
  doc.rows.reverse();
  const f = fakeFetch({ doc });
  await assert.rejects(runBackup({ ...quiet, env: ENV, fetch: f, dir }), /第一行必须是系统行/);
  assert.equal(existsSync(join(dir, 'journal.json')), false);
  assert.equal(existsSync(join(dir, 'state.json')), false);
  assert.ok(f.calls.some((c) => c.url.includes('/logout?scope=local')), '失败也要退出登录');
});

test('拉完对账：行数或 Content-Range 总数不是 1 就失败', async (t) => {
  const dir = await tmp(t);
  await assert.rejects(runBackup({ ...quiet, env: ENV, fetch: fakeFetch({ rows: [] }), dir }), /正好拿到 1 行/);
  await assert.rejects(runBackup({ ...quiet, env: ENV, fetch: fakeFetch({ doc: makeDoc(1), range: '0-0/2' }), dir }), /Content-Range/);
  assert.equal(existsSync(join(dir, 'journal.json')), false);
});

// ───────── 公开仓库 ─────────

test('仓库是公开的：拒绝，连登录都不做', async (t) => {
  const dir = await tmp(t);
  const f = fakeFetch({ doc: makeDoc(1), private: false });
  await assert.rejects(runBackup({ ...quiet, env: ENV, fetch: f, dir }), (e) => e instanceof BackupError && /不是私有/.test(e.message));
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /api\.github\.com\/repos\/Michael-L340\/trade-journal-backup$/);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer ghs_test');
  assert.equal(existsSync(join(dir, 'journal.json')), false);
});

test('没有 GITHUB_REPOSITORY / GITHUB_TOKEN：拒绝运行', async (t) => {
  const dir = await tmp(t);
  const f = fakeFetch({ doc: makeDoc(1) });
  await assert.rejects(runBackup({ ...quiet, env: { ...ENV, GITHUB_TOKEN: '' }, fetch: f, dir }), /私有/);
  assert.equal(f.calls.length, 0);
});

// ───────── 笔数闸门 ─────────

test('闸门：允许减少 max(3, 5%) 笔以内', () => {
  assert.equal(checkGate(null, 0), null, '第一次运行不比');
  assert.equal(checkGate(20, 17), null, '20 笔少 3 笔：放行');
  assert.match(checkGate(20, 16), /少了 4 笔/, '20 笔少 4 笔：拒绝');
  assert.equal(checkGate(200, 190), null, '200 笔少 10 笔（5%）：放行');
  assert.match(checkGate(200, 189), /拒绝/, '200 笔少 11 笔：拒绝');
  assert.equal(checkGate(200, 150, true), null, 'allow_drop=yes 放行');
  assert.match(checkGate(5, 0, true), /一笔都不剩/, '清空了：allow_drop 也不放行');
  assert.equal(checkGate(0, 0), null);
  assert.equal(checkGate(10, 30), null, '变多随便');
});

test('闸门拦下时不写 journal.json，也不下载截图', async (t) => {
  const dir = await tmp(t);
  await writeState(dir, { at: 'x', rev: 1, trades: 100, shots: 0, missing: [] });
  await writeFile(join(dir, 'journal.json'), 'OLD');
  const f = fakeFetch({ doc: makeDoc(94, (i) => [shot(`t_${i}`, i)]) });
  await assert.rejects(runBackup({ ...quiet, env: ENV, fetch: f, dir }), /从 100 降到 94/);
  assert.equal(await readFile(join(dir, 'journal.json'), 'utf8'), 'OLD');
  assert.equal(storageCalls(f).length, 0);

  // 手动运行填 allow_drop=yes 就放行
  await runBackup({ ...quiet, env: { ...ENV, ALLOW_DROP: 'yes' }, fetch: fakeFetch({ doc: makeDoc(94) }), dir });
  assert.equal((await readState(dir)).trades, 94);
});

// ───────── 正常路径、增量下载 ─────────

test('正常备份：写固定格式 journal.json、下载截图、state.json 记笔数和截图数', async (t) => {
  const dir = await tmp(t);
  const doc = makeDoc(2, (i) => [shot(`t_${i}`, i, 10)]);
  const objects = {
    'shots/t_1/sh_1.webp': Buffer.alloc(10, 1), 'shots/t_1/sh_1.thumb.webp': Buffer.alloc(3, 2),
    'shots/t_2/sh_2.webp': Buffer.alloc(10, 3), 'shots/t_2/sh_2.thumb.webp': Buffer.alloc(4, 4),
  };
  const f = fakeFetch({ doc, objects });
  const r = await runBackup({ ...quiet, env: ENV, fetch: f, dir });

  assert.equal(await readFile(join(dir, 'journal.json'), 'utf8'), formatJournal(doc));
  assert.deepEqual(await readFile(join(dir, 'shots/t_2/sh_2.thumb.webp')), Buffer.alloc(4, 4));
  assert.deepEqual(r.downloaded.length, 4);
  assert.deepEqual(await readState(dir), { at: '2026-10-05T18:17:00.000Z', rev: 7, trades: 2, shots: 2, missing: [] });

  // 请求头：登录只带 apikey；之后带 apikey + Bearer
  const loginCall = f.calls.find((c) => c.url.includes('/auth/v1/token'));
  assert.equal(loginCall.headers.apikey, 'sb_publishable_test');
  assert.equal(loginCall.headers.Authorization, undefined);
  const q = f.calls.find((c) => c.url.includes('/rest/v1/tj_journal'));
  assert.equal(q.headers.Authorization, 'Bearer jwt-abc');
  assert.equal(q.headers.Prefer, 'count=exact');
  assert.ok(f.calls.at(-1).url.endsWith('/auth/v1/logout?scope=local'));
  assert.equal(f.calls.some((c) => c.url.includes('/auth/v1/user')), false, '拉取这一步不写 user_metadata');
});

test('增量：仓库里已有的图不重下；第二次运行一张都不下，文件逐字节不变', async (t) => {
  const dir = await tmp(t);
  const doc = makeDoc(2, (i) => [shot(`t_${i}`, i, 10)]);
  const objects = {
    'shots/t_1/sh_1.webp': Buffer.alloc(10), 'shots/t_1/sh_1.thumb.webp': Buffer.alloc(2),
    'shots/t_2/sh_2.webp': Buffer.alloc(10), 'shots/t_2/sh_2.thumb.webp': Buffer.alloc(2),
  };
  // t_1 的两张图已经在 git 里（稀疏检出，磁盘上没有）
  const tracked = new Set(['shots/t_1/sh_1.webp', 'shots/t_1/sh_1.thumb.webp']);
  const f1 = fakeFetch({ doc, objects });
  await runBackup({ ...quiet, trackedShots: () => tracked, env: ENV, fetch: f1, dir });
  assert.deepEqual(storageCalls(f1).map((c) => c.url.split(`/${USER}/`)[1]).sort(), ['shots/t_2/sh_2.thumb.webp', 'shots/t_2/sh_2.webp']);
  assert.equal(existsSync(join(dir, 'shots/t_1/sh_1.webp')), false);

  const before = [await readFile(join(dir, 'journal.json'), 'utf8'), await readFile(join(dir, 'state.json'), 'utf8')];
  const f2 = fakeFetch({ doc, objects });
  await runBackup({ ...quiet, now: () => new Date('2026-10-06T18:17:00Z'), trackedShots: () => tracked, env: ENV, fetch: f2, dir });
  assert.equal(storageCalls(f2).length, 0, '磁盘上已有的也不重下');
  const after = [await readFile(join(dir, 'journal.json'), 'utf8'), await readFile(join(dir, 'state.json'), 'utf8')];
  assert.deepEqual(after, before, '没变化：state.json 的时间也不动，不产生提交');

  // 加一笔：state.json 时间更新
  const doc3 = makeDoc(3);
  await runBackup({ ...quiet, now: () => new Date('2026-10-07T18:17:00Z'), trackedShots: () => tracked, env: ENV, fetch: fakeFetch({ doc: doc3, objects }), dir });
  assert.equal((await readState(dir)).at, '2026-10-07T18:17:00.000Z');
});

// ───────── 缺图 ─────────

test('缺图：journal.json 和拿到的图照常写，缺的进 state.json；汇报时写状态再以失败结束', async (t) => {
  const dir = await tmp(t);
  const doc = makeDoc(3, (i) => [shot(`t_${i}`, i, 10)]);
  const objects = {
    'shots/t_1/sh_1.webp': Buffer.alloc(10), 'shots/t_1/sh_1.thumb.webp': Buffer.alloc(2),
    // t_2 大图桶里没有
    'shots/t_2/sh_2.thumb.webp': Buffer.alloc(2),
    // t_3 大图字节数对不上
    'shots/t_3/sh_3.webp': Buffer.alloc(9), 'shots/t_3/sh_3.thumb.webp': Buffer.alloc(2),
  };
  const r = await runBackup({ ...quiet, env: ENV, fetch: fakeFetch({ doc, objects }), dir });

  assert.equal(await readFile(join(dir, 'journal.json'), 'utf8'), formatJournal(doc));
  assert.equal(existsSync(join(dir, 'shots/t_1/sh_1.webp')), true);
  assert.equal(existsSync(join(dir, 'shots/t_2/sh_2.thumb.webp')), true);
  assert.equal(existsSync(join(dir, 'shots/t_2/sh_2.webp')), false);
  assert.equal(existsSync(join(dir, 'shots/t_3/sh_3.webp')), false, '字节数不对的不提交');
  const state = await readState(dir);
  assert.deepEqual(state.missing.map((m) => [m.trade, m.tradeId, m.file]), [
    [2, 't_2', 'shots/t_2/sh_2.webp'],
    [3, 't_3', 'shots/t_3/sh_3.webp'],
  ]);
  assert.match(state.missing[0].reason, /桶里没有/);
  assert.match(state.missing[1].reason, /字节数不对：下载到 9，doc 里记的是 10/);
  assert.equal(r.missing.length, 2);

  // 汇报：写 user_metadata.tj_backup，退出登录，返回缺图张数（入口据此以非零退出码结束）
  const f = fakeFetch({});
  const missing = await runReport({ ...quiet, env: ENV, fetch: f, dir });
  assert.equal(missing, 2);
  const put = f.calls.find((c) => c.url === `${URL_}/auth/v1/user`);
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers.Authorization, 'Bearer jwt-abc');
  assert.deepEqual(JSON.parse(put.body), {
    data: { tj_backup: { at: '2026-10-05T18:17:00.000Z', rev: 7, trades: 3, shots: 3, missing: 2 } },
  });
  assert.ok(f.calls.at(-1).url.endsWith('/auth/v1/logout?scope=local'));

  // 下一次桶里补上了：缺图清单清空
  objects['shots/t_2/sh_2.webp'] = Buffer.alloc(10);
  objects['shots/t_3/sh_3.webp'] = Buffer.alloc(10);
  await runBackup({ ...quiet, env: ENV, fetch: fakeFetch({ doc, objects }), dir });
  assert.deepEqual((await readState(dir)).missing, []);
  assert.equal(await runReport({ ...quiet, env: ENV, fetch: fakeFetch({}), dir }), 0);
});

test('汇报：没有 state.json 就失败，不登录', async (t) => {
  const dir = await tmp(t);
  const f = fakeFetch({});
  await assert.rejects(runReport({ ...quiet, env: ENV, fetch: f, dir }), /没有 state\.json/);
  assert.equal(f.calls.length, 0);
});

test('登录失败的报错里不带密码', async (t) => {
  const dir = await tmp(t);
  await mkdir(dir, { recursive: true });
  await assert.rejects(
    runBackup({ ...quiet, env: { ...ENV, TJ_PASSWORD: 'wrong-pw-123' }, fetch: fakeFetch({ doc: makeDoc(1) }), dir }),
    (e) => /登录失败/.test(e.message) && !e.message.includes('wrong-pw-123'),
  );
});
