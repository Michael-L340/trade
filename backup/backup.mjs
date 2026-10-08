#!/usr/bin/env node
// 交易日志每日备份（放在私有仓库 Michael-L340/trade-journal-backup 的根目录，由 .github/workflows/backup.yml 调用）。
// Node 20+，零依赖：用全局 fetch 直接调 GitHub API、Supabase Auth / REST / Storage。
//
// 分两步跑，中间由 workflow 提交推送：
//   node backup.mjs           拉取：确认仓库私有 → 登录 → 读 tj_journal → 校验 → 笔数闸门
//                             → 写 journal.json → 增量下载截图到 shots/ → 写 state.json → 退出登录
//   （workflow：git add 只添加不删除；有变化才 commit + push）
//   node backup.mjs --report  汇报：登录 → 把 state.json 写进 user_metadata.tj_backup → 退出登录
//                             → state.json 里有缺图就以非零退出码结束（让这次 Action 变红）
// 这样"推送成功之后才告诉网站备份好了"（规格 8.7 第 9 步）。
//
// 环境变量：SUPABASE_URL、SUPABASE_KEY（publishable key）、TJ_EMAIL、TJ_PASSWORD、
//           GITHUB_REPOSITORY、GITHUB_TOKEN（Actions 自带）、ALLOW_DROP（填 yes 才放行笔数大减）。
// 密码和令牌不进任何文件、日志和报错信息。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 这个脚本认识的 schemaVersion。网站升版时这里要一起改（规格 5.1）。 */
export const KNOWN_SCHEMA_VERSIONS = Object.freeze([1]);
export const BUCKET = 'tj-shots';
const DOWNLOAD_CONCURRENCY = 4;

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ───────── 5.2 固定格式 ─────────

const TOP_KEYS = ['schemaVersion', 'appVersion', 'currency', 'rows'];
const SYSTEM_KEYS = ['type', 'id', 'name', 'desc', 'createdAt'];
const TRADE_KEYS = ['type', 'id', 'date', 'symbol', 'direction', 'rr', 'risk', 'result', 'pnlOverride', 'reason', 'note', 'shots', 'createdAt', 'updatedAt'];
const SHOT_KEYS = ['id', 'label', 'file', 'thumb', 'width', 'height', 'bytes', 'addedAt'];

/** 已知键按固定顺序在前（缺的不补），不认识的键接在后面，保持原来的相对顺序。 */
function orderedKeys(obj, known) {
  return known.filter((k) => hasOwn(obj, k)).concat(Object.keys(obj).filter((k) => !known.includes(k)));
}

function objectJson(obj, keys, valueJson) {
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + valueJson(obj[k], k)).join(',') + '}';
}

const plain = (v) => JSON.stringify(v);

function shotJson(shot) {
  return isObj(shot) ? objectJson(shot, orderedKeys(shot, SHOT_KEYS), plain) : plain(shot);
}

function rowJson(row) {
  if (!isObj(row)) return plain(row);
  const known = row.type === 'system' ? SYSTEM_KEYS : row.type === 'trade' ? TRADE_KEYS : ['type', 'id'];
  return objectJson(row, orderedKeys(row, known), (v, k) => (
    k === 'shots' && Array.isArray(v) ? '[' + v.map(shotJson).join(',') + ']' : plain(v)
  ));
}

/**
 * journal.json 的固定格式（规格 5.2）：UTF-8 无 BOM、\n 换行、末尾一个换行；
 * 顶层每个键一行（缩进 2）；rows 里每个 row 一行（缩进 4，紧凑 JSON）；键顺序固定。
 * JSON.stringify 不转义中文，正合要求。
 */
export function formatJournal(doc) {
  const keys = orderedKeys(doc, TOP_KEYS);
  const lines = ['{'];
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    const v = doc[k];
    if (k === 'rows' && Array.isArray(v)) {
      if (!v.length) { lines.push('  "rows": []' + comma); return; }
      lines.push('  "rows": [');
      v.forEach((row, n) => lines.push('    ' + rowJson(row) + (n < v.length - 1 ? ',' : '')));
      lines.push('  ]' + comma);
      return;
    }
    lines.push('  ' + JSON.stringify(k) + ': ' + plain(v) + comma);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

// 规格 5.2 原文给出的样例：附录 A 只留前两行时的写出结果。启动时拿它自检，键顺序打乱后也必须写出同样的字节。
const SELFCHECK_EXPECTED = [
  '{',
  '  "schemaVersion": 1,',
  '  "currency": "$",',
  '  "rows": [',
  '    {"type":"system","id":"sys_a","name":"趋势回调","desc":"顺日线趋势，H1 回踩前高或前低，出现反转 K 线后进场；止损放在回踩低点外。","createdAt":"2026-09-01T08:00:00Z"},',
  '    {"type":"trade","id":"t_01","date":"2026-09-01","symbol":"XAUUSD","direction":"long","rr":2,"risk":100,"result":"win","pnlOverride":null,"reason":"日线上升结构（HH/HL），H1 回踩前高 4105 转支撑，收出看涨吞没后进场。","note":"按计划 2 倍止盈。","shots":[]}',
  '  ]',
  '}',
  '',
].join('\n');

export function selfCheck() {
  const doc = JSON.parse(SELFCHECK_EXPECTED);
  const shuffle = (o) => Object.fromEntries(Object.entries(o).reverse());
  const shuffled = shuffle({ ...doc, rows: doc.rows.map(shuffle) });
  for (const d of [doc, shuffled]) {
    if (formatJournal(d) !== SELFCHECK_EXPECTED) throw new BackupError('自检失败：formatJournal 写出的结果和规格 5.2 的样例不一致');
  }
}

// ───────── 结构检查（规格 8.7 第 4 步） ─────────

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const FILE_NAME = /^[A-Za-z0-9_.-]+$/;

function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const posNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);

/** 截图路径必须是 shots/<交易 id>/<文件名>，不许 .. 和多余的层级（也防止写到仓库目录外面）。 */
function shotPathOk(p, tradeId) {
  if (typeof p !== 'string') return false;
  const parts = p.split('/');
  return parts.length === 3 && parts[0] === 'shots' && parts[1] === tradeId
    && FILE_NAME.test(parts[2]) && parts[2] !== '.' && parts[2] !== '..';
}

/** 返回错误列表，空数组表示通过。 */
export function validateDoc(doc) {
  const errs = [];
  if (!isObj(doc)) return ['doc 不是 JSON 对象'];
  if (!KNOWN_SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
    errs.push(`schemaVersion 是 ${JSON.stringify(doc.schemaVersion)}，备份脚本只认识 ${KNOWN_SCHEMA_VERSIONS.join('、')}（网站升版了就要同步改 backup.mjs）`);
  }
  if (doc.appVersion !== undefined && typeof doc.appVersion !== 'string') errs.push('appVersion 必须是字符串');
  if (typeof doc.currency !== 'string') errs.push('currency 必须是字符串');
  if (!Array.isArray(doc.rows)) return [...errs, 'rows 必须是数组'];
  if (!doc.rows.length || !isObj(doc.rows[0]) || doc.rows[0].type !== 'system') errs.push('第一行必须是系统行');
  const seen = new Set();
  const useId = (id, where) => {
    if (seen.has(id)) errs.push(`${where}的 id ${id} 重复`);
    seen.add(id);
  };
  doc.rows.forEach((row, i) => {
    const at = `第 ${i + 1} 行`;
    if (!isObj(row)) { errs.push(`${at}不是对象`); return; }
    if (row.type !== 'system' && row.type !== 'trade') { errs.push(`${at}的 type 必须是 system 或 trade`); return; }
    const prefix = row.type === 'system' ? 'sys_' : 't_';
    if (typeof row.id !== 'string' || !row.id.startsWith(prefix) || !ID_PATTERN.test(row.id)) {
      errs.push(`${at}的 id 必须以 ${prefix} 开头、只含字母数字下划线连字符`);
      return;
    }
    useId(row.id, at);
    const str = (f) => { if (typeof row[f] !== 'string') errs.push(`${at}（${row.id}）的 ${f} 必须是字符串`); };
    const optStr = (f) => { if (row[f] !== undefined && typeof row[f] !== 'string') errs.push(`${at}（${row.id}）的 ${f} 必须是字符串`); };
    if (row.type === 'system') {
      str('name'); str('desc'); optStr('createdAt');
      return;
    }
    const bad = (msg) => errs.push(`${at}（${row.id}）${msg}`);
    if (!isRealDate(row.date)) bad('的 date 必须是真实日期 YYYY-MM-DD');
    str('symbol'); str('reason'); str('note'); optStr('createdAt'); optStr('updatedAt');
    if (row.direction !== 'long' && row.direction !== 'short') bad('的 direction 必须是 long 或 short');
    if (!posNumOrNull(row.rr)) bad('的 rr 必须是大于 0 的数字或 null');
    if (!posNumOrNull(row.risk)) bad('的 risk 必须是大于 0 的数字或 null');
    if (row.result !== 'win' && row.result !== 'loss' && row.result !== null) bad('的 result 必须是 win、loss 或 null');
    if (row.pnlOverride !== null && !(typeof row.pnlOverride === 'number' && Number.isFinite(row.pnlOverride))) bad('的 pnlOverride 必须是数字或 null');
    if (!Array.isArray(row.shots)) { bad('的 shots 必须是数组'); return; }
    row.shots.forEach((s, k) => {
      const sat = `的第 ${k + 1} 张截图`;
      if (!isObj(s)) { bad(sat + '不是对象'); return; }
      if (typeof s.id !== 'string' || !s.id.startsWith('sh_') || !ID_PATTERN.test(s.id)) bad(sat + '的 id 必须以 sh_ 开头');
      else useId(s.id, `${at}${sat}`);
      if (typeof s.label !== 'string') bad(sat + '的 label 必须是字符串（open、close、空串或自己写的字）');
      if (!shotPathOk(s.file, row.id)) bad(`${sat}的 file 必须在 shots/${row.id}/ 下，实际是 ${JSON.stringify(s.file)}`);
      if (s.thumb !== undefined && !shotPathOk(s.thumb, row.id)) bad(`${sat}的 thumb 必须在 shots/${row.id}/ 下，实际是 ${JSON.stringify(s.thumb)}`);
      for (const f of ['width', 'height', 'bytes']) {
        if (s[f] !== undefined && !(Number.isInteger(s[f]) && s[f] >= 0)) bad(`${sat}的 ${f} 必须是不小于 0 的整数`);
      }
    });
  });
  return errs;
}

export function countTrades(doc) {
  return doc.rows.filter((r) => r.type === 'trade').length;
}

export function countShots(doc) {
  return doc.rows.reduce((n, r) => n + (r.type === 'trade' ? r.shots.length : 0), 0);
}

// ───────── 笔数闸门（规格 8.7 第 5 步） ─────────

/**
 * prev：上次 state.json 里的笔数（第一次运行时为 null，不比）。
 * 允许减少 max(3, 上次的 5%) 笔以内；超过要 allowDrop 才放行。
 * 交易一笔不剩而上次不是 0：一律拒绝，allowDrop 也不放行。
 * 返回 null 表示通过，否则是拒绝的理由。
 */
export function checkGate(prev, now, allowDrop = false) {
  if (prev === null || prev === undefined) return null;
  if (now === 0 && prev > 0) return `交易一笔都不剩了（上次 ${prev} 笔），拒绝提交。云端可能被清空，先去网站看看`;
  const drop = prev - now;
  const limit = Math.max(3, prev * 0.05);
  if (drop > limit && !allowDrop) {
    return `交易笔数从 ${prev} 降到 ${now}，少了 ${drop} 笔，超过允许的 ${Math.floor(limit)} 笔，拒绝提交。`
      + '确实是删了一批的话，到 Actions 页手动运行"每日备份"，allow_drop 选 yes';
  }
  return null;
}

// ───────── HTTP ─────────

function cfg(env) {
  const need = ['SUPABASE_URL', 'SUPABASE_KEY', 'TJ_EMAIL', 'TJ_PASSWORD'];
  const lack = need.filter((k) => !env[k]);
  if (lack.length) throw new BackupError(`缺环境变量：${lack.join('、')}（Actions 里由仓库 Secret TJ_SUPABASE_URL、TJ_SUPABASE_KEY、TJ_EMAIL、TJ_PASSWORD 传入）`);
  return { url: env.SUPABASE_URL.replace(/\/+$/, ''), key: env.SUPABASE_KEY };
}

async function failText(res) {
  let body = '';
  try { body = (await res.text()).slice(0, 300); } catch { /* 读不到正文就算了 */ }
  return `HTTP ${res.status}${body ? ' ' + body : ''}`;
}

export async function checkRepoPrivate(env, fetchFn) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !env.GITHUB_TOKEN) throw new BackupError('缺 GITHUB_REPOSITORY 或 GITHUB_TOKEN，确认不了仓库是不是私有的，拒绝运行');
  const res = await fetchFn(`https://api.github.com/repos/${repo}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trade-journal-backup',
    },
  });
  if (!res.ok) throw new BackupError(`查不到仓库 ${repo} 的信息：${await failText(res)}`);
  const info = await res.json();
  if (info.private !== true) throw new BackupError(`仓库 ${repo} 不是私有的，拒绝备份。先在 Settings 里改回 Private`);
}

async function login(c, env, fetchFn) {
  const res = await fetchFn(`${c.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.TJ_EMAIL, password: env.TJ_PASSWORD }),
  });
  if (!res.ok) throw new BackupError(`登录失败：${await failText(res)}（密码改过的话，记得更新 TJ_PASSWORD）`);
  const s = await res.json();
  if (!s || typeof s.access_token !== 'string' || !s.user || typeof s.user.id !== 'string') {
    throw new BackupError('登录返回的内容里没有 access_token 或 user.id');
  }
  return { token: s.access_token, userId: s.user.id };
}

const authHeaders = (c, sess) => ({ apikey: c.key, Authorization: `Bearer ${sess.token}` });

async function logout(c, sess, fetchFn, log) {
  // scope=local：只退出脚本这一次的会话。global 会把浏览器也踢下线。
  try {
    const res = await fetchFn(`${c.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: authHeaders(c, sess) });
    if (!res.ok) log(`退出登录没成功（${res.status}），不影响备份`);
  } catch (e) {
    log(`退出登录没成功（${e.message}），不影响备份`);
  }
}

async function fetchJournal(c, sess, fetchFn) {
  const res = await fetchFn(`${c.url}/rest/v1/tj_journal?select=rev,doc,updated_at`, {
    headers: { ...authHeaders(c, sess), Accept: 'application/json', Prefer: 'count=exact' },
  });
  if (!res.ok) throw new BackupError(`读 tj_journal 失败：${await failText(res)}`);
  const rows = await res.json();
  const range = res.headers.get('content-range') || '';
  const total = range.includes('/') ? range.split('/').pop() : '';
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new BackupError(`tj_journal 应该正好拿到 1 行，实际 ${Array.isArray(rows) ? rows.length : '不是数组'}（网站还没保存过的话，先在网站上记一笔）`);
  }
  if (total !== '1') throw new BackupError(`tj_journal 的 Content-Range 是 "${range}"，总数应该是 1`);
  const { rev, doc } = rows[0];
  if (!Number.isInteger(rev) || rev < 1) throw new BackupError(`tj_journal 的 rev 不对：${JSON.stringify(rev)}`);
  return { rev, doc };
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ───────── 本地文件 ─────────

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new BackupError(`${file} 读不出来：${e.message}`);
  }
}

async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/**
 * 仓库里已有的截图。workflow 用稀疏检出，旧图不在磁盘上，所以看 git 的 HEAD 树（不下载图本身）；
 * 不是 git 仓库或还没有提交时返回空集合，再由调用方用磁盘上是否存在兜底。
 */
export function gitTrackedShots(dir) {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'shots/'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return new Set();
  }
}

/** state.json 去掉 at 以后的内容，用来判断"有没有变化"。 */
const stateBody = (s) => (s ? JSON.stringify({ ...s, at: undefined }) : '');

// ───────── 第一步：拉取 ─────────

/**
 * @param {object} o
 * @param {Record<string,string|undefined>} o.env
 * @param {typeof fetch} o.fetch
 * @param {string} o.dir 备份仓库的工作目录
 * @param {() => Date} [o.now]
 * @param {(dir: string) => Set<string>} [o.trackedShots]
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{rev:number, trades:number, shots:number, downloaded:string[], missing:object[]}>}
 */
export async function runBackup(o) {
  const { env, dir } = o;
  const fetchFn = o.fetch;
  const now = o.now || (() => new Date());
  const log = o.log || ((m) => console.log(m));
  const tracked = (o.trackedShots || gitTrackedShots)(dir);

  selfCheck();
  const c = cfg(env);
  await checkRepoPrivate(env, fetchFn);

  const sess = await login(c, env, fetchFn);
  try {
    const { rev, doc } = await fetchJournal(c, sess, fetchFn);

    const errs = validateDoc(doc);
    if (errs.length) throw new BackupError('日志结构检查没通过，拒绝提交：\n  ' + errs.slice(0, 20).join('\n  '));

    const statePath = join(dir, 'state.json');
    const prevState = await readJson(statePath);
    const trades = countTrades(doc);
    const shots = countShots(doc);
    const prevTrades = prevState && Number.isInteger(prevState.trades) ? prevState.trades : null;
    const gate = checkGate(prevTrades, trades, env.ALLOW_DROP === 'yes');
    if (gate) throw new BackupError(gate);
    if (prevTrades !== null && trades < prevTrades) log(`交易笔数 ${prevTrades} → ${trades}，在允许范围内`);

    // journal.json
    const journalPath = join(dir, 'journal.json');
    const text = formatJournal(doc);
    const journalChanged = (await readText(journalPath)) !== text;
    await writeFile(journalPath, text, 'utf8');

    // 截图增量：仓库里已有的不重下；拿不到或字节数不对的记进缺图清单，接着往下走
    const jobs = [];
    const queued = new Set();
    let tradeNo = 0;
    for (const row of doc.rows) {
      if (row.type !== 'trade') continue;
      tradeNo++;
      for (const s of row.shots) {
        for (const [path, bytes] of [[s.file, s.bytes], [s.thumb, undefined]]) {
          if (path === undefined || queued.has(path)) continue;
          queued.add(path);
          if (tracked.has(path) || existsSync(join(dir, path))) continue;
          jobs.push({ trade: tradeNo, tradeId: row.id, file: path, bytes });
        }
      }
    }
    const downloaded = [];
    const missing = [];
    const one = async (job) => {
      let reason;
      try {
        const res = await fetchFn(`${c.url}/storage/v1/object/authenticated/${BUCKET}/${sess.userId}/${encodePath(job.file)}`, {
          headers: authHeaders(c, sess),
        });
        if (!res.ok) {
          reason = res.status === 400 || res.status === 404 ? '桶里没有这个文件' : `下载失败 HTTP ${res.status}`;
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (job.bytes !== undefined && buf.length !== job.bytes) {
            reason = `字节数不对：下载到 ${buf.length}，doc 里记的是 ${job.bytes}`;
          } else {
            const target = join(dir, job.file);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, buf);
            downloaded.push(job.file);
          }
        }
      } catch (e) {
        reason = `下载出错：${e.message}`;
      }
      if (reason) missing.push({ trade: job.trade, tradeId: job.tradeId, file: job.file, reason });
    };
    const queue = jobs.slice();
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await one(queue.shift());
    }));
    // 并发下载完成顺序不定，按引用顺序排，保证同样的缺图写出同样的 state.json
    const order = new Map(jobs.map((j, i) => [j.file, i]));
    missing.sort((a, b) => order.get(a.file) - order.get(b.file));
    downloaded.sort((a, b) => order.get(a) - order.get(b));

    // state.json：at 只在内容有变化时更新，没变化就逐字节不变，不产生提交
    const next = { at: '', rev, trades, shots, missing };
    const changed = journalChanged || downloaded.length > 0 || stateBody(prevState) !== stateBody(next);
    next.at = !changed && prevState && typeof prevState.at === 'string' ? prevState.at : now().toISOString();
    await writeFile(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8');

    log(`rev ${rev}，交易 ${trades} 笔，截图 ${shots} 张；本次新下载 ${downloaded.length} 个文件，缺 ${missing.length} 个`);
    for (const m of missing) log(`  缺图：第 ${m.trade} 笔（${m.tradeId}）${m.file}：${m.reason}`);
    return { rev, trades, shots, downloaded, missing };
  } finally {
    await logout(c, sess, fetchFn, log);
  }
}

// ───────── 第二步：推送成功后汇报 ─────────

/** 把 state.json 写进 user_metadata.tj_backup。返回缺图张数，调用方据此决定退出码。 */
export async function runReport(o) {
  const { env, dir } = o;
  const fetchFn = o.fetch;
  const now = o.now || (() => new Date());
  const log = o.log || ((m) => console.log(m));
  const c = cfg(env);
  const state = await readJson(join(dir, 'state.json'));
  if (!state || !Array.isArray(state.missing)) throw new BackupError('没有 state.json，先运行 node backup.mjs');

  const tjBackup = { at: now().toISOString(), rev: state.rev, trades: state.trades, shots: state.shots, missing: state.missing.length };
  const sess = await login(c, env, fetchFn);
  try {
    // GoTrue 按顶层键合并 user_metadata，不会动别的键
    const res = await fetchFn(`${c.url}/auth/v1/user`, {
      method: 'PUT',
      headers: { ...authHeaders(c, sess), 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { tj_backup: tjBackup } }),
    });
    if (!res.ok) throw new BackupError(`写备份状态失败：${await failText(res)}`);
  } finally {
    await logout(c, sess, fetchFn, log);
  }
  log(`备份状态已写入：${JSON.stringify(tjBackup)}`);
  if (state.missing.length) {
    log(`有 ${state.missing.length} 个截图文件没备份到（journal.json 和拿到的图已经提交）：`);
    for (const m of state.missing) log(`  第 ${m.trade} 笔（${m.tradeId}）${m.file}：${m.reason}`);
  }
  return state.missing.length;
}

// ───────── 入口 ─────────

async function main() {
  const dir = process.cwd();
  const o = { env: process.env, fetch: globalThis.fetch, dir };
  if (process.argv.includes('--report')) {
    const missing = await runReport(o);
    process.exitCode = missing ? 1 : 0;
  } else {
    await runBackup(o);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof BackupError ? e.message : `备份出错：${e && e.stack || e}`);
    process.exitCode = 1;
  });
}
