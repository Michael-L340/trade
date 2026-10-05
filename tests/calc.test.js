// 计算模块：附录 A 的数据 → 附录 B 的预期结果，逐项断言；外加边界情况。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveTrade, groupRows, computeStats, sampleHint, segmentLetter, deriveJournal, EPS } from '../src/calc.js';

const journal = JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('../fixtures/sample-expected.json', import.meta.url), 'utf8'));

// 附录 B：小数比较允许 1e-6 的误差。ciHalfWidth 在附录 B 里只给到一位小数，按一位小数比较。
const TOL = 1e-6;
const TOL_BY_FIELD = { ciHalfWidth: 0.05 };

function near(actual, want, label, tol = TOL) {
  if (want === null) {
    assert.equal(actual, null, `${label} 应为 null，实际 ${actual}`);
    return;
  }
  if (typeof want === 'string') {
    assert.equal(actual, want, label);
    return;
  }
  assert.equal(typeof actual, 'number', `${label} 应为数字，实际 ${actual}`);
  assert.ok(Math.abs(actual - want) <= tol, `${label}：预期 ${want}，实际 ${actual}`);
}

function trade(fields) {
  return { type: 'trade', id: 't_x', date: '2026-10-01', symbol: 'XAUUSD', direction: 'long', rr: 2, risk: 100, result: null, pnlOverride: null, reason: '', note: '', shots: [], ...fields };
}

function items(rList) {
  // 只关心 R 的简化交易项：r 为 null 的当持仓中
  return rList.map((r, i) => ({ t: { id: 't_' + i }, d: { r, pnl: r === null ? null : r * 100, outcome: r === null ? 'open' : r > EPS ? 'win' : r < -EPS ? 'loss' : 'breakeven' }, no: i + 1 }));
}

test('附录 B：单笔派生值', () => {
  const byId = new Map(journal.rows.map((r) => [r.id, r]));
  for (const [id, want] of Object.entries(expected.trades)) {
    const d = deriveTrade(byId.get(id));
    for (const key of ['takeProfit', 'pnl', 'r', 'outcome']) near(d[key], want[key], `${id}.${key}`);
  }
});

test('附录 B：系统 A、系统 B 的小计', () => {
  const g = groupRows(journal.rows);
  assert.equal(g.segments.length, 2);
  for (const seg of g.segments) {
    const want = expected.systems[seg.sys.id];
    assert.ok(want, `附录 B 里没有 ${seg.sys.id}`);
    const s = computeStats(seg.trades);
    for (const [key, value] of Object.entries(want)) near(s[key], value, `${seg.sys.id}.${key}`, TOL_BY_FIELD[key]);
  }
});

test('附录 B：全部交易的合计', () => {
  const g = groupRows(journal.rows);
  const s = computeStats(g.trades);
  for (const [key, value] of Object.entries(expected.all)) near(s[key], value, `all.${key}`, TOL_BY_FIELD[key]);
});

test('附录 B：累计 R 序列 cumulativeR', () => {
  const s = computeStats(groupRows(journal.rows).trades);
  assert.equal(s.cumulative.length, expected.cumulativeR.length);
  expected.cumulativeR.forEach((v, i) => near(s.cumulative[i], v, `cumulativeR[${i}]`));
  assert.equal(s.closed.length, 15);
  assert.equal(s.closed.some((it) => it.t.id === 't_16'), false, '持仓中的 t_16 不进曲线');
});

test('附录 B：样本提示', () => {
  assert.equal(sampleHint(12), '样本偏少');
  assert.equal(sampleHint(3), '只有 3 笔，先别下结论');
  assert.equal(sampleHint(0), '只有 0 笔，先别下结论');
  assert.equal(sampleHint(4), '只有 4 笔，先别下结论');
  assert.equal(sampleHint(5), '样本偏少');
  assert.equal(sampleHint(29), '样本偏少');
  assert.equal(sampleHint(30), '');
});

test('分段：字母、顺序号、空行号、位置字段', () => {
  const g = groupRows(journal.rows);
  assert.deepEqual(g.segments.map((s) => s.letter), ['A', 'B']);
  assert.deepEqual(g.segments.map((s) => s.trades.length), [12, 4]);
  assert.deepEqual(g.trades.map((it) => it.no), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(g.nextNo, 17);
  const t13 = g.trades.find((it) => it.t.id === 't_13');
  assert.equal(t13.no, 13);
  assert.equal(t13.segIndex, 1);
  assert.equal(t13.rowIndex, 14, 't_13 在 rows 里的下标（中间隔着 sys_b）');
});

test('分段：系统字母超过 Z 后接 AA、AB', () => {
  assert.equal(segmentLetter(0), 'A');
  assert.equal(segmentLetter(25), 'Z');
  assert.equal(segmentLetter(26), 'AA');
  assert.equal(segmentLetter(27), 'AB');
  assert.equal(segmentLetter(51), 'AZ');
  assert.equal(segmentLetter(52), 'BA');
  const rows = Array.from({ length: 28 }, (_, i) => ({ type: 'system', id: 'sys_' + i, name: '', desc: '' }));
  assert.deepEqual(groupRows(rows).segments.slice(24).map((s) => s.letter), ['Y', 'Z', 'AA', 'AB']);
});

test('分段：第一行之前没有系统行时归到一个无名分段；不认识的行类型忽略', () => {
  const g = groupRows([trade({ id: 't_a' }), { type: 'note', id: 'x' }, { type: 'system', id: 'sys_1', name: '', desc: '' }, trade({ id: 't_b' })]);
  assert.equal(g.segments.length, 2);
  assert.equal(g.segments[0].sys, null);
  assert.deepEqual(g.segments[0].trades.map((it) => it.t.id), ['t_a']);
  assert.deepEqual(g.segments[1].trades.map((it) => it.t.id), ['t_b']);
  assert.equal(g.nextNo, 3);
});

test('单笔：持仓中、保本、手改金额、缺数', () => {
  assert.deepEqual(deriveTrade(trade({})), { takeProfit: 200, pnl: null, r: null, outcome: 'open', edited: false, missing: { rr: false, risk: false } });
  const be = deriveTrade(trade({ pnlOverride: 0 }));
  assert.equal(be.outcome, 'breakeven');
  assert.equal(be.r, 0);
  assert.equal(be.edited, true);
  assert.equal(deriveTrade(trade({ result: 'win', pnlOverride: 1e-12 })).outcome, 'breakeven', '容差内的小数算保本');
  assert.equal(deriveTrade(trade({ result: 'loss', pnlOverride: 35 })).outcome, 'win', '手改金额按正负判断盈亏');

  const noRr = deriveTrade(trade({ rr: null, result: 'win' }));
  assert.equal(noRr.outcome, 'invalid');
  assert.equal(noRr.r, null);
  assert.equal(noRr.takeProfit, null);
  assert.deepEqual(noRr.missing, { rr: true, risk: false });

  const noRisk = deriveTrade(trade({ risk: null, result: 'loss' }));
  assert.equal(noRisk.outcome, 'invalid');
  assert.deepEqual(noRisk.missing, { rr: false, risk: true });

  const overrideNoRisk = deriveTrade(trade({ risk: null, pnlOverride: 50 }));
  assert.equal(overrideNoRisk.pnl, 50);
  assert.equal(overrideNoRisk.r, null);
  assert.equal(overrideNoRisk.outcome, 'invalid');

  // 6.1 的公式：亏损只用到止损金额，缺盈亏比也算得出 R = −1
  const lossNoRr = deriveTrade(trade({ rr: null, result: 'loss' }));
  assert.equal(lossNoRr.r, -1);
  assert.equal(lossNoRr.outcome, 'loss');
  assert.equal(lossNoRr.missing.rr, true);

  for (const bad of [0, -2, NaN, Infinity, '2']) {
    assert.equal(deriveTrade(trade({ rr: bad, result: 'win' })).outcome, 'invalid', `rr = ${String(bad)} 不算有效`);
    assert.equal(deriveTrade(trade({ risk: bad })).missing.risk, true, `risk = ${String(bad)} 不算有效`);
  }
});

test('统计：没有已出场的交易时，没法算的指标都是 null', () => {
  const s = computeStats(items([null, null]));
  assert.equal(s.n, 0);
  assert.equal(s.open, 2);
  for (const key of ['winRate', 'ciHalfWidth', 'avgWinR', 'avgLossR', 'payoff', 'expectancy', 'profitFactor', 'avgWinMoney', 'avgLossMoney']) {
    assert.equal(s[key], null, key);
  }
  assert.equal(s.totalR, 0);
  assert.equal(s.totalMoney, 0);
  assert.equal(s.maxDrawdownR, 0);
  assert.equal(s.maxLossStreak, 0);
  assert.deepEqual(s.cumulative, [0]);
});

test('统计：没有亏损时实际盈亏比和盈利因子是 null；n < 5 不给胜率误差', () => {
  const s = computeStats(items([2, 1.5, 3, 1]));
  assert.equal(s.profitFactor, null);
  assert.equal(s.payoff, null);
  assert.equal(s.avgLossR, null);
  assert.equal(s.ciHalfWidth, null);
  assert.equal(s.winRate, 1);
  assert.equal(computeStats(items([2, 1.5, 3, 1, -1])).ciHalfWidth !== null, true, 'n = 5 开始给误差');
});

test('统计：最大连亏遇到保本或盈利就重新计数；最大回撤从 0 开始算', () => {
  assert.equal(computeStats(items([-1, -1, 0, -1])).maxLossStreak, 2);
  assert.equal(computeStats(items([-1, -1, -1, 2, -1])).maxLossStreak, 3);
  near(computeStats(items([-1])).maxDrawdownR, -1, '第一笔就亏');
  near(computeStats(items([2, -1, -1.5, 3, -0.5])).maxDrawdownR, -2.5, '高点 2 回到 −0.5');
  assert.equal(computeStats(items([1, 1, 1])).maxDrawdownR, 0);
});

test('统计：缺数的交易既不进统计也不算持仓中', () => {
  const rows = [
    { type: 'system', id: 'sys_1', name: '', desc: '' },
    trade({ id: 't_1', result: 'win' }),
    trade({ id: 't_2', rr: null, result: 'win' }),
    trade({ id: 't_3' }),
  ];
  const s = computeStats(groupRows(rows).trades);
  assert.equal(s.n, 1);
  assert.equal(s.open, 1);
});

test('deriveJournal：小计按系统行 id 取，分段上挂同一份统计', () => {
  const dj = deriveJournal(journal.rows);
  assert.deepEqual([...dj.segStats.keys()], ['sys_a', 'sys_b']);
  assert.equal(dj.segStats.get('sys_a'), dj.grouped.segments[0].stats);
  assert.equal(dj.segStats.get('sys_b').n, 3);
  assert.equal(dj.all.n, 15);
  assert.equal(dj.tradeById.get('t_07').no, 7);
  assert.equal(dj.segmentById.get('sys_b').letter, 'B');
});

test('计算不改动入参', () => {
  const before = JSON.stringify(journal);
  deriveJournal(journal.rows);
  assert.equal(JSON.stringify(journal), before);
});
