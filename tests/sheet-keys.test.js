// 交易表的纯逻辑（src/ui/sheet.js 上半部分）：键盘移动的下一格、按键含义、输入的解析和提交规则、格子显示。
// 不碰 DOM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLUMNS, NAV_COLUMNS, NEWLINE_MARK, nextCell, keyAction, resultForKey, isComposingKey, interpretInput, liveValue,
  emptyRowPatch, toCellText, fromCellText, tradeCellText, missingFlags, outcomeChip, headerLabel, segmentHint,
  readOnlyMessage,
} from '../src/ui/sheet.js';
import { deriveJournal, deriveTrade } from '../src/calc.js';

const M = '\u{2212}';
const NOW = new Date(2026, 9, 5, 10, 0, 0);
const sample = JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));

// 系统 A、两笔、系统 B、一笔、空行
const ROWS = [
  { kind: 'system' }, // 0
  { kind: 'trade' }, // 1
  { kind: 'trade' }, // 2
  { kind: 'system' }, // 3
  { kind: 'trade' }, // 4
  { kind: 'empty' }, // 5
];
const at = (row, col) => ({ row, col });

test('列定义：12 列、宽度和预览稿一致；键盘能停的格子', () => {
  assert.deepEqual(COLUMNS.map((c) => c.key), ['no', 'date', 'symbol', 'direction', 'rr', 'risk', 'tp', 'result', 'pnl', 'reason', 'shots', 'note']);
  assert.deepEqual(COLUMNS.map((c) => c.width), [48, 104, 84, 56, 72, 80, 108, 84, 108, null, 112, 220]);
  assert.equal(NAV_COLUMNS.trade.includes('tp'), false, '止盈是自动算的，不停留');
  assert.equal(NAV_COLUMNS.empty.includes('no'), false, '空行的行号不是按钮');
  assert.deepEqual(NAV_COLUMNS.system, ['menu', 'name', 'desc']);
});

test('Enter / ↓：下一行同一列，跳过系统行，最后落到空行；空行再往下不动', () => {
  assert.deepEqual(nextCell(ROWS, 1, 'rr', 'down'), at(2, 'rr'));
  assert.deepEqual(nextCell(ROWS, 2, 'rr', 'down'), at(4, 'rr'), '跳过系统 B 那一行');
  assert.deepEqual(nextCell(ROWS, 4, 'rr', 'down'), at(5, 'rr'));
  assert.equal(nextCell(ROWS, 5, 'rr', 'down'), null);
  assert.deepEqual(nextCell(ROWS, 4, 'result', 'down'), at(5, 'result'));
});

test('↑：上一行同一列，跳过系统行；第一笔往上不动', () => {
  assert.deepEqual(nextCell(ROWS, 5, 'date', 'up'), at(4, 'date'));
  assert.deepEqual(nextCell(ROWS, 4, 'note', 'up'), at(2, 'note'));
  assert.equal(nextCell(ROWS, 1, 'rr', 'up'), null, '上面只有系统行');
});

test('空行没有的列（行号、截图）：落在左边最近的一列', () => {
  assert.deepEqual(nextCell(ROWS, 4, 'no', 'down'), at(5, 'date'));
  assert.deepEqual(nextCell(ROWS, 4, 'shots', 'down'), at(5, 'reason'));
  assert.deepEqual(nextCell(ROWS, 2, 'no', 'down'), at(4, 'no'), '交易行之间行号对行号');
});

test('从系统行上下移动：菜单按钮对行号，名称和说明对日期；相邻的系统行停在同一格', () => {
  assert.deepEqual(nextCell(ROWS, 0, 'name', 'down'), at(1, 'date'));
  assert.deepEqual(nextCell(ROWS, 0, 'menu', 'down'), at(1, 'no'));
  assert.deepEqual(nextCell(ROWS, 3, 'desc', 'down'), at(4, 'date'));
  assert.deepEqual(nextCell(ROWS, 3, 'name', 'up'), at(2, 'date'));
  assert.equal(nextCell(ROWS, 0, 'name', 'up'), null);
  const twoSystems = [{ kind: 'system' }, { kind: 'system' }, { kind: 'empty' }];
  assert.deepEqual(nextCell(twoSystems, 0, 'desc', 'down'), at(1, 'desc'));
  assert.deepEqual(nextCell(twoSystems, 1, 'name', 'down'), at(2, 'date'));
  assert.deepEqual(nextCell(twoSystems, 1, 'menu', 'down'), at(2, 'date'), '空行没有行号，落在日期');
  assert.deepEqual(nextCell(twoSystems, 2, 'rr', 'up'), null, '交易列往上只有系统行');
});

test('Tab / Shift+Tab：从左到右、从上到下，系统行也算；到表格两头返回 null', () => {
  assert.deepEqual(nextCell(ROWS, 1, 'date', 'next'), at(1, 'symbol'));
  assert.deepEqual(nextCell(ROWS, 1, 'risk', 'next'), at(1, 'result'), '跳过自动算的止盈');
  assert.deepEqual(nextCell(ROWS, 0, 'desc', 'next'), at(1, 'no'));
  assert.deepEqual(nextCell(ROWS, 1, 'note', 'next'), at(2, 'no'));
  assert.deepEqual(nextCell(ROWS, 2, 'note', 'next'), at(3, 'menu'));
  assert.deepEqual(nextCell(ROWS, 4, 'note', 'next'), at(5, 'date'));
  assert.equal(nextCell(ROWS, 5, 'note', 'next'), null, '最后一格：交给浏览器移出表格');
  assert.deepEqual(nextCell(ROWS, 5, 'date', 'prev'), at(4, 'note'));
  assert.deepEqual(nextCell(ROWS, 1, 'no', 'prev'), at(0, 'desc'));
  assert.equal(nextCell(ROWS, 0, 'menu', 'prev'), null, '第一格');
  // 一路 Tab 走完整张表，格子数等于各行能停的格子之和
  let pos = at(0, 'menu');
  let steps = 0;
  for (;;) {
    const n = nextCell(ROWS, pos.row, pos.col, 'next');
    if (!n) break;
    pos = n;
    steps += 1;
  }
  const total = ROWS.reduce((s, r) => s + NAV_COLUMNS[r.kind].length, 0);
  assert.equal(steps, total - 1);
  assert.deepEqual(pos, at(5, 'note'));
});

test('← / →（按钮格）：只在同一行里走', () => {
  assert.deepEqual(nextCell(ROWS, 1, 'direction', 'right'), at(1, 'rr'));
  assert.deepEqual(nextCell(ROWS, 1, 'result', 'left'), at(1, 'risk'));
  assert.equal(nextCell(ROWS, 1, 'no', 'left'), null);
  assert.equal(nextCell(ROWS, 1, 'note', 'right'), null);
  assert.equal(nextCell(ROWS, 9, 'rr', 'down'), null, '行号越界');
  assert.deepEqual(nextCell([{ kind: 'trade', cols: ['a', 'b'] }], 0, 'a', 'right'), at(0, 'b'), '可以传自己的列');
});

test('示例数据：在盈亏比一列一路按 Enter，按表格顺序走完 16 笔，最后停在空行', () => {
  const rows = sample.rows.map((r) => ({ kind: r.type })).concat([{ kind: 'empty' }]);
  const tradeIdx = sample.rows.map((r, i) => (r.type === 'trade' ? i : -1)).filter((i) => i >= 0);
  let pos = at(tradeIdx[0], 'rr');
  const visited = [pos.row];
  for (;;) {
    const n = nextCell(rows, pos.row, pos.col, 'down');
    if (!n) break;
    assert.equal(n.col, 'rr');
    visited.push(n.row);
    pos = n;
  }
  assert.deepEqual(visited, tradeIdx.concat([rows.length - 1]));
});

test('按键：输入法组字时一律不处理（Enter 是选词）', () => {
  assert.equal(isComposingKey({ key: 'Enter', isComposing: true }), true);
  assert.equal(isComposingKey({ key: 'Enter', keyCode: 229 }), true, 'Safari 组字结束那一下 keyCode 是 229');
  assert.equal(isComposingKey({ key: 'Enter', isComposing: false, keyCode: 13 }), false);
  for (const kind of ['text', 'direction', 'result', 'button']) {
    assert.equal(keyAction({ key: 'Enter', isComposing: true }, kind), null);
    assert.equal(keyAction({ key: 'ArrowDown', keyCode: 229 }, kind), null);
    assert.equal(keyAction({ key: 'Escape', isComposing: true }, kind), null);
  }
});

test('按键：文字格', () => {
  assert.deepEqual(keyAction({ key: 'Enter' }, 'text'), { type: 'move', move: 'down', commit: true });
  assert.deepEqual(keyAction({ key: 'Enter', shiftKey: true }, 'text'), { type: 'move', move: 'up', commit: true });
  assert.deepEqual(keyAction({ key: 'ArrowDown' }, 'text'), { type: 'move', move: 'down', commit: true });
  assert.deepEqual(keyAction({ key: 'ArrowUp' }, 'text'), { type: 'move', move: 'up', commit: true });
  assert.deepEqual(keyAction({ key: 'Tab' }, 'text'), { type: 'move', move: 'next', commit: true });
  assert.deepEqual(keyAction({ key: 'Tab', shiftKey: true }, 'text'), { type: 'move', move: 'prev', commit: true });
  assert.deepEqual(keyAction({ key: 'Escape' }, 'text'), { type: 'restore' });
  assert.equal(keyAction({ key: 'ArrowLeft' }, 'text'), null, '← → 在文字里移动光标');
  assert.equal(keyAction({ key: 'ArrowDown', shiftKey: true }, 'text'), null, 'Shift+↓ 选字');
  assert.equal(keyAction({ key: 'a' }, 'text'), null);
  assert.equal(keyAction({ key: 'Enter', ctrlKey: true }, 'text'), null, '带 Ctrl 的组合键不管');
  assert.equal(keyAction({ key: 'z', metaKey: true }, 'text'), null);
});

test('按键：方向格空格和 Enter 由按钮自己切换；结果格 1/Y/0/N/Backspace', () => {
  assert.equal(keyAction({ key: 'Enter' }, 'direction'), null);
  assert.equal(keyAction({ key: ' ' }, 'direction'), null);
  assert.deepEqual(keyAction({ key: 'ArrowDown' }, 'direction'), { type: 'move', move: 'down', commit: false });
  assert.deepEqual(keyAction({ key: 'ArrowRight' }, 'direction'), { type: 'move', move: 'right', commit: false });
  assert.equal(keyAction({ key: 'Escape' }, 'direction'), null);

  assert.deepEqual(keyAction({ key: '1' }, 'result'), { type: 'result', value: 'win' });
  assert.deepEqual(keyAction({ key: 'Y', shiftKey: true }, 'result'), { type: 'result', value: 'win' });
  assert.deepEqual(keyAction({ key: 'n' }, 'result'), { type: 'result', value: 'loss' });
  assert.deepEqual(keyAction({ key: 'Backspace' }, 'result'), { type: 'result', value: null });
  assert.deepEqual(keyAction({ key: 'Enter' }, 'result'), { type: 'move', move: 'down', commit: false }, '结果格里 Enter 照常往下');
  assert.equal(keyAction({ key: ' ' }, 'result'), null, '空格由按钮自己点一下（循环）');
  assert.equal(keyAction({ key: 'x' }, 'result'), null);
  assert.equal(keyAction({ key: '1' }, 'text'), null, '数字键只在结果格里有特殊含义');

  assert.equal(keyAction({ key: 'Enter' }, 'button'), null, '行号、截图按钮：Enter 打开详情');
  assert.deepEqual(keyAction({ key: 'ArrowUp' }, 'button'), { type: 'move', move: 'up', commit: false });

  for (const k of ['1', 'y', 'Y', '\u{FF11}', '\u{FF59}']) assert.equal(resultForKey(k), 'win', k);
  for (const k of ['0', 'n', 'N', '\u{FF10}', '\u{FF2E}']) assert.equal(resultForKey(k), 'loss', k);
  assert.equal(resultForKey('Backspace'), null);
  assert.equal(resultForKey('Delete'), null);
  for (const k of ['2', 'a', 'Enter', 'F1', undefined]) assert.equal(resultForKey(k), undefined, String(k));
});

test('输入解析：日期', () => {
  const ok = (s, v) => assert.deepEqual(interpretInput('date', s, { now: NOW }), { ok: true, patch: { date: v } }, s);
  ok('2026-9-1', '2026-09-01');
  ok('9-1', '2026-09-01');
  ok('9/1', '2026-09-01');
  ok('9月1日', '2026-09-01');
  ok('20260901', '2026-09-01');
  ok(' 2026-10-05 ', '2026-10-05');
  for (const bad of ['', '   ', 'abc', '2026-2-30', '13/1', '2']) {
    const r = interpretInput('date', bad, { now: NOW });
    assert.equal(r.ok, false, bad);
    assert.match(r.message, /恢复/, '提示里说已恢复原值');
  }
});

test('输入解析：盈亏比（大于 0；1:2 取冒号后；2R、2倍；空着是清空）', () => {
  const ok = (s, v) => assert.deepEqual(interpretInput('rr', s), { ok: true, patch: { rr: v } }, s);
  ok('2', 2);
  ok('2.5', 2.5);
  ok('1:2', 2);
  ok('1：3', 3);
  ok('2R', 2);
  ok('2 倍', 2);
  ok('\u{FF12}.\u{FF15}', 2.5);
  ok('', null);
  for (const bad of ['0', '-2', `${M}2`, 'abc', '1:', 'R']) assert.equal(interpretInput('rr', bad).ok, false, bad);
  assert.match(interpretInput('rr', '0').message, /大于 0/);
});

test('输入解析：止损金额（忽略货币符号、逗号、单位；负数按绝对值）', () => {
  const ok = (s, v, cur = '$') => assert.deepEqual(interpretInput('risk', s, { currency: cur }), { ok: true, patch: { risk: v } }, s);
  ok('100', 100);
  ok('$1,250.5', 1250.5);
  ok('-100', 100);
  ok(`${M}80`, 80);
  ok('100元', 100, '元');
  ok(' 75 ', 75);
  ok('', null);
  assert.equal(interpretInput('risk', '0').ok, false);
  assert.equal(interpretInput('risk', 'abc').ok, false);
});

test('输入解析：盈亏金额交给 setPnlInput；空着回到自动值', () => {
  assert.deepEqual(interpretInput('pnl', ''), { ok: true, pnl: null });
  assert.deepEqual(interpretInput('pnl', '  '), { ok: true, pnl: null });
  assert.deepEqual(interpretInput('pnl', '-50'), { ok: true, pnl: '-50' });
  assert.deepEqual(interpretInput('pnl', `${M}1,250.50`), { ok: true, pnl: `${M}1,250.50` });
  assert.deepEqual(interpretInput('pnl', '+$120'), { ok: true, pnl: '+$120' });
  assert.equal(interpretInput('pnl', 'abc').ok, false);
  assert.equal(interpretInput('pnl', '-').ok, false);
});

test('输入解析：文字原样保存，↵ 换回换行', () => {
  assert.deepEqual(interpretInput('symbol', ' XAUUSD '), { ok: true, patch: { symbol: ' XAUUSD ' } });
  assert.deepEqual(interpretInput('reason', `第一行${NEWLINE_MARK}第二行`), { ok: true, patch: { reason: '第一行\n第二行' } });
  assert.deepEqual(interpretInput('note', ''), { ok: true, patch: { note: '' } });
  assert.deepEqual(interpretInput('name', '趋势回调'), { ok: true, patch: { name: '趋势回调' } });
  assert.deepEqual(interpretInput('desc', ''), { ok: true, patch: { desc: '' } });
  assert.equal(interpretInput('tp', '100').ok, false, '止盈是自动算的，不能输入');
  const multi = '回踩 4136\r\n双底\n突破颈线';
  assert.equal(toCellText(multi), `回踩 4136${NEWLINE_MARK}双底${NEWLINE_MARK}突破颈线`);
  assert.equal(fromCellText(toCellText(multi)), '回踩 4136\n双底\n突破颈线');
  assert.equal(toCellText(null), '');
});

test('边打边提交：只有盈亏比和止损，看得懂才提交', () => {
  assert.deepEqual(liveValue('rr', '2'), { value: 2 });
  assert.deepEqual(liveValue('rr', '2.'), { value: 2 });
  assert.equal(liveValue('rr', '1:'), null);
  assert.equal(liveValue('rr', '0'), null);
  assert.deepEqual(liveValue('rr', ''), { value: null });
  assert.deepEqual(liveValue('risk', '1,5'), { value: 15 });
  assert.equal(liveValue('risk', '-'), null);
  for (const col of ['date', 'symbol', 'pnl', 'reason', 'note']) assert.equal(liveValue(col, '2'), null, col);
});

test('空行第一次输入带的字段：看得懂才带，看不懂先用默认值', () => {
  assert.deepEqual(emptyRowPatch('rr', '2'), { rr: 2 });
  assert.deepEqual(emptyRowPatch('rr', '1:'), {});
  assert.deepEqual(emptyRowPatch('rr', ''), {});
  assert.deepEqual(emptyRowPatch('risk', 'abc'), {});
  assert.deepEqual(emptyRowPatch('risk', '50'), { risk: 50 });
  assert.deepEqual(emptyRowPatch('date', '2', { now: NOW }), {}, '日期只打了一个字');
  assert.deepEqual(emptyRowPatch('date', '9-1', { now: NOW }), { date: '2026-09-01' });
  assert.deepEqual(emptyRowPatch('symbol', 'X'), { symbol: 'X' });
  assert.deepEqual(emptyRowPatch('reason', '突破'), { reason: '突破' });
  assert.deepEqual(emptyRowPatch('pnl', '-50'), {}, '盈亏金额等建好以后按 6.2 提交');
});

test('格子显示：示例数据里的几笔', () => {
  const { tradeById } = deriveJournal(sample.rows);
  const cell = (id, col) => tradeCellText(col, tradeById.get(id).t, tradeById.get(id).d);
  assert.equal(cell('t_01', 'rr'), '2.0');
  assert.equal(cell('t_01', 'risk'), '100');
  assert.equal(cell('t_01', 'tp'), '200');
  assert.equal(cell('t_01', 'pnl'), '+200');
  assert.equal(cell('t_06', 'pnl'), `${M}50`, '手改过的金额');
  assert.equal(cell('t_12', 'rr'), '1.8');
  assert.equal(cell('t_12', 'tp'), '180');
  assert.equal(cell('t_16', 'pnl'), '', '持仓中');
  assert.equal(cell('t_16', 'date'), '2026-10-05');
  assert.equal(cell('t_03', 'symbol'), 'EURUSD');
  // 显示出来的文字再按输入解析，得到的还是原来的数
  for (const it of tradeById.values()) {
    if (it.t.rr !== null) assert.equal(interpretInput('rr', cell(it.t.id, 'rr')).patch.rr, it.t.rr);
    if (it.t.risk !== null) assert.equal(interpretInput('risk', cell(it.t.id, 'risk')).patch.risk, it.t.risk);
    assert.equal(interpretInput('date', cell(it.t.id, 'date'), { now: NOW }).patch.date, it.t.date);
  }
  const big = { rr: null, risk: 1250.5, pnlOverride: -1250.5, result: 'loss', shots: [] };
  assert.equal(tradeCellText('risk', big, deriveTrade(big)), '1,250.50');
  assert.equal(tradeCellText('pnl', big, deriveTrade(big)), `${M}1,250.50`);
});

test('缺数标记：结果已选（或金额手改过）却缺盈亏比或止损', () => {
  const flags = (t) => missingFlags(t, deriveTrade(t));
  const base = { rr: 2, risk: 100, result: null, pnlOverride: null };
  assert.deepEqual(flags(base), { rr: false, risk: false });
  assert.deepEqual(flags({ ...base, rr: null }), { rr: false, risk: false }, '持仓中缺数不标');
  assert.deepEqual(flags({ ...base, rr: null, result: 'win' }), { rr: true, risk: false });
  assert.deepEqual(flags({ ...base, risk: null, result: 'loss' }), { rr: false, risk: true });
  assert.deepEqual(flags({ ...base, risk: null, pnlOverride: 30 }), { rr: false, risk: true });
});

test('结果格标签、表头、样本提示、只读说明', () => {
  assert.deepEqual(outcomeChip('win'), { cls: 'chip win', text: '盈' });
  assert.deepEqual(outcomeChip('loss'), { cls: 'chip loss', text: '亏' });
  assert.deepEqual(outcomeChip('breakeven'), { cls: 'chip flat', text: '平' });
  assert.deepEqual(outcomeChip('open'), { cls: 'chip open', text: '持仓中' });
  assert.deepEqual(outcomeChip('invalid'), { cls: 'chip open', text: '缺数' });

  assert.equal(headerLabel('risk', '$'), '止损 ($)');
  assert.equal(headerLabel('tp', '$'), '止盈 ($)');
  assert.equal(headerLabel('pnl', '元'), '盈亏 (元)');
  assert.equal(headerLabel('pnl', ''), '盈亏');
  assert.equal(headerLabel('date', '$'), '日期');
  assert.equal(headerLabel('nope', '$'), '');

  assert.equal(segmentHint(0), '还没有出场的交易');
  assert.equal(segmentHint(3), '只有 3 笔，先别下结论');
  assert.equal(segmentHint(12), '样本偏少');
  assert.equal(segmentHint(30), '');

  assert.match(readOnlyMessage('other-tab'), /另一个标签页/);
  assert.match(readOnlyMessage('newer-schema'), /刷新/);
});
