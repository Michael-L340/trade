// 版本号和版本守卫（5.1）、journal.json 的固定格式（5.2）的金标准。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../src/version.js';
import * as Model from '../src/model.js';
import { formatJournal } from '../src/journal-format.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sample = () => JSON.parse(read('../fixtures/sample-journal.json'));

test('版本号只有一个来源：package.json 的 version 等于 src/version.js，model 转出的也是它', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(APP_VERSION, pkg.version);
  assert.equal(Model.APP_VERSION, APP_VERSION);
  assert.ok(!/APP_VERSION\s*=/.test(read('../src/model.js')), 'model.js 不另写一份');
  assert.ok(!/APP_VERSION\s*=/.test(read('../src/main.js')), 'main.js 不另写一份');
});

test('compareVersions：按数字逐段比，认不出的写法当相同', () => {
  const { compareVersions } = Model;
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('dev', '1.0.0'), 0);
  assert.equal(compareVersions(undefined, '1.0.0'), 0);
  assert.equal(compareVersions('20261005093000', '1.0.0'), 0);
});

test('版本守卫：schemaVersion 更大或 appVersion 更新时只读；没有 appVersion 不拦', () => {
  const { versionGuard, SCHEMA_VERSION } = Model;
  const j = sample();
  assert.equal(versionGuard(j), null, '附录 A 没有 appVersion，不拦');
  assert.equal(versionGuard({ ...j, appVersion: APP_VERSION }), null, '同一版本写的照常');
  assert.equal(versionGuard({ ...j, appVersion: '0.0.1' }), null, '旧版本写的照常');
  assert.equal(versionGuard({ ...j, appVersion: '999.0.0' }), 'newer-schema');
  assert.equal(versionGuard({ ...j, schemaVersion: SCHEMA_VERSION + 1 }), 'newer-schema');
  assert.equal(versionGuard({ ...j, appVersion: '0.3.0' }, '0.2.9'), 'newer-schema', '旧标签页读到新版本写的数据');
  assert.equal(versionGuard(null), null);
});

test('stampAppVersion：保存时写入本网站版本，排在 schemaVersion 后面；不改入参', () => {
  const j = sample();
  const out = Model.stampAppVersion(j);
  assert.equal(out.appVersion, APP_VERSION);
  assert.equal(j.appVersion, undefined);
  assert.equal(Model.stampAppVersion(out), out, '已经是本版本时原样返回');
  const text = formatJournal(out);
  assert.ok(text.startsWith(`{\n  "schemaVersion": 1,\n  "appVersion": "${APP_VERSION}",\n  "currency": "$",\n`));
});

test('不认识的键：顶层、行、截图三层都排在已知键后面，按原来的相对顺序', () => {
  const j = {
    zebra: 1, schemaVersion: 1, apple: { z: 1, a: 2 }, rows: [
      { mid: 1, type: 'system', id: 'sys_a', name: '', desc: '', aaa: 2 },
      { type: 'trade', id: 't_1', date: '2026-09-01', symbol: '', direction: 'long', rr: null, risk: null, result: null, pnlOverride: null, reason: '', note: '', shots: [{ zz: 1, id: 'sh_1', label: '', file: 'f', yy: 2 }], q: 1, b: 2 },
    ], currency: '$',
  };
  const text = formatJournal(j);
  assert.equal(text, [
    '{',
    '  "schemaVersion": 1,',
    '  "currency": "$",',
    '  "rows": [',
    '    {"type":"system","id":"sys_a","name":"","desc":"","mid":1,"aaa":2},',
    '    {"type":"trade","id":"t_1","date":"2026-09-01","symbol":"","direction":"long","rr":null,"risk":null,"result":null,"pnlOverride":null,"reason":"","note":"","shots":[{"id":"sh_1","label":"","file":"f","zz":1,"yy":2}],"q":1,"b":2}',
    '  ],',
    '  "zebra": 1,',
    '  "apple": {"z":1,"a":2}',
    '}',
    '',
  ].join('\n'));
  assert.equal(formatJournal(JSON.parse(text)), text, '读回再写一遍不变');
});

test('金标准：附录 A 写出来和 fixtures/sample-journal.formatted.json 逐字节相同（4,831 字节）', () => {
  const golden = read('../fixtures/sample-journal.formatted.json');
  const text = formatJournal(sample());
  assert.equal(text, golden);
  assert.equal(Buffer.byteLength(text, 'utf8'), 4831);
  assert.equal(formatJournal(JSON.parse(golden)), golden);
  assert.equal(Model.serialize, formatJournal, '导出和哈希用同一个函数');
});

test('本机存储拒绝覆盖更新版本网站写的数据（appVersion 更新）', async () => {
  const { openLocalDb } = await import('../src/store/localdb.js');
  const { createFakeIndexedDB } = await import('./fakes.js');
  const db = await openLocalDb({ indexedDB: createFakeIndexedDB(), delay: 5, lifecycle: null, visibility: null });
  const newer = { ...sample(), appVersion: '999.0.0' };
  await db.saveJournal(newer, 1); // 第一次写：库里还没有数据
  await assert.rejects(db.saveJournal(sample(), 2), (e) => e.code === 'NEWER_SCHEMA');
  assert.equal((await db.loadJournal()).appVersion, '999.0.0');
});

test('自动保存时写进本机的数据带上本网站的 appVersion', async () => {
  const { openLocalDb, connectStore } = await import('../src/store/localdb.js');
  const { createFakeIndexedDB } = await import('./fakes.js');
  const { createStore } = await import('../src/state.js');
  const db = await openLocalDb({ indexedDB: createFakeIndexedDB(), delay: 5, lifecycle: null, visibility: null });
  const store = createStore(sample());
  const link = connectStore(store, db, { BroadcastChannel: null });
  store.actions.setCurrency('¥');
  await link.saveNow();
  await db.flush();
  const saved = await db.loadJournal();
  assert.equal(saved.appVersion, APP_VERSION);
  assert.equal(saved.currency, '¥');
  link.stop();
});
