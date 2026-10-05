// 测试用的最小 IndexedDB 和 Web Locks（只实现 localdb.js 用到的部分）。不是测试文件本身。

const later = (fn) => setTimeout(fn, 0);

/** 最小 IndexedDB：open / onupgradeneeded / onversionchange、事务（读写隔离、abort 回滚）、get / put / delete / getAllKeys */
export function createFakeIndexedDB() {
  const dbs = new Map();
  const stats = { readwrite: 0 };

  function transaction(rec, names, mode) {
    if (mode === 'readwrite') stats.readwrite += 1;
    // 读写事务在副本上改，完成时才落到库里；abort 时丢掉副本
    const work = new Map(names.map((n) => [n, mode === 'readwrite' ? new Map(rec.stores.get(n)) : rec.stores.get(n)]));
    let pending = 0;
    let finished = false;
    const tx = { mode, error: null, oncomplete: null, onerror: null, onabort: null };
    const finishIfIdle = () => later(() => {
      if (finished || pending > 0) return;
      finished = true;
      if (mode === 'readwrite') for (const [n, m] of work) rec.stores.set(n, m);
      if (tx.oncomplete) tx.oncomplete({ target: tx });
    });
    const abortWith = (err) => {
      if (finished) return;
      finished = true;
      tx.error = err;
      later(() => { if (tx.onabort) tx.onabort({ target: tx }); });
    };
    const request = (op) => {
      if (finished) throw new DOMException('The transaction has finished.', 'TransactionInactiveError');
      const r = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending += 1;
      later(() => {
        pending -= 1;
        if (finished) return;
        try {
          r.result = op();
        } catch (err) {
          r.error = err;
          if (r.onerror) r.onerror({ target: r });
          abortWith(err);
          return;
        }
        if (r.onsuccess) r.onsuccess({ target: r });
        finishIfIdle();
      });
      return r;
    };
    tx.objectStore = (n) => {
      if (!names.includes(n)) throw new DOMException('Not in transaction scope', 'NotFoundError');
      const data = work.get(n);
      const mustWrite = () => { if (mode !== 'readwrite') throw new DOMException('Read-only transaction', 'ReadOnlyError'); };
      return {
        get: (key) => request(() => (data.has(key) ? structuredClone(data.get(key)) : undefined)),
        getAllKeys: () => request(() => Array.from(data.keys())),
        put: (value, key) => {
          mustWrite();
          const copy = structuredClone(value); // 和真的一样：put 时同步复制，复制不了就同步抛错
          return request(() => { data.set(key, copy); return key; });
        },
        delete: (key) => {
          mustWrite();
          return request(() => { data.delete(key); });
        },
      };
    };
    tx.abort = () => {
      if (finished) throw new DOMException('The transaction has finished.', 'InvalidStateError');
      abortWith(null);
    };
    tx.commit = () => {};
    finishIfIdle();
    return tx;
  }

  function connection(rec, version) {
    const conn = {
      version,
      closed: false,
      onversionchange: null,
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(n) { rec.stores.set(n, new Map()); return {}; },
      transaction(names, mode = 'readonly') {
        if (conn.closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
        const list = [].concat(names);
        for (const n of list) if (!rec.stores.has(n)) throw new DOMException('No objectStore named ' + n, 'NotFoundError');
        return transaction(rec, list, mode);
      },
      close() { conn.closed = true; rec.connections.delete(conn); },
    };
    return conn;
  }

  return {
    stats,
    /** 直接读写库里的内容（模拟别的版本的网站写过数据） */
    raw(name, store) { return dbs.get(name).stores.get(store); },
    open(name, version) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        let rec = dbs.get(name);
        if (!rec) { rec = { version: 0, stores: new Map(), connections: new Set() }; dbs.set(name, rec); }
        const v = version === undefined ? Math.max(rec.version, 1) : version;
        if (v < rec.version) {
          req.error = new DOMException('The requested version is less than the existing version.', 'VersionError');
          if (req.onerror) req.onerror({ target: req });
          return;
        }
        const conn = connection(rec, v);
        req.result = conn;
        if (v > rec.version) {
          for (const other of Array.from(rec.connections)) if (other.onversionchange) other.onversionchange({ oldVersion: rec.version, newVersion: v });
          if (rec.connections.size && req.onblocked) req.onblocked({});
          rec.version = v;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        rec.connections.add(conn);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

/** 最小 Web Locks：同名锁同一时间只给一个；ifAvailable、signal；回调返回的 Promise 结束时放锁 */
export function createFakeLocks() {
  const held = new Set();
  const queues = new Map();
  function grant(name, entry) {
    held.add(name);
    let ret;
    try {
      ret = Promise.resolve(entry.cb({ name }));
    } catch (err) {
      ret = Promise.reject(err);
    }
    ret.then((v) => { release(name); entry.resolve(v); }, (e) => { release(name); entry.reject(e); });
  }
  function release(name) {
    held.delete(name);
    const q = queues.get(name) || [];
    const next = q.shift();
    if (next) grant(name, next);
  }
  return {
    request(name, options, cb) {
      if (typeof options === 'function') { cb = options; options = {}; }
      return new Promise((resolve, reject) => {
        const entry = { cb, resolve, reject };
        if (!held.has(name)) { grant(name, entry); return; }
        if (options.ifAvailable) {
          Promise.resolve().then(() => cb(null)).then(resolve, reject);
          return;
        }
        if (options.signal) {
          if (options.signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
          options.signal.addEventListener('abort', () => {
            const q = queues.get(name) || [];
            const i = q.indexOf(entry);
            if (i !== -1) { q.splice(i, 1); reject(new DOMException('aborted', 'AbortError')); }
          });
        }
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push(entry);
      });
    },
  };
}
