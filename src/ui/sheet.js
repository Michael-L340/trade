// 交易表（交接文档 7.2–7.6）：可编辑的格子、系统行、空行、键盘、行操作菜单、删除确认和撤销。
//
// - 数据只通过 store.actions 改。订阅 store 后：'row' / 'rows' 只更新涉及的行，并且逐格对比、只改有差异的格子；
//   正在编辑（有焦点）的输入框和输入法组字中的输入框一律不动，所以焦点和光标不会丢。
//   只有 'journal' 事件（载入、恢复备份、进出示例、另一个标签页更新）才整表重建，重建后把焦点放回原来那一格。
// - 文字格（日期、品种、盈亏比、止损、盈亏、开仓理由、备注、系统名称和说明）失焦或 Enter 时解析并提交，
//   看不懂就恢复原值并提示；盈亏比和止损在输入过程中看得懂就先提交，止盈金额立刻跟着变。
// - 空行（7.4）：第一次在任何一格输入就建一笔交易（createTradeFromEmptyRow），这一行原地变成交易行、
//   下面再接一行新的空行；正在输入的格子不重建，焦点和光标留在原处。在这一格里按 Esc 会撤掉这一笔、变回空行。
// - 输入法（7.5）：event.isComposing（或 keyCode 229）时键盘一律不处理；组字过程中不提交、不改写输入框。
// - 截图格（7.2、7.8）：传了 opts.shots（main.js 给，见 shotApi）才是真的截图功能。有图显示第一张的缩略图（60×34，
//   滚动到看得见时才读）加"n 张"，没图是虚线框"贴图"；光标在某一行任意格子里按 Ctrl+V，剪贴板里有图片就加到这一行
//   （在空行里贴就先按默认值建好这一笔）；剪贴板里是文字照常粘贴，只有收图时才 preventDefault。
//   缩略图的 Blob 地址不再显示就 release。没传 opts.shots 时保持占位：灰框加"n 张"，粘贴图片只提示一句。
// - 上半部分是不碰 DOM 的纯函数（下一格的计算、输入的解析和提交规则、截图的小工具），tests/sheet-keys.test.js 直接测它们；
//   DOM 只在 mountSheet 里用到，所以这个模块在 Node 里也能 import。单笔详情（detail.js）也用这里的截图小工具。

import { sampleHint } from '../calc.js';
import {
  fmtDirection, fmtMoney, fmtPct, fmtR, fmtRR, fmtTwo, OUTCOME_LABEL, parseDate, parseNumber, todayLocal,
} from '../format.js';
import { symbolOptions } from '../symbols.js';
import { confirmDialog, showToast } from './toast.js';

// ====================================================================
// 纯函数
// ====================================================================

/** 表格的列（7.2），顺序就是显示顺序。key 写在格子的 data-col 上。 */
export const COLUMNS = Object.freeze([
  { key: 'no', label: '#', width: 48, align: 'c' },
  { key: 'date', label: '日期', width: 104 },
  { key: 'symbol', label: '品种', width: 84 },
  { key: 'direction', label: '方向', width: 56, align: 'c' },
  { key: 'rr', label: '盈亏比', width: 72, align: 'c' },
  { key: 'risk', label: '止损', width: 80, align: 'c', money: true },
  { key: 'tp', label: '止盈', width: 108, align: 'c', money: true, auto: true },
  { key: 'result', label: '结果', width: 84, align: 'c' },
  { key: 'pnl', label: '盈亏', width: 108, align: 'c', money: true, auto: true },
  { key: 'reason', label: '开仓理由', width: null },
  { key: 'shots', label: '截图', width: 112, align: 'c' },
  { key: 'note', label: '备注', width: 220 },
].map(Object.freeze));

const COL_ORDER = COLUMNS.map((c) => c.key);

/** 各列的中文名（读屏、提示里用） */
export const COLUMN_NAME = Object.freeze({
  no: '行号', date: '日期', symbol: '品种', direction: '方向', rr: '盈亏比', risk: '止损金额', tp: '止盈金额',
  result: '结果', pnl: '盈亏金额', reason: '开仓理由', shots: '截图', note: '备注', menu: '操作菜单',
  name: '系统名称', desc: '系统说明',
});

/**
 * 每种行里能用键盘停留的格子，从左到右。
 * 交易行包括行号按钮和截图按钮（都是打开详情）；空行没有这两个；系统行是菜单按钮、名称、说明。
 */
export const NAV_COLUMNS = Object.freeze({
  trade: Object.freeze(['no', 'date', 'symbol', 'direction', 'rr', 'risk', 'result', 'pnl', 'reason', 'shots', 'note']),
  empty: Object.freeze(['date', 'symbol', 'direction', 'rr', 'risk', 'result', 'pnl', 'reason', 'note']),
  system: Object.freeze(['menu', 'name', 'desc']),
});

/** 文字输入的格子（失焦或 Enter 时提交） */
export const TEXT_COLUMNS = Object.freeze(['date', 'symbol', 'rr', 'risk', 'pnl', 'reason', 'note', 'name', 'desc']);
/** 交易行里的文字格 */
const LINE_TEXT_COLUMNS = Object.freeze(['date', 'symbol', 'rr', 'risk', 'pnl', 'reason', 'note']);
/** 直接存在交易字段里的格子（Esc 或输入看不懂时按字段恢复原值） */
const STORED_COLUMNS = new Set(['date', 'symbol', 'rr', 'risk', 'reason', 'note']);

/** 表头文字：金额列带单位，例如"止损 ($)"、"盈亏 (元)"；单位为空时不带括号 */
export function headerLabel(col, currency) {
  const c = COLUMNS.find((x) => x.key === col);
  if (!c) return '';
  const cur = typeof currency === 'string' ? currency.trim() : '';
  return c.money && cur ? `${c.label} (${cur})` : c.label;
}

/** 多行文字在单行格子里的显示：换行显示成 ↵，提交时再换回换行，这样在表格里改一下不会把换行弄丢 */
export const NEWLINE_MARK = '\u{21B5}';

export function toCellText(s) {
  return typeof s === 'string' ? s.replace(/\r\n|\r|\n/g, NEWLINE_MARK) : '';
}

export function fromCellText(s) {
  return typeof s === 'string' ? s.split(NEWLINE_MARK).join('\n') : '';
}

function colsOf(row) {
  return row && Array.isArray(row.cols) ? row.cols : (row && NAV_COLUMNS[row.kind]) || [];
}

/** 目标行没有这一列时（例如空行没有行号和截图），落在它左边最近的一列；左边都没有就落在第一格 */
function landingColumn(row, col) {
  const cols = colsOf(row);
  if (cols.indexOf(col) !== -1) return col;
  for (let i = COL_ORDER.indexOf(col) - 1; i >= 0; i--) {
    if (cols.indexOf(COL_ORDER[i]) !== -1) return COL_ORDER[i];
  }
  return cols.length ? cols[0] : null;
}

/**
 * 键盘移动后的下一格（7.5）。
 * @param {Array<{kind: 'system'|'trade'|'empty', cols?: string[]}>} rows 表格从上到下的行（cols 省略时用 NAV_COLUMNS）
 * @param {number} r 当前行的下标
 * @param {string} col 当前格的列
 * @param {'down'|'up'|'next'|'prev'|'left'|'right'} move
 *   - down / up（Enter、↓ / ↑、Shift+Enter）：到下面 / 上面最近一个有同一列的行。
 *     从交易行出发时跳过系统行；从系统行出发时，下一行若也是系统行就停在它的同一格，
 *     否则落到交易行或空行（菜单按钮对应行号，名称、说明对应日期）。
 *   - next / prev（Tab / Shift+Tab）：按从左到右、从上到下的顺序走，系统行也算；到表格两头返回 null。
 *   - left / right（按钮格里的 ← / →）：只在同一行里走，到头返回 null。
 * @returns {{row: number, col: string} | null} null 表示不移动（Tab 时交给浏览器把焦点移出表格）
 */
export function nextCell(rows, r, col, move) {
  if (!Array.isArray(rows) || r < 0 || r >= rows.length) return null;
  const src = rows[r];
  if (move === 'down' || move === 'up') {
    const step = move === 'down' ? 1 : -1;
    for (let i = r + step; i >= 0 && i < rows.length; i += step) {
      const row = rows[i];
      if (row.kind === 'system') {
        if (src.kind === 'system' && colsOf(row).indexOf(col) !== -1) return { row: i, col };
        continue;
      }
      const want = src.kind === 'system' ? (col === 'menu' ? 'no' : 'date') : col;
      const c = landingColumn(row, want);
      if (c) return { row: i, col: c };
    }
    return null;
  }
  if (move === 'next' || move === 'prev') {
    const step = move === 'next' ? 1 : -1;
    let i = r;
    let cols = colsOf(src);
    const at = cols.indexOf(col);
    let k = at === -1 ? (step > 0 ? 0 : -1) : at + step;
    for (;;) {
      if (k >= 0 && k < cols.length) return { row: i, col: cols[k] };
      i += step;
      if (i < 0 || i >= rows.length) return null;
      cols = colsOf(rows[i]);
      k = step > 0 ? 0 : cols.length - 1;
    }
  }
  if (move === 'left' || move === 'right') {
    const cols = colsOf(src);
    const at = cols.indexOf(col);
    if (at === -1) return null;
    const k = at + (move === 'right' ? 1 : -1);
    return k >= 0 && k < cols.length ? { row: r, col: cols[k] } : null;
  }
  return null;
}

/**
 * 结果格的按键（7.5）：1 或 Y 设为盈，0 或 N 设为亏，Backspace（或 Delete）清空。全角的也认。
 * @returns {'win'|'loss'|null|undefined} undefined 表示不是这几个键
 */
export function resultForKey(key) {
  if (typeof key !== 'string') return undefined;
  if (key === 'Backspace' || key === 'Delete') return null;
  if (key.length !== 1) return undefined;
  const k = key.normalize('NFKC').toLowerCase();
  if (k === '1' || k === 'y') return 'win';
  if (k === '0' || k === 'n') return 'loss';
  return undefined;
}

/** 输入法正在组字（这时 Enter 是确认候选词，不能当成移动） */
export function isComposingKey(e) {
  return !!e && (e.isComposing === true || e.keyCode === 229);
}

/**
 * 一个按键在某种格子里该做什么（7.5）。
 * @param {{key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean,
 *   isComposing?: boolean, keyCode?: number}} e 键盘事件
 * @param {'text'|'direction'|'result'|'button'} kind 文字格、方向格、结果格、其他按钮（行号、截图、菜单）
 * @returns {null | {type: 'move', move: string, commit: boolean} | {type: 'restore'} | {type: 'result', value: 'win'|'loss'|null}}
 *   null 表示交给浏览器（例如方向格的空格和 Enter 由按钮自己切换，文字格里的 ← → 移动光标）
 */
export function keyAction(e, kind) {
  if (!e || isComposingKey(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const text = kind === 'text';
  switch (e.key) {
    case 'Tab':
      return { type: 'move', move: e.shiftKey ? 'prev' : 'next', commit: text };
    case 'Enter':
      if (kind === 'direction' || kind === 'button') return null;
      return { type: 'move', move: e.shiftKey ? 'up' : 'down', commit: text };
    case 'ArrowDown':
    case 'ArrowUp':
      if (text && e.shiftKey) return null; // Shift+↑↓ 在文字里选字
      return { type: 'move', move: e.key === 'ArrowDown' ? 'down' : 'up', commit: text };
    case 'ArrowLeft':
    case 'ArrowRight':
      if (text) return null; // 文字格里是移动光标
      return { type: 'move', move: e.key === 'ArrowLeft' ? 'left' : 'right', commit: false };
    case 'Escape':
      return text ? { type: 'restore' } : null;
    default:
      break;
  }
  if (kind === 'result') {
    const value = resultForKey(e.key);
    if (value !== undefined) return { type: 'result', value };
  }
  return null;
}

function clip(s, n = 16) {
  const chars = Array.from(String(s).trim());
  return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
}

/**
 * 格子里的文字该怎么提交（失焦或 Enter 时）。
 * - 日期：接受 2026-9-1、9-1、9/1、9月1日、20260901（只写月日补当前年份）；空着或看不懂 → 恢复原值。
 * - 盈亏比：大于 0 的数，接受 1:2（取冒号后面）、2R、2倍；空着 → 清空；0、负数或看不懂 → 恢复原值。
 * - 止损金额：大于 0 的数，忽略货币符号、逗号、金额单位；写成负数按绝对值算；空着 → 清空。
 * - 盈亏金额：交给 setPnlInput（6.2）；空着 → 回到自动值；看不懂 → 恢复原值。
 * - 品种、开仓理由、备注、系统名称和说明：原样保存（显示成 ↵ 的地方换回换行）。
 * @param {string} col
 * @param {string} text 输入框里的文字
 * @param {{currency?: string, now?: Date}} [opts]
 * @returns {{ok: true, patch?: object, pnl?: string|null} | {ok: false, message: string}}
 *   ok 时：patch 给 updateTrade / updateSystem；盈亏格给的是 pnl（setPnlInput 的参数）。
 *   不 ok 时：message 是给用户看的说明（"……没看懂，已恢复原值"）。
 */
/** 盈亏格里代表"按系统止盈/止损"的字 */
export const PNL_WORDS = Object.freeze({ 盈: 'win', 盈利: 'win', 止盈: 'win', 亏: 'loss', 亏损: 'loss', 止损: 'loss' });

export function interpretInput(col, text, opts = {}) {
  const s = typeof text === 'string' ? text : '';
  const blank = s.trim() === '';
  switch (col) {
    case 'date': {
      if (blank) return { ok: false, message: '日期不能空着，已恢复原来的日期' };
      const v = parseDate(s, opts.now instanceof Date ? opts.now : new Date());
      if (v) return { ok: true, patch: { date: v } };
      return { ok: false, message: `日期“${clip(s)}”没看懂，已恢复原值。可以写 2026-9-1、9-1 或 9/1` };
    }
    case 'rr':
    case 'risk': {
      if (blank) return { ok: true, patch: { [col]: null } };
      const label = col === 'rr' ? '盈亏比' : '止损金额';
      const raw = col === 'rr' ? s.trim().replace(/\s*(?:[rR]|倍)$/u, '') : s;
      const v = parseNumber(raw, { currency: opts.currency });
      if (v === null) return { ok: false, message: `${label}“${clip(s)}”没看懂，已恢复原值` };
      const value = col === 'risk' ? Math.abs(v) : v;
      if (!(value > 0)) return { ok: false, message: `${label}要大于 0，已恢复原值` };
      return { ok: true, patch: { [col]: value } };
    }
    case 'pnl': {
      if (blank) return { ok: true, pnl: null };
      const word = PNL_WORDS[s.trim()];
      if (word) return { ok: true, result: word }; // 按系统出场：结果跟着变，金额回到自动值
      if (parseNumber(s, { currency: opts.currency }) === null) {
        return { ok: false, message: `盈亏“${clip(s)}”没看懂，已恢复原值。可以打 盈、亏，或者实际金额` };
      }
      return { ok: true, pnl: s };
    }
    case 'symbol':
    case 'reason':
    case 'note':
    case 'name':
    case 'desc':
      return { ok: true, patch: { [col]: fromCellText(s) } };
    default:
      return { ok: false, message: '' };
  }
}

/**
 * 输入过程中（还没失焦）就提交的值：只有盈亏比和止损金额，而且要看得懂，这样止盈金额能边打边算出来。
 * @returns {{value: number|null} | null} null 表示先不提交（例如只打了"1:"）
 */
export function liveValue(col, text, opts = {}) {
  if (col !== 'rr' && col !== 'risk') return null;
  const r = interpretInput(col, text, opts);
  return r.ok ? { value: r.patch[col] } : null;
}

/**
 * 在空行里第一次输入时，带给 createTradeFromEmptyRow 的字段：这一格看得懂就带上，看不懂先不带
 * （例如日期只打了一个"2"：这一笔先用今天，打完失焦时再按 interpretInput 提交）。
 */
export function emptyRowPatch(col, text, opts = {}) {
  if (!STORED_COLUMNS.has(col)) return {};
  const r = interpretInput(col, text, opts);
  if (!r.ok || !r.patch) return {};
  if ((col === 'rr' || col === 'risk') && r.patch[col] === null) return {};
  return r.patch;
}

/** 交易行文字格里显示的文字 */
export function tradeCellText(col, t, d) {
  switch (col) {
    case 'date': return typeof t.date === 'string' ? t.date : '';
    case 'symbol': return toCellText(t.symbol);
    case 'rr': return fmtRR(t.rr);
    case 'risk': return typeof t.risk === 'number' && Number.isFinite(t.risk) ? fmtMoney(t.risk) : '';
    case 'tp': return fmtMoney(d.takeProfit, { blank: true });
    case 'pnl': return fmtMoney(d.pnl, { sign: true, blank: true });
    case 'reason': return toCellText(t.reason);
    case 'note': return toCellText(t.note);
    default: return '';
  }
}

/** 哪些格子要标"缺数"（6.1）：结果已选（或金额手改过）却缺盈亏比或止损金额 */
export function missingFlags(t, d) {
  const decided = t.result === 'win' || t.result === 'loss' || d.edited === true;
  return { rr: decided && d.missing.rr, risk: decided && d.missing.risk };
}

/** 结果格的标签：盈、亏、平、持仓中、缺数 */
export function outcomeChip(outcome) {
  const cls = outcome === 'win' ? 'chip win' : outcome === 'loss' ? 'chip loss' : outcome === 'breakeven' ? 'chip flat' : 'chip open';
  return { cls, text: OUTCOME_LABEL[outcome] || OUTCOME_LABEL.open };
}

/** 系统行右边的样本提示：还没有出场的交易时换一句更直白的话 */
export function segmentHint(n) {
  return n === 0 ? '还没有出场的交易' : sampleHint(n);
}

/** 只读时给用户看的原因 */
export function readOnlyMessage(reason) {
  if (reason === 'other-tab') return '另一个标签页正在编辑，这里只读';
  if (reason === 'newer-schema') return '网站已更新，刷新页面后才能保存';
  return '只读：现在不能修改';
}

// ====================================================================
// 截图（7.8）：表格和单笔详情共用的小工具（不碰 DOM）
// ====================================================================

/** 截图标签的显示文字（第 5 节）。空标签在详情里也要能点着切换，所以显示一个"无" */
export const SHOT_LABEL_TEXT = Object.freeze({ open: '开仓时', close: '平仓后', '': '无' });

/** 标签的显示文字；不认识的当成空标签 */
export function shotLabelText(label) {
  return label === 'open' || label === 'close' ? SHOT_LABEL_TEXT[label] : SHOT_LABEL_TEXT[''];
}

/** 点标签时换成哪个：开仓时 → 平仓后 → 无 → 开仓时 */
export function nextShotLabel(label) {
  if (label === 'open') return 'close';
  if (label === 'close') return '';
  return 'open';
}

const nonEmpty = (s) => typeof s === 'string' && s !== '';

/** 缩略图的路径（shots[].thumb）；没有缩略图就用原图；都没有返回 null */
export function shotThumbPath(shot) {
  if (!shot) return null;
  if (nonEmpty(shot.thumb)) return shot.thumb;
  return nonEmpty(shot.file) ? shot.file : null;
}

/** 原图的路径（shots[].file）；没有原图就用缩略图；都没有返回 null */
export function shotFilePath(shot) {
  if (!shot) return null;
  if (nonEmpty(shot.file)) return shot.file;
  return nonEmpty(shot.thumb) ? shot.thumb : null;
}

const isImageType = (type) => typeof type === 'string' && /^image\//i.test(type);

/**
 * 从粘贴或拖放的数据（DataTransfer）里取出图片文件，并看看有没有文字。
 * 要在事件处理函数里同步调用：事件结束后浏览器就不让读了。
 * 图片先从 items 取（截图工具贴的图在这里），取不到再看 files（从资源管理器复制或拖进来的文件），两边不重复算。
 * @param {{items?: ArrayLike<{kind: string, type: string, getAsFile?: () => (Blob|null)}>,
 *   files?: ArrayLike<{type: string}>, types?: ArrayLike<string>}|null|undefined} data
 * @returns {{images: Blob[], hasText: boolean}}
 */
export function readTransfer(data) {
  const images = [];
  let hasText = false;
  if (!data) return { images, hasText };
  for (const it of Array.from(data.items || [])) {
    if (!it) continue;
    if (it.kind === 'file' && isImageType(it.type)) {
      const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
      if (f) images.push(f);
    } else if (it.kind === 'string' && it.type === 'text/plain') {
      hasText = true;
    }
  }
  if (!images.length) {
    for (const f of Array.from(data.files || [])) if (f && isImageType(f.type)) images.push(f);
  }
  if (Array.from(data.types || []).indexOf('text/plain') !== -1) hasText = true;
  return { images, hasText };
}

/**
 * 这次粘贴要不要当成贴截图（9.4：只有剪贴板里有图片时才 preventDefault）。
 * - 没有图片：不管，照常粘贴；
 * - 只有图片：贴截图；
 * - 图片和文字都有（例如从 Excel、Word、网页复制的）：光标在输入框里就按文字粘贴，不在输入框里就贴截图。
 * @param {{images: Blob[], hasText: boolean}|null} info readTransfer 的结果
 * @param {boolean} inTextField 焦点在能打字的地方（格子的输入框、详情的文本框）
 */
export function pasteWantsImage(info, inTextField) {
  if (!info || !Array.isArray(info.images) || !info.images.length) return false;
  return !(inTextField && info.hasText);
}

/**
 * 新截图的默认标签（7.8）：这一笔还没出场是 open（开仓时），出场了是 close（平仓后）。
 * 先问 shots.js 的 defaultLabel。约定里它的参数叫 derived：这里给的对象既有派生值的字段（outcome 等），
 * 也带着 t（这一笔）、d（派生值）和 result，按哪种写法读都读得到。它没给出 open / close 时按 outcome 自己判断。
 * @param {Function|null|undefined} defaultLabel
 * @param {{t?: object, d?: object}|null} it 交易项（derived.tradeById 里的）
 * @returns {'open'|'close'}
 */
export function pickShotLabel(defaultLabel, it) {
  const t = it && it.t ? it.t : {};
  const d = it && it.d ? it.d : {};
  if (typeof defaultLabel === 'function') {
    let v;
    try {
      v = defaultLabel({ ...d, result: t.result, t, d });
    } catch (err) {
      v = undefined;
    }
    if (v === 'open' || v === 'close') return v;
  }
  if (typeof d.outcome === 'string') return d.outcome === 'open' ? 'open' : 'close';
  return t.result === 'win' || t.result === 'loss' ? 'close' : 'open';
}

const urlShares = new WeakMap();

/**
 * 截图地址的共用计数。表格和详情用的是同一个 urlCache（shots.js 的 createUrlCache），同一张缩略图可能两边都在显示，
 * 要等都不用了才 release（释放 Blob 地址）。这里给每个路径数一数有几处在用：
 * 第一处 acquire 才调 cache.get，最后一处 release 才调 cache.release；
 * get 还没回来就都 release 了的，等它回来再放；等的时候又有人要，就接着用、不放。
 * 同一个 cache 拿到的是同一个计数器。每次 acquire 都要配一次 release。
 * @param {{get: (path: string) => Promise<string|null>, release?: (path: string) => void}|null|undefined} cache
 * @returns {{acquire: (path: string) => Promise<string|null>, release: (path: string) => void,
 *   count: (path: string) => number}|null} acquire 兑现为 Blob 地址；文件不在本机时是 null；读不出来时 reject。
 */
export function shotUrls(cache) {
  if (!cache || typeof cache !== 'object' || typeof cache.get !== 'function') return null;
  const known = urlShares.get(cache);
  if (known) return known;
  const entries = new Map(); // 路径 → { n: 在用的处数, p: cache.get 的结果 }
  const shared = Object.freeze({
    acquire(path) {
      let e = entries.get(path);
      if (!e) {
        let p;
        try {
          p = Promise.resolve(cache.get(path));
        } catch (err) {
          p = Promise.reject(err);
        }
        p.catch(() => {}); // 读不出来由用的地方自己处理，这里不算没人接的错误
        e = { n: 0, p };
        entries.set(path, e);
      }
      e.n += 1;
      return e.p;
    },
    release(path) {
      const e = entries.get(path);
      if (!e || e.n <= 0) return;
      e.n -= 1;
      if (e.n > 0) return;
      const done = () => {
        if (e.n > 0 || entries.get(path) !== e) return; // 等的时候又有人要了
        entries.delete(path);
        if (typeof cache.release === 'function') {
          try {
            cache.release(path);
          } catch (err) { /* 释放失败不影响界面 */ }
        }
      };
      e.p.then(done, done);
    },
    count(path) {
      const e = entries.get(path);
      return e ? e.n : 0;
    },
  });
  urlShares.set(cache, shared);
  return shared;
}

const apiShares = new WeakMap();
let addQueue = Promise.resolve();

/**
 * 把 main.js 传来的 opts.shots 整理成界面用的样子；表格和详情各调一次，同一个对象拿到的是同一份。
 * opts.shots = { addShot, deleteShot, setShotLabel, urlCache, defaultLabel }（src/shots.js 的接口）：
 * - 推荐传已经绑好 ctx 的函数：addShot(tradeId, blob, label) → shot、deleteShot(tradeId, shotId) → 撤销函数、
 *   setShotLabel(tradeId, shotId, label)；urlCache 是 createUrlCache(ctx) 的结果；defaultLabel 原样；
 * - 也可以直接传 shots.js 导出的函数，再加一个 ctx 字段（{ store, db, demo }），这里替它把 ctx 放在第一个参数。
 * 加截图排成一队：一张处理完再处理下一张，几张同时贴进同一笔时不会互相盖掉 shots 数组。
 * @param {object|null|undefined} raw
 * @returns {null | {addShot: Function|null, deleteShot: Function|null, setShotLabel: Function|null,
 *   urls: ReturnType<typeof shotUrls>, labelFor: (it: object) => ('open'|'close')}}
 */
export function shotApi(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const known = apiShares.get(raw);
  if (known) return known;
  const withCtx = Object.prototype.hasOwnProperty.call(raw, 'ctx');
  const bind = (fn) => {
    if (typeof fn !== 'function') return null;
    return withCtx ? (...args) => fn(raw.ctx, ...args) : (...args) => fn(...args);
  };
  const add = bind(raw.addShot);
  const api = Object.freeze({
    addShot: add
      ? (tradeId, blob, label) => {
        const run = addQueue.then(() => add(tradeId, blob, label));
        addQueue = run.then(() => undefined, () => undefined);
        return run;
      }
      : null,
    deleteShot: bind(raw.deleteShot),
    setShotLabel: bind(raw.setShotLabel),
    urls: shotUrls(raw.urlCache),
    labelFor: (it) => pickShotLabel(raw.defaultLabel, it),
  });
  apiShares.set(raw, api);
  return api;
}

/** 错误 → 给用户看的一句话 */
export function errorText(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return err === undefined || err === null ? '原因不明' : String(err);
}

// ====================================================================
// 表格
// ====================================================================

/**
 * 把交易表画进 container，并接上 store。
 * @param {HTMLElement} container 表格的容器（会加上 sheet-wrap 类）
 * @param {object} store createStore 的返回值
 * @param {object} [opts]
 * @param {(id: string) => void} [opts.openDetail] 点行号或截图格时打开单笔详情（选中行由详情自己 select）
 * @param {() => (void|Promise)} [opts.onLoadDemo] "看看示例数据"按钮的回调；不传就不显示这个按钮。
 *   默认在没有交易、也不在示例模式时显示；main 可以用返回值的 setDemoButton(true/false/null) 自己决定。
 * @param {object} [opts.shots] 截图功能（main.js 传入）：{ addShot, deleteShot, setShotLabel, urlCache, defaultLabel }，
 *   怎么传见 shotApi。不传时截图格是占位：灰框加"n 张"，粘贴图片只提示一句。
 * @returns {{focusCell: (id: string, col: string) => boolean, rebuild: () => void,
 *   setDemoButton: (visible: boolean|null) => void, setLoadDemo: (fn: Function|null) => void, destroy: () => void}}
 */
export function mountSheet(container, store, opts = {}) {
  if (!container || !store) throw new TypeError('mountSheet(container, store) 缺参数');
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const openDetail = typeof opts.openDetail === 'function' ? opts.openDetail : null;
  const shotsApi = shotApi(opts.shots);
  let onLoadDemo = typeof opts.onLoadDemo === 'function' ? opts.onLoadDemo : null;
  let demoOverride = null;
  const ac = new AbortController();
  const listen = (target, type, fn, options) => target.addEventListener(type, fn, { ...(options || {}), signal: ac.signal });

  // ---------- 小工具 ----------
  function h(tag, cls, text) {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function button(cls, text) {
    const b = h('button', cls, text);
    b.type = 'button';
    return b;
  }
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setClass(el, cls, on) {
    if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
  }
  function setAttr(el, name, value) {
    if (value === null || value === undefined) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }
  function setHidden(el, hidden) {
    if (el.hidden !== !!hidden) el.hidden = !!hidden;
  }

  // ---------- 骨架 ----------
  container.textContent = '';
  container.classList.add('sheet-wrap');
  if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', '交易表');
  const scroll = h('div', 'sheet-scroll');
  const table = h('table', 'sheet');
  const caption = h('caption', 'sr-only', '交易表：一行一笔交易，深色的行是交易系统的分隔行');
  const colgroup = h('colgroup');
  for (const c of COLUMNS) colgroup.appendChild(h('col', c.width ? 'w' + c.width : null));
  const thead = h('thead');
  const headRow = h('tr');
  const headLabels = new Map();
  for (const c of COLUMNS) {
    const th = h('th', c.align || null);
    th.setAttribute('scope', 'col');
    const label = h('span', null, '');
    th.appendChild(label);
    if (c.auto) th.appendChild(h('span', 'auto-tag', '自动'));
    headRow.appendChild(th);
    headLabels.set(c.key, label);
  }
  thead.appendChild(headRow);
  const tbody = h('tbody');
  table.append(caption, colgroup, thead, tbody);
  scroll.appendChild(table);
  const footer = h('div', 'sheet-footer');
  const addTradeBtn = button('btn primary', '＋ 记一笔');
  const addBtn = button('btn', '＋ 换交易系统（插入系统行）');
  const demoBtn = button('btn', '看看示例数据');
  demoBtn.hidden = true;
  const hint = h('span', 'footer-hint');
  hint.setAttribute('role', 'status');
  footer.append(addTradeBtn, addBtn, demoBtn, hint);
  container.append(scroll, footer);
  // 品种的候选项（用过的品种，按近 30 天使用次数排序），点品种格时浏览器会列出来直接选
  const symbolListId = 'tj-symbols-' + Math.random().toString(36).slice(2, 8);
  const symbolList = doc.createElement('datalist');
  symbolList.id = symbolListId;
  container.appendChild(symbolList);
  let symbolKey = '';
  function refreshSymbols() {
    const opts = symbolOptions(store.get().journal.rows, todayLocal(new Date()));
    const key = opts.join('\u0001');
    if (key === symbolKey) return;
    symbolKey = key;
    symbolList.textContent = '';
    for (const sym of opts) { const o = doc.createElement('option'); o.value = sym; symbolList.appendChild(o); }
  }

  // ---------- 状态 ----------
  /** 行 id → view。view = { kind: 'trade'|'empty'|'system', id, tr, cells } */
  const views = new Map();
  let emptyView = null;
  /** 正在编辑的文字格：{ input, view, col, entryText, entryRaw, edited, createdId } */
  let edit = null;
  const composing = new Set();
  let promoting = null; // 空行正在变成交易行
  let demoting = null; // 刚在空行建的交易被 Esc 撤掉，变回空行
  let menu = null; // 打开着的行操作菜单
  let destroyed = false;

  const canEdit = () => store.canEdit();
  const ctx = () => ({ currency: store.get().journal.currency, now: new Date() });
  const notifyReadOnly = () => showToast(readOnlyMessage(store.get().ui.readOnly));

  // ---------- 建行 ----------
  function textCell(col, numeric) {
    const td = h('td', numeric ? 'edit num' : 'edit');
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = numeric ? 'cell-input num' : 'cell-input';
    input.dataset.col = col;
    input.setAttribute('autocomplete', 'off');
    input.spellcheck = false;
    if (col === 'symbol') input.setAttribute('list', symbolListId);
    td.appendChild(input);
    return { td, input };
  }

  function toggleCell(col) {
    const td = h('td', 'edit');
    const btn = button('cell-input cell-toggle');
    btn.dataset.col = col;
    const label = h('span', col === 'direction' ? 'dir' : 'chip');
    btn.appendChild(label);
    td.appendChild(btn);
    return { td, btn, label };
  }

  function fillRowhead(view) {
    const c = view.cells.no;
    c.td.textContent = '';
    c.btn = null;
    c.menu = null;
    c.span = null;
    if (view.kind === 'trade') {
      c.btn = button('rownum');
      c.btn.dataset.col = 'no';
      c.btn.dataset.open = view.id;
      c.menu = button('row-menu-btn', '⋮');
      c.menu.tabIndex = -1;
      c.menu.setAttribute('aria-haspopup', 'menu');
      c.menu.setAttribute('aria-expanded', 'false');
      c.td.append(c.btn, c.menu);
    } else {
      c.span = h('span', 'rownum-text');
      c.td.appendChild(c.span);
    }
  }

  function fillShots(view) {
    const c = view.cells.shots;
    dropThumb(c);
    c.td.textContent = '';
    c.btn = null;
    c.key = null;
    c.slot = null;
    c.countEl = null;
    c.emptyEl = null;
    if (view.kind === 'trade') {
      c.btn = button('shot-btn');
      c.btn.dataset.col = 'shots';
      c.btn.dataset.open = view.id;
      c.td.appendChild(c.btn);
    } else {
      const empty = h('span', 'shot-empty', '贴图');
      if (shotsApi) empty.title = '光标放在这一行的格子里按 Ctrl+V 贴图，会先建好这一笔';
      c.td.appendChild(empty);
    }
  }

  /** 交易行或空行（两者格子一样，只有行号和截图格不同，空行变成交易行时原地换这两格） */
  function buildLineView(kind, id) {
    const tr = h('tr', kind === 'empty' ? 'empty-row' : 'trade-row');
    if (id) tr.dataset.id = id;
    const view = { kind, id: id || null, tr, cells: {} };
    const c = view.cells;
    c.no = { td: h('td', 'rowhead') };
    c.date = textCell('date', false);
    c.symbol = textCell('symbol', false);
    c.direction = toggleCell('direction');
    c.rr = textCell('rr', true);
    c.risk = textCell('risk', true);
    c.tp = { td: h('td', 'num calc') };
    c.result = toggleCell('result');
    c.pnl = textCell('pnl', true);
    c.pnl.td.classList.add('calc', 'pnl');
    c.pnl.tag = h('span', 'edited-tag cell-tag', '改');
    c.pnl.tag.hidden = true;
    c.pnl.tag.setAttribute('aria-hidden', 'true');
    c.pnl.td.insertBefore(c.pnl.tag, c.pnl.input);
    c.reason = textCell('reason', false);
    c.reason.td.classList.add('reason');
    c.shots = { td: h('td') };
    c.note = textCell('note', false);
    c.note.td.classList.add('note');
    for (const key of COL_ORDER) tr.appendChild(c[key].td);
    fillRowhead(view);
    fillShots(view);
    applyEditable(view);
    return view;
  }

  function buildSystemView(id) {
    const tr = h('tr', 'system-row');
    tr.dataset.id = id;
    const td = h('td');
    td.colSpan = COLUMNS.length;
    const wrap = h('div', 'sys');
    const menuBtn = button('sys-menu-btn', '⋮');
    menuBtn.dataset.col = 'menu';
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    const label = h('span', 'sys-label');
    const name = doc.createElement('input');
    name.type = 'text';
    name.className = 'cell-input sys-name-input';
    name.dataset.col = 'name';
    name.placeholder = '给这个系统起个名字';
    name.setAttribute('autocomplete', 'off');
    name.spellcheck = false;
    const desc = doc.createElement('input');
    desc.type = 'text';
    desc.className = 'cell-input sys-desc-input';
    desc.dataset.col = 'desc';
    desc.placeholder = '一句话写下规则：什么情况进场，止损放哪';
    desc.setAttribute('autocomplete', 'off');
    desc.spellcheck = false;
    const stats = h('div', 'sys-stats');
    const stat = (prefix, suffix) => {
      const span = h('span');
      const b = h('b');
      if (prefix) span.append(prefix + ' ');
      span.append(b);
      if (suffix) span.append(' ' + suffix);
      stats.appendChild(span);
      return b;
    };
    const s = { n: stat('', '笔'), win: stat('胜率'), payoff: stat('实际盈亏比'), exp: stat('期望'), total: stat('累计') };
    const hintEl = h('span', 'sys-hint');
    stats.appendChild(hintEl);
    wrap.append(menuBtn, label, name, desc, stats);
    td.appendChild(wrap);
    tr.appendChild(td);
    const view = {
      kind: 'system', id, tr, label, menuBtn, name, desc, stats: s, hint: hintEl,
      cells: { menu: { btn: menuBtn }, name: { input: name }, desc: { input: desc } },
    };
    applyEditable(view);
    return view;
  }

  function buildView(row) {
    return row.type === 'system' ? buildSystemView(row.id) : buildLineView('trade', row.id);
  }

  // ---------- 找格子 ----------
  function viewOfTr(tr) {
    if (!tr) return null;
    if (emptyView && tr === emptyView.tr) return emptyView;
    const id = tr.dataset ? tr.dataset.id : null;
    return id ? views.get(id) || null : null;
  }

  function viewOf(el) {
    const tr = el && typeof el.closest === 'function' ? el.closest('tr') : null;
    if (!tr || tr.parentNode !== tbody) return null;
    return viewOfTr(tr);
  }

  function cellEl(view, col) {
    if (!view) return null;
    const c = view.cells[col];
    if (!c) return null;
    return c.input || c.btn || null;
  }

  function cellKind(el) {
    if (el.tagName === 'INPUT') return 'text';
    const col = el.dataset ? el.dataset.col : '';
    if (col === 'direction') return 'direction';
    if (col === 'result') return 'result';
    return 'button';
  }

  function isCellInput(el) {
    return !!el && el.tagName === 'INPUT' && el.classList.contains('cell-input') && !!viewOf(el);
  }

  // ---------- 画格子（逐格对比，只改有差异的地方） ----------
  function locked(input) {
    return (edit !== null && edit.input === input) || composing.has(input);
  }

  function setValue(input, value) {
    if (locked(input)) return; // 正在编辑或组字：不动它
    if (input.value !== value) input.value = value;
  }

  function renderTrade(view, it, st) {
    const t = it.t;
    const d = it.d;
    const c = view.cells;
    const no = it.no;
    setClass(view.tr, 'selected', st.ui.selectedId === t.id);
    setText(c.no.btn, String(no));
    setAttr(c.no.btn, 'aria-label', `第 ${no} 笔：打开详情`);
    setAttr(c.no.menu, 'aria-label', `第 ${no} 笔的操作`);
    for (const col of LINE_TEXT_COLUMNS) {
      const input = c[col].input;
      setValue(input, tradeCellText(col, t, d));
      setAttr(input, 'placeholder', null);
      setAttr(input, 'aria-label', `第 ${no} 笔 ${COLUMN_NAME[col]}${col === 'pnl' && d.edited ? '（手改过）' : ''}`);
    }
    setAttr(c.reason.input, 'title', t.reason ? t.reason : null);
    setAttr(c.note.input, 'title', t.note ? t.note : null);

    const dir = fmtDirection(t.direction);
    setText(c.direction.label, dir);
    setAttr(c.direction.btn, 'aria-label', `第 ${no} 笔 方向：${dir}（空格或回车切换）`);

    const miss = missingFlags(t, d);
    for (const col of ['rr', 'risk']) {
      setClass(c[col].td, 'missing', miss[col]);
      setAttr(c[col].input, 'aria-invalid', miss[col] ? 'true' : null);
      setAttr(c[col].input, 'title', miss[col] ? `已经有结果，但缺${COLUMN_NAME[col]}` : null);
    }

    setText(c.tp.td, tradeCellText('tp', t, d));

    const chip = outcomeChip(d.outcome);
    const noChip = d.outcome === 'open' && d.missing.rr; // 还没填盈亏比：结果格留空，不显示"持仓中"
    setHidden(c.result.label, noChip);
    setAttr(c.result.label, 'class', chip.cls);
    setText(c.result.label, chip.text);
    setAttr(c.result.btn, 'aria-label', `第 ${no} 笔 结果：${chip.text}（点一下切换；1 或 Y 盈，0 或 N 亏，退格清空）`);

    const tone = d.outcome === 'win' ? 'win' : d.outcome === 'loss' ? 'loss' : '';
    setClass(c.pnl.td, 'win', tone === 'win');
    setClass(c.pnl.td, 'loss', tone === 'loss');
    setClass(c.pnl.td, 'has-tag', d.edited);
    setHidden(c.pnl.tag, !d.edited);
    setAttr(c.pnl.input, 'title', d.edited ? '手改过的盈亏金额（清空就回到自动值）' : null);

    renderShots(c.shots, t, no);
  }

  // ---------- 截图格（7.2、7.8） ----------
  // c 是 view.cells.shots：{ td, btn, key, slot（60×34 的小框）, countEl（"n 张"）, emptyEl（"贴图"）,
  //   thumbPath（小框该显示的缩略图）, thumbHeld（已经向 urlCache 要了这张、用完要 release） }
  let thumbObserver = null;
  const watching = new Map(); // 等着滚动到看得见的小框 → 它所在的截图格

  function renderShots(c, t, no) {
    const list = Array.isArray(t.shots) ? t.shots : [];
    const count = list.length;
    const path = count ? shotThumbPath(list[0]) : null;
    const key = count + '|' + no + '|' + (path || '');
    if (c.key === key) return;
    c.key = key;
    if (!shotsApi) {
      placeholderShots(c, count, no);
      return;
    }
    if (!count) {
      dropThumb(c);
      if (!c.emptyEl) {
        c.btn.textContent = '';
        c.slot = null;
        c.countEl = null;
        c.emptyEl = h('span', 'shot-empty', '贴图');
        c.btn.appendChild(c.emptyEl);
      }
      c.btn.setAttribute('aria-label', `第 ${no} 笔：还没有截图，打开详情`);
      c.btn.title = '还没有截图：光标放在这一行任意格子里按 Ctrl+V 就能贴上，或点开详情';
      return;
    }
    if (!c.slot) {
      dropThumb(c);
      c.btn.textContent = '';
      c.emptyEl = null;
      c.slot = h('span', 'thumb-slot');
      c.slot.setAttribute('aria-hidden', 'true');
      c.countEl = h('span', 'shot-count');
      c.btn.append(c.slot, c.countEl);
    }
    setText(c.countEl, count + ' 张');
    c.btn.setAttribute('aria-label', `第 ${no} 笔的 ${count} 张截图：打开详情`);
    c.btn.removeAttribute('title');
    if (c.thumbPath !== path) {
      dropThumb(c);
      c.slot.className = 'thumb-slot';
      c.slot.textContent = '';
      c.slot.removeAttribute('title');
      c.thumbPath = path;
      if (path) watchThumb(c);
    }
  }

  /** 没传 opts.shots 时的占位（截图功能接上之前的样子） */
  function placeholderShots(c, count, no) {
    c.btn.textContent = '';
    if (count) {
      c.btn.append(h('span', 'thumb-ph'), h('span', null, count + ' 张'));
      c.btn.setAttribute('aria-label', `第 ${no} 笔的 ${count} 张截图：打开详情`);
      c.btn.removeAttribute('title');
    } else {
      c.btn.appendChild(h('span', 'shot-empty', '贴图'));
      c.btn.setAttribute('aria-label', `第 ${no} 笔：打开详情`);
      c.btn.title = '截图功能下一版加上，现在点开是单笔详情';
    }
  }

  /** 小框滚动到看得见（上下各提前 200px）时才去读缩略图；浏览器没有 IntersectionObserver 就直接读 */
  function watchThumb(c) {
    if (!shotsApi || !shotsApi.urls || !c.slot) return; // 没有 urlCache：只显示灰色小框
    const IO = win.IntersectionObserver;
    if (typeof IO !== 'function') {
      loadThumb(c);
      return;
    }
    if (!thumbObserver) thumbObserver = new IO(onThumbsVisible, { rootMargin: '200px 0px' });
    watching.set(c.slot, c);
    thumbObserver.observe(c.slot);
  }

  function onThumbsVisible(entries) {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const c = watching.get(en.target);
      watching.delete(en.target);
      if (thumbObserver) thumbObserver.unobserve(en.target);
      if (c && c.slot === en.target) loadThumb(c);
    }
  }

  function loadThumb(c) {
    const path = c.thumbPath;
    const slot = c.slot;
    if (!path || !slot || c.thumbHeld || !shotsApi || !shotsApi.urls) return;
    c.thumbHeld = true;
    const current = () => !destroyed && c.thumbPath === path && c.slot === slot;
    shotsApi.urls.acquire(path).then((url) => {
      if (!current()) return; // 已经换了图或拆掉了（那时已经 release 过）
      if (!url) {
        slotNote(slot, 'missing', '文件不在\n本机', '这一笔第一张截图的文件不在这个浏览器里');
        return;
      }
      const img = doc.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        if (current()) slotNote(slot, 'broken', '打不开', '这张缩略图打不开');
      }, { once: true });
      img.src = url;
      slot.className = 'thumb-slot';
      slot.textContent = '';
      slot.appendChild(img);
    }, (err) => {
      if (current()) slotNote(slot, 'broken', '读不出', '读不出这张缩略图：' + errorText(err));
    });
  }

  function slotNote(slot, kind, text, title) {
    slot.className = 'thumb-slot note ' + kind;
    slot.textContent = text;
    slot.title = title;
  }

  /** 这一格不再显示原来那张缩略图：不再等它变得看得见；已经要过地址的 release 掉 */
  function dropThumb(c) {
    if (!c) return;
    if (c.slot && watching.has(c.slot)) {
      watching.delete(c.slot);
      if (thumbObserver) thumbObserver.unobserve(c.slot);
    }
    if (c.thumbHeld && c.thumbPath && shotsApi && shotsApi.urls) shotsApi.urls.release(c.thumbPath);
    c.thumbHeld = false;
    c.thumbPath = null;
  }

  function releaseView(v) {
    if (v && v.kind !== 'system' && v.cells && v.cells.shots) dropThumb(v.cells.shots);
  }

  function renderEmpty(view, st) {
    const c = view.cells;
    const dflt = store.emptyRowDefaults();
    setClass(view.tr, 'selected', false);
    setText(c.no.span, String(st.derived.grouped.nextNo));
    const ghost = {
      date: dflt.date,
      symbol: dflt.symbol || null,
      risk: typeof dflt.risk === 'number' ? fmtMoney(dflt.risk) : null,
    };
    for (const col of LINE_TEXT_COLUMNS) {
      const input = c[col].input;
      setValue(input, '');
      setAttr(input, 'placeholder', ghost[col] || null);
      setAttr(input, 'aria-label', `新的一笔 ${COLUMN_NAME[col]}${ghost[col] ? `（默认 ${ghost[col]}）` : ''}`);
      setAttr(input, 'title', null);
      setAttr(input, 'aria-invalid', null);
    }
    const dir = fmtDirection(dflt.direction);
    setText(c.direction.label, dir);
    setAttr(c.direction.btn, 'aria-label', `新的一笔 方向：默认${dir}（空格或回车切换）`);
    setClass(c.rr.td, 'missing', false);
    setClass(c.risk.td, 'missing', false);
    setText(c.tp.td, '');
    setHidden(c.result.label, true);
    setAttr(c.result.label, 'class', 'chip');
    setText(c.result.label, '');
    setAttr(c.result.btn, 'aria-label', '新的一笔 结果（1 或 Y 盈，0 或 N 亏）');
    setClass(c.pnl.td, 'win', false);
    setClass(c.pnl.td, 'loss', false);
    setClass(c.pnl.td, 'has-tag', false);
    setHidden(c.pnl.tag, true);
  }

  function renderSystem(view, seg) {
    const sys = seg.sys || { name: '', desc: '' };
    const s = seg.stats;
    const letter = seg.letter;
    setText(view.label, '系统 ' + letter);
    setValue(view.name, toCellText(sys.name));
    setValue(view.desc, toCellText(sys.desc));
    setAttr(view.desc, 'title', sys.desc ? sys.desc : null);
    setAttr(view.name, 'aria-label', `系统 ${letter} 名称`);
    setAttr(view.desc, 'aria-label', `系统 ${letter} 说明`);
    setAttr(view.menuBtn, 'aria-label', `系统 ${letter} 的操作`);
    setText(view.stats.n, String(s.n));
    setText(view.stats.win, fmtPct(s.winRate));
    setText(view.stats.payoff, fmtTwo(s.payoff));
    setText(view.stats.exp, fmtR(s.expectancy, 2));
    setText(view.stats.total, fmtR(s.n ? s.totalR : null, 1));
    const text = segmentHint(s.n);
    setText(view.hint, text);
    setHidden(view.hint, !text);
  }

  function refreshView(view, st = store.get()) {
    if (!view) return;
    if (view.kind === 'trade') {
      const it = st.derived.tradeById.get(view.id);
      if (it) renderTrade(view, it, st);
    } else if (view.kind === 'system') {
      const seg = st.derived.segmentById.get(view.id);
      if (seg) renderSystem(view, seg);
    } else {
      renderEmpty(view, st);
    }
  }

  function refreshAll() {
    const st = store.get();
    for (const tr of Array.from(tbody.children)) refreshView(viewOfTr(tr), st);
  }

  function refreshSystems() {
    const st = store.get();
    for (const v of views.values()) if (v.kind === 'system') refreshView(v, st);
  }

  function renderHeader() {
    const cur = store.get().journal.currency;
    for (const c of COLUMNS) setText(headLabels.get(c.key), headerLabel(c.key, cur));
  }

  function refreshFooter() {
    const st = store.get();
    const can = canEdit();
    // 只读时（另一个标签页在写、版本守卫拦着）不显示"换交易系统"（7.11）
    setHidden(addBtn, !can);
    setHidden(addTradeBtn, !can);
    const auto = !st.ui.demo && st.derived.grouped.trades.length === 0;
    setHidden(demoBtn, !(onLoadDemo && (demoOverride === null ? auto : demoOverride)));
    let text;
    let warn = false;
    if (st.ui.demo) text = '现在是示例数据：只在这个页面里，随便改都不会保存；退出示例后回到你自己的数据。';
    else if (st.ui.readOnly) { text = readOnlyMessage(st.ui.readOnly) + '。'; warn = true; }
    else text = '点「＋ 记一笔」新增一行。出场后在盈亏格打「盈」或「亏」；打实际金额就是没按系统做，会标「改」。';
    setText(hint, text);
    setClass(hint, 'warn', warn);
  }

  function applyEditable(view, can = canEdit()) {
    const inputs = view.kind === 'system' ? [view.name, view.desc] : LINE_TEXT_COLUMNS.map((col) => view.cells[col].input);
    for (const input of inputs) if (input.readOnly !== !can) input.readOnly = !can;
    // 只读时隐藏空行（7.11）
    if (view.kind === 'empty') setHidden(view.tr, !can);
    if (view.kind !== 'system') {
      setAttr(view.cells.direction.btn, 'aria-disabled', can ? null : 'true');
      setAttr(view.cells.result.btn, 'aria-disabled', can ? null : 'true');
    }
  }

  function updateEditable() {
    const can = canEdit();
    for (const v of views.values()) applyEditable(v, can);
    if (emptyView) applyEditable(emptyView, can);
    setClass(table, 'is-readonly', !can);
    refreshFooter();
  }

  // ---------- 行的增删（只动变了的行，不移动已有的行，免得有焦点的格子失焦） ----------
  function reconcile() {
    const rows = store.get().journal.rows;
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, v] of Array.from(views)) {
      if (!ids.has(id)) {
        releaseView(v);
        v.tr.remove();
        views.delete(id);
      }
    }
    let cursor = tbody.firstElementChild;
    for (const row of rows) {
      let v = views.get(row.id);
      if (v && v.kind !== row.type) {
        releaseView(v);
        v.tr.remove();
        views.delete(row.id);
        v = null;
      }
      if (!v) {
        v = buildView(row);
        views.set(row.id, v);
      }
      if (v.tr === cursor) cursor = cursor.nextElementSibling;
      else tbody.insertBefore(v.tr, cursor);
    }
    if (!emptyView) emptyView = buildLineView('empty');
    if (tbody.lastElementChild !== emptyView.tr) tbody.appendChild(emptyView.tr);
  }

  /** 空行变成交易行：原地换掉行号和截图格，格子里的输入框不动；下面接一行新的空行 */
  function promote(view, id) {
    view.kind = 'trade';
    view.id = id;
    view.tr.className = 'trade-row';
    view.tr.dataset.id = id;
    fillRowhead(view);
    fillShots(view);
    views.set(id, view);
    emptyView = buildLineView('empty');
    tbody.appendChild(emptyView.tr);
  }

  /** 交易行变回空行（刚在空行建的一笔被 Esc 撤掉）：去掉多出来的那行空行 */
  function demote(view) {
    views.delete(view.id);
    if (emptyView && emptyView !== view) emptyView.tr.remove();
    view.kind = 'empty';
    view.id = null;
    view.tr.className = 'empty-row';
    view.tr.removeAttribute('data-id');
    fillRowhead(view);
    fillShots(view);
    emptyView = view;
  }

  // ---------- 整表重建（只在 'journal' 事件和挂载时） ----------
  function captureFocus() {
    const el = doc.activeElement;
    if (!el || !tbody.contains(el)) return null;
    const view = viewOf(el);
    if (!view || !el.dataset || !el.dataset.col) return null;
    const pos = { id: view.kind === 'empty' ? null : view.id, kind: view.kind, col: el.dataset.col, start: null, end: null };
    if (el.tagName === 'INPUT') {
      pos.start = el.selectionStart;
      pos.end = el.selectionEnd;
    }
    return pos;
  }

  function restoreFocus(pos) {
    if (!pos) return;
    const view = pos.kind === 'empty' ? emptyView : views.get(pos.id);
    const el = cellEl(view, pos.col);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.tagName === 'INPUT' && pos.start !== null) {
      try {
        el.setSelectionRange(Math.min(pos.start, el.value.length), Math.min(pos.end, el.value.length));
      } catch (err) { /* 有的输入框类型不支持 */ }
    }
  }

  function rebuild() {
    const pos = captureFocus();
    closeMenu(false);
    edit = null;
    composing.clear();
    promoting = null;
    demoting = null;
    for (const v of views.values()) releaseView(v);
    releaseView(emptyView);
    tbody.textContent = '';
    views.clear();
    emptyView = null;
    for (const row of store.get().journal.rows) {
      const v = buildView(row);
      views.set(row.id, v);
      tbody.appendChild(v.tr);
    }
    emptyView = buildLineView('empty');
    tbody.appendChild(emptyView.tr);
    renderHeader();
    updateEditable();
    refreshAll();
    restoreFocus(pos);
  }

  // ---------- 订阅 store ----------
  function onRows(ev) {
    const id = ev.ids && ev.ids[0];
    if (ev.reason === 'create' && promoting && id && !views.has(id)) promote(promoting, id);
    else if (ev.reason === 'delete' && demoting && id === demoting.id) demote(demoting);
    reconcile();
    if (edit && !edit.input.isConnected) edit = null;
    for (const input of Array.from(composing)) if (!input.isConnected) composing.delete(input);
    if (menu && !menu.view.tr.isConnected) closeMenu(false);
    if (ev.reason === 'currency') renderHeader();
    refreshAll();
    refreshFooter();
  }

  function onRow(ev) {
    const st = store.get();
    const id = ev.ids && ev.ids[0];
    const v = id ? views.get(id) : null;
    if (v) refreshView(v, st);
    if (!v || v.kind === 'trade') refreshSystems(); // 交易变了，各系统的小计跟着变
    if (emptyView) refreshView(emptyView, st); // 空行沿用上一笔的品种和止损
  }

  function onUi(ev) {
    if (ev.reason === 'select') {
      const sel = store.get().ui.selectedId;
      for (const id of ev.ids || []) {
        const v = views.get(id);
        if (v) setClass(v.tr, 'selected', sel === id);
      }
    } else if (ev.reason === 'readOnly') {
      updateEditable();
    }
  }

  refreshSymbols();
  const off = store.subscribe((ev) => {
    if (!ev) return;
    if (ev.type !== 'ui') refreshSymbols();
    if (ev.type === 'journal') rebuild();
    else if (ev.type === 'rows') onRows(ev);
    else if (ev.type === 'row') onRow(ev);
    else if (ev.type === 'ui') onUi(ev);
  });

  // ---------- 编辑一格 ----------
  function rawValue(view, col) {
    const st = store.get();
    if (view.kind === 'trade') {
      const it = st.derived.tradeById.get(view.id);
      if (!it) return undefined;
      return col === 'pnl' ? it.t.pnlOverride : it.t[col];
    }
    if (view.kind === 'system') {
      const seg = st.derived.segmentById.get(view.id);
      return seg && seg.sys ? seg.sys[col] : undefined;
    }
    const d = store.emptyRowDefaults(); // 空行的"原值"就是灰色的默认值
    return { date: d.date, symbol: d.symbol, risk: d.risk, rr: null, reason: '', note: '', pnl: null }[col];
  }

  function startSession(input) {
    const view = viewOf(input);
    if (!view) return null;
    const col = input.dataset.col;
    edit = { input, view, col, entryText: input.value, entryRaw: rawValue(view, col), edited: false, createdId: null };
    return edit;
  }

  /** 用数据里的值重画这一格（就算它有焦点）：提交或恢复之后用 */
  function renderInput(s) {
    if (composing.has(s.input)) return;
    const st = store.get();
    let text = s.input.value;
    if (s.view.kind === 'trade') {
      const it = st.derived.tradeById.get(s.view.id);
      if (it) text = tradeCellText(s.col, it.t, it.d);
    } else if (s.view.kind === 'system') {
      const seg = st.derived.segmentById.get(s.view.id);
      if (seg && seg.sys) text = toCellText(seg.sys[s.col]);
    } else {
      text = '';
    }
    if (s.input.value !== text) s.input.value = text;
  }

  function rebaseline(s) {
    s.entryText = s.input.value;
    s.entryRaw = rawValue(s.view, s.col);
    s.edited = false;
  }

  /** 提交正在编辑的格子（失焦、Enter、↑↓、切到后台、关页面时） */
  function commitSession(s) {
    if (!s || !s.edited || !s.input.isConnected || composing.has(s.input)) return;
    const { view, col, input } = s;
    if (view.kind === 'empty') { // 空行里打了字却没建成交易（只读时）
      renderInput(s);
      rebaseline(s);
      return;
    }
    if (!canEdit()) {
      notifyReadOnly();
      renderInput(s);
      rebaseline(s);
      return;
    }
    const res = interpretInput(col, input.value, ctx());
    if (!res.ok) {
      if (view.kind === 'trade' && STORED_COLUMNS.has(col) && s.entryRaw !== undefined) {
        store.actions.updateTrade(view.id, { [col]: s.entryRaw }); // 输入过程中先提交过的值也一起撤回
      }
      if (res.message) showToast(res.message);
    } else if (view.kind === 'system') {
      store.actions.updateSystem(view.id, res.patch);
    } else if (col === 'pnl' && res.result) {
      store.actions.updateTrade(view.id, { result: res.result, pnlOverride: null });
    } else if (col === 'pnl') {
      store.actions.setPnlInput(view.id, res.pnl);
    } else {
      store.actions.updateTrade(view.id, res.patch);
    }
    renderInput(s);
    rebaseline(s);
  }

  /** Esc：恢复成进入这一格时的值；这一笔是在这一格里刚建的，就撤掉它、变回空行 */
  function restoreSession(s) {
    const { view, col, input } = s;
    if (composing.has(input)) return;
    if (view.kind === 'trade' && s.createdId && s.createdId === view.id && canEdit()) {
      demoting = view;
      let undo = null;
      try {
        undo = store.actions.deleteTrade(view.id);
      } finally {
        demoting = null;
      }
      if (undo) {
        input.value = '';
        s.createdId = null;
        rebaseline(s);
        return;
      }
    }
    if (view.kind === 'trade' && STORED_COLUMNS.has(col) && s.entryRaw !== undefined && canEdit()) {
      store.actions.updateTrade(view.id, { [col]: s.entryRaw });
    }
    if (input.value !== s.entryText) input.value = s.entryText;
    s.edited = false;
    try { input.select(); } catch (err) { /* 不支持就算了 */ }
  }

  /** 空行里第一次输入：建一笔交易，这一行原地变成交易行（在 'rows' 事件里完成） */
  function createFromEmpty(view, patch) {
    if (!canEdit()) {
      notifyReadOnly();
      return null;
    }
    promoting = view;
    try {
      return store.actions.createTradeFromEmptyRow(patch);
    } finally {
      promoting = null;
    }
  }

  function handleTyped(input) {
    const s = edit && edit.input === input ? edit : startSession(input);
    if (!s) return;
    s.edited = true;
    const view = s.view;
    if (view.kind === 'empty') {
      const id = createFromEmpty(view, emptyRowPatch(s.col, input.value, ctx()));
      if (id && view.kind === 'trade' && view.id === id) s.createdId = id;
      return;
    }
    if (view.kind === 'trade' && canEdit()) {
      const live = liveValue(s.col, input.value, ctx());
      if (live) store.actions.updateTrade(view.id, { [s.col]: live.value });
    }
  }

  // ---------- 按钮格 ----------
  function toggleDirection(view) {
    if (!canEdit()) { notifyReadOnly(); return; }
    if (view.kind === 'empty') {
      const d = store.emptyRowDefaults();
      createFromEmpty(view, { direction: d.direction === 'short' ? 'long' : 'short' });
      return;
    }
    const it = store.get().derived.tradeById.get(view.id);
    if (it) store.actions.updateTrade(view.id, { direction: it.t.direction === 'short' ? 'long' : 'short' });
  }

  function cycleResult(view) {
    if (!canEdit()) { notifyReadOnly(); return; }
    if (view.kind === 'empty') createFromEmpty(view, { result: 'win' });
    else if (view.kind === 'trade') store.actions.cycleResult(view.id);
  }

  function applyResult(view, value) {
    if (!canEdit()) { notifyReadOnly(); return; }
    if (view.kind === 'empty') {
      if (value) createFromEmpty(view, { result: value });
    } else if (view.kind === 'trade') {
      store.actions.setResult(view.id, value);
    }
  }

  // ---------- 焦点移动 ----------
  function navRows() {
    return Array.from(tbody.children).filter((tr) => !tr.classList.contains('empty-row')).map((tr) => {
      const v = viewOfTr(tr);
      return { kind: v ? v.kind : 'system', cols: v ? NAV_COLUMNS[v.kind] : [] };
    });
  }

  function focusEl(el) {
    if (!el) return false;
    el.focus();
    if (el.tagName === 'INPUT') {
      try { el.select(); } catch (err) { /* 不支持就算了 */ }
    }
    return true;
  }

  function destination(view, col, move) {
    const trs = Array.from(tbody.children);
    const r = trs.indexOf(view.tr);
    const pos = nextCell(navRows(), r, col, move);
    return pos ? cellEl(viewOfTr(trs[pos.row]), pos.col) : null;
  }

  /** 把焦点放到某一行的第一格（删除后、撤销后用） */
  function focusRowStart(view) {
    if (!view) return false;
    const col = view.kind === 'trade' ? 'no' : view.kind === 'system' ? 'name' : 'date';
    return focusEl(cellEl(view, col));
  }

  /**
   * 把焦点放到某一格。id 是行 id；空行用 'empty'。
   * 例："换交易系统"后 focusCell(新系统行 id, 'name')。
   */
  function focusCell(id, col) {
    const view = id === 'empty' ? emptyView : views.get(id);
    return focusEl(cellEl(view, col));
  }

  // ---------- 事件 ----------
  /** 切窗口时留着没交的那一格：现在交掉（失焦时该做的事） */
  function settleAway() {
    const s = edit;
    if (!s || !s.awayFromWindow) return;
    s.awayFromWindow = false;
    commitSession(s);
    if (edit === s) edit = null;
    if (s.input.isConnected) refreshView(viewOf(s.input));
  }

  function onFocusIn(e) {
    const t = e.target;
    if (edit && edit.input !== t && edit.awayFromWindow) settleAway(); // 切窗口回来后点了别的格子：先把原来那格交掉
    if (edit && edit.input === t) edit.awayFromWindow = false; // 切窗口回来，焦点回到原来的格子：接着编辑
    if (isCellInput(t) && !(edit && edit.input === t)) startSession(t);
    const view = viewOf(t);
    if (view && view.kind === 'empty') renderEmpty(view, store.get()); // 日期按此刻的"今天"
  }

  function onFocusOut(e) {
    const t = e.target;
    if (!edit || edit.input !== t) return;
    // 切到别的窗口（document.hasFocus() 为 false）：先不提交也不恢复，等回来再处理。
    // 回来时焦点通常回到这一格（onFocusIn 接着编辑）；落到别处时由 onFocusIn / 窗口的 focus 事件交掉。
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus() && !composing.has(t)) {
      edit.awayFromWindow = true;
      return;
    }
    const s = edit;
    if (composing.has(t)) composing.delete(t);
    commitSession(s);
    if (edit === s) edit = null;
    if (t.isConnected) refreshView(viewOf(t));
  }

  function onInput(e) {
    const input = e.target;
    if (!isCellInput(input)) return;
    if (e.isComposing || composing.has(input)) return; // 组字中：不提交、不改写
    handleTyped(input);
  }

  function onKeyDown(e) {
    const target = e.target;
    if (!target || !target.dataset || !target.dataset.col) return;
    const view = viewOf(target);
    if (!view) return;
    const kind = cellKind(target);
    const act = keyAction(e, kind);
    if (!act) return;
    if (act.type === 'restore') {
      e.preventDefault();
      if (edit && edit.input === target) restoreSession(edit);
      return;
    }
    if (act.type === 'result') {
      e.preventDefault();
      applyResult(view, act.value);
      return;
    }
    if (act.commit && edit && edit.input === target) commitSession(edit);
    const current = viewOf(target) || view; // 提交可能让这一行从空行变成了交易行
    const dest = destination(current, target.dataset.col, act.move);
    if (!dest) {
      if (act.move !== 'next' && act.move !== 'prev') e.preventDefault(); // Tab 到头时交给浏览器移出表格
      return;
    }
    e.preventDefault();
    focusEl(dest);
  }

  function onClick(e) {
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('button') : null;
    if (!btn || !tbody.contains(btn)) return;
    const view = viewOf(btn);
    if (!view) return;
    if (btn.classList.contains('row-menu-btn') || btn.classList.contains('sys-menu-btn')) {
      e.preventDefault();
      if (menu && menu.view === view) closeMenu(true);
      else openMenu(view, btn, null);
      return;
    }
    const col = btn.dataset.col;
    if (col === 'no' || col === 'shots') {
      if (view.kind === 'trade' && openDetail) {
        e.stopPropagation(); // 已经处理了，别让页面上其他按 data-open 打开详情的监听再开一次
        openDetail(view.id);
      }
      return;
    }
    if (col === 'direction') toggleDirection(view);
    else if (col === 'result') cycleResult(view);
  }

  function onContextMenu(e) {
    const t = e.target;
    const view = viewOf(t);
    if (!view || view.kind === 'empty') return;
    if (view.kind === 'trade') {
      if (!t.closest('td.rowhead')) return; // 只拦行号上的右键，其他格子保留浏览器自己的菜单（复制粘贴）
    } else if (t.tagName === 'INPUT') {
      return;
    }
    e.preventDefault();
    const trigger = view.kind === 'trade' ? view.cells.no.btn : view.menuBtn;
    const point = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null;
    openMenu(view, trigger, point);
  }

  // ---------- 行操作菜单（7.6） ----------
  function menuItems(view) {
    const st = store.get();
    const can = canEdit();
    const why = can ? '' : readOnlyMessage(st.ui.readOnly);
    if (view.kind === 'trade') {
      return [
        { text: '在上方插入系统行', sub: '从这一笔开始换一个交易系统', disabled: !can, why, run: () => insertSystemAbove(view.id) },
        { text: '删除这一笔…', disabled: !can, why, run: () => { deleteTradeFlow(view.id); } },
      ];
    }
    if (view.kind === 'system') {
      const first = st.journal.rows.length > 0 && st.journal.rows[0].id === view.id;
      const firstWhy = '第一行的系统不能删除，可以改名';
      return [{
        text: '删除这个系统行…',
        sub: first ? firstWhy : '它下面的交易并入上一个系统',
        disabled: first || !can,
        why: first ? firstWhy : why,
        run: () => { deleteSystemFlow(view.id); },
      }];
    }
    return [];
  }

  function openMenu(view, trigger, point) {
    closeMenu(false);
    const items = menuItems(view);
    if (!items.length || !trigger) return;
    const el = h('div', 'ctx-menu');
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', view.kind === 'trade' ? '这一笔的操作' : '这个系统行的操作');
    const buttons = items.map((it) => {
      const b = button('ctx-item');
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.append(it.text);
      if (it.sub) b.appendChild(h('small', null, it.sub));
      if (it.disabled) {
        b.setAttribute('aria-disabled', 'true');
        if (it.why) b.title = it.why;
      }
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (it.disabled) {
          if (it.why) showToast(it.why);
          return;
        }
        closeMenu(true);
        it.run();
      });
      el.appendChild(b);
      return b;
    });
    doc.body.appendChild(el);

    // 放在鼠标位置（或按钮下方），超出窗口就往里挪
    const vw = doc.documentElement.clientWidth || win.innerWidth || 0;
    const vh = doc.documentElement.clientHeight || win.innerHeight || 0;
    const box = el.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    let x = point ? point.x : anchor.left;
    let y = point ? point.y : anchor.bottom;
    if (vw && x + box.width > vw - 8) x = Math.max(8, vw - box.width - 8);
    if (vh && y + box.height > vh - 8) y = Math.max(8, (point ? point.y : anchor.top) - box.height);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';

    const mac = new AbortController();
    const on = (target, type, fn, options) => target.addEventListener(type, fn, { ...(options || {}), signal: mac.signal });
    on(el, 'keydown', (ev) => {
      const i = buttons.indexOf(doc.activeElement);
      let k = -1;
      if (ev.key === 'ArrowDown') k = (i + 1) % buttons.length;
      else if (ev.key === 'ArrowUp') k = (i - 1 + buttons.length) % buttons.length;
      else if (ev.key === 'Home') k = 0;
      else if (ev.key === 'End') k = buttons.length - 1;
      else if (ev.key === 'Escape' || ev.key === 'Tab') {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu(true);
        return;
      }
      if (k >= 0) {
        ev.preventDefault();
        buttons[k].focus({ preventScroll: true });
      }
    });
    const toggles = trigger.hasAttribute('aria-haspopup'); // 菜单按钮自己负责开关；右键打开时点哪儿都关
    on(doc, 'pointerdown', (ev) => {
      if (el.contains(ev.target) || (toggles && trigger.contains(ev.target))) return;
      closeMenu(false);
    }, { capture: true });
    on(doc, 'scroll', () => closeMenu(false), { capture: true });
    on(win, 'resize', () => closeMenu(false));
    on(win, 'blur', () => closeMenu(false));

    if (trigger.hasAttribute('aria-haspopup')) trigger.setAttribute('aria-expanded', 'true');
    if (view.kind === 'trade' && view.cells.no.menu) view.cells.no.menu.setAttribute('aria-expanded', 'true');
    menu = { el, view, trigger, ac: mac };
    const first = buttons.find((b) => !b.hasAttribute('aria-disabled')) || buttons[0];
    first.focus({ preventScroll: true });
  }

  function closeMenu(restoreFocus) {
    if (!menu) return;
    const m = menu;
    menu = null;
    m.ac.abort();
    for (const b of [m.trigger, m.view.cells.no && m.view.cells.no.menu]) {
      if (b && b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus) { // 先把焦点放回行号，再拿掉菜单，焦点不经过 body
      const target = m.view.kind === 'trade' && m.view.cells.no.btn ? m.view.cells.no.btn : m.trigger;
      if (target && target.isConnected) target.focus();
    }
    m.el.remove();
  }

  // ---------- 行操作 ----------
  function insertSystemAbove(tradeId) {
    if (!canEdit()) { notifyReadOnly(); return; }
    const id = store.actions.insertSystemRowAbove(tradeId);
    if (id) focusCell(id, 'name');
  }

  /** ＋ 记一笔：按默认值（今天、沿用上一笔的品种和止损）新增一笔，光标放到品种格 */
  function addTrade() {
    if (!canEdit()) { notifyReadOnly(); return; }
    const id = createFromEmpty(emptyView, {});
    if (id) focusCell(id, 'symbol');
  }

  function addSystem() {
    if (!canEdit()) { notifyReadOnly(); return; }
    const id = store.actions.appendSystemRow();
    if (id) focusCell(id, 'name');
  }

  function sysTitle(seg) {
    return '系统 ' + seg.letter + (seg.sys && seg.sys.name ? `（${seg.sys.name}）` : '');
  }

  async function deleteTradeFlow(id) {
    const st = store.get();
    const it = st.derived.tradeById.get(id);
    if (!it) return;
    const t = it.t;
    const d = it.d;
    const money = d.pnl !== null ? ' ' + fmtMoney(d.pnl, { sign: true, currency: st.journal.currency }) : '';
    const line = [t.date, t.symbol || '没写品种', fmtDirection(t.direction), (OUTCOME_LABEL[d.outcome] || '') + money].join(' · ');
    const ok = await confirmDialog({
      title: `删除第 ${it.no} 笔？`,
      message: line + '\n删除后 10 秒内可以撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const view = views.get(id);
    if (!view) return;
    const next = viewOfTr(view.tr.nextElementSibling);
    const undo = store.actions.deleteTrade(id);
    if (!undo) {
      notifyReadOnly();
      return;
    }
    focusRowStart(next);
    showToast(`已删除第 ${it.no} 笔`, {
      undo: () => {
        const done = undo();
        if (done) focusCell(id, 'no');
        return done;
      },
    });
  }

  async function deleteSystemFlow(id) {
    const st = store.get();
    if (st.journal.rows.length && st.journal.rows[0].id === id) {
      showToast('第一行的系统不能删除，可以改名');
      return;
    }
    const seg = st.derived.segmentById.get(id);
    if (!seg) return;
    const segs = st.derived.grouped.segments;
    const k = segs.indexOf(seg);
    const prev = k > 0 ? segs[k - 1] : null;
    const name = sysTitle(seg);
    const n = seg.trades.length;
    const ok = await confirmDialog({
      title: `删除${name}？`,
      message: (n ? `它下面的 ${n} 笔交易会并入${prev ? sysTitle(prev) : '上一个系统'}，小计随之变化。` : '这个系统下面还没有交易。')
        + '\n删除后 10 秒内可以撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const view = views.get(id);
    if (!view) return;
    const next = viewOfTr(view.tr.nextElementSibling);
    const undo = store.actions.deleteSystemRow(id);
    if (!undo) {
      notifyReadOnly();
      return;
    }
    focusRowStart(next);
    showToast(`已删除${name}`, {
      undo: () => {
        const done = undo();
        if (done) focusCell(id, 'name');
        return done;
      },
    });
  }

  // ---------- 贴截图（7.8） ----------
  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
  }

  /** 没传 opts.shots 时：剪贴板里只有图片就提示一句（不收）；有文字照常粘贴 */
  function placeholderPaste(e) {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const hasImage = items.some((it) => it.kind === 'file' && /^image\//.test(it.type));
    const hasText = items.some((it) => it.kind === 'string' && it.type === 'text/plain');
    if (hasImage && !hasText) {
      e.preventDefault();
      showToast('截图功能下一版加上，现在还不能把截图贴进表格');
    }
  }

  function onPaste(e) {
    if (e.defaultPrevented) return;
    const view = viewOf(e.target);
    if (!view) return;
    if (!shotsApi) {
      placeholderPaste(e);
      return;
    }
    const info = readTransfer(e.clipboardData);
    if (!pasteWantsImage(info, isTypingTarget(e.target))) return; // 文字照常粘贴
    e.preventDefault();
    pasteShots(view, info.images);
  }

  function pasteShots(view, images) {
    if (!canEdit()) {
      notifyReadOnly();
      return;
    }
    if (!shotsApi.addShot) {
      showToast('现在还不能贴截图');
      return;
    }
    if (view.kind === 'system') {
      showToast('系统行不能贴图：把光标放到一笔交易的格子里，再按 Ctrl+V');
      return;
    }
    let id = view.kind === 'trade' ? view.id : null;
    let created = null;
    if (view.kind === 'empty') {
      id = createFromEmpty(view, {}); // 和在空行里打字一样：先按默认值建好这一笔
      if (!id) return;
      const it = store.get().derived.tradeById.get(id);
      created = it ? it.t : null;
    }
    if (id) addShotsTo(id, images, created);
  }

  /** 一张一张加；都没加上、而这一笔是刚为贴图新建的、之后也没人动过，就把它撤掉 */
  async function addShotsTo(id, images, created) {
    showToast(images.length > 1 ? `正在处理 ${images.length} 张截图…` : '正在处理截图…');
    let added = 0;
    let label = 'open';
    let failure = null;
    for (const blob of images) {
      const it = store.get().derived.tradeById.get(id);
      if (!it) {
        failure = failure || new Error('这一笔已经删掉了');
        break;
      }
      label = shotsApi.labelFor(it);
      try {
        const shot = await shotsApi.addShot(id, blob, label);
        if (shot) added += 1;
        else failure = failure || new Error('没有加上');
      } catch (err) {
        failure = failure || err;
      }
    }
    if (destroyed) return;
    const it = store.get().derived.tradeById.get(id);
    if (!added) {
      if (created && it && it.t === created) dropCreated(id);
      showToast('截图没加上：' + errorText(failure));
      return;
    }
    let msg = it
      ? `${created ? `新建了第 ${it.no} 笔，` : `第 ${it.no} 笔`}加了 ${added} 张截图（${shotLabelText(label)}）`
      : `加了 ${added} 张截图`;
    if (failure) msg += `；另有 ${images.length - added} 张没加上：${errorText(failure)}`;
    showToast(msg);
  }

  /** 撤掉为贴图新建、却没贴上图的那一笔；它是最后一笔时原地变回空行，焦点不丢 */
  function dropCreated(id) {
    const v = views.get(id);
    if (v && emptyView && v.tr.nextElementSibling === emptyView.tr) demoting = v;
    try {
      store.actions.deleteTrade(id);
    } finally {
      demoting = null;
    }
  }

  // ---------- 接上事件 ----------
  listen(tbody, 'focusin', onFocusIn);
  // 切窗口回来：焦点没回到原来那一格（落到了表格外面），就把那一格交掉
  listen(win, 'focus', () => {
    setTimeout(() => {
      if (edit && edit.awayFromWindow && doc.activeElement !== edit.input) settleAway();
    }, 0);
  });
  listen(tbody, 'focusout', onFocusOut);
  listen(tbody, 'input', onInput);
  listen(tbody, 'compositionstart', (e) => {
    if (isCellInput(e.target)) composing.add(e.target);
  });
  listen(tbody, 'compositionend', (e) => {
    const input = e.target;
    if (!composing.has(input)) return;
    composing.delete(input);
    if (isCellInput(input)) handleTyped(input); // 组字结束：这时才算输入（Chrome 组字中的 input 事件都跳过了）
  });
  listen(tbody, 'keydown', onKeyDown);
  listen(tbody, 'click', onClick);
  listen(tbody, 'contextmenu', onContextMenu);
  // 截图（7.8）：光标在某一行的任意格子里按 Ctrl+V，剪贴板里有图片就加到这一行；是文字照常粘贴，不拦截
  listen(tbody, 'paste', onPaste);
  listen(addTradeBtn, 'click', addTrade);
  listen(addBtn, 'click', addSystem);
  listen(demoBtn, 'click', () => {
    if (!onLoadDemo) return;
    Promise.resolve()
      .then(() => onLoadDemo())
      .catch((err) => showToast('示例数据没能载入：' + (err && err.message ? err.message : String(err))));
  });
  // 关页面、切到后台时，把正在编辑的那一格也提交掉（在本机存储立刻写盘之前：capture 阶段先于它执行）
  const flushEdit = () => {
    if (edit && edit.edited) commitSession(edit);
  };
  listen(win, 'pagehide', flushEdit, { capture: true });
  listen(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flushEdit();
  }, { capture: true });

  rebuild();

  return {
    focusCell,
    rebuild,
    /** "看看示例数据"按钮：true 显示、false 隐藏、null 自动（没有交易且不在示例模式时显示） */
    setDemoButton(visible) {
      demoOverride = visible === null || visible === undefined ? null : !!visible;
      refreshFooter();
    },
    /** 换掉"看看示例数据"的回调（null 表示不显示这个按钮） */
    setLoadDemo(fn) {
      onLoadDemo = typeof fn === 'function' ? fn : null;
      refreshFooter();
    },
    destroy() {
      destroyed = true;
      off();
      closeMenu(false);
      ac.abort();
      edit = null;
      composing.clear();
      for (const v of views.values()) releaseView(v);
      if (thumbObserver) thumbObserver.disconnect();
      thumbObserver = null;
      watching.clear();
      views.clear();
      emptyView = null;
      container.textContent = '';
    },
  };
}
