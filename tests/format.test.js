// 显示格式和输入解析（第 6.4 节），以及附录 B"界面上对应显示为"那张表。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MINUS, DASH, signOf, fmtR, fmtTwo, fmtPct, fmtCi, fmtMoney, fmtRR, fmtDirection, OUTCOME_LABEL, SHOT_LABEL,
  parseNumber, parseDate, isIsoDate, todayLocal,
} from '../src/format.js';
import { deriveJournal, sampleHint } from '../src/calc.js';

const M = '\u{2212}';

test('负号是 U+2212', () => {
  assert.equal(MINUS, M);
  assert.equal(MINUS.codePointAt(0), 0x2212);
  assert.equal(signOf(-1), M);
  assert.equal(signOf(1), '+');
  assert.equal(signOf(0), '');
  assert.equal(signOf(-1e-12), '', '容差内算 0');
});

test('fmtR：带符号、后缀 R，期望值两位、其余一位', () => {
  assert.equal(fmtR(0.2, 2), '+0.20R');
  assert.equal(fmtR(3), '+3.0R');
  assert.equal(fmtR(3, 1), '+3.0R');
  assert.equal(fmtR(-2.5, 1), M + '2.5R');
  assert.equal(fmtR(0, 1), '0.0R');
  assert.equal(fmtR(-1e-12, 1), '0.0R');
  assert.equal(fmtR(1.25, 1), '+1.3R', '十进制四舍五入');
  assert.equal(fmtR(-0.1666667, 2), M + '0.17R');
  assert.equal(fmtR(null), DASH);
  assert.equal(fmtR(undefined), DASH);
  assert.equal(fmtR(NaN), DASH);
});

test('fmtTwo：两位小数', () => {
  assert.equal(fmtTwo(2), '2.00');
  assert.equal(fmtTwo(1.3333333), '1.33');
  assert.equal(fmtTwo(2.1), '2.10');
  assert.equal(fmtTwo(1.005), '1.01', '按十进制舍入，不是二进制的 1.00');
  assert.equal(fmtTwo(-0.5), M + '0.50');
  assert.equal(fmtTwo(null), DASH);
});

test('fmtPct / fmtCi：整数百分比', () => {
  assert.equal(fmtPct(0.4), '40%');
  assert.equal(fmtPct(5 / 12), '42%');
  assert.equal(fmtPct(1 / 3), '33%');
  assert.equal(fmtPct(0.145), '15%', '0.145 × 100 不能因为浮点变成 14');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(1), '100%');
  assert.equal(fmtPct(null), DASH);
  assert.equal(fmtCi(24.79), '±25%');
  assert.equal(fmtCi(27.9), '±28%');
  assert.equal(fmtCi(null), '');
});

test('fmtMoney：带符号、千分位、整数不带小数', () => {
  assert.equal(fmtMoney(300, { sign: true }), '+300');
  assert.equal(fmtMoney(-1250.5, { sign: true }), M + '1,250.50');
  assert.equal(fmtMoney(-1250.5), M + '1,250.50', '不要求正号时负数也带负号');
  assert.equal(fmtMoney(1234567), '1,234,567');
  assert.equal(fmtMoney(1234567.891), '1,234,567.89');
  assert.equal(fmtMoney(100), '100');
  assert.equal(fmtMoney(0, { sign: true }), '0');
  assert.equal(fmtMoney(1.8 * 100), '180', '浮点误差不显示出来');
  assert.equal(fmtMoney(0.1 + 0.2), '0.30');
  assert.equal(fmtMoney(50.025), '50.03');
  assert.equal(fmtMoney(1250.999), '1,251', '四舍五入后是整数就不带小数');
  assert.equal(fmtMoney(null), DASH);
  assert.equal(fmtMoney(null, { blank: true }), '');
  assert.equal(fmtMoney(20, { sign: true, currency: '$' }), '+$20');
  assert.equal(fmtMoney(-50, { sign: true, currency: '$' }), M + '$50');
  assert.equal(fmtMoney(200, { currency: '$' }), '$200');
  assert.equal(fmtMoney(200, { currency: 'HK$' }), 'HK$200');
  assert.equal(fmtMoney(200, { sign: true, currency: '元' }), '+200 元');
  assert.equal(fmtMoney(-200, { currency: 'USD' }), M + '200 USD');
});

test('fmtRR：至少一位小数，最多两位', () => {
  assert.equal(fmtRR(2), '2.0');
  assert.equal(fmtRR(1.8), '1.8');
  assert.equal(fmtRR(2.25), '2.25');
  assert.equal(fmtRR(2.5), '2.5');
  assert.equal(fmtRR(1.234), '1.23');
  assert.equal(fmtRR(1.235), '1.24');
  assert.equal(fmtRR(10), '10.0');
  assert.equal(fmtRR(null), '');
  assert.equal(fmtRR(undefined), '');
});

test('文字标签：方向只显示多/空，结果和截图标签', () => {
  assert.equal(fmtDirection('long'), '多');
  assert.equal(fmtDirection('short'), '空');
  assert.deepEqual(OUTCOME_LABEL, { win: '盈', loss: '亏', breakeven: '平', open: '持仓中', invalid: '缺数' });
  assert.equal(SHOT_LABEL.open, '开仓时');
  assert.equal(SHOT_LABEL.close, '平仓后');
  assert.equal(SHOT_LABEL[''], '');
});

test('parseNumber：负号、空格、逗号、货币符号、1:2、全角', () => {
  assert.equal(parseNumber('2'), 2);
  assert.equal(parseNumber(' 2.5 '), 2.5);
  assert.equal(parseNumber('1:2'), 2);
  assert.equal(parseNumber('1:2.5'), 2.5);
  assert.equal(parseNumber('1 : 3'), 3);
  assert.equal(parseNumber('1\u{FF1A}2'), 2, '全角冒号');
  assert.equal(parseNumber('-50'), -50);
  assert.equal(parseNumber(M + '50'), -50);
  assert.equal(parseNumber(M + '$1,250.50'), -1250.5);
  assert.equal(parseNumber('$1,250.50'), 1250.5);
  assert.equal(parseNumber('+20'), 20);
  assert.equal(parseNumber('¥300'), 300);
  assert.equal(parseNumber('\u{FFE5}300'), 300, '全角人民币符号');
  assert.equal(parseNumber('€ 1 000'), 1000);
  assert.equal(parseNumber('\u{FF11}\u{FF12}\u{FF10}'), 120, '全角数字');
  assert.equal(parseNumber('\u{FF0D}50'), -50, '全角减号');
  assert.equal(parseNumber('1\u{3002}5'), 1.5, '中文输入法打出的句号当小数点');
  assert.equal(parseNumber('300元', { currency: '元' }), 300);
  assert.equal(parseNumber('1.'), 1, '输入到一半的 "1." 也认');
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(Object.is(parseNumber('-0'), 0), true, '−0 归成 0');
  for (const bad of ['', '   ', '-', '+', '.', 'abc', '1.2.3', '1e5', '2:', '--1', '1-', '$', null, undefined, {}]) {
    assert.equal(parseNumber(bad), null, `应无法解析：${JSON.stringify(bad)}`);
  }
  assert.equal(parseNumber(42), 42);
  assert.equal(parseNumber(NaN), null);
});

test('parseDate：补当前年份、各种分隔符、无效日期返回 null', () => {
  const now = new Date(2026, 9, 5, 12, 0); // 本地时间 2026-10-05
  assert.equal(parseDate('2026-9-1', now), '2026-09-01');
  assert.equal(parseDate('2026-09-01', now), '2026-09-01');
  assert.equal(parseDate('9-1', now), '2026-09-01');
  assert.equal(parseDate('9/1', now), '2026-09-01');
  assert.equal(parseDate('12/31', now), '2026-12-31');
  assert.equal(parseDate('2025/12/31', now), '2025-12-31');
  assert.equal(parseDate('2026.9.1', now), '2026-09-01');
  assert.equal(parseDate(' 2026-9-1 ', now), '2026-09-01');
  assert.equal(parseDate('2026年9月1日', now), '2026-09-01');
  assert.equal(parseDate('9月1日', now), '2026-09-01');
  assert.equal(parseDate('20260901', now), '2026-09-01');
  assert.equal(parseDate('\u{FF19}/\u{FF11}', now), '2026-09-01', '全角数字');
  assert.equal(parseDate('2024-2-29', now), '2024-02-29', '闰年');
  for (const bad of ['', 'abc', '2026-2-29', '2026-13-1', '2026-0-1', '13/1', '9/31', '2026-9', '26-9-1', '0226-9-1', '2026-09-01T08:00:00Z', null]) {
    assert.equal(parseDate(bad, now), null, `应无法解析：${JSON.stringify(bad)}`);
  }
  assert.equal(parseDate('9-1'), new Date().getFullYear() + '-09-01', '不传 now 时用当前年份');
});

test('isIsoDate', () => {
  assert.equal(isIsoDate('2026-09-01'), true);
  assert.equal(isIsoDate('2026-9-1'), false);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate(''), false);
  assert.equal(isIsoDate(null), false);
});

test('todayLocal 按本地日期，不用 UTC', () => {
  // 东八区的 00:30 在 UTC 还是前一天；西半球的 23:30 在 UTC 已经是第二天
  assert.equal(todayLocal(new Date(2026, 9, 5, 0, 30)), '2026-10-05');
  assert.equal(todayLocal(new Date(2026, 9, 5, 23, 30)), '2026-10-05');
  assert.equal(todayLocal(new Date(2026, 0, 9, 12)), '2026-01-09');
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
});

test('附录 B：界面上的显示文字', () => {
  const journal = JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));
  const cur = journal.currency;
  const { all, segStats } = deriveJournal(journal.rows);
  const a = segStats.get('sys_a');
  const b = segStats.get('sys_b');

  // 系统行小计
  assert.deepEqual(
    [a, b].map((s) => [s.n + ' 笔', fmtPct(s.winRate), fmtTwo(s.payoff), fmtR(s.expectancy, 2), fmtR(s.totalR, 1), sampleHint(s.n)]),
    [
      ['12 笔', '42%', '2.10', '+0.29R', '+3.5R', '样本偏少'],
      ['3 笔', '33%', '1.50', M + '0.17R', M + '0.5R', '只有 3 笔，先别下结论'],
    ],
  );

  // 顶部统计
  assert.equal(`${all.n} 笔已平仓，${all.open} 笔持仓中`, '15 笔已平仓，1 笔持仓中');
  assert.equal(fmtPct(all.winRate), '40%');
  assert.equal(`${all.wins} 胜 ${all.losses} 负，误差 ${fmtCi(all.ciHalfWidth)}`, '6 胜 9 负，误差 ±25%');
  assert.equal(fmtTwo(all.payoff), '2.00');
  assert.equal(`平均赚 ${fmtMoney(all.avgWinMoney, { currency: cur })}，亏 ${fmtMoney(all.avgLossMoney, { currency: cur })}`, '平均赚 $200，亏 $100');
  assert.equal(fmtR(all.expectancy, 2), '+0.20R');
  assert.equal(`每笔平均 ${fmtMoney(all.totalMoney / all.n, { sign: true, currency: cur })}`, '每笔平均 +$20');
  assert.equal(fmtR(all.totalR, 1), '+3.0R');
  assert.equal(`金额 ${fmtMoney(all.totalMoney, { sign: true, currency: cur })}`, '金额 +$300');
  assert.equal(fmtTwo(all.profitFactor), '1.33');
  assert.equal(fmtR(all.maxDrawdownR, 1), M + '2.5R');
  assert.equal(`${all.maxLossStreak} 笔`, '2 笔');
});
