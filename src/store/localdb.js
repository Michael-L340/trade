// 本机存储（IndexedDB）和多标签页协调。不碰 DOM（只监听页面的 pagehide / visibilitychange 事件）。
//
// - 库名 trade-journal，三个对象仓库：journal（整份数据，键 'current'）、meta（键值）、files（截图，键是路径）。
// - saveJournal 去抖 300 ms（连续修改时最长 2 秒一定写一次），页面 pagehide 或切到后台时立刻写。
// - 写入前在同一个事务里检查已存数据的 schemaVersion，比本网站新就拒绝写入（不覆盖新版本的数据）。
// - 没有 IndexedDB（或打不开）时降级为只在内存里，kind 为 'memory'，界面应提示"刷新会丢失"。
// - 多标签页：claimWriter 用 Web Locks 选出唯一写者，拿不到锁的标签页只读；
//   connectStore 把 store 接到存储上：自动保存、存完通知其他标签页（BroadcastChannel）重读、
//   前一个写者关掉后自动接手。
// - localStorage 只放设置：getPref / setPref / removePref，键名一律加 tj_ 前缀，从不调用 localStorage.clear()。

import { SCHEMA_VERSION } from '../model.js';

export const DB_NAME = 'tj-journal';
export const DB_VERSION = 1;
export const STORES = Object.freeze({ journal: 'journal', meta: 'meta', files: 'files', base: 'base', conflicts: 'conflicts' });
export const JOURNAL_KEY = 'current';
export const SAVE_DELAY_MS = 300;
export const SAVE_MAX_WAIT_MS = 2000;
export const LOCK_NAME = 'trade-journal-writer';
export const CHANNEL_NAME = 'trade-journal';
export const PREF_PREFIX = 'tj_';

/**
 * 存储层的错误。code：
 * 'NEWER_SCHEMA' 已存的数据是更新版本的网站写的；'READ_ONLY' 这个标签页不是写者；
 * 'CLOSED' 数据库被新版本网站升级后关闭了，要刷新页面；'IDB' 其他 IndexedDB 错误（例如空间不足）。
 */
export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function idbError(err) {
  if (err instanceof StorageError) return err;
  const name = err && err.name ? err.name : 'Error';
  const msg = name === 'QuotaExceededError' ? '浏览器的存储空间不够了，没能保存' : '保存到浏览器失败（' + name + '）';
  return new StorageError('IDB', msg, err);
}

const newerSchemaError = (v) => new StorageError('NEWER_SCHEMA', `浏览器里的数据是更新版本的网站保存的（数据版本 ${v}），本页面不会覆盖它。请按 Ctrl+F5 刷新页面。`);

function isNewer(stored) {
  return !!stored && typeof stored.schemaVersion === 'number' && stored.schemaVersion > SCHEMA_VERSION;
}

// ---------- 后端：IndexedDB ----------

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openIdb(idb, name, { onVersionChange, onBlocked }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(name, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    req.onblocked = () => { if (onBlocked) onBlocked(); };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const backend = idbBackend(db);
      db.onversionchange = () => {
        // 新版本网站要升级数据库：关掉自己的连接让它升级，本页之后不能再写
        db.close();
        backend.closed = true;
        if (onVersionChange) onVersionChange();
      };
      resolve(backend);
    };
  });
}

function idbBackend(db) {
  const backend = {
    kind: 'indexeddb',
    closed: false,
    tx(store, mode) {
      if (backend.closed) throw new StorageError('CLOSED', '数据库已被新版本网站升级，请刷新页面');
      return db.transaction(store, mode);
    },
    async get(store, key) {
      return promisify(backend.tx(store, 'readonly').objectStore(store).get(key));
    },
    async keys(store) {
      return promisify(backend.tx(store, 'readonly').objectStore(store).getAllKeys());
    },
    put(store, key, value) {
      return backend.write(store, (os) => { os.put(value, key); });
    },
    /** 一个事务写多条：要么全写进去，要么一条都不写 */
    putMany(store, entries) {
      return backend.write(store, (os) => { for (const [key, value] of entries) os.put(value, key); });
    },
    delete(store, key) {
      return backend.write(store, (os) => { os.delete(key); });
    },
    deleteMany(store, keys) {
      return backend.write(store, (os) => { for (const key of keys) os.delete(key); });
    },
    write(store, fn) {
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = backend.tx(store, 'readwrite');
          fn(tx.objectStore(store));
        } catch (err) {
          try { if (tx) tx.abort(); } catch (e) { /* 已经结束 */ }
          reject(idbError(err));
          return;
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(idbError(tx.error));
        if (typeof tx.commit === 'function') tx.commit();
      });
    },
    /** 在一个事务里：读出已存数据，版本不比本网站新才写入。 */
    writeJournal(journal) {
      return new Promise((resolve, reject) => {
        let tx;
        let refused = null;
        try {
          tx = backend.tx(STORES.journal, 'readwrite');
        } catch (err) {
          reject(idbError(err));
          return;
        }
        const os = tx.objectStore(STORES.journal);
        const read = os.get(JOURNAL_KEY);
        read.onsuccess = () => {
          if (isNewer(read.result)) {
            refused = newerSchemaError(read.result.schemaVersion);
            tx.abort();
            return;
          }
          try {
            os.put(journal, JOURNAL_KEY);
            if (typeof tx.commit === 'function') tx.commit();
          } catch (err) {
            refused = idbError(err);
            try { tx.abort(); } catch (e) { /* 已经结束 */ }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(refused || idbError(tx.error));
      });
    },
    close() {
      backend.closed = true;
      db.close();
    },
  };
  return backend;
}

// ---------- 后端：只在内存（没有 IndexedDB 时） ----------

function memoryBackend() {
  const data = new Map(Object.values(STORES).map((s) => [s, new Map()]));
  const copy = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    kind: 'memory',
    async get(store, key) { return copy(data.get(store).get(key)); },
    async keys(store) { return Array.from(data.get(store).keys()); },
    async put(store, key, value) { data.get(store).set(key, copy(value)); },
    async putMany(store, entries) {
      const copies = entries.map(([key, value]) => [key, copy(value)]); // 先全部复制：有一条复制不了就都不写
      for (const [key, value] of copies) data.get(store).set(key, value);
    },
    async delete(store, key) { data.get(store).delete(key); },
    async deleteMany(store, keys) { for (const key of keys) data.get(store).delete(key); },
    async writeJournal(journal) {
      const stored = data.get(STORES.journal).get(JOURNAL_KEY);
      if (isNewer(stored)) throw newerSchemaError(stored.schemaVersion);
      data.get(STORES.journal).set(JOURNAL_KEY, copy(journal));
    },
    close() {},
  };
}

// ---------- 对外的本机存储对象 ----------

/**
 * 打开本机存储。
 * @param {object} [opts]
 * @param {IDBFactory|null} [opts.indexedDB] 默认用浏览器的 indexedDB；传 null 强制只用内存
 * @param {number} [opts.delay] 去抖时间，默认 300 ms
 * @param {number} [opts.maxWait] 连续修改时最长多久必须写一次，默认 2000 ms
 * @param {EventTarget} [opts.lifecycle] 监听 pagehide 的对象，默认 window
 * @param {object} [opts.visibility] 监听 visibilitychange 的对象（要有 visibilityState），默认 document
 * @param {() => void} [opts.onVersionChange] 新版本网站升级了数据库、本页不能再写时调用（提示刷新）
 * @param {() => void} [opts.onBlocked] 打开数据库被别的标签页挡住时调用（提示关掉其他标签页）
 * @returns {Promise<LocalDb>}
 */
export async function openLocalDb(opts = {}) {
  const idb = opts.indexedDB !== undefined ? opts.indexedDB : globalThis.indexedDB;
  let backend;
  let fallbackReason = null;
  if (!idb) {
    backend = memoryBackend();
    fallbackReason = '这个浏览器不支持 IndexedDB';
  } else {
    try {
      backend = await openIdb(idb, opts.name || DB_NAME, { onVersionChange: opts.onVersionChange, onBlocked: opts.onBlocked });
    } catch (err) {
      backend = memoryBackend();
      fallbackReason = '打不开浏览器的 IndexedDB（' + (err && err.name ? err.name : String(err)) + '）';
    }
  }
  return createLocalDb(backend, { ...opts, fallbackReason });
}

function createLocalDb(backend, opts) {
  const delay = opts.delay ?? SAVE_DELAY_MS;
  const maxWait = opts.maxWait ?? SAVE_MAX_WAIT_MS;
  let pending = null; // { journal, tag, waiters, firstAt }
  let timer = null;
  let chain = Promise.resolve();
  let writable = true;
  let closed = false;

  function guard() {
    if (closed) return new StorageError('CLOSED', '本机存储已经关闭');
    if (!writable) return new StorageError('READ_ONLY', '这个标签页是只读的（网站已在另一个标签页打开），不能保存');
    return null;
  }

  function flush() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending) {
      const batch = pending;
      pending = null;
      chain = chain
        .then(() => backend.writeJournal(batch.journal))
        .then(
          () => { for (const w of batch.waiters) w.resolve(batch.tag); },
          (err) => { const e = idbError(err); for (const w of batch.waiters) w.reject(e); },
        );
    }
    return chain;
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    const wait = Math.max(0, Math.min(delay, pending.firstAt + maxWait - Date.now()));
    timer = setTimeout(flush, wait);
  }

  // 页面关掉、刷新、切到后台时立刻写
  const lifecycle = opts.lifecycle !== undefined ? opts.lifecycle : globalThis;
  const visibility = opts.visibility !== undefined ? opts.visibility : globalThis.document;
  const onPageHide = () => { flush(); };
  const onVisibility = () => { if (visibility.visibilityState === 'hidden') flush(); };
  if (lifecycle && typeof lifecycle.addEventListener === 'function') lifecycle.addEventListener('pagehide', onPageHide);
  if (visibility && typeof visibility.addEventListener === 'function') visibility.addEventListener('visibilitychange', onVisibility);

  /** @typedef {ReturnType<typeof createLocalDb>} LocalDb */
  return {
    /** 'indexeddb' 或 'memory'（只在内存，刷新会丢失） */
    kind: backend.kind,
    /** 降级为内存的原因；用 IndexedDB 时为 null */
    fallbackReason: opts.fallbackReason || null,

    /** 读出保存的整份数据（原样，未经校验）；没有时返回 null。会先把还没写的修改写掉。 */
    async loadJournal() {
      await flush();
      const j = await backend.get(STORES.journal, JOURNAL_KEY);
      return j === undefined ? null : j;
    },

    /**
     * 安排保存整份数据：去抖 delay 毫秒，连续修改时最长 maxWait 毫秒写一次。
     * 返回的 Promise 在包含这次修改的那次写入完成后兑现，值是那次写入里最后一个 tag
     * （调用方可以传 localRev 作为 tag，据此判断自己是不是这一批里最新的）。
     */
    saveJournal(journal, tag) {
      const err = guard();
      if (err) return Promise.reject(err);
      return new Promise((resolve, reject) => {
        if (!pending) pending = { journal, tag, waiters: [], firstAt: Date.now() };
        pending.journal = journal;
        pending.tag = tag;
        pending.waiters.push({ resolve, reject });
        schedule();
      });
    },

    /** 立刻写掉还在等待的修改；返回的 Promise 在写入结束后兑现（成功或失败都兑现）。 */
    flush,

    /** 有没有还没写的修改 */
    hasPending: () => pending !== null,

    /** 设为可写或只读（只读时 saveJournal、saveMeta 和写、删截图文件的方法都会拒绝） */
    setWritable(value) { writable = !!value; },
    isWritable: () => writable && !closed && !backend.closed,

    async loadMeta(key) { return backend.get(STORES.meta, key); },
    async saveMeta(key, value) {
      const err = guard();
      if (err) throw err;
      return backend.put(STORES.meta, key, value);
    },

    // 截图文件（shots.js 用）：键是文件路径（shots/<交易 id>/<截图 id>.webp 等），
    // 记录形如 { blob, type, bytes, uploaded, addedAt }；uploaded 给以后的同步用
    async getFile(path) {
      const rec = await backend.get(STORES.files, path);
      return rec === undefined ? null : rec;
    },
    async putFile(path, record) {
      const err = guard();
      if (err) throw err;
      return backend.put(STORES.files, path, record);
    },
    async deleteFile(path) {
      const err = guard();
      if (err) throw err;
      return backend.delete(STORES.files, path);
    },
    /**
     * 在一个事务里写入几个文件（截图的大图和缩略图）：要么全写进去，要么一个都不写。
     * 事务在调用时就发出（IndexedDB 按先后执行），之后再读这些路径一定读得到。
     * @param {Array<[string, object]>} entries [[路径, 记录], ...]
     */
    async putFiles(entries) {
      const err = guard();
      if (err) throw err;
      return backend.putMany(STORES.files, Array.from(entries)).catch((e) => { throw idbError(e); });
    },
    /** 在一个事务里删掉几个文件（没有的路径跳过） */
    async deleteFiles(paths) {
      const err = guard();
      if (err) throw err;
      return backend.deleteMany(STORES.files, Array.from(paths)).catch((e) => { throw idbError(e); });
    },
    async listFiles() { return backend.keys(STORES.files); },

    /** 写掉还在等待的修改后关闭 */
    async close() {
      await flush();
      closed = true;
      if (lifecycle && typeof lifecycle.removeEventListener === 'function') lifecycle.removeEventListener('pagehide', onPageHide);
      if (visibility && typeof visibility.removeEventListener === 'function') visibility.removeEventListener('visibilitychange', onVisibility);
      backend.close();
    },
  };
}

// ---------- 持久化申请 ----------

/** 启动时调用：请浏览器不要在空间紧张时自动清掉本站数据。返回是否已获准，不会抛错。 */
export async function requestPersist(storage) {
  const s = storage !== undefined ? storage : globalThis.navigator && globalThis.navigator.storage;
  try {
    if (!s || typeof s.persist !== 'function') return false;
    if (typeof s.persisted === 'function' && await s.persisted()) return true;
    return !!(await s.persist());
  } catch (err) {
    return false;
  }
}

// ---------- 多标签页：唯一写者 ----------

/**
 * 用 Web Locks 申请"写者"身份。第一个打开的标签页拿到锁、可以写；后来的标签页只读，
 * 并在后台排队，等前一个标签页关掉后 acquired 兑现（这时应先重读数据再解除只读，connectStore 会做）。
 * 浏览器不支持 Web Locks 时，每个标签页都当写者（supported 为 false）。
 * @returns {Promise<{isWriter: boolean, supported: boolean, acquired: Promise<void>, release: () => void}>}
 */
export function claimWriter(opts = {}) {
  const nav = globalThis.navigator;
  const locks = opts.locks !== undefined ? opts.locks : nav && nav.locks;
  const name = opts.name || LOCK_NAME;
  const unsupported = () => ({ isWriter: true, supported: false, acquired: Promise.resolve(), release() {} });
  if (!locks || typeof locks.request !== 'function') return Promise.resolve(unsupported());

  return new Promise((resolve) => {
    let releaseHold;
    const hold = new Promise((r) => { releaseHold = r; });
    let markAcquired;
    const acquired = new Promise((r) => { markAcquired = r; });
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let released = false;
    const handle = {
      isWriter: false,
      supported: true,
      acquired,
      release() {
        released = true;
        if (abort) abort.abort();
        releaseHold();
      },
    };
    const grant = () => {
      if (released) return undefined; // 已经不要了：立刻放掉
      handle.isWriter = true;
      markAcquired();
      return hold; // 一直拿着，直到页面关闭或调用 release()
    };
    let first;
    try {
      first = locks.request(name, { ifAvailable: true }, (lock) => {
        if (lock) {
          resolve(handle);
          return grant();
        }
        resolve(handle);
        try {
          Promise.resolve(locks.request(name, abort ? { signal: abort.signal } : {}, grant)).catch(() => {});
        } catch (err) { /* 排不上队就一直只读 */ }
        return undefined;
      });
    } catch (err) {
      resolve(unsupported());
      return;
    }
    Promise.resolve(first).catch(() => resolve(unsupported()));
  });
}

/**
 * 打开 BroadcastChannel，用来通知其他标签页"数据已保存，请重读"。不支持时返回一个什么都不做的对象。
 * @returns {{supported: boolean, post: (msg: object) => void, close: () => void}}
 */
export function openChannel(opts = {}) {
  const BC = opts.BroadcastChannel !== undefined ? opts.BroadcastChannel : globalThis.BroadcastChannel;
  if (typeof BC !== 'function') return { supported: false, post() {}, close() {} };
  const ch = new BC(opts.name || CHANNEL_NAME);
  ch.onmessage = (e) => {
    if (opts.onMessage && e && e.data && typeof e.data === 'object') opts.onMessage(e.data);
  };
  return {
    supported: true,
    post(msg) { try { ch.postMessage(msg); } catch (err) { /* 通知失败不影响保存 */ } },
    close() { ch.close(); },
  };
}

/**
 * 把 store 接到本机存储上：
 * - 真实数据有修改（ui.dirty）且不在示例模式、不是只读时，自动保存；存完调用 markSaved 并通知其他标签页；
 * - 收到其他标签页"已保存"的通知时重读（本页有没保存的修改时不重读，只会出现在不支持 Web Locks 的浏览器里）；
 * - writer 不是写者时，等它拿到锁：先重读最新数据，再解除 'other-tab' 只读；
 * - 读到或写到更新版本的数据时，设为只读 'newer-schema'。
 * @param {object} store createStore 的返回值
 * @param {object} db openLocalDb 的返回值
 * @param {object} [opts]
 * @param {object} [opts.writer] claimWriter 的返回值
 * @param {(err: Error) => void} [opts.onError] 保存或读取失败（界面显示"保存失败，点击重试"）
 * @param {(rev: number) => void} [opts.onSaved] 写进本机存储之后
 * @param {Function} [opts.BroadcastChannel] 测试时替换
 * @param {string} [opts.channelName] 测试时替换频道名
 * @returns {{saveNow: () => Promise<boolean>, reload: () => Promise<void>, stop: () => void}}
 */
export function connectStore(store, db, opts = {}) {
  let stopped = false;
  let lastRequested = -1;
  const report = (err) => { if (opts.onError) opts.onError(err); };
  const onNewer = (err) => {
    if (err && err.code === 'NEWER_SCHEMA') store.actions.setReadOnly('newer-schema');
  };
  const syncWritable = () => db.setWritable(!store.get().ui.readOnly);

  function save(immediate) {
    const { ui, journal } = store.get();
    if (stopped || ui.demo || ui.readOnly || !ui.dirty) return Promise.resolve(false);
    const rev = ui.localRev;
    lastRequested = rev;
    const done = db.saveJournal(journal, rev).then(
      (writtenRev) => {
        if (writtenRev !== rev) return false; // 同一批里更新的那次保存会处理
        store.actions.markSaved(rev);
        channel.post({ type: 'saved', rev });
        if (opts.onSaved) opts.onSaved(rev);
        return true;
      },
      (err) => {
        onNewer(err);
        if (rev === lastRequested) report(err);
        return false;
      },
    );
    if (immediate) db.flush();
    return done;
  }

  async function reload() {
    if (stopped || store.get().ui.dirty) return;
    let raw;
    try {
      raw = await db.loadJournal();
    } catch (err) {
      report(err);
      return;
    }
    if (raw == null || stopped) return;
    try {
      store.actions.replaceJournal(raw, { external: true });
    } catch (err) {
      onNewer(err);
      report(err);
    }
  }

  const channel = openChannel({
    BroadcastChannel: opts.BroadcastChannel,
    name: opts.channelName,
    onMessage: (msg) => { if (msg.type === 'saved') reload(); },
  });

  syncWritable();
  const off = store.subscribe((ev) => {
    if (ev.type === 'ui') {
      if (ev.reason === 'readOnly') syncWritable();
      return;
    }
    save(false);
  });

  const writer = opts.writer;
  if (writer && !writer.isWriter && writer.acquired) {
    writer.acquired.then(async () => {
      if (stopped) return;
      await reload(); // 先读前一个标签页最后存下的数据
      if (!stopped && store.get().ui.readOnly === 'other-tab') store.actions.setReadOnly(null);
    });
  }

  save(false); // 万一建 store 时就已经有没保存的修改

  return {
    /** 立刻保存（"保存失败，点击重试"用）；有东西可存并且写成功时返回 true */
    saveNow: () => save(true),
    /** 立刻从本机存储重读 */
    reload,
    stop() {
      stopped = true;
      off();
      channel.close();
    },
  };
}

// ---------- 设置（localStorage，键名一律 tj_ 前缀） ----------

function localStore(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch (err) {
    return null; // 有些隐私模式下访问 localStorage 会抛错
  }
}

/** 读一个设置（JSON），没有或读不了时返回 fallback */
export function getPref(name, fallback = null, storage) {
  const s = localStore(storage);
  if (!s) return fallback;
  try {
    const raw = s.getItem(PREF_PREFIX + name);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

/** 写一个设置（JSON），成功返回 true */
export function setPref(name, value, storage) {
  const s = localStore(storage);
  if (!s) return false;
  try {
    s.setItem(PREF_PREFIX + name, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

/** 删掉一个设置（只删这一个键，从不清空整个 localStorage） */
export function removePref(name, storage) {
  const s = localStore(storage);
  if (!s) return false;
  try {
    s.removeItem(PREF_PREFIX + name);
    return true;
  } catch (err) {
    return false;
  }
}
