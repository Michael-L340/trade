// 测试用的假 supabase-js（只实现 src/store/remote.js 用到的部分）和一个内存里的"云端"。不是测试文件本身。
//
// 云端按 5.3/5.4 的规矩模拟：tj_journal 每个用户一行（doc 按 json 原文存，键顺序不变）、rev 只能 +1（否则 PT409）、
// 重复 insert 报 23505、每次 update 把旧 doc 存进历史；没会话的请求得到 401 加 42501。
// 桶 tj-shots：同名对象再传回 statusCode '409'（HTTP 400）；用量到上限回 '403'；下载没有的回 '404'。
//
// cloud.inject(op, fn)：下一次 op 调用时先跑 fn(args)，fn 返回一个结果就直接返回它（模拟出错），返回 undefined 照常执行。
//   op：'select' 'insert' 'update' 'history' 'upload' 'download' 'usage' 'refresh' 'getSession'
// cloud.calls：按顺序记下每次调用 [op, 细节]，用来断言"先图后文"、"只查了 rev"。

export const TEST_EMAIL = 'me+tj@example.test';
export const TEST_PASSWORD = 'pw-for-tests';

export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => Array.from(m.keys()),
  };
}

export function createFakeCloud({ uid = 'user-1' } = {}) {
  const cloud = {
    uid,
    row: null, // { rev, docText, updated_at }
    history: [], // { id, rev, docText }
    objects: new Map(), // 对象名 → Blob
    projectBytes: 0,
    limitBytes: 900000000,
    metadata: {},
    calls: [],
    injections: new Map(),
    signOutScopes: [],
    hid: 0,
    inject(op, fn) {
      if (!this.injections.has(op)) this.injections.set(op, []);
      this.injections.get(op).push(fn);
    },
    take(op, args) {
      const q = this.injections.get(op);
      if (!q || !q.length) return undefined;
      return q.shift()(args);
    },
    doc() { return this.row ? JSON.parse(this.row.docText) : null; },
    /** 模拟别的设备存了一版 */
    otherDeviceSaves(doc) {
      if (this.row) this.history.push({ id: ++this.hid, rev: this.row.rev, docText: this.row.docText });
      this.row = { rev: this.row ? this.row.rev + 1 : 1, docText: JSON.stringify(doc), updated_at: new Date().toISOString() };
    },
    count(op) { return this.calls.filter((c) => c[0] === op).length; },
  };
  return cloud;
}

const noSession = () => ({ data: null, error: { code: '42501', message: 'permission denied for table tj_journal' }, status: 401 });

class FakeStorageError extends Error {
  constructor(message, status, statusCode) {
    super(message);
    this.name = 'StorageApiError';
    this.status = status;
    this.statusCode = statusCode;
  }
}

/** 假的 supabase 全局对象：createClient(url, key, options) */
export function createFakeLib(cloud) {
  return {
    createClient(url, key, options) {
      const storageKey = options.auth.storageKey;
      const storage = options.auth.storage;
      cloud.lastClientOptions = options;
      const listeners = new Set();
      const session = () => {
        const raw = storage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      };
      const emit = (ev, s) => { for (const fn of listeners) fn(ev, s); };

      const auth = {
        async signInWithPassword({ email, password }) {
          cloud.calls.push(['signIn', email]);
          if (email !== TEST_EMAIL || password !== TEST_PASSWORD) {
            return { data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
          }
          const s = { access_token: 'tok', user: { id: cloud.uid, email } };
          storage.setItem(storageKey, JSON.stringify(s));
          emit('SIGNED_IN', s);
          return { data: { user: s.user, session: s }, error: null };
        },
        async signOut(opts) {
          cloud.signOutScopes.push(opts && opts.scope);
          storage.removeItem(storageKey);
          emit('SIGNED_OUT', null);
          return { error: null };
        },
        async getSession() {
          const inj = cloud.take('getSession');
          if (inj) return inj;
          return { data: { session: session() }, error: null };
        },
        async refreshSession() {
          cloud.calls.push(['refresh']);
          const inj = cloud.take('refresh');
          if (inj) return inj;
          const s = session();
          return s ? { data: { session: s }, error: null } : { data: { session: null }, error: { name: 'AuthSessionMissingError', status: 400, message: 'no session' } };
        },
        async getUser() {
          const s = session();
          if (!s) return { data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400, message: 'no session' } };
          return { data: { user: { ...s.user, user_metadata: cloud.metadata } }, error: null };
        },
        onAuthStateChange(fn) {
          listeners.add(fn);
          return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
        },
        /** 测试用：模拟 supabase-js 自己发出的事件（例如别处让会话失效） */
        _emit: emit,
      };

      function query(table) {
        const q = { table, op: 'select', cols: '', filters: [], body: null, single: false };
        const builder = {
          select(cols) { if (q.op === 'select') q.cols = cols; else q.returning = cols; return builder; },
          insert(body) { q.op = 'insert'; q.body = body; return builder; },
          update(body) { q.op = 'update'; q.body = body; return builder; },
          eq(col, val) { q.filters.push([col, val]); return builder; },
          order() { return builder; },
          limit() { return builder; },
          maybeSingle() { q.single = true; return builder; },
          then(resolve, reject) { return Promise.resolve().then(() => run(q)).then(resolve, reject); },
        };
        return builder;
      }

      function run(q) {
        const s = session();
        if (q.table === 'tj_journal') {
          const op = q.op === 'select' ? 'select' : q.op;
          cloud.calls.push([op, q.op === 'select' ? q.cols : q.op === 'update' ? 'rev=eq.' + q.filters[0][1] : 'rev=1']);
          const inj = cloud.take(op, q);
          if (inj) return inj;
          if (!s) return noSession();
          if (q.op === 'select') {
            if (!cloud.row) return { data: null, error: null, status: 200 };
            const full = { rev: cloud.row.rev, doc: JSON.parse(cloud.row.docText), updated_at: cloud.row.updated_at };
            return { data: q.cols === 'rev' ? { rev: cloud.row.rev } : full, error: null, status: 200 };
          }
          if (q.op === 'insert') {
            if (cloud.row) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 };
            if (q.body.rev !== 1) return { data: null, error: { code: 'PT409', message: 'rev 必须是 1' }, status: 409 };
            cloud.row = { rev: 1, docText: JSON.stringify(q.body.doc), updated_at: new Date().toISOString() };
            return { data: [{ rev: 1 }], error: null, status: 201 };
          }
          if (q.op === 'update') {
            const want = q.filters.find((f) => f[0] === 'rev')[1];
            if (!cloud.row || cloud.row.rev !== want) return { data: [], error: null, status: 200 };
            if (q.body.rev !== cloud.row.rev + 1) return { data: null, error: { code: 'PT409', message: 'rev 必须加 1' }, status: 409 };
            cloud.history.push({ id: ++cloud.hid, rev: cloud.row.rev, docText: cloud.row.docText });
            cloud.row = { rev: q.body.rev, docText: JSON.stringify(q.body.doc), updated_at: new Date().toISOString() };
            const after = cloud.take('afterUpdate', q); // 存上了，但响应丢了
            if (after) return after;
            return { data: [{ rev: cloud.row.rev }], error: null, status: 200 };
          }
        }
        if (q.table === 'tj_journal_history') {
          cloud.calls.push(['history', q.filters[0][1]]);
          const inj = cloud.take('history', q);
          if (inj) return inj;
          if (!s) return noSession();
          const rev = q.filters.find((f) => f[0] === 'rev')[1];
          const hit = cloud.history.filter((h) => h.rev === rev).sort((a, b) => b.id - a.id)[0];
          return { data: hit ? { doc: JSON.parse(hit.docText) } : null, error: null, status: 200 };
        }
        throw new Error('假 supabase 不认识的表：' + q.table);
      }

      return {
        auth,
        from: (table) => query(table),
        async rpc(name) {
          cloud.calls.push(['usage']);
          const inj = cloud.take('usage');
          if (inj) return inj;
          if (!session()) return noSession();
          return { data: { tj_shots_bytes: cloud.projectBytes, tj_shots_files: cloud.objects.size, project_bytes: cloud.projectBytes, warn_bytes: 800000000, limit_bytes: cloud.limitBytes }, error: null, status: 200 };
        },
        storage: {
          from(bucket) {
            return {
              async upload(name, blob, opts) {
                cloud.calls.push(['upload', name, opts]);
                const inj = cloud.take('upload', { name, blob, opts });
                if (inj) return inj;
                if (!session()) return { data: null, error: new FakeStorageError('new row violates row-level security policy', 400, '403') };
                if (cloud.objects.has(bucket + '/' + name)) return { data: null, error: new FakeStorageError('The resource already exists', 400, '409') };
                if (cloud.projectBytes >= cloud.limitBytes) return { data: null, error: new FakeStorageError('new row violates row-level security policy', 400, '403') };
                cloud.objects.set(bucket + '/' + name, blob);
                cloud.projectBytes += blob.size;
                return { data: { path: name }, error: null };
              },
              async download(name) {
                cloud.calls.push(['download', name]);
                const inj = cloud.take('download', { name });
                if (inj) return inj;
                const b = session() ? cloud.objects.get(bucket + '/' + name) : null;
                if (!b) return { data: null, error: new FakeStorageError('Object not found', 400, '404') };
                return { data: b, error: null };
              },
            };
          },
        },
      };
    },
  };
}

/** 不会自己走的计时器：记下来，测试里需要时手动触发 */
export function manualTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { id += 1; pending.set(id, { fn, ms }); return id; },
    clearTimeout(t) { pending.delete(t); },
    setInterval() { id += 1; return id; },
    clearInterval() {},
    /** 跑掉现在排着的全部 */
    runAll() { const list = Array.from(pending.values()); pending.clear(); for (const t of list) t.fn(); },
  };
}
