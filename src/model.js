// 数据模型（交接文档第 5 节）：生成 id、新建行、清洗文字、校验、版本迁移、固定格式序列化。
// 纯函数，不碰 DOM。派生值（止盈、盈亏、R、统计）不进数据，见 calc.js。

import { isIsoDate, todayLocal } from './format.js';

/** 数据格式版本。读到比它新的数据时拒绝写入，提示刷新页面。 */
export const SCHEMA_VERSION = 1;
/** 网站版本号，显示在页面底部，方便确认部署后看到的是不是新版。每次发布改一下。 */
export const APP_VERSION = '0.1.0';
/** 金额单位的默认值 */
export const DEFAULT_CURRENCY = '$';

/** 序列化时的键顺序；不认识的键排在这些后面，按字母序。 */
export const TOP_KEYS = Object.freeze(['schemaVersion', 'currency', 'rows']);
export const SYSTEM_KEYS = Object.freeze(['type', 'id', 'name', 'desc', 'createdAt']);
export const TRADE_KEYS = Object.freeze(['type', 'id', 'date', 'symbol', 'direction', 'rr', 'risk', 'result', 'pnlOverride', 'reason', 'note', 'shots', 'createdAt', 'updatedAt']);
export const SHOT_KEYS = Object.freeze(['id', 'label', 'file', 'thumb', 'width', 'height', 'bytes', 'addedAt']);

/** 数据层的错误。code：'NEWER_SCHEMA'（数据比网站新）、'INVALID'（校验没过）、'BAD_JSON'（不是 JSON） */
export class ModelError extends Error {
  constructor(code, message, errors = []) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.errors = errors;
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------- id 和时间 ----------

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s.slice(0, length);
}

/**
 * 生成随机 id：前缀（'sys_'、't_'、'sh_'）+ 12 位十六进制。生成后不再改变。
 * @param {string} prefix
 * @param {Set<string>|((id: string) => boolean)} [taken] 已经用掉的 id，碰上就重新生成
 */
export function newId(prefix, taken) {
  for (;;) {
    const id = prefix + randomHex(12);
    const clash = typeof taken === 'function' ? taken(id) : taken ? taken.has(id) : false;
    if (!clash) return id;
  }
}

/** ISO 时间串，精确到秒：2026-09-10T14:30:00Z */
export function isoNow(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- 文字清洗 ----------

/**
 * 文字入库前清洗：去掉 U+0000，把孤立的代理项换成 U+FFFD（String.prototype.toWellFormed）。
 * 不 trim：用户正在输入时首尾空格也是内容。非字符串返回空串。
 */
export function cleanText(s) {
  if (typeof s !== 'string') return '';
  const t = s.indexOf('\x00') === -1 ? s : s.split('\x00').join('');
  if (typeof t.toWellFormed === 'function') return t.toWellFormed();
  return t.replace(/[\u{D800}-\u{DFFF}]/gu, '\u{FFFD}'); // u 模式下只会匹配到孤立的代理项
}

// ---------- 新建行 ----------

/**
 * 新建系统行。
 * @param {{name?: string, desc?: string}} [fields]
 * @param {{now?: Date, taken?: Set<string>|Function}} [opts]
 */
export function newSystemRow(fields = {}, opts = {}) {
  return {
    type: 'system',
    id: newId('sys_', opts.taken),
    name: cleanText(fields.name ?? ''),
    desc: cleanText(fields.desc ?? ''),
    createdAt: isoNow(opts.now),
  };
}

/**
 * 新建一笔交易。fields 里的字段按 sanitizeTradePatch 的规则清洗，不合规的忽略。
 * 默认：日期是今天（本地时区）、方向"多"、其余为空。
 * @param {object} [fields]
 * @param {{now?: Date, taken?: Set<string>|Function}} [opts]
 */
export function newTrade(fields = {}, opts = {}) {
  const now = opts.now || new Date();
  const ts = isoNow(now);
  const trade = {
    type: 'trade',
    id: newId('t_', opts.taken),
    date: todayLocal(now),
    symbol: '',
    direction: 'long',
    rr: null,
    risk: null,
    result: null,
    pnlOverride: null,
    reason: '',
    note: '',
    shots: [],
    createdAt: ts,
    updatedAt: ts,
  };
  return Object.assign(trade, sanitizeTradePatch(fields).patch);
}

/** 只有系统行的一份空数据（首次使用时）。 */
export function emptyJournal(opts = {}) {
  return { schemaVersion: SCHEMA_VERSION, currency: DEFAULT_CURRENCY, rows: [newSystemRow({}, opts)] };
}

// ---------- 修改内容的清洗 ----------

function positiveOrNull(v) {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'number' || Number.isNaN(v)) return { ok: false };
  return { ok: true, value: Number.isFinite(v) && v > 0 ? v : null }; // 0、负数、无穷当作没填
}

/**
 * 清洗对交易的修改：只留认识的字段，值不合规的丢掉（记在 rejected 里）。
 * - date：真实存在的 'YYYY-MM-DD'；symbol、reason、note：字符串，做 cleanText；
 * - direction：'long' | 'short'；result：'win' | 'loss' | null；
 * - rr、risk：大于 0 的数字或 null，填 0 或负数当作清空；pnlOverride：有限数字或 null；
 * - shots：数组（截图功能下一步再细化）。
 * @returns {{patch: object, rejected: string[]}}
 */
export function sanitizeTradePatch(fields) {
  const patch = {};
  const rejected = [];
  if (!isPlainObject(fields)) return { patch, rejected };
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    switch (key) {
      case 'date':
        if (isIsoDate(v)) patch.date = v; else rejected.push(key);
        break;
      case 'symbol':
      case 'reason':
      case 'note':
        if (typeof v === 'string') patch[key] = cleanText(v); else rejected.push(key);
        break;
      case 'direction':
        if (v === 'long' || v === 'short') patch.direction = v; else rejected.push(key);
        break;
      case 'rr':
      case 'risk': {
        const r = positiveOrNull(v);
        if (r.ok) patch[key] = r.value; else rejected.push(key);
        break;
      }
      case 'result':
        if (v === 'win' || v === 'loss' || v === null) patch.result = v; else rejected.push(key);
        break;
      case 'pnlOverride':
        if (v === null || (typeof v === 'number' && Number.isFinite(v))) patch.pnlOverride = v === 0 ? 0 : v; else rejected.push(key);
        break;
      case 'shots':
        if (Array.isArray(v) && v.every(isPlainObject)) patch.shots = v.map((s) => ({ ...s })); else rejected.push(key);
        break;
      default:
        rejected.push(key);
    }
  }
  return { patch, rejected };
}

/** 清洗对系统行的修改：name、desc 两个字符串字段。 */
export function sanitizeSystemPatch(fields) {
  const patch = {};
  const rejected = [];
  if (!isPlainObject(fields)) return { patch, rejected };
  for (const key of Object.keys(fields)) {
    if ((key === 'name' || key === 'desc') && typeof fields[key] === 'string') patch[key] = cleanText(fields[key]);
    else rejected.push(key);
  }
  return { patch, rejected };
}

// ---------- 校验 ----------

const FIELD_LABEL = {
  type: '类型', id: 'id', name: '系统名称', desc: '系统说明', date: '日期', symbol: '品种', direction: '方向',
  rr: '盈亏比', risk: '止损金额', result: '结果', pnlOverride: '手改的盈亏金额', reason: '开仓理由', note: '备注',
  shots: '截图', createdAt: '创建时间', updatedAt: '修改时间', label: '截图标签', file: '截图文件', thumb: '缩略图文件',
  width: '宽度', height: '高度', bytes: '文件大小', addedAt: '添加时间',
};

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 校验整份数据，返回错误列表（空数组表示没问题）。每条错误：
 * { row: 第几行（rows 里从 1 数起，顶层字段为 null）, id, field, message }，message 是可以直接给用户看的中文。
 * 不认识的字段不算错，会原样保留。
 */
export function validateJournal(j) {
  const errors = [];
  if (!isPlainObject(j)) return [{ row: null, id: null, field: null, message: '数据不是一个 JSON 对象' }];
  const top = (field, problem) => errors.push({ row: null, id: null, field, message: `${field} ${problem}` });
  if (!Number.isInteger(j.schemaVersion) || j.schemaVersion < 1) top('schemaVersion', '必须是正整数');
  else if (j.schemaVersion > SCHEMA_VERSION) top('schemaVersion', `是 ${j.schemaVersion}，比这个网站支持的 ${SCHEMA_VERSION} 新`);
  if (typeof j.currency !== 'string') top('currency', '（金额单位）必须是字符串');
  if (!Array.isArray(j.rows)) {
    top('rows', '必须是数组');
    return errors;
  }
  const seen = new Set();
  j.rows.forEach((row, i) => {
    const rowNo = i + 1;
    const rowId = isPlainObject(row) && typeof row.id === 'string' ? row.id : null;
    const bad = (field, problem) => errors.push({
      row: rowNo, id: rowId, field,
      message: `第 ${rowNo} 行${rowId ? `（${rowId}）` : ''}${field ? `${FIELD_LABEL[field] || field}（${field}）` : ''}${problem}`,
    });
    if (!isPlainObject(row)) { bad(null, '不是一个对象'); return; }
    if (row.type !== 'system' && row.type !== 'trade') { bad('type', '必须是 "system" 或 "trade"'); return; }
    const prefix = row.type === 'system' ? 'sys_' : 't_';
    if (typeof row.id !== 'string' || !row.id.startsWith(prefix) || !ID_PATTERN.test(row.id)) bad('id', `必须是以 ${prefix} 开头、只含字母数字下划线和连字符的字符串`);
    else if (seen.has(row.id)) bad('id', '和前面的行重复');
    else seen.add(row.id);
    const str = (f) => { if (typeof row[f] !== 'string') bad(f, '必须是字符串'); };
    const optStr = (f) => { if (row[f] !== undefined && typeof row[f] !== 'string') bad(f, '必须是字符串'); };
    if (row.type === 'system') {
      str('name');
      str('desc');
      optStr('createdAt');
      return;
    }
    if (!isIsoDate(row.date)) bad('date', '必须是真实存在的日期，格式 YYYY-MM-DD');
    str('symbol');
    if (row.direction !== 'long' && row.direction !== 'short') bad('direction', '必须是 "long" 或 "short"');
    for (const f of ['rr', 'risk']) {
      if (row[f] !== null && !(typeof row[f] === 'number' && Number.isFinite(row[f]) && row[f] > 0)) bad(f, '必须是大于 0 的数字或 null');
    }
    if (row.result !== 'win' && row.result !== 'loss' && row.result !== null) bad('result', '必须是 "win"、"loss" 或 null');
    if (row.pnlOverride !== null && !(typeof row.pnlOverride === 'number' && Number.isFinite(row.pnlOverride))) bad('pnlOverride', '必须是数字或 null');
    str('reason');
    str('note');
    optStr('createdAt');
    optStr('updatedAt');
    if (!Array.isArray(row.shots)) { bad('shots', '必须是数组'); return; }
    row.shots.forEach((shot, k) => {
      const at = `的第 ${k + 1} 张`;
      if (!isPlainObject(shot)) { bad('shots', at + '不是一个对象'); return; }
      if (typeof shot.id !== 'string' || !shot.id.startsWith('sh_') || !ID_PATTERN.test(shot.id)) bad('shots', at + '的 id 必须以 sh_ 开头');
      else if (seen.has(shot.id)) bad('shots', at + '的 id 和别处重复');
      else seen.add(shot.id);
      if (shot.label !== 'open' && shot.label !== 'close' && shot.label !== '') bad('shots', at + '的标签（label）必须是 "open"、"close" 或空串');
      if (typeof shot.file !== 'string') bad('shots', at + '的文件路径（file）必须是字符串');
      if (shot.thumb !== undefined && typeof shot.thumb !== 'string') bad('shots', at + '的缩略图路径（thumb）必须是字符串');
      for (const f of ['width', 'height', 'bytes']) {
        if (shot[f] !== undefined && !(typeof shot[f] === 'number' && Number.isFinite(shot[f]) && shot[f] >= 0)) bad('shots', at + `的 ${f} 必须是不小于 0 的数字`);
      }
      if (shot.addedAt !== undefined && typeof shot.addedAt !== 'string') bad('shots', at + '的添加时间（addedAt）必须是字符串');
    });
  });
  return errors;
}

// ---------- 版本迁移 ----------

/**
 * 从版本 k 升到 k + 1 的规则写在 MIGRATIONS[k] 里，例如：
 *   1: (j) => ({ ...j, schemaVersion: 2, rows: j.rows.map(...) }),
 * 现在只有版本 1，表是空的。
 */
const MIGRATIONS = {};

/**
 * 按 schemaVersion 把数据升级到当前版本。不改动入参。
 * 数据比网站新时抛 ModelError('NEWER_SCHEMA')：这时不能写入，要提示用户刷新页面。
 */
export function migrate(j) {
  if (!isPlainObject(j)) throw new ModelError('INVALID', '数据不是一个 JSON 对象');
  const v = j.schemaVersion;
  if (!Number.isInteger(v) || v < 1) throw new ModelError('INVALID', 'schemaVersion 必须是正整数');
  if (v > SCHEMA_VERSION) {
    throw new ModelError('NEWER_SCHEMA', `这份数据是更新版本的网站保存的（数据版本 ${v}，本页面只认到 ${SCHEMA_VERSION}）。为了不覆盖它，本页面不会写入。请按 Ctrl+F5 刷新，加载最新版网站。`);
  }
  let out = j;
  for (let k = v; k < SCHEMA_VERSION; k++) {
    const step = MIGRATIONS[k];
    if (!step) throw new ModelError('INVALID', `缺少从数据版本 ${k} 升级的规则`);
    out = step(out);
  }
  return out;
}

/** 保证第一行是系统行：不是就在最前面补一个名称为空的系统行。没变化时原样返回同一个对象。 */
export function ensureFirstSystemRow(j, opts = {}) {
  const rows = Array.isArray(j.rows) ? j.rows : [];
  if (rows.length && isPlainObject(rows[0]) && rows[0].type === 'system') return j;
  const taken = new Set(rows.map((r) => r && r.id));
  return { ...j, rows: [newSystemRow({}, { ...opts, taken }), ...rows] };
}

function cleanRowText(row) {
  if (row.type === 'system') return { ...row, name: cleanText(row.name), desc: cleanText(row.desc) };
  return { ...row, symbol: cleanText(row.symbol), reason: cleanText(row.reason), note: cleanText(row.note) };
}

/**
 * 把读进来的数据（本机存储或用户选的 journal.json）整理成可以直接用的样子：
 * 深拷贝 → 迁移 → 校验 → 清洗文字 → 保证第一行是系统行。不改动入参。
 * 校验不过抛 ModelError('INVALID')，errors 里是逐条的错误；数据比网站新抛 'NEWER_SCHEMA'。
 */
export function normalizeJournal(raw, opts = {}) {
  let copy;
  try {
    copy = structuredClone(raw);
  } catch (e) {
    throw new ModelError('INVALID', '数据里有无法保存的内容（' + e.message + '）');
  }
  copy = migrate(copy);
  const errors = validateJournal(copy);
  if (errors.length) throw new ModelError('INVALID', `数据有 ${errors.length} 处问题：${errors[0].message}${errors.length > 1 ? ' 等' : ''}`, errors);
  const cleaned = { ...copy, currency: cleanText(copy.currency), rows: copy.rows.map(cleanRowText) };
  return ensureFirstSystemRow(cleaned, opts);
}

/**
 * 解析 journal.json 的文本（恢复备份用）。开头的 BOM 会去掉。
 * @returns {{ok: true, journal: object} | {ok: false, code: string, message: string, errors: object[]}}
 */
export function parseJournalText(text, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\u{FEFF}/u, ''));
  } catch (e) {
    return { ok: false, code: 'BAD_JSON', message: '文件不是有效的 JSON：' + e.message, errors: [] };
  }
  let journal;
  try {
    journal = normalizeJournal(raw, opts);
  } catch (e) {
    if (e instanceof ModelError) return { ok: false, code: e.code, message: e.message, errors: e.errors };
    throw e;
  }
  // 恢复时第一行必须本来就是系统行（不像首次使用那样自动补），否则交易会被悄悄挂到一个空系统下
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  if (!rows.length || !isPlainObject(rows[0]) || rows[0].type !== 'system') {
    const msg = rows.length ? `第 1 行（${rows[0] && rows[0].id ? rows[0].id : '无 id'}）的 type 应该是 "system"：第一行必须是系统行` : '文件里没有任何行：第一行必须是系统行';
    return { ok: false, code: 'INVALID', message: '数据有 1 处问题：' + msg, errors: [{ row: 1, field: 'type', message: msg }] };
  }
  try {
    return { ok: true, journal };
  } catch (e) {
    if (e instanceof ModelError) return { ok: false, code: e.code, message: e.message, errors: e.errors };
    throw e;
  }
}

// ---------- 固定格式序列化 ----------

function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canonicalJson(x))).join(',') + ']';
  if (isPlainObject(v)) return objectJson(v, Object.keys(v).sort());
  return JSON.stringify(v);
}

function objectJson(obj, keys, valueJson = canonicalJson) {
  const parts = [];
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined || typeof val === 'function') continue;
    parts.push(JSON.stringify(k) + ':' + valueJson(val, k));
  }
  return '{' + parts.join(',') + '}';
}

function orderedKeys(obj, known) {
  const own = Object.keys(obj);
  return known.filter((k) => hasOwn(obj, k)).concat(own.filter((k) => known.indexOf(k) === -1).sort());
}

function shotJson(shot) {
  return isPlainObject(shot) ? objectJson(shot, orderedKeys(shot, SHOT_KEYS)) : canonicalJson(shot);
}

function rowJson(row) {
  if (!isPlainObject(row)) return canonicalJson(row);
  const known = row.type === 'system' ? SYSTEM_KEYS : row.type === 'trade' ? TRADE_KEYS : ['type', 'id'];
  return objectJson(row, orderedKeys(row, known), (val, k) => (
    k === 'shots' && Array.isArray(val) ? '[' + val.map(shotJson).join(',') + ']' : canonicalJson(val)
  ));
}

/**
 * 固定格式的 journal.json 文本（导出和以后备份用）：
 * 每个 row 占一行；键顺序固定（已知字段按文档顺序，不认识的字段排在后面、按字母序，原样保留）；
 * 换行用 LF，末尾有换行。返回字符串，存成文件时按 UTF-8 编码（Blob 默认就是 UTF-8，不加 BOM）。
 */
export function serialize(journal) {
  const keys = orderedKeys(journal, TOP_KEYS).filter((k) => journal[k] !== undefined && typeof journal[k] !== 'function');
  const lines = ['{'];
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    const rows = journal[k];
    if (k === 'rows' && Array.isArray(rows)) {
      if (!rows.length) { lines.push('  "rows": []' + comma); return; }
      lines.push('  "rows": [');
      rows.forEach((row, n) => lines.push('    ' + rowJson(row) + (n < rows.length - 1 ? ',' : '')));
      lines.push('  ]' + comma);
      return;
    }
    lines.push('  ' + JSON.stringify(k) + ': ' + canonicalJson(journal[k]) + comma);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}
