// shots.js：默认标签、路径、加图、删除和撤销、改标签、Blob 地址缓存的释放。
// store 用真的 createStore（纯内存）；db 用假的（记录每次调用，可以让某次写入失败），
// 压缩用假的 processImage（Node 里没有 canvas）；最后接一遍真的 localdb（tests/fakes.js 的假 IndexedDB 和内存降级）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/state.js';
import { validateJournal, serialize, SHOT_KEYS } from '../src/model.js';
import { deriveTrade } from '../src/calc.js';
import { openLocalDb } from '../src/store/localdb.js';
import { ImageError } from '../src/images.js';
import { createFakeIndexedDB } from './fakes.js';
import {
  addShot, deleteShot, setShotLabel, createUrlCache, getShotBlob, defaultLabel, shotPaths, nextLabel,
  LABELS, LABEL_TEXT, LABEL_MAX, normalizeLabel, ShotError,
} from '../src/shots.js';

const sampleText = readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);
const NOW = () => new Date(Date.UTC(2026, 9, 5, 6, 30, 15));

function journal() {
  return {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_r', name: '我的系统', desc: '', createdAt: '2026-10-01T00:00:00Z' },
      { type: 'trade', id: 't_open', date: '2026-10-01', symbol: 'XAUUSD', direction: 'long', rr: 2, risk: 100, result: null, pnlOverride: null, reason: '', note: '', shots: [] },
      { type: 'trade', id: 't_done', date: '2026-10-02', symbol: 'EURUSD', direction: 'short', rr: 2, risk: 50, result: 'win', pnlOverride: null, reason: '', note: '', shots: [] },
    ],
  };
}

const storageFull = () => Object.assign(new Error('浏览器的存储空间不够了，没能保存'), { name: 'StorageError', code: 'IDB' });

/**
 * 假的本机存储：files 仓库就是一个 Map。putFile / deleteFile 在调用时立刻生效（真的 IndexedDB 按请求先后执行，效果一样）。
 * failPut(第几次 put, 路径) 返回 true 时那次写入失败；onPut(第几次 put, 路径) 在写入生效前调用。
 */
function fakeDb() {
  const db = {
    files: new Map(),
    calls: [],
    puts: 0,
    failPut: null,
    onPut: null,
    getFile(path) {
      db.calls.push(['get', path]);
      return Promise.resolve(db.files.has(path) ? db.files.get(path) : null);
    },
    putFile(path, rec) {
      db.calls.push(['put', path]);
      db.puts += 1;
      if (db.onPut) db.onPut(db.puts, path);
      if (db.failPut && db.failPut(db.puts, path)) return Promise.reject(storageFull());
      db.files.set(path, rec);
      return Promise.resolve();
    },
    deleteFile(path) {
      db.calls.push(['delete', path]);
      db.files.delete(path);
      return Promise.resolve();
    },
    listFiles() { return Promise.resolve(Array.from(db.files.keys())); },
  };
  return db;
}

/** 假的压缩：不碰 canvas，直接给大图（bytes 字节）和缩略图（100 字节） */
function fakeProcess({ ext = 'webp', width = 1920, height = 1080, bytes = 1234, delay = null } = {}) {
  const type = ext === 'jpg' ? 'image/jpeg' : 'image/webp';
  const fn = async (blob, opts) => {
    fn.calls.push({ blob, opts });
    if (delay) await delay();
    return {
      file: new Blob([new Uint8Array(bytes)], { type }),
      thumb: new Blob([new Uint8Array(100)], { type }),
      width, height, bytes, ext, type,
    };
  };
  fn.calls = [];
  return fn;
}

/** 假的 URL.createObjectURL / revokeObjectURL：记下建了几个、revoke 了哪些，live 是还没释放的 */
function fakeUrl() {
  let n = 0;
  const live = new Map();
  const log = { created: 0, revoked: [] };
  return {
    live,
    log,
    createObjectURL(blob) {
      const u = 'blob:fake/' + (++n);
      live.set(u, blob);
      log.created += 1;
      return u;
    },
    revokeObjectURL(u) {
      log.revoked.push(u);
      live.delete(u);
    },
  };
}

function setup({ db = fakeDb(), process = fakeProcess(), j = journal(), storeOpts = {} } = {}) {
  const store = createStore(j, { now: NOW, ...storeOpts });
  const errors = [];
  const ctx = { store, db, processImage: process, now: NOW, onError: (e) => errors.push(e) };
  return { store, db, ctx, process, errors };
}

const png = () => new Blob([new Uint8Array(8)], { type: 'image/png' });
const shotsOf = (store, id) => store.get().journal.rows.find((r) => r.id === id).shots;
const ids = (list) => list.map((s) => s.id);

// ---------- 纯函数 ----------

test('defaultLabel：没出场是"开仓时"，已出场是"平仓后"；派生值、{t, d}、交易行都认', () => {
  assert.equal(defaultLabel({ outcome: 'open' }), 'open');
  for (const o of ['win', 'loss', 'breakeven', 'invalid']) assert.equal(defaultLabel({ outcome: o }), 'close', o);
  const [, open, done] = journal().rows;
  assert.equal(defaultLabel(deriveTrade(open)), 'open');
  assert.equal(defaultLabel(deriveTrade(done)), 'close');
  assert.equal(defaultLabel({ t: done, d: deriveTrade(done) }), 'close', 'store 里 tradeById 的一项');
  assert.equal(defaultLabel(open), 'open', '交易行本身');
  assert.equal(defaultLabel(done), 'close');
  assert.equal(defaultLabel({ ...open, pnlOverride: 0 }), 'close', '手填了盈亏（保本出场）也算已出场');
  assert.equal(defaultLabel({ ...open, result: 'loss', rr: null }), 'close');
  assert.equal(defaultLabel(null), 'open');
  assert.equal(defaultLabel(undefined), 'open');
  const { store } = setup();
  assert.equal(defaultLabel(store.get().derived.tradeById.get('t_open').d), 'open');
  assert.equal(defaultLabel(store.get().derived.tradeById.get('t_done').d), 'close');
});

test('shotPaths：shots/<交易 id>/<截图 id>.webp 和 .thumb.webp，JPEG 用 .jpg；id 不对就抛错', () => {
  assert.deepEqual(shotPaths('t_8d2c1a9f', 'sh_4f7e2b10', 'webp'), {
    file: 'shots/t_8d2c1a9f/sh_4f7e2b10.webp',
    thumb: 'shots/t_8d2c1a9f/sh_4f7e2b10.thumb.webp',
  }, '和第 5 节的示例一样');
  assert.deepEqual(shotPaths('t_01', 'sh_1', 'jpg'), { file: 'shots/t_01/sh_1.jpg', thumb: 'shots/t_01/sh_1.thumb.jpg' });
  assert.deepEqual(shotPaths('t_01', 'sh_1', 'jpeg'), shotPaths('t_01', 'sh_1', 'jpg'), 'jpeg 当 jpg');
  assert.deepEqual(shotPaths('t_01', 'sh_1', 'WEBP'), shotPaths('t_01', 'sh_1', 'webp'));
  for (const ext of ['png', '', null, undefined, 'constructor', 'image/webp', '.webp']) {
    assert.throws(() => shotPaths('t_01', 'sh_1', ext), TypeError, String(ext));
  }
  for (const [t, s] of [['t_01/../x', 'sh_1'], ['t_01', 'sh_1/..'], ['sh_1', 't_01'], ['', 'sh_1'], ['t_01', 'sh_a.b'], [null, 'sh_1'], ['t_01', 'sh_ 1']]) {
    assert.throws(() => shotPaths(t, s, 'webp'), TypeError, `${t} ${s}`);
  }
});

test('标签：三种取值、显示文字、点一下换下一个', () => {
  assert.deepEqual(LABELS, ['open', 'close', '']);
  assert.deepEqual(LABEL_TEXT, { open: '开仓时', close: '平仓后', '': '无' });
  assert.equal(nextLabel('open'), 'close');
  assert.equal(nextLabel('close'), '');
  assert.equal(nextLabel(''), 'open');
  assert.equal(nextLabel(undefined), 'open');
});

// ---------- addShot ----------

test('addShot：先压缩、再写两个文件（uploaded: false），最后把元数据加进这一笔', async () => {
  const { store, db, ctx, process } = setup();
  const events = [];
  store.subscribe((ev) => events.push(ev));
  const blob = png();
  const shot = await addShot(ctx, 't_open', blob);

  assert.equal(process.calls.length, 1);
  assert.equal(process.calls[0].blob, blob);
  assert.match(shot.id, /^sh_[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(shot), SHOT_KEYS, '字段和顺序照第 5 节');
  assert.deepEqual(shot, {
    id: shot.id,
    label: 'open',
    file: `shots/t_open/${shot.id}.webp`,
    thumb: `shots/t_open/${shot.id}.thumb.webp`,
    width: 1920,
    height: 1080,
    bytes: 1234,
    addedAt: '2026-10-05T06:30:15Z',
  });

  assert.deepEqual(db.calls, [['put', shot.file], ['put', shot.thumb]]);
  const rec = db.files.get(shot.file);
  assert.deepEqual(Object.keys(rec), ['blob', 'type', 'bytes', 'uploaded', 'addedAt']);
  assert.deepEqual({ ...rec, blob: rec.blob.size }, { blob: 1234, type: 'image/webp', bytes: 1234, uploaded: false, addedAt: '2026-10-05T06:30:15Z' });
  const thumb = db.files.get(shot.thumb);
  assert.deepEqual({ ...thumb, blob: thumb.blob.type }, { blob: 'image/webp', type: 'image/webp', bytes: 100, uploaded: false, addedAt: '2026-10-05T06:30:15Z' });

  assert.deepEqual(shotsOf(store, 't_open'), [shot]);
  assert.equal(store.get().ui.dirty, true, '真实数据：会自动保存');
  assert.deepEqual(events.map((e) => [e.type, e.ids, e.fields]), [['row', ['t_open'], ['shots']]], '只刷新这一行');
  assert.deepEqual(validateJournal(store.get().journal), []);
  assert.ok(serialize(store.get().journal).includes(`"shots":[{"id":"${shot.id}","label":"open","file":"shots/t_open/${shot.id}.webp","thumb":`), '导出的 journal.json 里只有元数据');
});

test('addShot：已出场默认"平仓后"；传了标签就用传的；JPEG 是 .jpg；加在末尾', async () => {
  const { store, ctx } = setup({ process: fakeProcess({ ext: 'jpg' }) });
  const a = await addShot(ctx, 't_done', png());
  assert.equal(a.label, 'close');
  assert.ok(a.file.endsWith(`${a.id}.jpg`) && a.thumb.endsWith(`${a.id}.thumb.jpg`));
  const b = await addShot(ctx, 't_done', png(), '');
  assert.equal(b.label, '', '空标签也是合法的标签');
  const c = await addShot(ctx, 't_open', png(), 'close');
  assert.equal(c.label, 'close');
  const d = await addShot(ctx, 't_open', png(), 'later');
  assert.equal(d.label, 'open', '不认识的标签按默认');
  assert.deepEqual(ids(shotsOf(store, 't_done')), [a.id, b.id]);
  assert.deepEqual(ids(shotsOf(store, 't_open')), [c.id, d.id]);
  assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4);
  assert.deepEqual(validateJournal(store.get().journal), []);
});

test('addShot：同一笔连贴几张（并发处理）一张都不丢，id 不重复', async () => {
  const { store, ctx } = setup({ process: fakeProcess({ delay: () => new Promise((r) => setTimeout(r, 5)) }) });
  const shots = await Promise.all([1, 2, 3].map(() => addShot(ctx, 't_open', png())));
  assert.deepEqual(ids(shotsOf(store, 't_open')).sort(), ids(shots).sort());
  assert.equal(new Set(ids(shots)).size, 3);
  assert.deepEqual(validateJournal(store.get().journal), []);
});

test('addShot：只读、找不到这一笔、系统行、没有本机存储时拒绝，不压缩也不写', async () => {
  const { store, db, ctx, process } = setup({ storeOpts: { readOnly: 'other-tab' } });
  await assert.rejects(addShot(ctx, 't_open', png()), (e) => e instanceof ShotError && e.code === 'READ_ONLY' && /只能看/.test(e.message));
  store.actions.setReadOnly(null);
  await assert.rejects(addShot(ctx, 't_nope', png()), (e) => e instanceof ShotError && e.code === 'NO_TRADE');
  await assert.rejects(addShot(ctx, 'sys_r', png()), { code: 'NO_TRADE' });
  await assert.rejects(addShot({ ...ctx, db: null }, 't_open', png()), { code: 'NO_DB' });
  await assert.rejects(addShot({}, 't_open', png()), TypeError);
  assert.equal(process.calls.length, 0);
  assert.deepEqual(db.calls, []);
  assert.deepEqual(shotsOf(store, 't_open'), []);
});

test('addShot：压缩期间这一笔被删了、或者进了示例模式：报错，不留文件也不留元数据', async () => {
  let release = null;
  const gate = () => new Promise((r) => { release = r; });
  const { store, db, ctx } = setup({ process: fakeProcess({ delay: gate }) });

  const p = addShot(ctx, 't_open', png());
  const undoTrade = store.actions.deleteTrade('t_open');
  release();
  await assert.rejects(p, (e) => e.code === 'NO_TRADE' && /删掉/.test(e.message));
  assert.equal(db.files.size, 0);
  undoTrade();
  assert.deepEqual(shotsOf(store, 't_open'), [], '撤销删除后这一笔回来了，没有半截截图');

  const p2 = addShot(ctx, 't_open', png());
  store.actions.replaceJournal(sample(), { demo: true });
  release();
  await assert.rejects(p2, (e) => e.code === 'NO_TRADE' && /示例/.test(e.message));
  store.actions.exitDemo();
  assert.equal(db.files.size, 0);
  assert.deepEqual(shotsOf(store, 't_open'), []);
});

test('addShot：写文件期间这一笔被删了：已经写进去的两个文件删掉', async () => {
  const { store, db, ctx } = setup();
  db.onPut = (n) => { if (n === 2) store.actions.deleteTrade('t_open'); };
  await assert.rejects(addShot(ctx, 't_open', png()), { code: 'NO_TRADE' });
  assert.deepEqual(db.calls.map((c) => c[0]), ['put', 'put', 'delete', 'delete']);
  assert.equal(db.files.size, 0);
});

test('addShot：第二个文件写失败（例如空间不够）：删掉第一个，错误原样抛出，不加元数据', async () => {
  const { store, db, ctx } = setup();
  db.failPut = (n) => n === 2;
  await assert.rejects(addShot(ctx, 't_open', png()), (e) => e.code === 'IDB' && /空间不够/.test(e.message));
  assert.deepEqual(db.calls.map((c) => c[0]), ['put', 'put', 'delete']);
  assert.equal(db.files.size, 0);
  assert.deepEqual(shotsOf(store, 't_open'), []);
  assert.equal(store.get().ui.dirty, false);
});

test('addShot：图片读不出来时 ImageError 原样抛出；压缩结果不对时不保存', async () => {
  const bad = setup({ process: async () => { throw new ImageError('DECODE', '读不出这张图片'); } });
  await assert.rejects(addShot(bad.ctx, 't_open', png()), (e) => e instanceof ImageError && e.code === 'DECODE');
  assert.deepEqual(bad.db.calls, []);
  const odd = setup({ process: async () => ({ file: null }) });
  await assert.rejects(addShot(odd.ctx, 't_open', png()), { code: 'BAD_IMAGE' });
  const nan = setup({ process: async () => ({ ...(await fakeProcess()(png())), width: NaN }) });
  await assert.rejects(addShot(nan.ctx, 't_open', png()), { code: 'BAD_IMAGE' }, '宽高不是数字会让整份数据校验不过，不能存');
  assert.deepEqual(nan.db.calls, []);
});

test('addShot：接上真的 processImage（假的读图和画布）：浏览器不支持 WebP 时文件是 .jpg、类型 image/jpeg', async () => {
  const createCanvas = (webp) => (w, h) => {
    const canvas = {
      width: w,
      height: h,
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob(cb, type, q) {
        const out = type === 'image/webp' && !webp ? 'image/png' : type;
        const size = Math.round(canvas.width * canvas.height * q * 0.05);
        setTimeout(() => cb(new Blob([new Uint8Array(size)], { type: out })), 0);
      },
    };
    return canvas;
  };
  const decode = async () => ({ width: 2560, height: 1440, close() {} });
  for (const webp of [true, false]) {
    const { store, db } = setup();
    const ctx = { store, db, imageOptions: { decode, createCanvas: createCanvas(webp) }, now: NOW };
    const shot = await addShot(ctx, 't_open', png());
    const ext = webp ? 'webp' : 'jpg';
    const type = webp ? 'image/webp' : 'image/jpeg';
    assert.ok(shot.file.endsWith(`.${ext}`) && shot.thumb.endsWith(`.thumb.${ext}`), ext);
    assert.deepEqual([shot.width, shot.height], [1920, 1080], '长边缩到 1920');
    assert.equal(db.files.get(shot.file).type, type);
    assert.equal(db.files.get(shot.file).blob.type, type);
    assert.equal(db.files.get(shot.thumb).blob.type, type);
    assert.equal(shot.bytes, db.files.get(shot.file).bytes);
    assert.equal(shot.bytes, Math.round(1920 * 1080 * (webp ? 0.82 : 0.85) * 0.05));
  }
});

// ---------- 示例模式 ----------

test('示例模式：截图文件只在内存，不写 IndexedDB；别处建的 ctx 也读得到；进出示例时清空', async () => {
  const { store, db, ctx } = setup();
  store.actions.replaceJournal(sample(), { demo: true });
  const shot = await addShot(ctx, 't_01', png());
  assert.deepEqual(db.calls, [], '不碰本机存储');
  assert.equal(store.get().ui.dirty, false, '示例数据的修改不保存');
  assert.equal(shotsOf(store, 't_01').length, 1);

  const url = fakeUrl();
  const cache = createUrlCache({ store, db, URL: url }); // 表格、详情各自建的 ctx
  assert.match(await cache.get(shot.thumb), /^blob:fake\//);
  assert.equal((await getShotBlob({ store, db }, shot.file)).size, 1234);
  cache.releaseAll();

  store.actions.exitDemo();
  assert.equal(await getShotBlob({ store, db }, shot.file), null, '退出示例后内存里的截图没了');
  store.actions.replaceJournal(sample(), { demo: true });
  const again = await addShot(ctx, 't_01', png());
  store.actions.replaceJournal(sample(), { demo: true }); // 重新载入示例
  assert.equal(await getShotBlob(ctx, again.file), null, '重新载入示例也清空');
  assert.deepEqual(db.calls.filter((c) => c[0] !== 'get'), [], '始终没写过本机存储');
});

test('示例模式：另一个标签页在写（本页只读）时也能贴截图，只在内存', async () => {
  const { store, db, ctx } = setup({ storeOpts: { readOnly: 'other-tab' } });
  await assert.rejects(addShot(ctx, 't_open', png()), { code: 'READ_ONLY' });
  store.actions.replaceJournal(sample(), { demo: true });
  const shot = await addShot(ctx, 't_02', png());
  assert.equal(shotsOf(store, 't_02')[0].id, shot.id);
  assert.deepEqual(db.calls, []);
});

// ---------- deleteShot 和撤销 ----------

test('deleteShot：去掉元数据、删两个文件；撤销同步放回原位，文件原样写回（含 uploaded）', async () => {
  const { store, db, ctx } = setup();
  const a = await addShot(ctx, 't_open', png());
  const b = await addShot(ctx, 't_open', png());
  const c = await addShot(ctx, 't_open', png());
  const recB = { ...db.files.get(b.file), uploaded: true }; // 假装 b 已经传到云端
  db.files.set(b.file, recB);
  const thumbB = db.files.get(b.thumb);
  db.calls.length = 0;

  const undo = await deleteShot(ctx, 't_open', b.id);
  assert.equal(typeof undo, 'function');
  assert.deepEqual(ids(shotsOf(store, 't_open')), [a.id, c.id]);
  assert.equal(db.files.has(b.file), false);
  assert.equal(db.files.has(b.thumb), false);
  assert.ok(db.files.has(a.file) && db.files.has(a.thumb) && db.files.has(c.file) && db.files.has(c.thumb), '别的截图不动');
  assert.deepEqual(db.calls, [['get', b.file], ['get', b.thumb], ['delete', b.file], ['delete', b.thumb]], '先读出来留着，再删');

  let fileThereOnRefresh = null;
  const off = store.subscribe(() => { fileThereOnRefresh = db.files.has(b.file) && db.files.has(b.thumb); });
  assert.equal(undo(), true, '撤销是同步的，可以直接交给 toast');
  off();
  assert.equal(fileThereOnRefresh, true, '放回元数据（界面刷新）时，写回文件的请求已经发出');
  assert.deepEqual(ids(shotsOf(store, 't_open')), [a.id, b.id, c.id], '回到原来的位置');
  assert.deepEqual(shotsOf(store, 't_open')[1], b);
  assert.equal(db.files.get(b.file), recB, '文件记录原样放回（uploaded 还是 true）');
  assert.equal(db.files.get(b.thumb), thumbB);
  assert.equal(await undo.done, true);
  assert.equal(undo(), false, '只能撤销一次');
  assert.deepEqual(validateJournal(store.get().journal), []);
});

test('deleteShot：找不到、不在这一笔、只读时返回 null，什么都不动', async () => {
  const { store, db, ctx } = setup();
  const a = await addShot(ctx, 't_open', png());
  db.calls.length = 0;
  assert.equal(await deleteShot(ctx, 't_open', 'sh_nope'), null);
  assert.equal(await deleteShot(ctx, 't_done', a.id), null);
  assert.equal(await deleteShot(ctx, 't_nope', a.id), null);
  store.actions.setReadOnly('other-tab');
  assert.equal(await deleteShot(ctx, 't_open', a.id), null);
  assert.deepEqual(ids(shotsOf(store, 't_open')), [a.id]);
  assert.deepEqual(db.calls.filter((c) => c[0] !== 'get'), []);
  assert.equal(db.files.size, 2);
});

test('撤销删除截图：这一笔不在了、只读、进了示例模式时返回 false 且不写文件；条件恢复后还能撤销', async () => {
  const { store, db, ctx } = setup();
  const a = await addShot(ctx, 't_open', png());
  const undo = await deleteShot(ctx, 't_open', a.id);
  const undoTrade = store.actions.deleteTrade('t_open');
  db.calls.length = 0;
  assert.equal(undo(), false, '这一笔已经删掉');
  assert.deepEqual(db.calls, []);
  undoTrade();
  assert.equal(undo(), true, '这一笔撤销回来以后，截图也能撤销回来');
  assert.deepEqual(ids(shotsOf(store, 't_open')), [a.id]);

  const b = await addShot(ctx, 't_done', png());
  const undoB = await deleteShot(ctx, 't_done', b.id);
  store.actions.setReadOnly('other-tab');
  assert.equal(undoB(), false, '只读');
  store.actions.setReadOnly(null);
  store.actions.replaceJournal(sample(), { demo: true });
  assert.equal(undoB(), false, '示例模式下不往真实数据里撤销');
  store.actions.exitDemo();
  assert.equal(undoB(), true);
  assert.ok(db.files.has(b.file) && db.files.has(b.thumb));
});

test('deleteShot：文件不在本机（从别处的备份恢复的）也能删，撤销只放回元数据，缩略图给 null', async () => {
  const j = journal();
  const far = { id: 'sh_far', label: 'open', file: 'shots/t_open/sh_far.webp', thumb: 'shots/t_open/sh_far.thumb.webp', width: 1920, height: 1080, bytes: 5, addedAt: '2026-09-01T00:00:00Z' };
  j.rows[1].shots = [far];
  const { store, db, ctx } = setup({ j });
  const undo = await deleteShot(ctx, 't_open', 'sh_far');
  assert.deepEqual(shotsOf(store, 't_open'), []);
  assert.equal(undo(), true);
  assert.deepEqual(shotsOf(store, 't_open'), [far]);
  assert.equal(db.files.size, 0);
  const cache = createUrlCache({ store, db, URL: fakeUrl() });
  assert.equal(await cache.get(far.thumb), null, '文件不在本机：给 null，不报错');
});

test('deleteShot：别的截图还引用着同一个文件（导入的数据里可能有）时不删这个文件', async () => {
  const j = journal();
  const same = (id) => ({ id, label: '', file: 'shots/t_open/sh_same.webp', thumb: 'shots/t_open/sh_same.thumb.webp' });
  j.rows[1].shots = [same('sh_one'), same('sh_two')];
  const db = fakeDb();
  db.files.set('shots/t_open/sh_same.webp', { blob: new Blob(['x'], { type: 'image/webp' }), type: 'image/webp', bytes: 1, uploaded: true });
  const { store, ctx } = setup({ j, db });
  assert.equal(typeof await deleteShot(ctx, 't_open', 'sh_one'), 'function');
  assert.deepEqual(ids(shotsOf(store, 't_open')), ['sh_two']);
  assert.equal(db.files.has('shots/t_open/sh_same.webp'), true);
  assert.deepEqual(db.calls.filter((c) => c[0] === 'delete'), []);
});

test('deleteShot：示例模式下删的是内存里的文件，撤销也放回内存', async () => {
  const { store, db, ctx } = setup();
  store.actions.replaceJournal(sample(), { demo: true });
  const a = await addShot(ctx, 't_02', png());
  const undo = await deleteShot(ctx, 't_02', a.id);
  assert.deepEqual(shotsOf(store, 't_02'), []);
  assert.equal(await getShotBlob(ctx, a.file), null);
  assert.equal(undo(), true);
  assert.equal(await undo.done, true);
  assert.equal((await getShotBlob(ctx, a.file)).size, 1234);
  assert.equal((await getShotBlob(ctx, a.thumb)).size, 100);
  assert.deepEqual(db.calls.filter((c) => c[0] !== 'get'), [], '始终没写过本机存储');
});

test('撤销时文件写回失败：元数据照样放回，错误交给 ctx.onError，undo.done 兑现为 false', async () => {
  const { store, db, ctx, errors } = setup();
  const a = await addShot(ctx, 't_open', png());
  const undo = await deleteShot(ctx, 't_open', a.id);
  db.failPut = () => true;
  assert.equal(undo(), true);
  assert.equal(await undo.done, false);
  assert.equal(errors.length, 1, '报一次（两个文件里先失败的那个）');
  assert.match(errors[0].message, /空间不够/);
  assert.deepEqual(ids(shotsOf(store, 't_open')), [a.id]);
});

// ---------- setShotLabel ----------

test('normalizeLabel：开仓时/平仓后存成 open/close，空和"无"存空串，自己打的字去空白、截到 LABEL_MAX 个字', () => {
  assert.equal(normalizeLabel('开仓时'), 'open');
  assert.equal(normalizeLabel(' 平仓后 '), 'close');
  assert.equal(normalizeLabel('open'), 'open');
  assert.equal(normalizeLabel(''), '');
  assert.equal(normalizeLabel('   '), '');
  assert.equal(normalizeLabel('无'), '');
  assert.equal(normalizeLabel('  回踩  确认 '), '回踩 确认');
  assert.equal(normalizeLabel('加仓\u0000'), '加仓');
  assert.equal(normalizeLabel('字'.repeat(LABEL_MAX + 5)), '字'.repeat(LABEL_MAX));
  assert.equal(normalizeLabel('😀'.repeat(LABEL_MAX + 1)), '😀'.repeat(LABEL_MAX), '按字数截，不切坏表情');
  assert.equal(normalizeLabel(null), null);
  assert.equal(normalizeLabel(3), null);
});

test('setShotLabel：改标签、可以写自己的字；不是字符串、找不到、没变化、只读时返回 false；不认识的字段原样保留', async () => {
  const j = journal();
  j.rows[2].shots = [{ id: 'sh_k', label: 'open', file: 'shots/t_done/sh_k.webp', thumb: 'shots/t_done/sh_k.thumb.webp', future: { x: 1 } }];
  const { store, ctx } = setup({ j });
  const a = await addShot(ctx, 't_open', png());
  const events = [];
  store.subscribe((ev) => events.push(ev));

  assert.equal(setShotLabel(ctx, 't_open', a.id, 'close'), true);
  assert.equal(shotsOf(store, 't_open')[0].label, 'close');
  assert.deepEqual(Object.keys(shotsOf(store, 't_open')[0]), SHOT_KEYS, '字段顺序不变');
  assert.deepEqual(events.map((e) => [e.type, e.ids, e.fields]), [['row', ['t_open'], ['shots']]]);
  assert.equal(setShotLabel(ctx, 't_open', a.id, nextLabel('close')), true);
  assert.equal(shotsOf(store, 't_open')[0].label, '');
  assert.equal(setShotLabel(ctx, 't_open', a.id, ''), false, '没变化');
  assert.equal(setShotLabel(ctx, 't_open', a.id, '无'), false, '"无"就是空标签，没变化');
  assert.equal(setShotLabel(ctx, 't_open', a.id, ' 第二次加仓 '), true);
  assert.equal(shotsOf(store, 't_open')[0].label, '第二次加仓');
  assert.equal(setShotLabel(ctx, 't_open', a.id, '开仓时'), true);
  assert.equal(shotsOf(store, 't_open')[0].label, 'open', '打"开仓时"存回 open');
  assert.equal(setShotLabel(ctx, 't_open', a.id, ''), true);
  assert.equal(setShotLabel(ctx, 't_open', a.id, null), false);
  assert.equal(setShotLabel(ctx, 't_open', 'sh_nope', 'open'), false);
  assert.equal(setShotLabel(ctx, 't_nope', a.id, 'open'), false);

  assert.equal(setShotLabel(ctx, 't_done', 'sh_k', 'close'), true);
  assert.deepEqual(shotsOf(store, 't_done')[0], { id: 'sh_k', label: 'close', file: 'shots/t_done/sh_k.webp', thumb: 'shots/t_done/sh_k.thumb.webp', future: { x: 1 } });

  store.actions.setReadOnly('other-tab');
  assert.equal(setShotLabel(ctx, 't_open', a.id, 'open'), false);
  assert.equal(shotsOf(store, 't_open')[0].label, '');
  assert.throws(() => setShotLabel(null, 't_open', a.id, 'open'), TypeError);
  assert.deepEqual(validateJournal(store.get().journal), []);
});

// ---------- Blob 地址缓存 ----------

test('createUrlCache：同一路径只建一个地址；release 时 revoke；releaseAll 全部 revoke，一个不漏', async () => {
  const { ctx } = setup();
  const a = await addShot(ctx, 't_open', png());
  const b = await addShot(ctx, 't_open', png());
  const url = fakeUrl();
  const cache = createUrlCache({ ...ctx, URL: url });

  const [u1, u1again] = await Promise.all([cache.get(a.thumb), cache.get(a.thumb)]);
  assert.equal(u1, u1again, '同时要同一个路径：只建一个地址');
  assert.equal(url.log.created, 1);
  assert.equal(await cache.get(a.thumb), u1, '再要还是同一个');
  assert.equal(cache.peek(a.thumb), u1);
  assert.equal(url.live.get(u1).type, 'image/webp', 'Blob 带着类型');
  const u2 = await cache.get(b.file);
  assert.equal(url.live.get(u2).size, 1234);
  assert.equal(cache.size(), 2);

  assert.equal(cache.release(a.thumb), true);
  assert.deepEqual(url.log.revoked, [u1]);
  assert.equal(cache.peek(a.thumb), null);
  assert.equal(cache.release(a.thumb), false, '已经释放过');
  assert.equal(cache.release('shots/never'), false);
  const u3 = await cache.get(a.thumb);
  assert.notEqual(u3, u1, '释放以后再要：新建一个');

  cache.releaseAll();
  assert.deepEqual(url.log.revoked.slice().sort(), [u1, u2, u3].sort());
  assert.equal(url.live.size, 0, '建过的地址全都 revoke 了');
  assert.equal(cache.size(), 0);
  cache.releaseAll();
  assert.equal(url.log.revoked.length, 3, '重复 releaseAll 不会重复 revoke');
});

test('createUrlCache：还在读的时候 release：读完不建地址、给 null；文件不在本机给 null 且不记住；读出错也给 null', async () => {
  const { store, db, ctx } = setup();
  const a = await addShot(ctx, 't_open', png());
  const url = fakeUrl();
  const cache = createUrlCache({ ...ctx, URL: url });

  const p = cache.get(a.thumb);
  assert.equal(cache.release(a.thumb), true);
  assert.equal(await p, null);
  const p2 = cache.get(a.file);
  cache.releaseAll();
  assert.equal(await p2, null);
  assert.equal(url.log.created, 0, '释放了的不再建地址，不会漏');
  assert.equal(cache.size(), 0);

  const gone = 'shots/t_open/sh_gone.webp';
  assert.equal(await cache.get(gone), null, '文件不在本机');
  assert.equal(cache.size(), 0, '不记住，免得以后文件有了还给 null');
  db.files.set(gone, { blob: new Blob(['x'], { type: 'image/webp' }), type: 'image/webp', bytes: 1, uploaded: true });
  assert.match(await cache.get(gone), /^blob:fake\//, '文件有了（例如以后从云端同步下来）就能拿到');
  assert.equal(await cache.get(''), null);
  assert.equal(await cache.get(undefined), null);

  const broken = createUrlCache({ store, db: { getFile: () => Promise.reject(new Error('CLOSED')) }, URL: url });
  assert.equal(await broken.get(a.thumb), null);
  assert.equal(broken.size(), 0);
  cache.releaseAll();
  assert.equal(url.live.size, 0);
  assert.throws(() => createUrlCache({ db }), TypeError);
});

test('getShotBlob / createUrlCache：Blob 没类型时用记录的 type 补上；存的是 ArrayBuffer 时按 type 重建（9.4 第 14 条）', async () => {
  const { store, db } = setup();
  db.files.set('p/untyped', { blob: new Blob([new Uint8Array([1, 2, 3])]), type: 'image/webp' });
  db.files.set('p/buffer', { blob: new Uint8Array([1, 2, 3, 4]).buffer, type: 'image/jpeg' });
  db.files.set('p/view', { blob: new Uint8Array([1, 2]), type: 'image/jpeg' });
  db.files.set('p/junk', { blob: '不是文件', type: 'image/webp' });
  const ctx = { store, db };
  const a = await getShotBlob(ctx, 'p/untyped');
  assert.deepEqual([a.type, a.size], ['image/webp', 3]);
  const b = await getShotBlob(ctx, 'p/buffer');
  assert.deepEqual([b.type, b.size], ['image/jpeg', 4]);
  const v = await getShotBlob(ctx, 'p/view');
  assert.deepEqual([v.type, v.size], ['image/jpeg', 2]);
  assert.equal(await getShotBlob(ctx, 'p/junk'), null);
  assert.equal(await getShotBlob(ctx, 'p/none'), null);
  assert.equal(await getShotBlob(ctx, ''), null);

  const url = fakeUrl();
  const cache = createUrlCache({ store, db, URL: url });
  const u = await cache.get('p/buffer');
  assert.equal(url.live.get(u).type, 'image/jpeg');
  assert.equal(await cache.get('p/junk'), null);
  cache.releaseAll();
  assert.equal(url.live.size, 0);
});

// ---------- 接上真的 localdb ----------

test('接上真的本机存储（假 IndexedDB 和内存降级）：Blob 带类型存取，删了再撤销能读回来；不可写时加图失败、不留元数据', async () => {
  for (const indexedDB of [createFakeIndexedDB(), null]) {
    const db = await openLocalDb({ indexedDB, lifecycle: null, visibility: null });
    const store = createStore(journal(), { now: NOW });
    const ctx = { store, db, processImage: fakeProcess(), now: NOW };
    const shot = await addShot(ctx, 't_open', png());

    const rec = await db.getFile(shot.file);
    assert.equal(rec.uploaded, false, db.kind);
    assert.equal(rec.type, 'image/webp');
    assert.ok(rec.blob instanceof Blob);
    assert.deepEqual([rec.blob.type, rec.blob.size], ['image/webp', 1234]);
    assert.deepEqual((await db.listFiles()).sort(), [shot.file, shot.thumb].sort());

    const url = fakeUrl();
    const cache = createUrlCache({ ...ctx, URL: url });
    assert.match(await cache.get(shot.thumb), /^blob:fake\//);

    const undo = await deleteShot(ctx, 't_open', shot.id);
    assert.deepEqual(await db.listFiles(), []);
    assert.equal(undo(), true);
    assert.equal(await undo.done, true);
    assert.deepEqual((await db.listFiles()).sort(), [shot.file, shot.thumb].sort());
    assert.equal((await getShotBlob(ctx, shot.file)).size, 1234);
    cache.releaseAll();
    assert.equal(url.live.size, 0);

    db.setWritable(false); // 例如数据库被新版本网站关掉、本页还没变只读
    await assert.rejects(addShot(ctx, 't_open', png()), (e) => e.name === 'StorageError' && e.code === 'READ_ONLY');
    assert.deepEqual(ids(shotsOf(store, 't_open')), [shot.id], '写不进文件就不加元数据');
    await db.close();
  }
});
