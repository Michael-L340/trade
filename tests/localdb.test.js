// 本机存储：IndexedDB 封装、去抖、pagehide 立刻写、版本保护、内存降级、唯一写者、多标签页同步、设置。
// 用 tests/fakes.js 里的最小 IndexedDB 和 Web Locks；BroadcastChannel 用 Node 自带的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeIndexedDB, createFakeLocks } from './fakes.js';
import {
  openLocalDb, claimWriter, connectStore, openChannel, requestPersist, getPref, setPref, removePref,
  DB_NAME, STORES, JOURNAL_KEY, StorageError,
} from '../src/store/localdb.js';
import { createStore } from '../src/state.js';

const sampleText = readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
    await sleep(5);
  }
}
const quiet = { lifecycle: null, visibility: null };
const tiny = (n) => ({ schemaVersion: 1, currency: '$', rows: [{ type: 'system', id: 'sys_1', name: 'v' + n, desc: '' }] });
let channelNo = 0;
const freshChannel = () => 'tj-test-' + process.pid + '-' + (++channelNo);

test('IndexedDB：建库和三个对象仓库，整份数据读写', async () => {
  const fake = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: fake, delay: 10, ...quiet });
  assert.equal(db.kind, 'indexeddb');
  assert.equal(db.fallbackReason, null);
  for (const s of Object.values(STORES)) assert.ok(fake.raw(DB_NAME, s), `有对象仓库 ${s}`);
  assert.equal(await db.loadJournal(), null, '首次使用时没有数据');
  const j = sample();
  assert.equal(await db.saveJournal(j, 1), 1);
  const back = await db.loadJournal();
  assert.deepEqual(back, j);
  back.rows.length = 0;
  assert.equal((await db.loadJournal()).rows.length, 18, '读出来的是副本');
  await db.close();
});

test('去抖：连续保存只写一次，每个调用都得到这一批最后的 tag', async () => {
  const fake = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: fake, delay: 30, ...quiet });
  const before = fake.stats.readwrite;
  const results = await Promise.all([db.saveJournal(tiny(1), 1), db.saveJournal(tiny(2), 2), db.saveJournal(tiny(3), 3)]);
  assert.deepEqual(results, [3, 3, 3]);
  assert.equal(fake.stats.readwrite - before, 1, '只写了一次');
  assert.equal((await db.loadJournal()).rows[0].name, 'v3');
  await db.close();
});

test('连续修改时最长 maxWait 一定写一次', async () => {
  const fake = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: fake, delay: 60, maxWait: 100, ...quiet });
  const before = fake.stats.readwrite;
  const all = [];
  for (let i = 0; i < 20; i++) {
    all.push(db.saveJournal(tiny(i), i));
    await sleep(15); // 间隔比去抖时间短，单靠去抖永远不会写
  }
  assert.ok(fake.stats.readwrite - before >= 2, `连续 300 ms 的修改至少写了两次，实际 ${fake.stats.readwrite - before}`);
  await Promise.all(all);
  assert.equal((await db.loadJournal()).rows[0].name, 'v19');
  await db.close();
});

test('页面 pagehide 或切到后台时立刻写', async () => {
  const fake = createFakeIndexedDB();
  const lifecycle = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const db = await openLocalDb({ indexedDB: fake, delay: 60_000, lifecycle, visibility });

  const p1 = db.saveJournal(tiny(1), 1);
  assert.equal(db.hasPending(), true);
  lifecycle.dispatchEvent(new Event('pagehide'));
  assert.equal(db.hasPending(), false, 'pagehide 时马上开始写');
  assert.equal(await p1, 1);

  const p2 = db.saveJournal(tiny(2), 2);
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(db.hasPending(), true, '切回前台不触发');
  visibility.visibilityState = 'hidden';
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(db.hasPending(), false, '切到后台时马上开始写');
  assert.equal(await p2, 2);
  assert.equal((await db.loadJournal()).rows[0].name, 'v2');
  await db.close();
  lifecycle.dispatchEvent(new Event('pagehide')); // 关闭后不再监听，也不会出错
  await assert.rejects(db.saveJournal(tiny(3), 3), (e) => e.code === 'CLOSED');
});

test('已存数据是更新版本的网站写的：拒绝写入，不覆盖', async () => {
  const fake = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: fake, delay: 5, ...quiet });
  const newer = { schemaVersion: 2, currency: '$', rows: [], future: true };
  fake.raw(DB_NAME, STORES.journal).set(JOURNAL_KEY, newer);
  await assert.rejects(db.saveJournal(tiny(1), 1), (e) => e instanceof StorageError && e.code === 'NEWER_SCHEMA' && /刷新/.test(e.message));
  assert.deepEqual(await db.loadJournal(), newer, '库里还是新版本的数据');
  await db.close();

  const mem = await openLocalDb({ indexedDB: null, delay: 5, ...quiet });
  await mem.saveJournal(newer, 1);
  await assert.rejects(mem.saveJournal(tiny(1), 2), (e) => e.code === 'NEWER_SCHEMA');
});

test('只读时拒绝一切写入，读不受影响', async () => {
  const db = await openLocalDb({ indexedDB: createFakeIndexedDB(), delay: 5, ...quiet });
  await db.saveJournal(tiny(1), 1);
  db.setWritable(false);
  assert.equal(db.isWritable(), false);
  await assert.rejects(db.saveJournal(tiny(2), 2), (e) => e.code === 'READ_ONLY');
  await assert.rejects(db.saveMeta('k', 1), (e) => e.code === 'READ_ONLY');
  await assert.rejects(db.putFile('shots/a.webp', { bytes: new Uint8Array([1]) }), (e) => e.code === 'READ_ONLY');
  await assert.rejects(db.deleteFile('shots/a.webp'), (e) => e.code === 'READ_ONLY');
  assert.equal((await db.loadJournal()).rows[0].name, 'v1');
  db.setWritable(true);
  assert.equal(await db.saveJournal(tiny(3), 3), 3);
  await db.close();
});

test('meta 和 files 仓库', async () => {
  const db = await openLocalDb({ indexedDB: createFakeIndexedDB(), ...quiet });
  assert.equal(await db.loadMeta('remoteSha'), undefined);
  await db.saveMeta('remoteSha', 'abc123');
  assert.equal(await db.loadMeta('remoteSha'), 'abc123');
  const path = 'shots/t_1/sh_1.webp';
  await db.putFile(path, { bytes: new Uint8Array([1, 2, 3]), uploaded: false });
  const rec = await db.getFile(path);
  assert.deepEqual([...rec.bytes], [1, 2, 3]);
  assert.equal(rec.uploaded, false);
  assert.deepEqual(await db.listFiles(), [path]);
  await db.deleteFile(path);
  assert.equal(await db.getFile(path), null);
  await db.close();
});

test('写入失败时报错，之后的保存照常', async () => {
  const db = await openLocalDb({ indexedDB: createFakeIndexedDB(), delay: 5, ...quiet });
  const bad = { ...tiny(1), oops: () => 1 }; // 函数复制不了
  await assert.rejects(db.saveJournal(bad, 1), (e) => e instanceof StorageError && e.code === 'IDB');
  assert.equal(await db.saveJournal(tiny(2), 2), 2);
  assert.equal((await db.loadJournal()).rows[0].name, 'v2');
  await db.close();
});

test('新版本网站升级数据库后，本页关闭连接并不再写', async () => {
  const fake = createFakeIndexedDB();
  let notified = 0;
  const db = await openLocalDb({ indexedDB: fake, delay: 5, onVersionChange: () => { notified += 1; }, ...quiet });
  await db.saveJournal(tiny(1), 1);
  await new Promise((resolve) => { fake.open(DB_NAME, 2).onsuccess = resolve; });
  assert.equal(notified, 1);
  assert.equal(db.isWritable(), false);
  await assert.rejects(db.saveJournal(tiny(2), 2), (e) => e.code === 'CLOSED');
});

test('没有 IndexedDB 或打不开时降级为只在内存', async () => {
  const none = await openLocalDb({ indexedDB: null, delay: 5, ...quiet });
  assert.equal(none.kind, 'memory');
  assert.match(none.fallbackReason, /IndexedDB/);
  await none.saveJournal(tiny(1), 1);
  assert.equal((await none.loadJournal()).rows[0].name, 'v1');

  const throwing = await openLocalDb({ indexedDB: { open() { throw new DOMException('denied', 'SecurityError'); } }, ...quiet });
  assert.equal(throwing.kind, 'memory');
  assert.match(throwing.fallbackReason, /SecurityError/);

  const failing = await openLocalDb({
    indexedDB: { open() { const r = {}; setTimeout(() => { r.error = new DOMException('x', 'InvalidStateError'); r.onerror(); }, 0); return r; } },
    ...quiet,
  });
  assert.equal(failing.kind, 'memory');
  assert.match(failing.fallbackReason, /InvalidStateError/);
});

test('claimWriter：第一个标签页是写者，后来的只读，前一个关掉后接手', async () => {
  const locks = createFakeLocks();
  const w1 = await claimWriter({ locks });
  const w2 = await claimWriter({ locks });
  const w3 = await claimWriter({ locks });
  assert.deepEqual([w1.isWriter, w2.isWriter, w3.isWriter], [true, false, false]);
  assert.equal(w1.supported, true);
  let got2 = false;
  w2.acquired.then(() => { got2 = true; });
  w3.release(); // 第三个标签页在排队时就关掉了
  await sleep(5);
  assert.equal(got2, false);
  w1.release();
  await w2.acquired;
  assert.equal(w2.isWriter, true);
  w2.release();
  await sleep(5);
  assert.equal(w3.isWriter, false, '已经放弃的标签页不会再拿到锁');

  const none = await claimWriter({ locks: null });
  assert.deepEqual([none.isWriter, none.supported], [true, false]);
  const broken = await claimWriter({ locks: { request() { throw new DOMException('no', 'SecurityError'); } } });
  assert.deepEqual([broken.isWriter, broken.supported], [true, false]);
});

test('openChannel：不支持 BroadcastChannel 时什么都不做', () => {
  const ch = openChannel({ BroadcastChannel: null });
  assert.equal(ch.supported, false);
  ch.post({ type: 'saved' });
  ch.close();
});

async function openTab(fake, locks, channelName) {
  const db = await openLocalDb({ indexedDB: fake, delay: 10, ...quiet });
  const writer = await claimWriter({ locks });
  const store = createStore(await db.loadJournal(), { readOnly: writer.isWriter ? null : 'other-tab' });
  const errors = [];
  const link = connectStore(store, db, { writer, channelName, onError: (e) => errors.push(e) });
  return { db, writer, store, link, errors, close() { link.stop(); writer.release(); } };
}

test('两个标签页：写者自动保存并清 dirty，只读页跟着更新；示例模式不写；写者关掉后另一页接手', async () => {
  const fake = createFakeIndexedDB();
  const locks = createFakeLocks();
  const name = freshChannel();
  const A = await openTab(fake, locks, name);
  const B = await openTab(fake, locks, name);
  try {
    assert.equal(A.store.get().ui.readOnly, null);
    assert.equal(B.store.get().ui.readOnly, 'other-tab');
    assert.equal(B.db.isWritable(), false);

    const id = A.store.actions.createTradeFromEmptyRow({ rr: 2 });
    assert.equal(A.store.get().ui.dirty, true);
    await until(() => !A.store.get().ui.dirty, 'A 保存完成');
    assert.equal(fake.raw(DB_NAME, STORES.journal).get(JOURNAL_KEY).rows[1].id, id, '写进了 IndexedDB');
    await until(() => B.store.get().journal.rows.length === 2, 'B 收到通知后重读');
    assert.equal(B.store.get().derived.tradeById.get(id).d.takeProfit, null, '止损还没填，算不出止盈');

    assert.equal(B.store.actions.updateTrade(id, { note: 'B 改' }), false, 'B 是只读的');

    // 示例模式：随便改，不写 IndexedDB
    const writes = fake.stats.readwrite;
    A.store.actions.replaceJournal(sample(), { demo: true });
    A.store.actions.createTradeFromEmptyRow({ rr: 3 });
    A.store.actions.deleteTrade('t_01');
    await sleep(60);
    assert.equal(fake.stats.readwrite, writes, '示例模式下没有写入');
    assert.equal(fake.raw(DB_NAME, STORES.journal).get(JOURNAL_KEY).rows.length, 2);
    A.store.actions.exitDemo();
    assert.equal(A.store.get().journal.rows.length, 2);

    // A 关掉，B 接手：先重读，再解除只读
    A.store.actions.updateTrade(id, { note: 'A 最后一次修改' });
    await until(() => !A.store.get().ui.dirty, 'A 保存最后一次修改');
    A.close();
    await until(() => B.store.get().ui.readOnly === null, 'B 接手成为写者');
    assert.equal(B.store.get().journal.rows[1].note, 'A 最后一次修改');
    assert.equal(B.db.isWritable(), true);
    assert.equal(B.store.actions.updateTrade(id, { note: 'B 接手后修改' }), true);
    await until(() => !B.store.get().ui.dirty, 'B 保存');
    assert.equal(fake.raw(DB_NAME, STORES.journal).get(JOURNAL_KEY).rows[1].note, 'B 接手后修改');
    assert.deepEqual(A.errors, []);
    assert.deepEqual(B.errors, []);
  } finally {
    A.close();
    B.close();
  }
});

test('connectStore：保存时发现更新版本的数据就转为只读并报错', async () => {
  const fake = createFakeIndexedDB();
  const T = await openTab(fake, createFakeLocks(), freshChannel());
  try {
    T.store.actions.createTradeFromEmptyRow({ rr: 2 });
    await until(() => !T.store.get().ui.dirty, '第一次保存');
    fake.raw(DB_NAME, STORES.journal).set(JOURNAL_KEY, { schemaVersion: 2, currency: '$', rows: [] });
    T.store.actions.createTradeFromEmptyRow({ rr: 3 });
    await until(() => T.errors.length > 0, '报错');
    assert.equal(T.errors[0].code, 'NEWER_SCHEMA');
    assert.equal(T.store.get().ui.readOnly, 'newer-schema');
    assert.equal(T.db.isWritable(), false);
    assert.equal(T.store.actions.createTradeFromEmptyRow({ rr: 1 }), null, '之后不能再改');
    assert.equal(fake.raw(DB_NAME, STORES.journal).get(JOURNAL_KEY).schemaVersion, 2, '没有覆盖');
  } finally {
    T.close();
  }
});

test('connectStore：saveNow 立刻写（"保存失败，点击重试"用）', async () => {
  const fake = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: fake, delay: 60_000, ...quiet });
  const store = createStore(null);
  const link = connectStore(store, db, { channelName: freshChannel() });
  try {
    store.actions.createTradeFromEmptyRow({ rr: 2 });
    assert.equal(store.get().ui.dirty, true);
    assert.equal(await link.saveNow(), true);
    assert.equal(store.get().ui.dirty, false);
    assert.equal(await link.saveNow(), false, '没有要存的');
  } finally {
    link.stop();
  }
});

test('requestPersist 不会抛错', async () => {
  let asked = 0;
  assert.equal(await requestPersist({ persisted: async () => false, persist: async () => { asked += 1; return true; } }), true);
  assert.equal(asked, 1);
  assert.equal(await requestPersist({ persisted: async () => true, persist: async () => { asked += 1; return true; } }), true);
  assert.equal(asked, 1, '已经获准就不再申请');
  assert.equal(await requestPersist({ persist: async () => { throw new Error('x'); } }), false);
  assert.equal(await requestPersist(null), false);
});

test('设置：键名加 tj_ 前缀，只动自己的键，从不清空', () => {
  const data = new Map([['other-site-key', 'keep']]);
  let cleared = 0;
  const storage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => { cleared += 1; data.clear(); },
  };
  assert.equal(setPref('lastRoute', '#/settings', storage), true);
  assert.equal(data.get('tj_lastRoute'), '"#/settings"');
  assert.equal(getPref('lastRoute', null, storage), '#/settings');
  assert.equal(getPref('missing', 'dflt', storage), 'dflt');
  data.set('tj_broken', '{not json');
  assert.equal(getPref('broken', 'dflt', storage), 'dflt');
  assert.equal(removePref('lastRoute', storage), true);
  assert.equal(data.has('tj_lastRoute'), false);
  assert.equal(data.get('other-site-key'), 'keep');
  assert.equal(cleared, 0);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(getPref('x', 1, throwing), 1);
  assert.equal(setPref('x', 1, throwing), false);
  assert.equal(removePref('x', throwing), false);
  assert.equal(getPref('x', 2, null), 2);
});
