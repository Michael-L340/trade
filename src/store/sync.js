// @ts-check
// 同步状态机（交接文档 8.4、8.5）：本机 IndexedDB ↔ 云端 tj_journal 的一行 + tj-shots 桶。
// 只依赖注入进来的 remote（store/remote.js）、db（store/localdb.js）和 store（state.js），不碰 DOM，测试时传假的。
//
// 要点：
// - 同一时间只跑一个同步任务；只有能写的标签页（store 不是只读）发请求。
// - 一次同步：先传还没上传的截图（先图后文），再带版本保存 doc（rev 乐观锁）；
//   发请求前先把 inflight（{ rev, sent: [{ hash, localRev }] }）写进 IndexedDB，响应丢了下次先核对（"保存响应丢失"）。
// - 查云端只查 rev（打开、可见、获焦、联网、登录状态变化时各一次，可见期间每 60 秒一次），变了才取整份。
// - 出错先分类（store/errors.js）：断网类按 5、15、60 秒退避重试；401 先核对会话、换一次令牌；缺授权、坏字符、
//   额度超限、其他错误停下等用户；本机数据、待传截图、inflight 一律不动。
//
// state.status：
//   'off'           没配置云端（config.js 留空）
//   'signedOut'     从没登录过，或用户自己点了退出 → "只保存在这个浏览器里（点击登录）"
//   'needLogin'     会话真没了 → "需要重新登录（本机修改已保留）"
//   'synced'        和云端一致（pending 为真时界面显示"有未同步的修改"）
//   'syncing'       正在保存 → "保存中…"
//   'pending'       断网、超时、5xx、429 自动重试中 → "有未同步的修改"
//   'paused'        在线却连续 3 次连不上（疑似项目暂停），仍在重试 → "云端暂时存不进去（点击查看）"
//   'conflict'      云端被别处改过 → "云端也改过，点击处理"
//   'grant'         缺授权；'badText' 有存不进去的字符；'quota' 额度超限；'error' 其他错误
//   'missingRemote' 同步过，云端那一行却没了；'otherOwner' 本机日志属于另一个账号
//   'newer'         云端的数据是更新版本的网站写的（版本守卫）

import { formatJournal } from '../journal-format.js';
import { classifyError } from './errors.js';
import { deepCleanText, emptyJournal, findBadText, isoNow, normalizeJournal, stampAppVersion, versionGuard } from '../model.js';
import { conflictSummary } from '../diff.js';

export const RETRY_DELAYS_MS = Object.freeze([5000, 15000, 60000]);
export const POLL_MS = 60000;
export const PUSH_DELAY_MS = 2000;
export const PUSH_MAX_WAIT_MS = 10000;
/** 连续这么多次连不上（又不是 401、403）就提示"云端连不上，可能被暂停了" */
export const PAUSE_AFTER_FAILURES = 3;
const MAX_SENT = 20;
const MAX_LOOPS = 6;

/** 停下来等用户动手、用户改了数据或点了重试才再发的几种 */
const STOP_ON_EDIT = new Set(['grant', 'badText', 'quota', 'error']);

/** SHA-256，十六进制 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 冲突留底下载的文件名：journal-落选-本机-20261005-1430.json */
export function loserFileName(source, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `journal-落选-${source === 'remote' ? '云端' : '本机'}-${stamp}.json`;
}

/** 这份本机数据算不算"没数据"：只有首次使用时自动建的空系统行 */
export function isBlankJournal(j) {
  if (!j || !Array.isArray(j.rows)) return true;
  return j.rows.every((r) => r && r.type === 'system' && !r.name && !r.desc);
}

/** 一份 doc 引用的全部截图文件路径（大图和缩略图） */
export function referencedFiles(j) {
  const out = [];
  for (const r of j && Array.isArray(j.rows) ? j.rows : []) {
    if (!r || r.type !== 'trade' || !Array.isArray(r.shots)) continue;
    for (const s of r.shots) {
      for (const p of [s && s.file, s && s.thumb]) if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

function recordBlob(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const b = rec.blob;
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (typeof Blob === 'function' && b instanceof Blob) return b.type || !type ? b : new Blob([b], { type });
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new Blob([b], { type });
  return null;
}

/**
 * @param {object} opts
 * @param {any} opts.remote createRemote 的返回值；没配置云端时传 null
 * @param {any} opts.db openLocalDb 的返回值
 * @param {any} opts.store createStore 的返回值
 * @param {() => Date} [opts.now]
 * @param {() => boolean} [opts.online] 默认看 navigator.onLine
 * @param {(text: string) => Promise<string>} [opts.hash] 默认 SHA-256
 * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} [opts.timers]
 * @param {(name: string, text: string) => void} [opts.download] 冲突留底时自动下载一份
 * @param {() => void} [opts.onPulled] 用云端数据替换了本机（通知其他标签页重读）
 * @param {(conflict: object) => void} [opts.onConflict] 出现冲突（界面弹出冲突对话框）
 */
export function createSync(opts) {
  const { remote, db, store } = opts;
  const now = opts.now || (() => new Date());
  const online = opts.online || (() => !(globalThis.navigator && globalThis.navigator.onLine === false));
  const hash = opts.hash || sha256Hex;
  const timers = opts.timers || globalThis;
  const download = opts.download || (() => {});

  const state = {
    configured: !!remote,
    status: remote ? 'signedOut' : 'off',
    pending: false,
    email: '',
    userId: null,
    error: null,
    errorKind: null,
    badText: null,
    conflict: null,
    usage: null,
    usageError: null,
    rejectedShots: 0,
    pendingShots: 0,
    remoteRev: null,
    lastSyncAt: null,
    lastCheckAt: null,
    docBytes: 0,
    failures: 0,
  };
  const listeners = new Set();
  let stopped = null; // 停下来等用户的原因（status 名）
  let running = null;
  let again = false;
  let signedOutEvent = false; // 收到过不是用户自己点的 SIGNED_OUT
  let userSigningOut = false;
  let authRetried = false;
  let retryTimer = null;
  let pushTimer = null;
  let pushFirstAt = 0;
  let pollTimer = null;
  let started = false;
  let destroyed = false;
  const detach = [];

  function emit() {
    for (const fn of Array.from(listeners)) {
      try { fn(state); } catch (err) { /* 界面出错不影响同步 */ }
    }
  }
  function set(patch) {
    Object.assign(state, patch);
    emit();
  }
  function stop(kind, extra = {}) {
    stopped = kind;
    clearRetry();
    set({ status: kind, ...extra });
  }
  function clearStop() {
    stopped = null;
  }
  function clearRetry() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function scheduleRetry(ms) {
    clearRetry();
    retryTimer = timers.setTimeout(() => { retryTimer = null; syncNow(); }, ms);
  }
  const readOnly = () => !!store.get().ui.readOnly;

  async function refreshMeta() {
    const m = await db.loadSyncMeta();
    set({ pending: m.localRev > m.syncedRev, remoteRev: m.remoteRev, lastSyncAt: m.lastSyncAt });
    return m;
  }

  // ---------- 出错 ----------

  async function fail(err, kindOverride, ctx = {}) {
    const kind = kindOverride || classifyError(err) || 'other';
    state.error = err;
    state.errorKind = kind;
    if (kind === 'network') {
      state.failures += 1;
      const paused = online() && state.failures >= PAUSE_AFTER_FAILURES;
      set({ status: paused ? 'paused' : 'pending' });
      if (online()) scheduleRetry(RETRY_DELAYS_MS[Math.min(state.failures, RETRY_DELAYS_MS.length) - 1]);
      return;
    }
    if (kind === 'auth') {
      await handleAuth();
      return;
    }
    if (kind === 'badText') {
      stop('badText', { badText: findBadText(ctx.doc || store.realJournal()) });
      return;
    }
    if (kind === 'grant' || kind === 'quota') {
      stop(kind);
      return;
    }
    stop('error');
  }

  /** 8.4"可能要重新登录"：先核对会话，确认真没了才要求重新登录 */
  async function handleAuth() {
    if (signedOutEvent || !remote.hasStoredSession()) {
      stop('needLogin');
      return;
    }
    if (authRetried) { // 换过令牌重试还是 401：不要循环
      authRetried = false;
      stop('needLogin');
      return;
    }
    const r = await remote.refreshSession();
    if (r.ok) {
      authRetried = true;
      again = true; // 立即重试
      set({ status: 'pending' });
      return;
    }
    if (r.error && r.error.network) {
      await fail(r.error, 'network'); // 冷却期或断网：按断网退避，状态保持"有未同步的修改"
      return;
    }
    stop('needLogin');
  }

  function ok(extra = {}) {
    state.failures = 0;
    authRetried = false;
    state.error = null;
    state.errorKind = null;
    set({ status: 'synced', lastCheckAt: isoNow(now()), ...extra });
  }

  // ---------- 一次同步 ----------

  async function cycle() {
    if (!remote) { set({ status: 'off' }); return; }
    if (readOnly() || stopped) return;
    if (!remote.hasStoredSession()) {
      const m = await db.loadSyncMeta();
      set({ status: m.everSignedIn && !m.signedOutByUser ? 'needLogin' : 'signedOut', pending: m.localRev > m.syncedRev });
      return;
    }
    if (!online()) {
      set({ status: 'pending' });
      return; // 明确断网时不空转，等 online 事件
    }
    const s = await remote.getSession();
    if (!s.userId) {
      // tj-auth 还在、getSession() 却是 null 或网络错误：多半是令牌过期又断网，按断网处理
      await fail(s.error || { source: 'auth', network: true, status: 0, message: '暂时拿不到会话' }, 'network');
      return;
    }
    const uid = s.userId;
    if (state.userId !== uid || state.email !== s.email) set({ userId: uid, email: s.email });

    let snap = await db.readSnapshot();
    let meta = snap.meta;
    if (!meta.everSignedIn || meta.signedOutByUser) {
      meta = await db.updateSyncMeta((m) => ({ ...m, everSignedIn: true, signedOutByUser: false }));
    }
    if (meta.ownerUserId && meta.ownerUserId !== uid) {
      stop('otherOwner');
      return;
    }
    if (meta.inflight) {
      const r = await resolveInflight(uid, meta);
      if (r !== 'continue') return;
      snap = await db.readSnapshot();
      meta = snap.meta;
    }

    const fr = await remote.fetchRev();
    if (fr.error) { await fail(fr.error); return; }
    state.lastCheckAt = isoNow(now());
    const c = fr.rev;
    const pending = meta.localRev > meta.syncedRev;
    if (c === null) {
      if (meta.remoteRev === null) { await push(uid, snap, null); return; }
      stop('missingRemote');
      return;
    }
    if (meta.remoteRev === null) {
      if (isBlankJournal(snap.journal)) { await pull(uid, snap); return; }
      await openConflict(uid, snap, null);
      return;
    }
    if (c === meta.remoteRev) {
      if (!pending) {
        await refreshMeta();
        ok({ remoteRev: c });
        return;
      }
      await push(uid, snap, meta.remoteRev);
      return;
    }
    if (!pending) { await pull(uid, snap); return; }
    await openConflict(uid, snap, await db.loadBase());
  }

  /** 先传截图（先图后文）。返回 'ok' 可以接着存 doc；'stop' 本轮停下（不存 doc） */
  async function uploadShots(uid, journal) {
    let fullOk = null; // 空间满被拒的图：这一轮查过用量没有（true 已回到上限以下）
    let uploaded = 0;
    for (const path of referencedFiles(journal)) {
      let rec = await db.getFile(path);
      if (!rec || rec.uploaded) continue;
      if (rec.rejected === '413' || rec.rejected === '415') continue;
      if (rec.rejected === 'full') {
        if (fullOk === null) {
          const u = await remote.usage();
          if (!u.error && u.usage) set({ usage: u.usage, usageError: null });
          fullOk = !u.error && !!u.usage && u.usage.project_bytes < u.usage.limit_bytes;
        }
        if (!fullOk) continue;
        rec = { ...rec, rejected: null };
      }
      const blob = recordBlob(rec);
      if (!blob) continue;
      const res = await remote.upload(uid, path, blob);
      const kind = classifyError(res.error);
      if (!kind || kind === 'exists') { // 409：上次其实传成功了
        await db.putFile(path, { ...rec, uploaded: true, rejected: null });
        uploaded += 1;
        continue;
      }
      if (kind === 'tooBig') {
        await db.putFile(path, { ...rec, rejected: res.error.statusCode });
        continue;
      }
      if (kind === 'denied') { // '403'：会话坏了、空间满、缺授权都回这个，查用量分辨
        const u = await remote.usage();
        if (u.error) { await fail(u.error); return 'stop'; }
        set({ usage: u.usage, usageError: null });
        if (u.usage && u.usage.project_bytes >= u.usage.limit_bytes) {
          await db.putFile(path, { ...rec, rejected: 'full' });
          fullOk = false;
          continue;
        }
        await fail(res.error, 'grant');
        return 'stop';
      }
      await fail(res.error); // 断网、超时、会话问题：本轮停下，不存 doc
      return 'stop';
    }
    await countShots(journal);
    if (uploaded) refreshUsage();
    return 'ok';
  }

  async function countShots(journal) {
    let rejected = 0;
    let pendingN = 0;
    for (const path of referencedFiles(journal)) {
      if (/\.thumb\./.test(path)) continue; // 按张数算，缩略图不另算
      let rec = null;
      try { rec = await db.getFile(path); } catch (err) { rec = null; }
      if (!rec || rec.uploaded) continue;
      if (rec.rejected) rejected += 1; else pendingN += 1;
    }
    set({ rejectedShots: rejected, pendingShots: pendingN });
  }

  /** 带版本保存。fromRev 为 null 时第一次保存（insert，rev 为 1） */
  async function push(uid, snap, fromRev) {
    const journal = snap.journal || store.realJournal();
    set({ status: 'syncing' });
    if ((await uploadShots(uid, journal)) !== 'ok') return;
    const k = snap.meta.localRev;
    const doc = deepCleanText(stampAppVersion(journal));
    const text = formatJournal(doc);
    const h = await hash(text);
    const newRev = (fromRev === null ? 0 : fromRev) + 1;
    const meta = await db.updateSyncMeta((m) => {
      const prev = m.inflight && m.inflight.rev === newRev && Array.isArray(m.inflight.sent) ? m.inflight.sent : [];
      return { ...m, inflight: { rev: newRev, sent: prev.concat([{ hash: h, localRev: k }]).slice(-MAX_SENT) } };
    });
    set({ docBytes: new TextEncoder().encode(text).length });
    const res = fromRev === null ? await remote.insertDoc(doc) : await remote.updateDoc(doc, fromRev);
    if (res.error) {
      const kind = classifyError(res.error);
      if (kind === 'conflict' || kind === 'duplicate') {
        if ((await resolveInflight(uid, meta)) === 'continue') again = true;
        return;
      }
      await fail(res.error, null, { doc: journal });
      return;
    }
    if (res.rev === null) { // 返回空数组：云端已经不是 fromRev（或那一行没了），先核对
      if ((await resolveInflight(uid, meta)) === 'continue') again = true;
      return;
    }
    const after = await db.applySync({
      base: doc,
      metaPatch: (m) => ({ ...m, remoteRev: res.rev, syncedRev: Math.max(m.syncedRev, k), inflight: null, ownerUserId: uid, lastSyncAt: isoNow(now()) }),
    });
    ok({ remoteRev: res.rev, lastSyncAt: after.lastSyncAt, pending: after.localRev > after.syncedRev });
    if (after.localRev > k) again = true; // 上传期间又有修改
  }

  /**
   * 8.4"保存响应丢失"：不知道上次保存到底存上没有，先核对。
   * 返回 'continue'（核对完了，接着按正常流程走）或 'stop'（已经停下：出错、冲突、云端没了）
   */
  async function resolveInflight(uid, meta) {
    const inf = meta.inflight;
    const fr = await remote.fetchRev();
    if (fr.error) { await fail(fr.error); return 'stop'; }
    const c = fr.rev;
    if (c === null) {
      if (meta.remoteRev === null) return 'continue'; // 从没同步过：留着 inflight 重新 insert
      await db.updateSyncMeta((m) => ({ ...m, inflight: null }));
      stop('missingRemote');
      return 'stop';
    }
    if (c === inf.rev - 1) return 'continue'; // 没存上：用同一个 rev 重新保存
    if (c < inf.rev - 1) { // 那一行被删过又重建过
      await db.updateSyncMeta((m) => ({ ...m, inflight: null }));
      await openConflict(uid, await db.readSnapshot(), await db.loadBase());
      return 'stop';
    }
    let doc = null;
    if (c === inf.rev) {
      const r = await remote.fetchDoc();
      if (r.error) { await fail(r.error); return 'stop'; }
      doc = r.row && r.row.rev === inf.rev ? r.row.doc : null;
    } else {
      const r = await remote.historyDoc(inf.rev);
      if (r.error) { await fail(r.error); return 'stop'; }
      doc = r.doc;
    }
    let match = null;
    if (doc) {
      const h = await hash(formatJournal(doc));
      match = (inf.sent || []).find((x) => x.hash === h) || null;
    }
    if (match) { // 是自己存上的
      await db.applySync({
        base: doc,
        metaPatch: (m) => ({ ...m, remoteRev: inf.rev, syncedRev: Math.max(m.syncedRev, match.localRev), inflight: null, ownerUserId: uid, lastSyncAt: isoNow(now()) }),
      });
      return 'continue';
    }
    await db.updateSyncMeta((m) => ({ ...m, inflight: null }));
    await openConflict(uid, await db.readSnapshot(), await db.loadBase());
    return 'stop';
  }

  /** 取整份 doc，替换本机 */
  async function pull(uid, snap) {
    const r = await remote.fetchDoc();
    if (r.error) { await fail(r.error); return; }
    if (!r.row) { again = true; return; }
    if (versionGuard(r.row.doc)) {
      store.actions.setReadOnly('newer-schema');
      set({ status: 'newer' });
      return;
    }
    let j;
    try {
      j = normalizeJournal(r.row.doc);
    } catch (err) {
      await fail({ source: 'db', network: false, status: 0, code: 'INVALID', statusCode: '', message: '云端的数据没通过校验：' + (err && err.message ? err.message : String(err)) }, 'other');
      return;
    }
    const m = await db.loadSyncMeta();
    if (m.localRev !== snap.meta.localRev || store.get().ui.dirty || db.hasPending()) { again = true; return; }
    store.actions.replaceJournal(j, { external: true }); // 先换内存：之后的修改都基于云端这一份
    try {
      const after = await db.applySync({
        journal: j,
        base: r.row.doc,
        expectLocalRev: snap.meta.localRev,
        metaPatch: (mm) => ({ ...mm, remoteRev: r.row.rev, syncedRev: mm.localRev, inflight: null, ownerUserId: uid, lastSyncAt: isoNow(now()) }),
      });
      if (opts.onPulled) opts.onPulled();
      ok({ remoteRev: r.row.rev, lastSyncAt: after.lastSyncAt, pending: false });
      countShots(j);
    } catch (err) {
      if (err && err.code === 'CHANGED') { // 这期间本机写进了修改：内存换回本机的，下一轮按冲突处理
        const raw = await db.loadJournal();
        if (raw) store.actions.replaceJournal(raw, { external: true });
        again = true;
        return;
      }
      throw err;
    }
  }

  async function openConflict(uid, snap, base) {
    const r = await remote.fetchDoc();
    if (r.error) { await fail(r.error); return; }
    if (!r.row) { again = true; return; }
    if (versionGuard(r.row.doc)) {
      store.actions.setReadOnly('newer-schema');
      set({ status: 'newer' });
      return;
    }
    const local = (snap && snap.journal) || store.realJournal();
    const conflict = { summary: conflictSummary(base, local, r.row.doc), remoteRev: r.row.rev, remoteDoc: r.row.doc, localDoc: local, base, userId: uid };
    stop('conflict', { conflict });
    if (opts.onConflict) opts.onConflict(conflict);
  }

  // ---------- 调度 ----------

  /** 立刻同步一次（返回的 Promise 在这一轮结束后兑现）。force：清掉"停下等用户"的状态再试 */
  function syncNow({ force = false } = {}) {
    if (destroyed) return Promise.resolve();
    if (force && stopped && stopped !== 'conflict' && stopped !== 'otherOwner') clearStop();
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        let loops = 0;
        do {
          again = false;
          loops += 1;
          try {
            await cycle();
          } catch (err) {
            await fail({ source: 'db', network: false, status: 0, code: err && err.code ? String(err.code) : '', statusCode: '', message: err && err.message ? err.message : String(err) }, 'other');
          }
        } while (again && !stopped && loops < MAX_LOOPS && !destroyed);
        if (again && loops >= MAX_LOOPS) scheduleRetry(RETRY_DELAYS_MS[0]);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** 本机写完一次修改（connectStore 的 onSaved）：最后一次修改后 2 秒发，连续修改最长 10 秒发一次 */
  function notifyLocalChange() {
    if (!remote || destroyed) return;
    if (stopped && STOP_ON_EDIT.has(stopped)) clearStop(); // 用户改了数据：再试一次
    set({ pending: true });
    const t = now().getTime();
    if (pushTimer === null) pushFirstAt = t;
    else timers.clearTimeout(pushTimer);
    const wait = Math.max(0, Math.min(PUSH_DELAY_MS, pushFirstAt + PUSH_MAX_WAIT_MS - t));
    pushTimer = timers.setTimeout(() => { pushTimer = null; syncNow(); }, wait);
  }

  async function refreshUsage() {
    if (!remote || !remote.hasStoredSession()) return null;
    const u = await remote.usage();
    if (u.error) set({ usageError: u.error });
    else set({ usage: u.usage, usageError: null });
    return u.usage;
  }

  function startPolling() {
    if (pollTimer !== null || !remote) return;
    pollTimer = timers.setInterval(() => { syncNow(); }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer !== null) timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * 开始自动同步：挂上 online、visibilitychange、focus、登录状态的监听，立刻查一次。
   * @param {{window?: any, document?: any}} [env]
   */
  function start(env = {}) {
    if (started || !remote || destroyed) return;
    started = true;
    const win = env.window !== undefined ? env.window : globalThis.window;
    const doc = env.document !== undefined ? env.document : globalThis.document;
    const visible = () => !doc || doc.visibilityState !== 'hidden';
    const on = (target, type, fn) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      detach.push(() => target.removeEventListener(type, fn));
    };
    on(win, 'online', () => { state.failures = 0; syncNow(); });
    on(win, 'focus', () => syncNow());
    on(doc, 'visibilitychange', () => {
      if (visible()) { startPolling(); syncNow(); return; }
      stopPolling();
      // 页面变为隐藏时立即发一次待同步的修改
      if (pushTimer !== null) { timers.clearTimeout(pushTimer); pushTimer = null; }
      if (state.pending) db.flush().then(() => syncNow());
    });
    const off = remote.onAuthChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        signedOutEvent = false;
        if (stopped === 'needLogin') clearStop();
        syncNow();
        if (event === 'SIGNED_IN') refreshUsage();
      } else if (event === 'SIGNED_OUT') {
        if (userSigningOut) {
          set({ status: 'signedOut', email: '', userId: null });
        } else {
          signedOutEvent = true;
          stop('needLogin');
        }
      }
    });
    detach.push(off);
    if (visible()) startPolling();
    syncNow().then(() => { if (remote.hasStoredSession()) refreshUsage(); });
  }

  // ---------- 给界面用的操作 ----------

  const api = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
    syncNow,
    notifyLocalChange,
    refreshUsage,
    /** 停下来等用户的原因（测试和界面用） */
    stoppedReason: () => stopped,
    /** localStorage 里有没有会话（tj-auth） */
    hasSession: () => !!remote && remote.hasStoredSession(),

    /** 登录：{ ok, message } */
    async signIn(email, password) {
      if (!remote) return { ok: false, message: '云端还没配置' };
      const r = await remote.signIn(String(email || '').trim(), String(password || ''));
      if (r.error || !r.userId) {
        const e = r.error;
        let message = '登录失败';
        if (e && e.network) message = '连不上云端，请检查网络后再试';
        else if (e && (e.status === 400 || e.code === 'invalid_credentials')) message = '邮箱或密码不对';
        else if (e && e.message) message = '登录失败：' + e.message;
        return { ok: false, message, error: e };
      }
      signedOutEvent = false;
      userSigningOut = false;
      if (!readOnly()) {
        try { await db.updateSyncMeta((m) => ({ ...m, everSignedIn: true, signedOutByUser: false })); } catch (err) { /* 只读标签页 */ }
      }
      if (stopped === 'needLogin') clearStop();
      set({ email: r.email, userId: r.userId });
      syncNow();
      refreshUsage();
      return { ok: true, message: '已登录' };
    },

    /** 退出登录（只退出这个浏览器），本机数据不动 */
    async signOut() {
      if (!remote) return { ok: false };
      userSigningOut = true;
      try {
        if (!readOnly()) {
          try { await db.updateSyncMeta((m) => ({ ...m, signedOutByUser: true })); } catch (err) { /* 只读 */ }
        }
        const r = await remote.signOut();
        clearStop();
        clearRetry();
        set({ status: 'signedOut', email: '', userId: null, conflict: null, usage: null });
        return { ok: !r.error };
      } finally {
        setTimeout(() => { userSigningOut = false; }, 1000);
      }
    },

    /**
     * 处理冲突（8.5）：落败的一份先存进冲突留底并下载，再执行。
     * @param {'remote'|'local'} choice
     */
    async resolveConflict(choice) {
      const c = state.conflict;
      if (!c || stopped !== 'conflict') return false;
      const at = isoNow(now());
      const snap = await db.readSnapshot();
      const local = snap.journal || store.realJournal();
      if (choice === 'remote') {
        await db.addConflict({ at, source: 'local', doc: local });
        download(loserFileName('local', now()), formatJournal(local));
        const j = normalizeJournal(c.remoteDoc);
        store.actions.replaceJournal(j, { external: true });
        const after = await db.applySync({
          journal: j,
          base: c.remoteDoc,
          metaPatch: (m) => ({ ...m, remoteRev: c.remoteRev, syncedRev: m.localRev, inflight: null, ownerUserId: c.userId, lastSyncAt: isoNow(now()) }),
        });
        if (opts.onPulled) opts.onPulled();
        clearStop();
        ok({ conflict: null, remoteRev: c.remoteRev, lastSyncAt: after.lastSyncAt, pending: false });
        return true;
      }
      await db.addConflict({ at, source: 'remote', doc: c.remoteDoc });
      download(loserFileName('remote', now()), formatJournal(c.remoteDoc));
      // 用这台电脑上的：从云端现在的 rev 带版本 update（条件是云端 rev 没变）；又变了会再核对、再走一遍冲突
      await db.updateSyncMeta((m) => ({ ...m, remoteRev: c.remoteRev, inflight: null, ownerUserId: c.userId, syncedRev: Math.min(m.syncedRev, m.localRev - 1) }));
      clearStop();
      set({ conflict: null, status: 'pending', pending: true });
      await syncNow();
      return true;
    },

    /** "用本机数据重建云端"（云端找不到日志时） */
    async rebuildCloud() {
      await db.updateSyncMeta((m) => ({ ...m, remoteRev: null, inflight: null }));
      clearStop();
      set({ status: 'pending' });
      await syncNow();
    },

    /** "换成当前账号的云端数据"（本机日志属于另一个账号时）：本机数据先进冲突留底并下载一份 */
    async adoptAccountData() {
      if (!remote) return;
      const s = await remote.getSession();
      if (!s.userId) return;
      const snap = await db.readSnapshot();
      const local = snap.journal || store.realJournal();
      const at = isoNow(now());
      await db.addConflict({ at, source: 'local', doc: local });
      download(loserFileName('local', now()), formatJournal(local));
      const r = await remote.fetchDoc();
      if (r.error) { clearStop(); await fail(r.error); return; }
      let j;
      let base = null;
      let rev = null;
      if (r.row) {
        if (versionGuard(r.row.doc)) { store.actions.setReadOnly('newer-schema'); set({ status: 'newer' }); return; }
        j = normalizeJournal(r.row.doc);
        base = r.row.doc;
        rev = r.row.rev;
      } else {
        j = emptyJournal();
      }
      store.actions.replaceJournal(j, { external: true });
      await db.applySync({
        journal: j,
        ...(base ? { base } : {}),
        metaPatch: (m) => ({ ...m, ownerUserId: s.userId, remoteRev: rev, syncedRev: m.localRev, inflight: null }),
      });
      if (opts.onPulled) opts.onPulled();
      clearStop();
      await syncNow();
    },

    /** 截图空间回落后"重试上传"：空间满被拒的图改回待上传，立即同步 */
    async retryRejected() {
      const j = store.realJournal();
      for (const path of referencedFiles(j)) {
        const rec = await db.getFile(path);
        if (rec && !rec.uploaded && rec.rejected === 'full') await db.putFile(path, { ...rec, rejected: null });
      }
      await db.updateSyncMeta((m) => ({ ...m, syncedRev: Math.min(m.syncedRev, m.localRev - 1) }));
      await syncNow({ force: true });
      await refreshUsage();
    },

    /**
     * 取一张本机没有的截图（7.8）：从桶里下载，存进 IndexedDB，下次直接用本机的。
     * 取不到返回 null（云端没有这张图、没登录、断网）。'404' 时先查一次 rev 分辨是不是会话问题。
     */
    async fetchShot(path) {
      if (!remote || !remote.hasStoredSession()) return null;
      let uid = remote.userId();
      if (!uid) uid = (await remote.getSession()).userId;
      if (!uid) return null;
      const r = await remote.download(uid, path);
      if (r.blob) {
        if (!readOnly()) {
          try {
            await db.putFile(path, { blob: r.blob, type: r.blob.type, bytes: r.blob.size, uploaded: true, addedAt: isoNow(now()) });
          } catch (err) { /* 存不进本机也照常显示 */ }
        }
        return r.blob;
      }
      const kind = classifyError(r.error);
      if (kind === 'notFound' || kind === 'auth') {
        const fr = await remote.fetchRev();
        if (fr.error && classifyError(fr.error) === 'auth') syncNow(); // 会话问题：交给同步按 8.4 核对
      }
      return null;
    },

    /** 每日备份的状态（7.10）：{ ok, backup: { at, rev, trades, shots, missing } | null, message } */
    async backupStatus() {
      if (!remote || !remote.hasStoredSession()) return { ok: false, backup: null, message: '读不到备份状态（没登录）' };
      const r = await remote.getUser();
      if (r.error || !r.user) return { ok: false, backup: null, message: '读不到备份状态' + (r.error && r.error.network ? '（连不上云端）' : '') };
      const meta = r.user.user_metadata || {};
      return { ok: true, backup: meta.tj_backup && typeof meta.tj_backup === 'object' ? meta.tj_backup : null, message: '' };
    },

    destroy() {
      destroyed = true;
      clearRetry();
      stopPolling();
      if (pushTimer !== null) timers.clearTimeout(pushTimer);
      for (const fn of detach.splice(0)) { try { fn(); } catch (err) { /* 已经拆了 */ } }
      listeners.clear();
    },
  };
  return api;
}
