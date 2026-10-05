// 数字和日期的显示与解析（交接文档第 6.4 节）。纯函数，不碰 DOM。
// 显示：负号一律用 U+2212（−），数字始终带正负号，只在显示时四舍五入。
// 解析：- 和 − 都接受，忽略空格、逗号和货币符号；全角数字和全角标点也认。

import { EPS } from './calc.js';

/** 显示用的负号 U+2212 */
export const MINUS = '\u{2212}';
/** 没法算时显示的占位符 */
export const DASH = '—';

// ---------- 显示 ----------

/**
 * 把 abs（≥ 0）乘以 10^digits 后按十进制四舍五入成整数。
 * 不直接用 toFixed / Math.round(x * 100)：它们按二进制值舍入，
 * 50.025 会变成 50.02、1.005 会变成 1.00、0.145 × 100 会变成 14.499…。
 * 这里借助数字的最短十进制写法移动小数点，结果和手算一致。
 */
function scaledRound(abs, digits) {
  const s = String(abs);
  if (s.indexOf('e') !== -1) return Math.round(abs * Math.pow(10, digits)); // 极大或极小的数
  return Math.round(Number(s + 'e' + digits));
}

function roundAbs(abs, digits) {
  return scaledRound(abs, digits) / Math.pow(10, digits);
}

function fixed(abs, digits) {
  return roundAbs(abs, digits).toFixed(digits);
}

function group(intDigits) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 正数 '+'，负数 '−'，零（容差内）不带符号 */
export function signOf(v) {
  return v > EPS ? '+' : v < -EPS ? MINUS : '';
}

/**
 * R 值：带符号、固定小数位、后缀 R。
 * 期望值用 2 位（+0.20R），累计、最大回撤、单笔 R 用 1 位（+3.0R、−2.5R）。
 */
export function fmtR(v, digits = 1) {
  if (!isNum(v)) return DASH;
  return signOf(v) + fixed(Math.abs(v), digits) + 'R';
}

/** 两位小数：实际盈亏比、盈利因子（2.00、1.33） */
export function fmtTwo(v) {
  if (!isNum(v)) return DASH;
  return (v < -EPS ? MINUS : '') + fixed(Math.abs(v), 2);
}

/** 胜率：整数百分比（40%）。p 是 0–1 之间的比例。 */
export function fmtPct(p) {
  if (!isNum(p)) return DASH;
  const pct = scaledRound(Math.abs(p), 2);
  return (p < 0 && pct !== 0 ? MINUS : '') + pct + '%';
}

/** 胜率误差：整数百分比、前面带 ±（±25%）。ci 的单位已经是百分点。没有时返回空串。 */
export function fmtCi(ci) {
  if (!isNum(ci)) return '';
  return '±' + scaledRound(Math.abs(ci), 0) + '%';
}

/**
 * 金额：千分位，整数不带小数，否则两位小数（+300、−1,250.50）。
 * @param {object} [opts]
 * @param {boolean} [opts.sign]  正数也带 '+'（负数总是带 '−'）
 * @param {string}  [opts.currency]  金额单位。符号类（$、¥、HK$）放在数字前：+$20；
 *   以文字结尾的（元、USD）放在数字后并空一格：+20 元
 * @param {boolean} [opts.blank]  没有值时返回空串而不是 '—'（表格格子用）
 */
export function fmtMoney(v, opts = {}) {
  const { sign = false, currency = '', blank = false } = opts;
  if (!isNum(v)) return blank ? '' : DASH;
  const r = roundAbs(Math.abs(v), 2);
  const body = Number.isInteger(r) ? group(String(r)) : (function () {
    const parts = r.toFixed(2).split('.');
    return group(parts[0]) + '.' + parts[1];
  })();
  const prefix = v < -EPS ? MINUS : (sign && v > EPS ? '+' : '');
  if (!currency) return prefix + body;
  return /\p{L}$/u.test(currency) ? prefix + body + ' ' + currency : prefix + currency + body;
}

/** 盈亏比：至少一位小数，最多两位（2.0、1.8、2.25）。没有值时返回空串。 */
export function fmtRR(v) {
  if (!isNum(v)) return '';
  const s = fixed(Math.abs(v), 2);
  return (v < -EPS ? MINUS : '') + (s.charAt(s.length - 1) === '0' ? s.slice(0, -1) : s);
}

/** 方向只显示"多"/"空"两个字 */
export function fmtDirection(direction) {
  return direction === 'short' ? '空' : '多';
}

/** 结果格显示的文字（6.2：盈、亏、平、持仓中；缺盈亏比或止损时显示"缺数"） */
export const OUTCOME_LABEL = Object.freeze({ win: '盈', loss: '亏', breakeven: '平', open: '持仓中', invalid: '缺数' });

/** 截图标签的显示文字 */
export const SHOT_LABEL = Object.freeze({ open: '开仓时', close: '平仓后', '': '' });

// ---------- 解析 ----------

/**
 * 解析用户输入的数字。
 * - 接受 - 和 −（以及全角减号等），接受开头的 +；
 * - 忽略空格、逗号、货币符号（$、¥、€…），以及传入的金额单位（如"元"）；
 * - 接受 1:2 这种写法，取冒号后面的数；全角数字、全角冒号、全角句点都认；
 * - 空串或无法解析返回 null（调用方用 str.trim() === '' 区分"清空"和"写错"）。
 * @param {string|number} input
 * @param {{currency?: string}} [opts]
 * @returns {number|null}
 */
export function parseNumber(input, opts = {}) {
  if (typeof input === 'number') return Number.isFinite(input) ? (input === 0 ? 0 : input) : null;
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC');
  const cur = typeof opts.currency === 'string' ? opts.currency.normalize('NFKC').trim() : '';
  if (cur && !/[\d.+\-]/.test(cur)) s = s.split(cur).join('');
  s = s
    .replace(/[\u{2212}\u{2010}-\u{2013}\u{FE63}]/gu, '-')
    .replace(/\u{3002}/gu, '.')
    .replace(/[\s,\p{Sc}]/gu, '');
  const colon = s.lastIndexOf(':');
  if (colon !== -1) s = s.slice(colon + 1);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : n; // 把 −0 归成 0
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].indexOf(m) !== -1 ? 30 : 31;
}

function ymd(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return y + '-' + pad2(m) + '-' + pad2(d);
}

/**
 * 解析用户输入的日期，返回 'YYYY-MM-DD'，无法解析返回 null。
 * 接受 2026-9-1、2026/9/1、2026.9.1、2026年9月1日、20260901；
 * 只写月日（9-1、9/1、9月1日）时补当前年份（按本地时间）。
 * @param {string} input
 * @param {Date} [now] 用来取"当前年份"，测试时可传入固定时间
 */
export function parseDate(input, now = new Date()) {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFKC').replace(/\s+/g, '');
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (m) return ymd(now.getFullYear(), +m[1], +m[2]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  return null;
}

/** 是不是一个真实存在的 'YYYY-MM-DD' 日期 */
export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return !!m && ymd(+m[1], +m[2], +m[3]) === s;
}

/** 今天的本地日期 'YYYY-MM-DD'（按用户所在时区，不用 UTC） */
export function todayLocal(now = new Date()) {
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
}
