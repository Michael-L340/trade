// 交易表的纯逻辑（src/ui/sheet.js 上半部分）：键盘移动的下一格、按键含义、输入的解析和提交规则、格子显示，
// 以及表格和详情共用的截图小工具（标签、路径、剪贴板、默认标签、地址计数、shotApi）和详情里选大图的规则。不碰 DOM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLUMNS, NAV_COLUMNS, NEWLINE_MARK, nextCell, keyAction, resultForKey, isComposingKey, interpretInput, liveValue,
  emptyRowPatch, toCellText, fromCellText, tradeCellText, missingFlags, outcomeChip, headerLabel, segmentHint,
  readOnlyMessage, SHOT_LABEL_TEXT, shotLabelText, nextShotLabel, shotThumbPath, shotFilePath, readTransfer,
  pasteWantsImage, pickShotLabel, shotUrls, shotApi, errorText, isBlankNewTrade,
} from '../src/ui/sheet.js';
import { pickCurrentShot } from '../src/ui/detail.js';
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

// ---------- 截图（7.8）：表格和详情共用的小工具 ----------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('截图标签：显示文字，点一下换成哪个（开仓时 → 平仓后 → 无 → 开仓时）', () => {
  assert.deepEqual(Object.keys(SHOT_LABEL_TEXT).sort(), ['', 'close', 'open']);
  assert.equal(shotLabelText('open'), '开仓时');
  assert.equal(shotLabelText('close'), '平仓后');
  assert.equal(shotLabelText(''), '无');
  assert.equal(shotLabelText(undefined), '无', '不认识的当成空标签');
  assert.equal(nextShotLabel('open'), 'close');
  assert.equal(nextShotLabel('close'), '');
  assert.equal(nextShotLabel(''), 'open');
  assert.equal(nextShotLabel('nope'), 'open');
  for (const l of ['open', 'close', '']) assert.equal(nextShotLabel(nextShotLabel(nextShotLabel(l))), l, '点三下回到原样');
});

test('截图路径：缩略图优先 thumb、原图优先 file，缺了一个就用另一个', () => {
  const shot = { id: 'sh_1', file: 'shots/t_1/sh_1.webp', thumb: 'shots/t_1/sh_1.thumb.webp' };
  assert.equal(shotThumbPath(shot), 'shots/t_1/sh_1.thumb.webp');
  assert.equal(shotFilePath(shot), 'shots/t_1/sh_1.webp');
  assert.equal(shotThumbPath({ file: 'shots/t_1/sh_2.jpg' }), 'shots/t_1/sh_2.jpg');
  assert.equal(shotThumbPath({ file: 'shots/t_1/sh_2.jpg', thumb: '' }), 'shots/t_1/sh_2.jpg');
  assert.equal(shotFilePath({ thumb: 'shots/t_1/sh_3.thumb.jpg' }), 'shots/t_1/sh_3.thumb.jpg');
  assert.equal(shotThumbPath({}), null);
  assert.equal(shotFilePath(null), null);
});

/** 假的剪贴板条目 */
const fileItem = (type) => {
  const file = { type, name: 'x' };
  return { kind: 'file', type, file, getAsFile: () => file };
};
const stringItem = (type) => ({ kind: 'string', type, getAsFile: () => null });

test('读剪贴板 / 拖放：截图工具贴的图、资源管理器复制的文件、文字', () => {
  const shot = fileItem('image/png');
  assert.deepEqual(readTransfer({ items: [shot], files: [shot.file], types: ['Files'] }),
    { images: [shot.file], hasText: false }, 'items 和 files 里是同一张，只算一次');
  assert.deepEqual(readTransfer({ items: [stringItem('text/plain'), stringItem('text/html')], files: [], types: ['text/plain', 'text/html'] }),
    { images: [], hasText: true });
  const a = { type: 'image/jpeg', name: 'a.jpg' };
  const b = { type: 'application/pdf', name: 'b.pdf' };
  const c = { type: 'image/webp', name: 'c.webp' };
  assert.deepEqual(readTransfer({ items: [], files: [a, b, c], types: ['Files'] }).images, [a, c], '只要图片，顺序不变');
  const bmp = fileItem('image/png'); // Excel 复制格子：文字、HTML 和一张位图都有
  assert.deepEqual(readTransfer({ items: [stringItem('text/plain'), stringItem('text/html'), bmp], types: ['text/plain', 'text/html', 'Files'] }),
    { images: [bmp.file], hasText: true });
  assert.equal(readTransfer({ types: ['text/plain'] }).hasText, true, '只看 types 也认文字');
  assert.deepEqual(readTransfer({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] }).images, [], '取不到文件不算');
  assert.deepEqual(readTransfer(null), { images: [], hasText: false });
});

test('粘贴：只有剪贴板里有图片才贴截图（才 preventDefault）；图文都有、光标在输入框里时按文字粘贴', () => {
  const img = { images: [{}], hasText: false };
  const both = { images: [{}], hasText: true };
  const text = { images: [], hasText: true };
  assert.equal(pasteWantsImage(img, true), true, '只有图片：光标在格子里也贴截图');
  assert.equal(pasteWantsImage(img, false), true);
  assert.equal(pasteWantsImage(text, true), false, '文字：照常粘贴，不拦截');
  assert.equal(pasteWantsImage(text, false), false);
  assert.equal(pasteWantsImage(both, true), false, '图文都有、光标在输入框里：按文字');
  assert.equal(pasteWantsImage(both, false), true, '图文都有、焦点在按钮上：贴截图');
  assert.equal(pasteWantsImage({ images: [], hasText: false }, false), false);
  assert.equal(pasteWantsImage(null, false), false);
});

test('新截图的默认标签：没出场是开仓时，出场了是平仓后；defaultLabel 按哪种写法读参数都行', () => {
  const { tradeById } = deriveJournal(sample.rows);
  const open = tradeById.get('t_16'); // 持仓中
  const win = tradeById.get('t_01');
  assert.equal(pickShotLabel(null, open), 'open');
  assert.equal(pickShotLabel(null, win), 'close');
  const t = { rr: null, risk: 100, result: 'win', pnlOverride: null };
  assert.equal(pickShotLabel(undefined, { t, d: deriveTrade(t) }), 'close', '缺数但已经选了结果：算出场');
  const readers = {
    outcome: (x) => (x.outcome === 'open' ? 'open' : 'close'),
    nested: (x) => (x.d.outcome === 'open' ? 'open' : 'close'),
    trade: (x) => (x.t.result ? 'close' : 'open'),
    result: (x) => (x.result ? 'close' : 'open'),
  };
  for (const [name, fn] of Object.entries(readers)) {
    assert.equal(pickShotLabel(fn, open), 'open', name);
    assert.equal(pickShotLabel(fn, win), 'close', name);
  }
  assert.equal(pickShotLabel(() => 'close', open), 'close', '以 defaultLabel 为准');
  assert.equal(pickShotLabel(() => { throw new Error('x'); }, win), 'close', '它出错就自己判断');
  assert.equal(pickShotLabel(() => '平仓后', open), 'open', '给的不是 open / close 也自己判断');
  assert.equal(pickShotLabel(null, { t: { result: 'loss' } }), 'close', '没有派生值时看 result');
  assert.equal(pickShotLabel(null, null), 'open');
});

/** 假的 urlCache：记下 get 和 release；manual 时 get 要手动兑现 */
function fakeUrlCache({ missing = [], broken = [], manual = false } = {}) {
  const log = [];
  const waiting = [];
  return {
    log,
    waiting,
    get(path) {
      log.push('get ' + path);
      if (broken.includes(path)) return Promise.reject(new Error('读不出 ' + path));
      const value = missing.includes(path) ? null : 'blob:' + path;
      if (!manual) return Promise.resolve(value);
      return new Promise((resolve) => waiting.push(() => resolve(value)));
    },
    release(path) { log.push('release ' + path); },
  };
}

test('截图地址：同一张两处在用，两处都放了才 release；同一个 cache 共用一个计数器', async () => {
  const cache = fakeUrlCache();
  const urls = shotUrls(cache);
  assert.equal(shotUrls(cache), urls, '表格和详情拿到的是同一个');
  assert.equal(await urls.acquire('a.thumb.webp'), 'blob:a.thumb.webp');
  assert.equal(await urls.acquire('a.thumb.webp'), 'blob:a.thumb.webp');
  assert.deepEqual(cache.log, ['get a.thumb.webp'], '第二处不再 get');
  assert.equal(urls.count('a.thumb.webp'), 2);
  urls.release('a.thumb.webp');
  await tick();
  assert.deepEqual(cache.log, ['get a.thumb.webp'], '还有一处在用，不放');
  urls.release('a.thumb.webp');
  await tick();
  assert.deepEqual(cache.log, ['get a.thumb.webp', 'release a.thumb.webp']);
  urls.release('a.thumb.webp');
  urls.release('never.webp');
  await tick();
  assert.equal(cache.log.length, 2, '多放、放没要过的，都不出事');
  assert.equal(await urls.acquire('a.thumb.webp'), 'blob:a.thumb.webp');
  assert.deepEqual(cache.log.slice(2), ['get a.thumb.webp'], '放掉以后再要，重新 get');
});

test('截图地址：get 还没回来就都放了，等它回来再 release；等的时候又有人要，就接着用', async () => {
  const cache = fakeUrlCache({ manual: true });
  const urls = shotUrls(cache);
  const p1 = urls.acquire('b.webp');
  urls.release('b.webp');
  await tick();
  assert.deepEqual(cache.log, ['get b.webp'], '还没回来，先不放');
  cache.waiting.shift()();
  assert.equal(await p1, 'blob:b.webp');
  await tick();
  assert.deepEqual(cache.log, ['get b.webp', 'release b.webp']);

  const p2 = urls.acquire('c.webp');
  urls.release('c.webp');
  const p3 = urls.acquire('c.webp'); // 回来之前又要了
  cache.waiting.shift()();
  assert.equal(await p2, 'blob:c.webp');
  assert.equal(await p3, 'blob:c.webp');
  await tick();
  assert.deepEqual(cache.log.slice(2), ['get c.webp'], '又有人在用：不放，也不重新 get');
  urls.release('c.webp');
  await tick();
  assert.deepEqual(cache.log.slice(2), ['get c.webp', 'release c.webp']);
});

test('截图地址：文件不在本机是 null，读不出来是 reject，两种都照常 release', async () => {
  const cache = fakeUrlCache({ missing: ['gone.webp'], broken: ['bad.webp'] });
  const urls = shotUrls(cache);
  assert.equal(await urls.acquire('gone.webp'), null);
  await assert.rejects(urls.acquire('bad.webp'), /读不出 bad\.webp/);
  urls.release('gone.webp');
  urls.release('bad.webp');
  await tick();
  assert.deepEqual(cache.log, ['get gone.webp', 'get bad.webp', 'release gone.webp', 'release bad.webp']);
  assert.equal(shotUrls(null), null);
  assert.equal(shotUrls({}), null, '没有 get 的不算 urlCache');
});

test('shotApi：没传是 null；可以传绑好 ctx 的函数，也可以传 shots.js 的原始函数加 ctx', async () => {
  assert.equal(shotApi(undefined), null);
  assert.equal(shotApi(null), null);
  const calls = [];
  const bound = {
    addShot: async (...a) => { calls.push(['add', ...a]); return { id: 'sh_1' }; },
    deleteShot: async (...a) => { calls.push(['delete', ...a]); return () => true; },
    setShotLabel: (...a) => { calls.push(['label', ...a]); return true; },
  };
  const api = shotApi(bound);
  assert.equal(shotApi(bound), api, '同一个对象拿到同一份（表格和详情共用一个队列）');
  assert.equal(api.urls, null, '没有 urlCache');
  assert.deepEqual(await api.addShot('t_1', 'blob', 'open'), { id: 'sh_1' });
  assert.equal(typeof await api.deleteShot('t_1', 'sh_1'), 'function');
  assert.equal(api.setShotLabel('t_1', 'sh_1', 'close'), true);
  assert.deepEqual(calls, [['add', 't_1', 'blob', 'open'], ['delete', 't_1', 'sh_1'], ['label', 't_1', 'sh_1', 'close']]);

  const ctx = { store: 'S', db: 'D', demo: false };
  const seen = [];
  const cache = fakeUrlCache();
  const raw = shotApi({ ctx, setShotLabel: (...a) => { seen.push(a); return true; }, defaultLabel: () => 'close', urlCache: cache });
  raw.setShotLabel('t_2', 'sh_2', '');
  assert.deepEqual(seen, [[ctx, 't_2', 'sh_2', '']], 'ctx 放在第一个参数');
  assert.equal(raw.addShot, null, '没给的函数是 null');
  assert.equal(raw.deleteShot, null);
  assert.equal(raw.urls, shotUrls(cache), 'urlCache 套上共用计数');
  assert.equal(raw.labelFor({ t: { result: null }, d: { outcome: 'open' } }), 'close', '用传进来的 defaultLabel');
});

test('shotApi：加截图排队，一张处理完才开始下一张；前一张失败不挡后面的', async () => {
  const order = [];
  const gates = [];
  const api = shotApi({
    addShot: (tradeId, blob) => {
      order.push('start ' + blob);
      return new Promise((resolve, reject) => gates.push({ resolve, reject }));
    },
  });
  const a = api.addShot('t_1', 'A', 'open');
  const b = api.addShot('t_1', 'B', 'open');
  const c = api.addShot('t_2', 'C', 'close');
  await tick();
  assert.deepEqual(order, ['start A'], 'B 要等 A 处理完');
  gates.shift().reject(new Error('A 坏了'));
  await assert.rejects(a, /A 坏了/);
  await tick();
  assert.deepEqual(order, ['start A', 'start B']);
  gates.shift().resolve({ id: 'sh_b' });
  assert.deepEqual(await b, { id: 'sh_b' });
  await tick();
  assert.deepEqual(order, ['start A', 'start B', 'start C']);
  gates.shift().resolve({ id: 'sh_c' });
  assert.deepEqual(await c, { id: 'sh_c' });
});

test('错误说明', () => {
  assert.equal(errorText(new Error('图片解码失败')), '图片解码失败');
  assert.equal(errorText('空间不够'), '空间不够');
  assert.equal(errorText(undefined), '原因不明');
  assert.equal(errorText(new Error('')), 'Error');
});

test('详情的大图：截图列表变了以后显示哪一张', () => {
  const ids = ['sh_a', 'sh_b', 'sh_c'];
  assert.equal(pickCurrentShot(ids, 'sh_b', ids), 'sh_b', '还在就还是它');
  assert.equal(pickCurrentShot(ids, 'sh_b', ['sh_a', 'sh_c']), 'sh_c', '删了中间那张：显示补上来的那张');
  assert.equal(pickCurrentShot(ids, 'sh_c', ['sh_a', 'sh_b']), 'sh_b', '删了最后一张：显示新的最后一张');
  assert.equal(pickCurrentShot(ids, 'sh_a', ['sh_b', 'sh_c']), 'sh_b');
  assert.equal(pickCurrentShot(ids, 'sh_b', ['sh_a']), 'sh_a', '后面的也没了：往前找');
  assert.equal(pickCurrentShot(ids, 'sh_b', ['sh_x']), 'sh_x', '一张都不认识：第一张');
  assert.equal(pickCurrentShot([], null, ['sh_a', 'sh_b']), 'sh_a', '原来没有选：第一张');
  assert.equal(pickCurrentShot(ids, 'sh_b', []), null, '没有截图了');
  assert.equal(pickCurrentShot(ids, 'sh_b', [...ids, 'sh_d']), 'sh_b', '加了新的不跳（加完由详情自己选新的那张）');
});

test('isBlankNewTrade：只带默认值的新一笔算空，填过任何内容就不算', () => {
  const base = { symbol: 'XAUUSD', risk: 100 };
  const t = { symbol: 'XAUUSD', risk: 100, rr: null, result: null, pnlOverride: null, reason: '', note: '', shots: [] };
  assert.equal(isBlankNewTrade(t, base), true);
  assert.equal(isBlankNewTrade({ ...t, symbol: null }, { symbol: null, risk: null }), false); // risk 不同
  assert.equal(isBlankNewTrade({ ...t, symbol: null, risk: null }, { symbol: null, risk: null }), true);
  assert.equal(isBlankNewTrade({ ...t, symbol: 'EURUSD' }, base), false);
  assert.equal(isBlankNewTrade({ ...t, rr: 2 }, base), false);
  assert.equal(isBlankNewTrade({ ...t, result: 'win' }, base), false);
  assert.equal(isBlankNewTrade({ ...t, reason: '回踩' }, base), false);
  assert.equal(isBlankNewTrade({ ...t, shots: [{ id: 's' }] }, base), false);
});
