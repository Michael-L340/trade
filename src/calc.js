// 计算规则（交接文档第 6.1–6.3 节）。纯函数，不碰 DOM、不改入参。
// 逻辑从预览稿 preview/index.html 的 @calc-begin/@calc-end 块移植，结果与之一致
// （预览稿的这段已与附录 B 对账）。改动只有两处，都不影响已有结果：
//   1. 系统字母超过 Z 以后接着用 AA、AB……（预览稿会变成 [、\ 等符号）；
//   2. groupRows 给每笔多带两个位置字段 segIndex、rowIndex，方便界面定位。

/** 判断正负时用的容差，避免浮点误差（6.1）。只在显示时才四舍五入。 */
export const EPS = 1e-9;

/**
 * 单笔的派生值（6.1）。
 * @returns {{takeProfit: number|null, pnl: number|null, r: number|null,
 *   outcome: 'open'|'win'|'loss'|'breakeven'|'invalid', edited: boolean,
 *   missing: {rr: boolean, risk: boolean}}}
 *   outcome 为 'invalid'：结果已选（或手改过金额）但缺盈亏比或止损金额、算不出 R，不进统计，
 *   界面在 missing 标出的格子上做标记。
 */
export function deriveTrade(t) {
  const rrOk = typeof t.rr === 'number' && Number.isFinite(t.rr) && t.rr > 0;
  const riskOk = typeof t.risk === 'number' && Number.isFinite(t.risk) && t.risk > 0;
  const takeProfit = rrOk && riskOk ? t.risk * t.rr : null;
  const hasOverride = typeof t.pnlOverride === 'number' && Number.isFinite(t.pnlOverride);
  let pnl = null;
  if (hasOverride) pnl = t.pnlOverride;
  else if (t.result === 'win') pnl = takeProfit;
  else if (t.result === 'loss') pnl = riskOk ? -t.risk : null;
  const r = pnl !== null && riskOk ? pnl / t.risk : null;
  let outcome;
  if (r === null) outcome = (t.result || hasOverride) ? 'invalid' : 'open';
  else if (r > EPS) outcome = 'win';
  else if (r < -EPS) outcome = 'loss';
  else outcome = 'breakeven';
  return { takeProfit, pnl, r, outcome, edited: hasOverride, missing: { rr: !rrOk, risk: !riskOk } };
}

/** 第 index 个系统行的字母：0 → A … 25 → Z，26 → AA，27 → AB…… */
export function segmentLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 按系统行分段（2.3：一笔交易属于它上方最近的那个系统行）。
 * @returns {{segments: Array<{sys: object|null, letter: string, trades: Array}>,
 *   trades: Array<{t: object, d: object, no: number, segIndex: number, rowIndex: number}>,
 *   nextNo: number}}
 *   no 是交易的顺序号（系统行不占号），nextNo 是空行该显示的下一个号。
 */
export function groupRows(rows) {
  const segments = [];
  let seg = null;
  let no = 0;
  rows.forEach(function (row, rowIndex) {
    if (row.type === 'system') {
      seg = { sys: row, letter: segmentLetter(segments.length), trades: [] };
      segments.push(seg);
    } else if (row.type === 'trade') {
      if (!seg) { seg = { sys: null, letter: 'A', trades: [] }; segments.push(seg); }
      no += 1;
      seg.trades.push({ t: row, d: deriveTrade(row), no: no, segIndex: segments.length - 1, rowIndex: rowIndex });
    }
  });
  const trades = [];
  segments.forEach(function (s) { s.trades.forEach(function (it) { trades.push(it); }); });
  return { segments: segments, trades: trades, nextNo: no + 1 };
}

/**
 * 一组交易的统计（6.3）。items 是 groupRows 产出的交易项（按表格顺序）。
 * 只有算得出 R 的交易才进统计；没法算的指标返回 null（界面显示"—"）。
 * ciHalfWidth 是胜率误差，单位是百分点；cumulative 是从 0 开始的累计 R 序列；
 * closed 是进了统计的那些交易项。
 */
export function computeStats(items) {
  const sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
  const mean = function (a) { return a.length ? sum(a) / a.length : null; };
  const closed = items.filter(function (it) { return it.d.r !== null; });
  const n = closed.length;
  const wins = closed.filter(function (it) { return it.d.r > EPS; });
  const losses = closed.filter(function (it) { return it.d.r < -EPS; });
  const winRate = n ? wins.length / n : null;
  const ciHalfWidth = n >= 5 ? 1.96 * Math.sqrt(winRate * (1 - winRate) / n) * 100 : null;
  const avgWinR = mean(wins.map(function (it) { return it.d.r; }));
  const avgLossR = mean(losses.map(function (it) { return Math.abs(it.d.r); }));
  const payoff = avgWinR !== null && avgLossR !== null ? avgWinR / avgLossR : null;
  const expectancy = n ? mean(closed.map(function (it) { return it.d.r; })) : null;
  const sumWinR = sum(wins.map(function (it) { return it.d.r; }));
  const sumLossR = sum(losses.map(function (it) { return Math.abs(it.d.r); }));
  const profitFactor = sumLossR > EPS ? sumWinR / sumLossR : null;
  const totalR = sum(closed.map(function (it) { return it.d.r; }));
  const totalMoney = sum(closed.map(function (it) { return it.d.pnl; }));
  let cum = 0, peak = 0, maxDrawdownR = 0;
  const cumulative = [0];
  closed.forEach(function (it) {
    cum += it.d.r;
    cumulative.push(cum);
    if (cum > peak) peak = cum;
    if (cum - peak < maxDrawdownR) maxDrawdownR = cum - peak;
  });
  let streak = 0, maxLossStreak = 0;
  closed.forEach(function (it) {
    if (it.d.r < -EPS) { streak += 1; if (streak > maxLossStreak) maxLossStreak = streak; } else streak = 0;
  });
  const avgWinMoney = mean(wins.map(function (it) { return it.d.pnl; }));
  const avgLossMoney = mean(losses.map(function (it) { return Math.abs(it.d.pnl); }));
  const open = items.filter(function (it) { return it.d.outcome === 'open' && !(it.d.missing && it.d.missing.rr); }).length; // 还没填盈亏比的不算持仓（表格里结果格也留空）
  return {
    n: n, wins: wins.length, losses: losses.length, open: open, winRate: winRate, ciHalfWidth: ciHalfWidth,
    avgWinR: avgWinR, avgLossR: avgLossR, payoff: payoff, expectancy: expectancy, profitFactor: profitFactor,
    totalR: totalR, totalMoney: totalMoney, maxDrawdownR: maxDrawdownR, maxLossStreak: maxLossStreak,
    avgWinMoney: avgWinMoney, avgLossMoney: avgLossMoney, cumulative: cumulative, closed: closed,
  };
}

/** 样本提示（6.3）：n < 5、5 ≤ n < 30 时各有一句，n ≥ 30 返回空串。 */
export function sampleHint(n) {
  if (n < 5) return '只有 ' + n + ' 笔，先别下结论';
  if (n < 30) return '样本偏少';
  return '';
}

/**
 * 整份数据的派生值：分段、全部合计、每个系统的小计。
 * segStats 的键是系统行 id；每个分段对象上也挂了同一份 stats（seg.stats）。
 * tradeById / segmentById 方便界面按 id 找到交易项或分段。
 */
export function deriveJournal(rows) {
  const grouped = groupRows(rows);
  const segStats = new Map();
  const segmentById = new Map();
  grouped.segments.forEach(function (seg) {
    seg.stats = computeStats(seg.trades);
    const key = seg.sys ? seg.sys.id : null;
    segStats.set(key, seg.stats);
    segmentById.set(key, seg);
  });
  const tradeById = new Map();
  grouped.trades.forEach(function (it) { tradeById.set(it.t.id, it); });
  // 几个系统同时在用：全部交易的统计和累计曲线按日期排（同一天按表里的先后），回撤、连亏才对得上时间
  const byDate = grouped.trades.slice().sort(function (x, y) {
    const a = typeof x.t.date === 'string' ? x.t.date : '';
    const b = typeof y.t.date === 'string' ? y.t.date : '';
    return a < b ? -1 : a > b ? 1 : x.no - y.no;
  });
  return { grouped: grouped, all: computeStats(byDate), segStats: segStats, tradeById: tradeById, segmentById: segmentById };
}
