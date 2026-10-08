// 截图的增删改，和显示截图用的 Blob 地址（交接文档 7.7、7.8）。表格和详情只通过这里存取截图，不直接碰 IndexedDB。
//
// ctx = { store, db, demo? }
//   store：createStore 的返回值。截图的元数据（第 5 节的 shots[]：id、label、file、thumb、width、height、bytes、addedAt）
//          只通过 store.actions.updateTrade(tradeId, { shots }) 写进交易。
//   db：openLocalDb 的返回值。截图文件存在 files 仓库，键是路径，记录是
//       { blob, type, bytes, uploaded: false, addedAt }（uploaded 留给第 3 步同步：传到云端后改成 true）。
//   示例模式（7.13）以 store.get().ui.demo 为准：这时截图文件只放在内存里，不写 IndexedDB。
//       内存里的文件按 store 各存一份，整份换数据（进出示例、恢复备份）时自动清空。ctx.demo 可以不传，
//       传了布尔值或函数也只在 store 没有 ui 状态时才用；表格和详情各自建的 ctx 看到的是同一份内存文件。
//   另外可以传（测试用为主）：processImage（代替 images.js 的压缩）、imageOptions（传给 processImage）、
//       now（() => Date，addedAt 用）、onError（撤销时写回文件失败这类后台错误）、URL（给 createUrlCache 换掉
//       URL.createObjectURL / URL.revokeObjectURL）。
//
// 文件和元数据的先后：加图先写文件、再写元数据；删图先删元数据、再删文件；撤销先发出写回文件的请求、再放回元数据。
// 任何一步中断，最多留下没被引用的文件（不碍事），不会出现引用了却没有文件的截图（导入别处的备份时除外，
// 那时缩略图位置显示"文件不在本机"）。删除交易时它的截图文件留着（7.6：V1 不做清理），撤销删除照常显示。
//
// createUrlCache(ctx)：路径 → Blob 地址（blob:…）。同一个路径只建一个地址，release / releaseAll 时立刻 revoke。
//   release 不数次数：几处界面共用一个缓存时（表格和详情都显示同一张缩略图），要由共用的一层数着、都不用了才 release
//   （ui/sheet.js 的 shotUrls 就是这样做的）；只有一处用时，哪个路径不再显示就 release 它。卸载时 releaseAll。

import { processImage as defaultProcessImage } from './images.js';
import { deriveTrade } from './calc.js';
import { cleanText, isoNow, newId } from './model.js';

/** 截图标签的三种固定取值（第 5 节）：开仓时、平仓后、不显示。也可以是用户自己打的字（normalizeLabel） */
export const LABELS = Object.freeze(['open', 'close', '']);
/** 自己打的标签最多几个字（缩略图下面一行放得下） */
export const LABEL_MAX = 20;
/** 标签在界面上的文字（详情里缩略图下方；空标签显示"无"） */
export const LABEL_TEXT = Object.freeze({ open: '开仓时', close: '平仓后', '': '无' });

/**
 * 用户在标签上打的字 → 存进 shots[].label 的值：去掉首尾空白、连续空白并成一个、最多 LABEL_MAX 个字；
 * 打"开仓时"存 'open'、"平仓后"存 'close'，空着或打"无"存 ''，其余原样存。不是字符串返回 null。
 */
export function normalizeLabel(text) {
  if (typeof text !== 'string') return null;
  const t = Array.from(cleanText(text).replace(/\s+/g, ' ').trim()).slice(0, LABEL_MAX).join('').trim();
  if (t === '' || t === '无') return '';
  if (t === 'open' || t === LABEL_TEXT.open) return 'open';
  if (t === 'close' || t === LABEL_TEXT.close) return 'close';
  return t;
}

/** 点标签时的下一个：开仓时 → 平仓后 → 无 → 开仓时 */
export function nextLabel(label) {
  return LABELS[(LABELS.indexOf(label) + 1) % LABELS.length];
}

/**
 * 截图操作的错误，message 可以直接给用户看。code：
 * 'READ_ONLY' 现在只能看；'NO_TRADE' 这一笔不在了（或处理期间切换了示例数据）；'NO_DB' 本机存储没准备好；
 * 'BAD_IMAGE' 压缩结果不对。压缩本身的错误是 images.js 的 ImageError，存储的错误是 localdb.js 的 StorageError。
 */
export class ShotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShotError';
    this.code = code;
  }
}

/**
 * 新截图的默认标签（7.8）：这一笔还没出场是 'open'（开仓时），已出场是 'close'（平仓后）。
 * @param {object} derived 单笔的派生值（calc.js deriveTrade 的结果，看 outcome）；
 *   也可以传 store 里 derived.tradeById 的一项 { t, d }，或者交易行本身（按 result、pnlOverride 现算）
 * @returns {'open'|'close'}
 */
export function defaultLabel(derived) {
  if (!derived || typeof derived !== 'object') return 'open';
  const d = derived.d && typeof derived.d === 'object' ? derived.d : derived;
  if (typeof d.outcome === 'string') return d.outcome === 'open' ? 'open' : 'close';
  if ('result' in d || 'pnlOverride' in d) return deriveTrade(d).outcome === 'open' ? 'open' : 'close';
  return 'open';
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const EXTS = new Map([['webp', 'webp'], ['jpg', 'jpg'], ['jpeg', 'jpg']]);

/**
 * 截图和缩略图的路径（7.8 第 5 步），也是 files 仓库的键和以后云端桶里的相对路径：
 * shots/<交易 id>/<截图 id>.webp 和 shots/<交易 id>/<截图 id>.thumb.webp；JPEG 时扩展名是 .jpg。
 * @param {string} tradeId 't_' 开头
 * @param {string} shotId 'sh_' 开头
 * @param {'webp'|'jpg'} ext 'jpeg' 也认，当成 'jpg'
 * @returns {{file: string, thumb: string}}
 */
export function shotPaths(tradeId, shotId, ext) {
  if (typeof tradeId !== 'string' || !tradeId.startsWith('t_') || !SAFE_ID.test(tradeId)) {
    throw new TypeError(`交易 id 不对：${tradeId}`);
  }
  if (typeof shotId !== 'string' || !shotId.startsWith('sh_') || !SAFE_ID.test(shotId)) {
    throw new TypeError(`截图 id 不对：${shotId}`);
  }
  const e = typeof ext === 'string' ? EXTS.get(ext.toLowerCase()) : undefined;
  if (!e) throw new TypeError(`截图的扩展名只能是 webp 或 jpg：${ext}`);
  const base = `shots/${tradeId}/${shotId}`;
  return { file: `${base}.${e}`, thumb: `${base}.thumb.${e}` };
}

// ---------- 上下文和小工具 ----------

/** store → Map(路径 → 文件记录)：示例模式的截图文件只在内存里 */
const demoFiles = new WeakMap();

function memoryFiles(store) {
  let files = demoFiles.get(store);
  if (!files) {
    files = new Map();
    demoFiles.set(store, files);
    if (typeof store.subscribe === 'function') {
      // 进出示例模式、恢复备份：整份数据换了，内存里的示例截图再也用不上
      store.subscribe((ev) => { if (ev && ev.type === 'journal') files.clear(); });
    }
  }
  return files;
}

function context(ctx) {
  if (!ctx || !ctx.store || typeof ctx.store.get !== 'function') {
    throw new TypeError('截图操作需要 ctx.store（createStore 的返回值）');
  }
  return {
    store: ctx.store,
    db: ctx.db || null,
    demoFlag: ctx.demo,
    mem: memoryFiles(ctx.store),
    process: typeof ctx.processImage === 'function' ? ctx.processImage : defaultProcessImage,
    imageOptions: ctx.imageOptions,
    now: typeof ctx.now === 'function' ? ctx.now : () => new Date(),
    onError: typeof ctx.onError === 'function' ? ctx.onError : null,
    fetchRemote: typeof ctx.fetchRemote === 'function' ? ctx.fetchRemote : null,
  };
}

function isDemo(c) {
  const st = c.store.get();
  if (st && st.ui && typeof st.ui.demo === 'boolean') return st.ui.demo;
  return typeof c.demoFlag === 'function' ? !!c.demoFlag() : c.demoFlag === true;
}

const canEdit = (c) => (typeof c.store.canEdit === 'function' ? !!c.store.canEdit() : true);
const shotsOf = (row) => (row && Array.isArray(row.shots) ? row.shots : []);

function findTrade(c, id) {
  for (const row of c.store.get().journal.rows) {
    if (row.type === 'trade' && row.id === id) return row;
  }
  return null;
}

/** 数据里已经用掉的 id（行和截图），新截图 id 不能和它们重复（validateJournal 要求全局唯一） */
function takenIds(c) {
  const taken = new Set();
  for (const row of c.store.get().journal.rows) {
    taken.add(row.id);
    for (const s of shotsOf(row)) if (s && typeof s.id === 'string') taken.add(s.id);
  }
  return taken;
}

/** 数据里所有截图引用着的文件路径 */
function referencedPaths(c) {
  const used = new Set();
  for (const row of c.store.get().journal.rows) {
    for (const s of shotsOf(row)) for (const p of filePaths(s)) used.add(p);
  }
  return used;
}

function filePaths(shot) {
  const out = [];
  for (const p of [shot && shot.file, shot && shot.thumb]) {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  }
  return out;
}

const isBlobLike = (v) => !!v && typeof v === 'object' && typeof v.size === 'number' && typeof v.type === 'string';
const isSize = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function readOnlyError() {
  return new ShotError('READ_ONLY', '现在只能看、不能改，截图没有保存');
}

function needDb(c) {
  if (!c.db || (typeof c.db.putFiles !== 'function' && typeof c.db.putFile !== 'function')) {
    throw new ShotError('NO_DB', '本机存储还没准备好，截图没有保存');
  }
  return c.db;
}

/** 同步调用 fn（IndexedDB 的请求要在这一刻发出），把同步抛的错也变成失败的 Promise */
function callNow(fn) {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

function report(c, err) {
  if (c.onError) {
    try { c.onError(err); } catch (e) { /* 报错的回调自己出错就算了 */ }
  } else if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(err);
  } else {
    console.error(err);
  }
}

// ---------- 文件记录的读写（IndexedDB 或示例模式的内存） ----------
// 本机存储有 putFiles / deleteFiles（localdb.js）时，大图和缩略图在一个事务里一起写、一起删；
// 只有 putFile / deleteFile 的存储一个一个来。

/** 写入几条文件记录：要么都写进去，要么出错时一条不留（已经写进去的删掉），再把错误抛出去 */
async function putRecords(c, demo, entries) {
  if (demo) {
    for (const [path, rec] of entries) c.mem.set(path, rec);
    return;
  }
  const db = needDb(c);
  if (typeof db.putFiles === 'function') {
    await db.putFiles(entries);
    return;
  }
  const written = [];
  try {
    for (const [path, rec] of entries) {
      await db.putFile(path, rec);
      written.push(path);
    }
  } catch (err) {
    await removeRecords(c, false, written);
    throw err;
  }
}

/** 删掉几条文件记录；删不掉就留着（只读、库被关掉等；没被引用的文件不碍事） */
async function removeRecords(c, demo, paths) {
  if (!paths.length) return;
  if (demo) {
    for (const path of paths) c.mem.delete(path);
    return;
  }
  if (!c.db) return;
  if (typeof c.db.deleteFiles === 'function') {
    try { await c.db.deleteFiles(paths); } catch (err) { /* 留着 */ }
    return;
  }
  for (const path of paths) {
    try { await c.db.deleteFile(path); } catch (err) { /* 留着 */ }
  }
}

/**
 * 撤销删除时写回文件记录。写入请求在这里同步发出：IndexedDB 按请求的先后执行事务，
 * 之后界面再读这些文件（放回元数据会触发刷新）一定读得到。
 */
function writeBack(c, demo, entries) {
  if (demo) {
    for (const [path, rec] of entries) c.mem.set(path, rec);
    return Promise.resolve();
  }
  if (!entries.length) return Promise.resolve();
  if (c.db && typeof c.db.putFiles === 'function') return callNow(() => c.db.putFiles(entries));
  return Promise.all(entries.map(([path, rec]) => callNow(() => c.db.putFile(path, rec))));
}

/** 读一条文件记录：先看内存（示例模式），再看 IndexedDB；没有返回 null */
async function readRecord(c, path) {
  if (c.mem.has(path)) return c.mem.get(path);
  if (!c.db || typeof c.db.getFile !== 'function') return null;
  const rec = await c.db.getFile(path);
  return rec || null;
}

/**
 * 本机没有的截图：登录了就从云端桶里取（ctx.fetchRemote，由同步模块下载并存进 IndexedDB，7.8）。
 * 示例模式不取。取不到返回 null。
 */
async function readOrFetch(c, path) {
  const rec = await readRecord(c, path);
  if (rec || !c.fetchRemote || isDemo(c)) return rec;
  try {
    const blob = await c.fetchRemote(path);
    return blob ? { blob, type: blob.type } : null;
  } catch (err) {
    return null;
  }
}

/** 记录里的 Blob。类型丢了用记录里的 type 补上；存的是 ArrayBuffer 时按 type 重建（9.4 第 14 条） */
function recordBlob(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const b = rec.blob;
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (typeof Blob === 'function' && b instanceof Blob) return b.type || !type ? b : new Blob([b], { type });
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new Blob([b], { type });
  return null;
}

// ---------- 对外的操作 ----------

/**
 * 给一笔交易加一张截图（粘贴、选文件、拖放都走这里）：压缩（images.js）→ 写两个文件（大图、缩略图）→
 * 把元数据加到这一笔 shots 的末尾。示例模式下文件只放内存。
 * @param {object} ctx 见文件开头
 * @param {string} tradeId
 * @param {Blob} blob 图片
 * @param {'open'|'close'|''} [label] 不传（或不认识）时按 defaultLabel：没出场"开仓时"、已出场"平仓后"
 * @returns {Promise<object>} 加进去的那条截图元数据
 *   出错时抛 ShotError（只读、这一笔不在了）、ImageError（图片读不出、压不下来）或 StorageError（存储空间不够等），
 *   这些错误的 message 都可以直接显示给用户；出错时不会留下元数据，已经写的文件会删掉。
 */
export async function addShot(ctx, tradeId, blob, label) {
  const c = context(ctx);
  if (!canEdit(c)) throw readOnlyError();
  if (!findTrade(c, tradeId)) throw new ShotError('NO_TRADE', '找不到这一笔交易，截图没有保存');
  const demo = isDemo(c);
  if (!demo) needDb(c);

  const img = await c.process(blob, c.imageOptions);
  if (!img || !isBlobLike(img.file) || !isBlobLike(img.thumb) || !isSize(img.width) || !isSize(img.height)
    || !isSize(img.bytes) || !EXTS.has(img.ext)) {
    throw new ShotError('BAD_IMAGE', '截图压缩的结果不对，没有保存');
  }

  // 压缩要一会儿：这期间这一笔可能被删掉、进出了示例模式、或者变成只读
  const stillOk = () => {
    if (isDemo(c) !== demo) throw new ShotError('NO_TRADE', '处理截图的时候切换了示例数据，截图没有保存');
    if (!canEdit(c)) throw readOnlyError();
    if (!findTrade(c, tradeId)) throw new ShotError('NO_TRADE', '这一笔已经删掉了，截图没有保存');
  };
  stillOk();

  const id = newId('sh_', takenIds(c));
  const paths = shotPaths(tradeId, id, img.ext);
  const addedAt = isoNow(c.now());
  const type = typeof img.type === 'string' && img.type ? img.type : img.file.type;
  await putRecords(c, demo, [
    [paths.file, { blob: img.file, type: img.file.type || type, bytes: img.file.size, uploaded: false, addedAt }],
    [paths.thumb, { blob: img.thumb, type: img.thumb.type || type, bytes: img.thumb.size, uploaded: false, addedAt }],
  ]);

  try {
    stillOk();
    const trade = findTrade(c, tradeId);
    const shot = {
      id,
      label: LABELS.includes(label) ? label : defaultLabel(deriveTrade(trade)),
      file: paths.file,
      thumb: paths.thumb,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
      addedAt,
    };
    if (!c.store.actions.updateTrade(tradeId, { shots: [...shotsOf(trade), shot] })) {
      throw new ShotError('NO_TRADE', '这一笔现在改不了，截图没有保存');
    }
    return shot;
  } catch (err) {
    await removeRecords(c, demo, [paths.file, paths.thumb]);
    throw err;
  }
}

/**
 * 删除一张截图：先从这一笔的 shots 里去掉，再删两个文件（别的截图还引用着的文件不删）。
 * 删之前把文件记录读出来留在撤销函数里。
 * @returns {Promise<null | ((() => boolean) & {done: Promise<boolean>})>}
 *   没删成（只读、找不到）返回 null；删成了返回撤销函数 undo：
 *   undo() 同步返回是否放回去了（这一笔已经不在、已经撤销过、整份数据换过、只读时返回 false），可以直接交给
 *   toast 的 undo；文件和元数据都放回原样（包括 uploaded 标记），截图回到原来的位置。
 *   文件写回是异步的，undo.done 在写完后兑现为 true（写失败兑现为 false，错误交给 ctx.onError）。
 */
export async function deleteShot(ctx, tradeId, shotId) {
  const c = context(ctx);
  if (!canEdit(c)) return null;
  const demo = isDemo(c);
  const before = shotsOf(findTrade(c, tradeId)).find((s) => s && s.id === shotId);
  if (!before) return null;

  // 先把文件记录读出来留着，撤销时原样放回
  const saved = [];
  for (const path of filePaths(before)) {
    let rec = null;
    try {
      rec = await readRecord(c, path);
    } catch (err) {
      rec = null; // 读不出来就当本机没有：撤销时只放回元数据
    }
    if (rec) saved.push([path, rec]);
  }

  // 读文件的这段时间里数据可能变了：按现在的数据再找一遍
  if (!canEdit(c) || isDemo(c) !== demo) return null;
  const list = shotsOf(findTrade(c, tradeId));
  const index = list.findIndex((s) => s && s.id === shotId);
  if (index < 0) return null;
  const shot = list[index];
  if (!c.store.actions.updateTrade(tradeId, { shots: list.filter((s, i) => i !== index) })) return null;

  const stillUsed = referencedPaths(c);
  await removeRecords(c, demo, filePaths(shot).filter((p) => !stillUsed.has(p)));
  return makeUndo(c, { tradeId, shot, index, demo, saved });
}

function makeUndo(c, { tradeId, shot, index, demo, saved }) {
  let used = false;
  const undo = () => {
    if (used || !canEdit(c) || isDemo(c) !== demo) return false;
    const trade = findTrade(c, tradeId);
    if (!trade || takenIds(c).has(shot.id)) return false;
    used = true;
    const writing = writeBack(c, demo, saved); // 先发出写文件的请求，再放回元数据
    const list = shotsOf(trade).slice();
    list.splice(Math.min(index, list.length), 0, shot);
    const ok = c.store.actions.updateTrade(tradeId, { shots: list });
    undo.done = writing.then(() => ok, (err) => {
      report(c, err);
      return false;
    });
    return ok;
  };
  undo.done = Promise.resolve(false);
  return undo;
}

/**
 * 改一张截图的标签：'open'、'close'、''，或者用户打的字（先过 normalizeLabel，"开仓时"会存成 'open'）。
 * @returns {boolean} 改了返回 true；不是字符串、找不到、没变化、只读时返回 false
 */
export function setShotLabel(ctx, tradeId, shotId, text) {
  const c = context(ctx);
  const label = normalizeLabel(text);
  if (label === null || !canEdit(c)) return false;
  const trade = findTrade(c, tradeId);
  const list = shotsOf(trade);
  const i = list.findIndex((s) => s && s.id === shotId);
  if (i < 0 || list[i].label === label) return false;
  const next = list.slice();
  next[i] = { ...list[i], label };
  return c.store.actions.updateTrade(tradeId, { shots: next });
}

/**
 * 取一个截图文件的 Blob（例如"在新标签页打开原图"要自己管地址时）。文件不在本机返回 null。
 * @param {object} ctx
 * @param {string} path shots[].file 或 shots[].thumb
 * @returns {Promise<Blob|null>}
 */
export async function getShotBlob(ctx, path) {
  const c = context(ctx);
  if (typeof path !== 'string' || !path) return null;
  return recordBlob(await readOrFetch(c, path));
}

/**
 * Blob 地址的缓存（7.8：不再显示的 Blob 地址要释放）。
 * - get(path)：Promise<string|null>。同一个路径只建一次地址，之后直接给同一个；文件不在本机（例如从别处的
 *   journal.json 恢复的数据）或读不出来时给 null，不报错，也不记住（以后文件有了再 get 就能拿到）。
 * - peek(path)：已经建好的地址，没有返回 null（同步，重画时免得闪一下）。
 * - release(path)：revoke 这个路径的地址并忘掉它（不数次数，见文件开头）；还在读的时候 release，读完也不会再建地址（get 给 null）。
 * - releaseAll()：全部 revoke。
 * - size()：现在记着几个路径（测试用）。
 * @param {object} ctx 见文件开头；ctx.URL 可以换掉 createObjectURL / revokeObjectURL
 */
export function createUrlCache(ctx) {
  const c = context(ctx);
  const api = ctx.URL || globalThis.URL;
  const entries = new Map(); // 路径 → { url: string|null, promise }

  function get(path) {
    if (typeof path !== 'string' || !path) return Promise.resolve(null);
    const hit = entries.get(path);
    if (hit) return hit.promise;
    const entry = { url: null, promise: null };
    entries.set(path, entry);
    entry.promise = (async () => {
      let blob = null;
      try {
        blob = recordBlob(await readOrFetch(c, path));
      } catch (err) {
        blob = null;
      }
      if (entries.get(path) !== entry) return null; // 读的时候已经 release 了
      if (!blob) {
        entries.delete(path);
        return null;
      }
      entry.url = api.createObjectURL(blob);
      return entry.url;
    })();
    return entry.promise;
  }

  function release(path) {
    const entry = entries.get(path);
    if (!entry) return false;
    entries.delete(path);
    if (entry.url) api.revokeObjectURL(entry.url);
    return true;
  }

  return {
    get,
    peek(path) {
      const entry = entries.get(path);
      return entry && entry.url ? entry.url : null;
    },
    release,
    releaseAll() {
      for (const path of Array.from(entries.keys())) release(path);
    },
    size: () => entries.size,
  };
}
