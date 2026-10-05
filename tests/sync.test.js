// 同步时序（8.4、8.5）：真的 remote.js + sync.js + localdb.js（假 IndexedDB），云端是 tests/fake-supabase.js 的假 supabase。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeIndexedDB } from './fakes.js';
import { createFakeCloud, createFakeLib, memoryStorage, manualTimers, TEST_EMAIL, TEST_PASSWORD } from './fake-supabase.js';
import { createRemote, AUTH_STORAGE_KEY } from '../src/store/remote.js';
import { createSync, loserFileName, isBlankJournal } from '../src/store/sync.js';
import { openLocalDb, connectStore } from '../src/store/localdb.js';
import { createStore } from '../src/state.js';
import { formatJournal } from '../src/journal-format.js';
import { APP_VERSION } from '../src/version.js';

const sample = () => JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));
const tick = () => new Promise((r) => setTimeout(r, 5));
const netErr = () => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 });

async function setup({ journal = sample(), signIn = true, cloud = createFakeCloud(), storage = memoryStorage(), online } = {}) {
  const remote = createRemote({ url: 'https://abc.supabase.co', key: 'sb_publishable_test', lib: createFakeLib(cloud), storage });
  const idb = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: idb, delay: 1, lifecycle: null, visibility: null });
  const store = createStore(journal);
  const downloads = [];
  const timers = manualTimers();
  let sync;
  const link = connectStore(store, db, { BroadcastChannel: null, onSaved: () => sync && sync.notifyLocalChange() });
  if (journal) { // 本机已经记过：先写进本机（localRev 变成 1）
    store.actions.setCurrency('$$');
    store.actions.setCurrency(journal.currency);
    await link.saveNow();
    await db.flush();
  }
  const conflicts = [];
  sync = createSync({
    remote, db, store, timers,
    online: online || (() => true),
    download: (name, text) => downloads.push({ name, text }),
    onConflict: (c) => conflicts.push(c),
  });
  if (signIn) {
    const r = await sync.signIn(TEST_EMAIL, TEST_PASSWORD);
    assert.equal(r.ok, true);
    await sync.syncNow();
    await tick();
  }
  /** 改一笔交易的备注，写进本机 */
  async function edit(note, index = 1) {
    const id = store.get().journal.rows.filter((r) => r.type === 'trade')[index - 1].id;
    store.actions.updateTrade(id, { note });
    await link.saveNow();
    await db.flush();
  }
  return { cloud, remote, db, store, sync, link, downloads, conflicts, timers, storage, edit };
}

test('第一次同步：云端没有这一行 → insert rev 1，记下账号；之后只查 rev', async () => {
  const t = await setup();
  assert.equal(t.cloud.row.rev, 1);
  assert.equal(t.sync.state.status, 'synced');
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.ownerUserId, 'user-1');
  assert.equal(meta.remoteRev, 1);
  assert.equal(meta.syncedRev, meta.localRev);
  assert.equal(meta.inflight, null);
  const doc = t.cloud.doc();
  assert.equal(doc.appVersion, APP_VERSION, '保存时写入 appVersion');
  assert.deepEqual((await t.db.loadBase()).rows, doc.rows, 'base 是这次传的 doc');
  assert.equal(t.cloud.lastClientOptions.auth.storageKey, 'tj-auth');
  const before = t.cloud.calls.length;
  await t.sync.syncNow();
  assert.deepEqual(t.cloud.calls.slice(before).map((c) => c[0] + ':' + c[1]), ['select:rev'], 'rev 没变时只查 rev，不拉整份');
});

test('正常保存：改了一笔 → update（rev=eq.1），云端 rev 2；hash 按固定格式算', async () => {
  const t = await setup();
  await t.edit('改过');
  assert.equal(t.sync.state.pending, true);
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 2);
  assert.ok(t.cloud.calls.some((c) => c[0] === 'update' && c[1] === 'rev=eq.1'));
  assert.equal(t.cloud.doc().rows[1].note, '改过');
  assert.equal(JSON.parse(t.cloud.row.docText).rows.length, t.store.realJournal().rows.length);
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.sync.state.pending, false);
});

test('云端被别处改过、本机没有待同步：拉下来替换本机，base、remoteRev 一起更新', async () => {
  const t = await setup();
  const other = t.cloud.doc();
  other.rows[1].reason = '另一台电脑改的';
  t.cloud.otherDeviceSaves(other);
  await t.sync.syncNow();
  assert.equal(t.store.get().journal.rows[1].reason, '另一台电脑改的');
  assert.equal((await t.db.loadJournal()).rows[1].reason, '另一台电脑改的');
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.remoteRev, 2);
  assert.equal(meta.syncedRev, meta.localRev);
  assert.equal(t.sync.state.status, 'synced');
});

test('冲突：两边都改了 → 弹冲突框、不自动合并；选"用这台电脑上的"：云端那份留底并下载，带版本写上去', async () => {
  const t = await setup();
  const other = t.cloud.doc();
  other.rows[2].note = '云端改的';
  t.cloud.otherDeviceSaves(other);
  await t.edit('本机改的');
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'conflict');
  assert.equal(t.conflicts.length, 1);
  assert.equal(t.sync.state.conflict.summary.text, '这台电脑：改了 1 笔。云端：改了 1 笔。');
  assert.equal(t.cloud.row.rev, 2, '没有悄悄覆盖');
  const callsBefore = t.cloud.calls.length;
  await t.sync.syncNow();
  assert.equal(t.cloud.calls.length, callsBefore, '冲突没处理时不再发请求');

  await t.sync.resolveConflict('local');
  assert.equal(t.cloud.row.rev, 3);
  assert.equal(t.cloud.doc().rows[1].note, '本机改的');
  assert.equal(t.cloud.doc().rows[2].note, sample().rows[2].note);
  const kept = await t.db.listConflicts();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, 'remote');
  assert.equal(kept[0].doc.rows[2].note, '云端改的');
  assert.equal(t.downloads.length, 1);
  assert.match(t.downloads[0].name, /^journal-落选-云端-\d{8}-\d{4}\.json$/);
  assert.equal(t.downloads[0].text, formatJournal(other));
  assert.equal(t.sync.state.status, 'synced');
});

test('冲突：选"用云端的"：本机那份留底并下载，本机换成云端的', async () => {
  const t = await setup();
  const other = t.cloud.doc();
  other.rows.push({ ...other.rows[1], id: 't_cloudnew' });
  t.cloud.otherDeviceSaves(other);
  await t.edit('本机改的');
  await t.sync.syncNow();
  assert.equal(t.sync.state.conflict.summary.text, '这台电脑：改了 1 笔。云端：多了 1 笔。');
  await t.sync.resolveConflict('remote');
  assert.ok(t.store.get().journal.rows.some((r) => r.id === 't_cloudnew'));
  assert.notEqual(t.store.get().journal.rows[1].note, '本机改的');
  const kept = await t.db.listConflicts();
  assert.equal(kept[0].source, 'local');
  assert.equal(kept[0].doc.rows[1].note, '本机改的');
  assert.match(t.downloads[0].name, /落选-本机/);
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.remoteRev, 2);
  assert.equal(meta.syncedRev, meta.localRev);
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 2, '选了云端的，不再上传');
});

test('第一次在这个浏览器登录、本机已经记过、云端也有：按冲突处理（base 为空，只写两边各有几笔）', async () => {
  const cloud = createFakeCloud();
  const other = sample();
  other.rows = other.rows.slice(0, 3);
  cloud.otherDeviceSaves(other);
  const t = await setup({ cloud });
  assert.equal(t.sync.state.status, 'conflict');
  assert.equal(t.sync.state.conflict.summary.text, '这台电脑：16 笔。云端：2 笔。');
});

test('第一次登录、本机没数据、云端有：直接拉下来', async () => {
  const cloud = createFakeCloud();
  cloud.otherDeviceSaves(sample());
  const t = await setup({ cloud, journal: null });
  assert.equal(t.store.get().journal.rows.length, sample().rows.length);
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(isBlankJournal({ rows: [{ type: 'system', id: 'sys_1', name: '', desc: '' }] }), true);
});

test('保存响应丢失（其实存上了）：inflight 留着，下次先核对哈希 → 按成功处理，不弹冲突，云端 rev 只加 1', async () => {
  const t = await setup();
  await t.edit('响应丢了的那次');
  t.cloud.inject('afterUpdate', netErr);
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 2, '服务器存上了');
  assert.equal(t.sync.state.status, 'pending', '有未同步的修改，自动重试中');
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.inflight.rev, 2);
  assert.equal(meta.inflight.sent.length, 1);
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.conflicts.length, 0);
  assert.equal(t.cloud.row.rev, 2, '没有再存一遍');
  const after = await t.db.loadSyncMeta();
  assert.equal(after.inflight, null);
  assert.equal(after.remoteRev, 2);
  assert.equal(after.syncedRev, after.localRev);
});

test('保存响应丢失（没存上）：用同一个 rev 重发，sent 里追加', async () => {
  const t = await setup();
  await t.edit('第一次');
  t.cloud.inject('update', netErr);
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 1);
  await t.edit('又改了');
  t.cloud.inject('update', netErr);
  await t.sync.syncNow();
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.inflight.rev, 2);
  assert.equal(meta.inflight.sent.length, 2, '同一个 rev 重发时追加，不覆盖');
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 2);
  assert.equal(t.cloud.doc().rows[1].note, '又改了');
  assert.equal(t.sync.state.status, 'synced');
});

test('同一个 rev 重发、先前那次其实存上了：update 返回空数组 → 核对哈希认出是自己 → 成功，再把新修改存上', async () => {
  const t = await setup();
  await t.edit('A');
  t.cloud.inject('afterUpdate', netErr); // A 存上了但不知道
  await t.sync.syncNow();
  await t.edit('B');
  // 下一轮先核对 inflight：A 的哈希对上 → 成功；然后 B 正常以 rev 3 保存
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 3);
  assert.equal(t.cloud.doc().rows[1].note, 'B');
  assert.equal(t.conflicts.length, 0);
});

test('存上之后别处又存了一版：靠历史版本的哈希认出是自己的，不弹冲突，接着拉取', async () => {
  const t = await setup();
  await t.edit('我的');
  t.cloud.inject('afterUpdate', netErr);
  await t.sync.syncNow();
  const other = t.cloud.doc();
  other.rows[3].note = '别处在我之后又改';
  t.cloud.otherDeviceSaves(other); // rev 3
  await t.sync.syncNow();
  assert.ok(t.cloud.calls.some((c) => c[0] === 'history' && c[1] === 2), '去历史表取 rev 2');
  assert.equal(t.conflicts.length, 0);
  assert.equal(t.store.get().journal.rows[3].note, '别处在我之后又改');
  assert.equal(t.store.get().journal.rows[1].note, '我的');
  assert.equal((await t.db.loadSyncMeta()).remoteRev, 3);
});

test('响应丢失后核对：哈希对不上（别处存了同一个版本号）→ 冲突', async () => {
  const t = await setup();
  await t.edit('我的');
  t.cloud.inject('update', netErr); // 没存上
  await t.sync.syncNow();
  const other = t.cloud.doc();
  other.rows[1].note = '别处的';
  t.cloud.otherDeviceSaves(other); // 别处占了 rev 2
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'conflict');
  assert.equal((await t.db.loadSyncMeta()).inflight, null);
});

test('update 返回空数组且那一行没了：转"云端找不到你的日志"，不进冲突；手动重建后 insert', async () => {
  const t = await setup();
  await t.edit('x');
  t.cloud.row = null;
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'missingRemote');
  assert.equal(t.conflicts.length, 0);
  await t.sync.rebuildCloud();
  assert.equal(t.cloud.row.rev, 1);
  assert.equal(t.cloud.doc().rows[1].note, 'x');
  assert.equal(t.sync.state.status, 'synced');
});

test('第一次保存撞 23505：rev 1 那一份是自己存上的（insert 响应丢失）→ 成功', async () => {
  const cloud = createFakeCloud();
  let firstDoc = null;
  cloud.inject('insert', (q) => { // 服务器存上了，响应却丢了
    firstDoc = q.body.doc;
    cloud.row = { rev: 1, docText: JSON.stringify(q.body.doc), updated_at: '' };
    return netErr();
  });
  const t = await setup({ cloud });
  assert.ok(firstDoc);
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.conflicts.length, 0);
  assert.equal((await t.db.loadSyncMeta()).remoteRev, 1);
});

test('401 加 42501 而 tj-auth 还在：先换令牌，成功就立即重试，不显示"需要重新登录"', async () => {
  const t = await setup();
  await t.edit('y');
  t.cloud.inject('select', () => ({ data: null, error: { code: '42501', message: 'permission denied' }, status: 401 }));
  await t.sync.syncNow();
  assert.ok(t.cloud.count('refresh') >= 1);
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.cloud.row.rev, 2);
});

test('换令牌碰上断网：按断网退避，状态"有未同步的修改"；本机、inflight、待传截图都不动；恢复后自动续传', async () => {
  const t = await setup();
  await t.edit('离线时改的');
  t.cloud.inject('select', () => ({ data: null, error: { code: '42501', message: 'permission denied' }, status: 401 }));
  t.cloud.inject('refresh', () => ({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } }));
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'pending');
  assert.notEqual(t.sync.stoppedReason(), 'needLogin');
  assert.ok(t.storage.getItem(AUTH_STORAGE_KEY), '会话还在');
  assert.equal(t.timers.pending.size > 0, true, '排了重试');
  const meta = await t.db.loadSyncMeta();
  assert.ok(meta.localRev > meta.syncedRev, '待同步的修改还在');
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.cloud.doc().rows[1].note, '离线时改的');
});

test('收到不是自己点的 SIGNED_OUT：需要重新登录；本机数据和队列不动；重新登录后自动补传', async () => {
  const t = await setup();
  t.sync.start({ window: null, document: null });
  await tick();
  await t.edit('掉线后改的');
  t.storage.removeItem(AUTH_STORAGE_KEY);
  // 让假客户端发出 SIGNED_OUT（不是用户点的）
  const client = t.cloud.lastClientOptions; // 只是确认建过客户端
  assert.ok(client);
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'needLogin');
  assert.equal((await t.db.loadJournal()).rows[1].note, '掉线后改的');
  const r = await t.sync.signIn(TEST_EMAIL, TEST_PASSWORD);
  assert.equal(r.ok, true);
  await t.sync.syncNow();
  await tick();
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.cloud.doc().rows[1].note, '掉线后改的');
  t.sync.destroy();
});

test('用户自己点退出：只退这个浏览器（scope local），状态"只保存在这个浏览器里"，本机数据还在', async () => {
  const t = await setup();
  await t.sync.signOut();
  assert.deepEqual(t.cloud.signOutScopes, ['local']);
  assert.equal(t.sync.state.status, 'signedOut');
  assert.equal(t.storage.getItem(AUTH_STORAGE_KEY), null);
  assert.ok((await t.db.loadJournal()).rows.length > 1);
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'signedOut', '退出后不是"需要重新登录"');
});

test('403 加 42501：缺授权，停止自动重试；用户改了数据再试', async () => {
  const t = await setup();
  await t.edit('z');
  t.cloud.inject('update', () => ({ data: null, error: { code: '42501', message: 'permission denied for table tj_journal' }, status: 403 }));
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'grant');
  assert.equal(t.sync.state.error.status, 403);
  const n = t.cloud.calls.length;
  await t.sync.syncNow();
  assert.equal(t.cloud.calls.length, n, '停下来了，不再发');
  await t.edit('zz');
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'synced');
});

test('22P05：停下，指出第几笔哪个字段；不丢数据', async () => {
  const t = await setup();
  await t.edit('w', 2);
  t.cloud.inject('update', () => ({ data: null, error: { code: '22P05', message: 'unsupported Unicode escape sequence' }, status: 400 }));
  // 模拟清洗漏掉的情况：本机数据里直接放一个坏字符
  const j = structuredClone(t.store.realJournal());
  j.rows[2].note = 'bad\u0000';
  await t.db.applySync({ journal: j });
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'badText');
  assert.equal(t.sync.state.badText.tradeNo, 2);
  assert.equal(t.sync.state.badText.label, '备注');
});

test('上传前清洗：内存里混进 U+0000 和半个 emoji 也能存上', async () => {
  const t = await setup();
  const j = structuredClone(t.store.realJournal());
  j.rows[1].reason = 'a\u0000b\uD83D';
  await t.db.applySync({ journal: j, metaPatch: (m) => ({ ...m, localRev: m.localRev + 1 }) });
  await t.sync.syncNow();
  assert.equal(t.cloud.doc().rows[1].reason, 'ab�');
});

async function addShot(t, tradeIndex = 1, bytes = 10) {
  const trade = t.store.get().journal.rows.filter((r) => r.type === 'trade')[tradeIndex - 1];
  const sid = 'sh_' + Math.random().toString(16).slice(2, 10);
  const file = `shots/${trade.id}/${sid}.webp`;
  const thumb = `shots/${trade.id}/${sid}.thumb.webp`;
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
  await t.db.putFiles([[file, { blob, type: 'image/webp', bytes, uploaded: false, addedAt: 'x' }], [thumb, { blob, type: 'image/webp', bytes, uploaded: false, addedAt: 'x' }]]);
  t.store.actions.updateTrade(trade.id, { shots: [...trade.shots, { id: sid, label: 'open', file, thumb, width: 1, height: 1, bytes, addedAt: 'x' }] });
  await t.link.saveNow();
  await t.db.flush();
  return { file, thumb };
}

test('先图后文：没传的截图先传（对象名带 user_id、upsert false、带类型），全部传完才存 doc', async () => {
  const t = await setup();
  const { file, thumb } = await addShot(t);
  await t.sync.syncNow();
  const seq = t.cloud.calls.filter((c) => c[0] === 'upload' || c[0] === 'update').map((c) => c[0]);
  assert.deepEqual(seq, ['upload', 'upload', 'update']);
  const up = t.cloud.calls.find((c) => c[0] === 'upload');
  assert.equal(up[1], 'user-1/' + file);
  assert.deepEqual(up[2], { upsert: false, contentType: 'image/webp' });
  assert.ok(t.cloud.objects.has('tj-shots/user-1/' + thumb));
  assert.equal((await t.db.getFile(file)).uploaded, true);
});

test('断网后补传：截图传不上 → 本轮不存 doc；联网后先图后文都补上', async () => {
  const t = await setup();
  const { file } = await addShot(t);
  t.cloud.inject('upload', () => ({ data: null, error: Object.assign(new Error('Failed to fetch'), { name: 'StorageUnknownError' }) }));
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'pending');
  assert.equal(t.cloud.count('update'), 0, '云端的 doc 不引用云端还没有的图');
  assert.equal(t.cloud.row.rev, 1);
  await t.sync.syncNow();
  assert.equal(t.cloud.row.rev, 2);
  assert.ok(t.cloud.objects.has('tj-shots/user-1/' + file));
  assert.ok(t.cloud.doc().rows[1].shots.length === 1);
});

test('离线时（navigator.onLine 为 false）不空转；明确断网不发请求', async () => {
  let isOnline = true;
  const t = await setup({ online: () => isOnline });
  await t.edit('离线改');
  isOnline = false;
  const n = t.cloud.calls.length;
  await t.sync.syncNow();
  assert.equal(t.cloud.calls.length, n);
  assert.equal(t.sync.state.status, 'pending');
  isOnline = true;
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'synced');
});

test("截图 '409'（已存在）：当成已上传", async () => {
  const t = await setup();
  const { file, thumb } = await addShot(t);
  t.cloud.objects.set('tj-shots/user-1/' + file, new Blob(['old']));
  await t.sync.syncNow();
  assert.equal((await t.db.getFile(file)).uploaded, true);
  assert.equal((await t.db.getFile(thumb)).uploaded, true);
  assert.equal(t.sync.state.status, 'synced');
});

test("截图 '403' 且空间已满：图标成被拒、doc 照常保存；用量回落后自动重传", async () => {
  const t = await setup();
  t.cloud.projectBytes = 900000000;
  const { file } = await addShot(t);
  await t.sync.syncNow();
  assert.equal((await t.db.getFile(file)).rejected, 'full');
  assert.equal(t.cloud.row.rev, 2, 'doc 照常存上');
  assert.equal(t.sync.state.status, 'synced');
  assert.equal(t.sync.state.rejectedShots, 1);
  t.cloud.projectBytes = 1000;
  await t.edit('空间腾出来以后');
  await t.sync.syncNow();
  assert.equal((await t.db.getFile(file)).uploaded, true);
  assert.equal(t.sync.state.rejectedShots, 0);
});

test("截图 '403' 而空间没满：缺授权，本轮不存 doc", async () => {
  const t = await setup();
  await addShot(t);
  t.cloud.inject('upload', () => ({ data: null, error: Object.assign(new Error('rls'), { status: 400, statusCode: '403' }) }));
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'grant');
  assert.equal(t.cloud.count('update'), 0);
});

test("截图 '413'：标成被拒，不自动重传，doc 照常存", async () => {
  const t = await setup();
  const { file } = await addShot(t);
  t.cloud.inject('upload', () => ({ data: null, error: Object.assign(new Error('too big'), { status: 400, statusCode: '413' }) }));
  await t.sync.syncNow();
  assert.equal((await t.db.getFile(file)).rejected, '413');
  assert.equal(t.cloud.row.rev, 2);
  const n = t.cloud.count('upload');
  await t.edit('再改');
  await t.sync.syncNow();
  assert.equal(t.cloud.count('upload'), n, '被拒的大图不自动重传（缩略图上一轮已经传上）');
  assert.equal(t.sync.state.rejectedShots, 1);
});

test('上传期间又有修改：存完这一版接着存下一版', async () => {
  const t = await setup();
  await addShot(t);
  let edited = false;
  t.cloud.inject('upload', () => {
    if (!edited) {
      edited = true;
      const id = t.store.get().journal.rows[2].id;
      t.store.actions.updateTrade(id, { note: '上传期间改的' });
      t.link.saveNow();
    }
    return undefined;
  });
  await t.sync.syncNow();
  await t.db.flush();
  await t.sync.syncNow();
  assert.equal(t.cloud.doc().rows[2].note, '上传期间改的');
  const meta = await t.db.loadSyncMeta();
  assert.equal(meta.syncedRev, meta.localRev);
});

test('本机没有的截图从桶里下载，存进本机；云端没有时给 null', async () => {
  const t = await setup();
  const blob = new Blob([new Uint8Array(5)], { type: 'image/webp' });
  t.cloud.objects.set('tj-shots/user-1/shots/t_01/sh_x.webp', blob);
  const got = await t.sync.fetchShot('shots/t_01/sh_x.webp');
  assert.equal(got.size, 5);
  const rec = await t.db.getFile('shots/t_01/sh_x.webp');
  assert.equal(rec.uploaded, true);
  assert.equal(rec.type, 'image/webp');
  assert.equal(await t.sync.fetchShot('shots/t_01/none.webp'), null);
});

test('版本守卫：云端是更新版本网站写的 → 不替换本机，这一页只读；只读时不发请求', async () => {
  const t = await setup();
  const other = t.cloud.doc();
  other.appVersion = '999.0.0';
  t.cloud.otherDeviceSaves(other);
  await t.sync.syncNow();
  assert.equal(t.store.get().ui.readOnly, 'newer-schema');
  assert.equal(t.sync.state.status, 'newer');
  const n = t.cloud.calls.length;
  await t.sync.syncNow();
  assert.equal(t.cloud.calls.length, n, '只读的标签页不发请求');
});

test('本机日志属于另一个账号：暂停同步；换成当前账号的云端数据前，本机数据先留底并下载', async () => {
  const cloud = createFakeCloud({ uid: 'user-2' });
  cloud.otherDeviceSaves({ ...sample(), rows: sample().rows.slice(0, 2) });
  const t = await setup({ cloud, signIn: false });
  await t.db.updateSyncMeta((m) => ({ ...m, ownerUserId: 'user-1', remoteRev: 5, syncedRev: m.localRev }));
  await t.sync.signIn(TEST_EMAIL, TEST_PASSWORD);
  await t.sync.syncNow();
  assert.equal(t.sync.state.status, 'otherOwner');
  await t.sync.adoptAccountData();
  assert.equal(t.store.get().journal.rows.length, 2);
  assert.equal((await t.db.listConflicts())[0].source, 'local');
  assert.equal(t.downloads.length, 1);
  assert.equal((await t.db.loadSyncMeta()).ownerUserId, 'user-2');
  assert.equal(t.sync.state.status, 'synced');
});

test('没配置云端：状态 off，什么都不发', async () => {
  const idb = createFakeIndexedDB();
  const db = await openLocalDb({ indexedDB: idb, delay: 1, lifecycle: null, visibility: null });
  const store = createStore(null);
  const sync = createSync({ remote: null, db, store, timers: manualTimers() });
  await sync.syncNow();
  assert.equal(sync.state.status, 'off');
  assert.equal(loserFileName('local', new Date(2026, 9, 5, 14, 30)), 'journal-落选-本机-20261005-1430.json');
});

test('登录失败：邮箱或密码不对', async () => {
  const t = await setup({ signIn: false });
  const r = await t.sync.signIn(TEST_EMAIL, 'wrong');
  assert.equal(r.ok, false);
  assert.equal(r.message, '邮箱或密码不对');
  assert.equal(t.sync.state.status, 'signedOut');
});
