// @ts-check
// journal.json 的固定写法（交接文档 5.2）。导出、算哈希（同步时核对"其实存上了没有"）、每日备份共用这一份。
// 备份仓库里的 backup/journal-format.mjs 是这个文件的原样拷贝（tests/journal-format.test.js 检查两份一致）。
// 不 import 任何东西，Node 和浏览器都能直接用。
//
// - UTF-8，不加 BOM，换行 \n，末尾一个换行；中文原样写出。
// - 顶层每个键一行（缩进 2 格）；rows 里每个 row 一行（缩进 4 格），row 本身是紧凑 JSON；没有行时写 "rows": []。
// - 已知键按固定顺序，缺的不补；不认识的键排在已知键后面，按原来的相对顺序（Object.keys 的顺序）原样写出，
//   它们里面的嵌套对象也保持原来的顺序（5.1：旧代码不能悄悄丢掉或打乱新代码加的字段）。

export const TOP_KEYS = Object.freeze(['schemaVersion', 'appVersion', 'currency', 'rows']);
export const SYSTEM_KEYS = Object.freeze(['type', 'id', 'name', 'desc', 'createdAt']);
export const TRADE_KEYS = Object.freeze(['type', 'id', 'date', 'symbol', 'direction', 'rr', 'risk', 'result', 'pnlOverride', 'reason', 'note', 'shots', 'createdAt', 'updatedAt']);
export const SHOT_KEYS = Object.freeze(['id', 'label', 'file', 'thumb', 'width', 'height', 'bytes', 'addedAt']);

/** @param {unknown} v */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const skip = (/** @type {unknown} */ v) => v === undefined || typeof v === 'function';

/** 原样的紧凑 JSON（键保持原来的顺序） */
function plainJson(/** @type {unknown} */ v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'null' : s;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @param {(val: unknown, key: string) => string} [valueJson]
 */
function objectJson(obj, keys, valueJson = plainJson) {
  const parts = [];
  for (const k of keys) {
    const val = obj[k];
    if (skip(val)) continue;
    parts.push(JSON.stringify(k) + ':' + valueJson(val, k));
  }
  return '{' + parts.join(',') + '}';
}

/** 已知键按固定顺序，再接不认识的键（原来的相对顺序） */
function orderedKeys(/** @type {Record<string, unknown>} */ obj, /** @type {readonly string[]} */ known) {
  const own = Object.keys(obj);
  return known.filter((k) => Object.prototype.hasOwnProperty.call(obj, k)).concat(own.filter((k) => known.indexOf(k) === -1));
}

function shotJson(/** @type {unknown} */ shot) {
  return isPlainObject(shot) ? objectJson(/** @type {any} */ (shot), orderedKeys(/** @type {any} */ (shot), SHOT_KEYS)) : plainJson(shot);
}

function rowJson(/** @type {unknown} */ row) {
  if (!isPlainObject(row)) return plainJson(row);
  const r = /** @type {Record<string, unknown>} */ (row);
  const known = r.type === 'system' ? SYSTEM_KEYS : r.type === 'trade' ? TRADE_KEYS : ['type', 'id'];
  return objectJson(r, orderedKeys(r, known), (val, k) => (
    k === 'shots' && Array.isArray(val) ? '[' + val.map(shotJson).join(',') + ']' : plainJson(val)
  ));
}

/**
 * 把 doc 写成固定格式的 journal.json 文本。同一份 doc 写出来逐字节相同。
 * @param {Record<string, any>} journal
 * @returns {string}
 */
export function formatJournal(journal) {
  const keys = orderedKeys(journal, TOP_KEYS).filter((k) => !skip(journal[k]));
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
    lines.push('  ' + JSON.stringify(k) + ': ' + plainJson(journal[k]) + comma);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}
