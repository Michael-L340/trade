// @ts-check
// 唯一碰 supabase-js 的文件（交接文档 8.3、9.1）。别的模块只通过这里导出的函数访问云端。
//
// vendor/supabase.js 由 index.html 用普通 <script> 先加载，定义全局变量 supabase；这里读 globalThis.supabase。
// 测试时用 createRemote({ lib: 假的 supabase }) 换掉。
//
// 所有方法都不抛错，返回 { ...结果, error }。error 是归一过的错误（store/errors.js 认的样子）：
//   { source: 'db'|'rpc'|'storage'|'auth', network: boolean, status: number, code: string, statusCode: string, message: string }
// 会话的规矩（8.3）：
//   - storageKey 必须是 'tj-auth'（和记账同源，默认的键会和它的会话撞在一起）；"有没有会话"以 localStorage 里有没有 tj-auth 为准。
//   - 退出只用 signOut({ scope: 'local' })：不带参数是 global，会把这个账号在所有设备上踢下线。
//   - 网站不调用 updateUser；备份状态用 getUser() 读（getSession() 读的是本机旧令牌里的 metadata）。

export const AUTH_STORAGE_KEY = 'tj-auth';
export const TABLE = 'tj_journal';
export const HISTORY_TABLE = 'tj_journal_history';
export const BUCKET = 'tj-shots';
/** 一般请求的超时 */
export const BASE_TIMEOUT_MS = 30000;
/** 带请求体的按大小放宽：每 50 KB 加 1 秒（3 MB 的 doc 约 90 秒） */
export const TIMEOUT_PER_50KB_MS = 1000;

/** 带请求体的请求的超时（8.3） */
export function timeoutFor(bodyBytes) {
  const n = typeof bodyBytes === 'number' && bodyBytes > 0 ? bodyBytes : 0;
  return BASE_TIMEOUT_MS + Math.floor(n / 50000) * TIMEOUT_PER_50KB_MS;
}

function bodySize(body) {
  if (!body) return 0;
  if (typeof body === 'string') return body.length * 3; // 按最坏的 UTF-8 估
  if (typeof body.size === 'number') return body.size;
  if (typeof body.byteLength === 'number') return body.byteLength;
  return 0;
}

/**
 * 包一层带超时、不走缓存的 fetch（supabase-js 自带的没有超时，电脑睡眠唤醒后请求可能永远不回来；9.4 第 1、16 条）。
 * @param {typeof fetch} fetchImpl
 */
export function timedFetch(fetchImpl) {
  return function tjFetch(input, init = {}) {
    const ac = new AbortController();
    const ms = timeoutFor(bodySize(init.body));
    const timer = setTimeout(() => ac.abort(new Error('请求超时（' + Math.round(ms / 1000) + ' 秒）')), ms);
    let signal = ac.signal;
    if (init.signal) {
      const AS = /** @type {any} */ (AbortSignal);
      if (typeof AS.any === 'function') signal = AS.any([init.signal, ac.signal]);
      else init.signal.addEventListener('abort', () => ac.abort(init.signal.reason));
    }
    return Promise.resolve(fetchImpl(input, { ...init, signal, cache: 'no-store' })).finally(() => clearTimeout(timer));
  };
}

const str = (v) => (v === undefined || v === null ? '' : String(v));

/** PostgREST 的返回（{ data, error, status }）→ 归一的错误；没错返回 null */
export function dbError(res, source = 'db') {
  if (!res || !res.error) return null;
  const e = res.error;
  const status = typeof res.status === 'number' ? res.status : 0;
  return { source, network: status === 0, status, code: str(e.code), statusCode: '', message: str(e.message) };
}

/** Storage 的错误：StorageApiError 有 status（HTTP）和 statusCode（返回体）；StorageUnknownError 多半是网络 */
export function storageError(e) {
  if (!e) return null;
  const hasStatus = typeof e.status === 'number' && e.status > 0;
  const sc = str(e.statusCode);
  return { source: 'storage', network: !hasStatus && !sc, status: hasStatus ? e.status : 0, code: str(e.code), statusCode: sc, message: str(e.message) };
}

/** Auth 的错误：AuthRetryableFetchError（网络）status 为 0 或没有 */
export function authError(e) {
  if (!e) return null;
  const status = typeof e.status === 'number' ? e.status : 0;
  const network = status === 0 || e.name === 'AuthRetryableFetchError';
  return { source: 'auth', network, status: network ? 0 : status, code: str(e.code), statusCode: '', message: str(e.message) };
}

function thrown(source, err) {
  return { source, network: true, status: 0, code: '', statusCode: '', message: err && err.message ? err.message : String(err) };
}

/**
 * 建一个云端对象。
 * @param {object} opts
 * @param {string} opts.url 项目地址
 * @param {string} opts.key publishable key
 * @param {any} [opts.lib] supabase-js 的全局对象，默认 globalThis.supabase
 * @param {any} [opts.storage] 会话存在哪（默认浏览器的 localStorage）；测试时传内存的
 * @param {typeof fetch} [opts.fetch] 默认全局 fetch
 */
export function createRemote(opts) {
  const lib = opts.lib !== undefined ? opts.lib : /** @type {any} */ (globalThis).supabase;
  if (!lib || typeof lib.createClient !== 'function') throw new Error('没有加载 supabase-js（vendor/supabase.js）');
  const storage = opts.storage !== undefined ? opts.storage : (() => {
    try { return globalThis.localStorage; } catch (err) { return undefined; }
  })();
  const fetchImpl = opts.fetch || globalThis.fetch.bind(globalThis);
  const auth = { storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false };
  if (opts.storage !== undefined) auth.storage = opts.storage;
  const client = lib.createClient(opts.url, opts.key, { auth, global: { fetch: timedFetch(fetchImpl) } });

  let userId = null;

  async function guard(source, fn) {
    try {
      return await fn();
    } catch (err) {
      return { error: thrown(source, err) };
    }
  }

  const api = {
    /** localStorage 里有没有 tj-auth（8.3："有没有会话"以它为准） */
    hasStoredSession() {
      try {
        return !!storage && storage.getItem(AUTH_STORAGE_KEY) !== null;
      } catch (err) {
        return false;
      }
    },

    /** 当前会话：{ session, userId, email, error }。令牌过期又断网时可能是 null 加网络错误。 */
    async getSession() {
      return guard('auth', async () => {
        const { data, error } = await client.auth.getSession();
        const session = data && data.session ? data.session : null;
        if (session && session.user) userId = session.user.id;
        return { session, userId: session && session.user ? session.user.id : null, email: session && session.user ? session.user.email || '' : '', error: authError(error) };
      });
    },

    /** 当前账号的 id（最近一次 getSession / 登录拿到的） */
    userId: () => userId,

    async signIn(email, password) {
      return guard('auth', async () => {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        const user = data && data.user ? data.user : null;
        if (user) userId = user.id;
        return { userId: user ? user.id : null, email: user ? user.email || '' : '', error: authError(error) };
      });
    },

    /** 只退出这个浏览器（scope: 'local'），本机数据不动 */
    async signOut() {
      return guard('auth', async () => {
        const { error } = await client.auth.signOut({ scope: 'local' });
        userId = null;
        return { error: authError(error) };
      });
    },

    /** 换令牌（只在核对会话时用）：{ ok, error }。error.network 为真表示网络失败（包括冷却期内返回的同一个失败） */
    async refreshSession() {
      return guard('auth', async () => {
        const { data, error } = await client.auth.refreshSession();
        const ok = !error && !!(data && data.session);
        if (ok && data.session.user) userId = data.session.user.id;
        return { ok, error: ok ? null : (authError(error) || { source: 'auth', network: false, status: 401, code: '', statusCode: '', message: '没有会话' }) };
      });
    },

    /** 从服务器读当前用户（备份状态在 user_metadata.tj_backup）：{ user, error } */
    async getUser() {
      return guard('auth', async () => {
        const { data, error } = await client.auth.getUser();
        return { user: data && data.user ? data.user : null, error: authError(error) };
      });
    },

    /**
     * 订阅登录状态变化：fn(event, userId)。event 是 supabase-js 的 'SIGNED_IN'、'SIGNED_OUT'、'TOKEN_REFRESHED' 等。
     * @returns {() => void} 取消订阅
     */
    onAuthChange(fn) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (session && session.user) userId = session.user.id;
        if (event === 'SIGNED_OUT') userId = null;
        // supabase-js 要求回调里不要直接 await 它自己的方法：放到下一轮
        setTimeout(() => fn(event, session && session.user ? session.user.id : null), 0);
      });
      return () => { try { data.subscription.unsubscribe(); } catch (err) { /* 已经取消 */ } };
    },

    /** 只查 rev（几十字节）：{ rev: number|null（null 表示云端没有这一行）, error } */
    async fetchRev() {
      return guard('db', async () => {
        const res = await client.from(TABLE).select('rev').maybeSingle();
        const error = dbError(res);
        return { rev: !error && res.data ? Number(res.data.rev) : null, error };
      });
    },

    /** 取整份：{ row: { rev, doc, updated_at } | null, error } */
    async fetchDoc() {
      return guard('db', async () => {
        const res = await client.from(TABLE).select('rev, doc, updated_at').maybeSingle();
        const error = dbError(res);
        return { row: !error && res.data ? { rev: Number(res.data.rev), doc: res.data.doc, updated_at: res.data.updated_at } : null, error };
      });
    },

    /** 第一次保存（rev 为 1，user_id 不传，默认就是自己）：{ rev, error } */
    async insertDoc(doc) {
      return guard('db', async () => {
        const res = await client.from(TABLE).insert({ doc, rev: 1 }).select('rev');
        const error = dbError(res);
        const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        return { rev: !error && rows.length ? Number(rows[0].rev) : null, error };
      });
    },

    /**
     * 带版本保存：PATCH /rest/v1/tj_journal?rev=eq.r&select=rev。
     * @returns {Promise<{rev: number|null, error: any}>} rev 为 null 且没有错误：返回空数组，云端已经不是 r（或那一行没了）
     */
    async updateDoc(doc, fromRev) {
      return guard('db', async () => {
        const res = await client.from(TABLE).update({ doc, rev: fromRev + 1 }).eq('rev', fromRev).select('rev');
        const error = dbError(res);
        const rows = Array.isArray(res.data) ? res.data : [];
        return { rev: !error && rows.length ? Number(rows[0].rev) : null, error };
      });
    },

    /** 历史表里版本号是 rev 的最新一份 doc（核对"保存响应丢失"用）：{ doc|null, error } */
    async historyDoc(rev) {
      return guard('db', async () => {
        const res = await client.from(HISTORY_TABLE).select('doc').eq('rev', rev).order('id', { ascending: false }).limit(1).maybeSingle();
        const error = dbError(res);
        return { doc: !error && res.data ? res.data.doc : null, error };
      });
    },

    /** 传截图：对象名 <user_id>/<path>，不覆盖（upsert: false），Content-Type 按 Blob 的 type。{ error } */
    async upload(uid, path, blob) {
      return guard('storage', async () => {
        const { error } = await client.storage.from(BUCKET).upload(uid + '/' + path, blob, { upsert: false, contentType: blob.type });
        return { error: storageError(error) };
      });
    },

    /** 取截图（自动带登录凭证；不用签名 URL）：{ blob|null, error } */
    async download(uid, path) {
      return guard('storage', async () => {
        const { data, error } = await client.storage.from(BUCKET).download(uid + '/' + path);
        return { blob: error ? null : data || null, error: storageError(error) };
      });
    },

    /** 截图空间用量：{ usage: { tj_shots_bytes, tj_shots_files, project_bytes, warn_bytes, limit_bytes } | null, error } */
    async usage() {
      return guard('rpc', async () => {
        const res = await client.rpc('tj_storage_usage');
        const error = dbError(res, 'rpc');
        let usage = null;
        if (!error && res.data) {
          const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          usage = {
            tj_shots_bytes: Number(d.tj_shots_bytes) || 0,
            tj_shots_files: Number(d.tj_shots_files) || 0,
            project_bytes: Number(d.project_bytes) || 0,
            warn_bytes: Number(d.warn_bytes) || 800000000,
            limit_bytes: Number(d.limit_bytes) || 900000000,
          };
        }
        return { usage, error };
      });
    },
  };
  return api;
}
