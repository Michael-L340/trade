// state.js：录入联动、删除撤销、系统行合并、示例模式、只读、事件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore, emptyRowDefaults } from '../src/state.js';
import { deriveJournal } from '../src/calc.js';
import { validateJournal, serialize, isoNow, ModelError } from '../src/model.js';

const sampleText = readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);
const NOW = () => new Date(2026, 9, 5, 10, 0, 0);
const M = '\u{2212}';

function setup(journal = sample(), opts = {}) {
  const store = createStore(journal, { now: NOW, ...opts });
  const events = [];
  store.subscribe((ev) => events.push(ev));
  return { store, events, a: store.actions };
}

const row = (store, id) => store.get().journal.rows.find((r) => r.id === id);
const item = (store, id) => store.get().derived.tradeById.get(id);
const ids = (store) => store.get().journal.rows.map((r) => r.id);

function smallJournal() {
  return {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_r', name: '我的系统', desc: '', createdAt: '2026-10-01T00:00:00Z' },
      { type: 'trade', id: 't_r1', date: '2026-10-01', symbol: 'EURUSD', direction: 'short', rr: 2, risk: 50, result: 'win', pnlOverride: null, reason: '', note: '', shots: [] },
    ],
  };
}

/** 每一步之后都要成立的约束 */
function checkInvariants(store) {
  const { journal, derived } = store.get();
  assert.equal(journal.rows[0].type, 'system', '第一行永远是系统行');
  assert.deepEqual(validateJournal(journal), [], '数据始终合规');
  const fresh = deriveJournal(journal.rows);
  assert.deepEqual(derived.all, fresh.all, '派生值和重新计算的一致');
  assert.deepEqual([...derived.segStats.keys()], [...fresh.segStats.keys()]);
  const text = serialize(journal);
  for (const key of ['"takeProfit"', '"pnl"', '"outcome"', '"r"', '"stats"']) assert.equal(text.includes(key), false, `派生值 ${key} 不进数据`);
}

test('初始：派生值、界面状态、冻结、首次使用', () => {
  const input = sample();
  const { store } = setup(input);
  const { journal, derived, ui } = store.get();
  assert.deepEqual(ui, { selectedId: null, demo: false, dirty: false, localRev: 0, readOnly: null });
  assert.equal(derived.all.n, 15);
  assert.equal(derived.segStats.get('sys_a').n, 12);
  assert.equal(derived.grouped.nextNo, 17);
  assert.equal(Object.isFrozen(input.rows[0]), false, '不冻结调用方传进来的对象');
  assert.throws(() => { journal.rows[1].rr = 9; }, TypeError);
  assert.throws(() => { journal.rows.push({}); }, TypeError);
  assert.throws(() => { journal.rows[1].shots.push({}); }, TypeError);
  checkInvariants(store);

  const fresh = createStore(null, { now: NOW });
  assert.equal(fresh.get().journal.rows.length, 1);
  assert.equal(fresh.get().journal.rows[0].type, 'system');
  assert.equal(fresh.get().journal.rows[0].name, '');
  assert.equal(fresh.get().ui.dirty, false);
  assert.throws(() => createStore({ ...sample(), schemaVersion: 2 }), (e) => e instanceof ModelError && e.code === 'NEWER_SCHEMA');
});

test('空行默认值：今天、沿用上一笔的品种和止损、方向多', () => {
  const { store } = setup();
  assert.deepEqual(store.emptyRowDefaults(), { date: '2026-10-05', symbol: 'XAUUSD', risk: 100, direction: 'long' });
  assert.deepEqual(emptyRowDefaults({ rows: [{ type: 'system', id: 'sys_1' }] }, NOW()), { date: '2026-10-05', symbol: '', risk: null, direction: 'long' });
});

test('空行输入盈亏比：止损沿用上一笔、止盈立刻算出、成为正式交易', () => {
  const { store, events, a } = setup();
  a.select('t_03');
  events.length = 0;
  const id = a.createTradeFromEmptyRow({ rr: 2 });
  assert.match(id, /^t_[0-9a-f]{12}$/);
  const t = row(store, id);
  assert.equal(store.get().journal.rows.at(-1), t, '加在表格最后');
  assert.deepEqual([t.date, t.symbol, t.direction, t.rr, t.risk, t.result, t.pnlOverride], ['2026-10-05', 'XAUUSD', 'long', 2, 100, null, null]);
  assert.equal(item(store, id).d.takeProfit, 200);
  assert.equal(item(store, id).no, 17);
  assert.equal(store.get().derived.grouped.nextNo, 18, '下面出现新的空行');
  assert.deepEqual(events, [{ type: 'rows', ids: [id], reason: 'create' }]);
  assert.equal(store.get().ui.localRev, 1);
  assert.equal(store.get().ui.dirty, true);
  assert.equal(store.get().ui.selectedId, 't_03', '不改变选中行');
  assert.equal(store.get().derived.segStats.get('sys_b').open, 2);
  checkInvariants(store);

  const id2 = a.createTradeFromEmptyRow({ reason: '回踩' });
  assert.equal(row(store, id2).rr, null);
  assert.equal(row(store, id2).reason, '回踩');
  const id3 = a.createTradeFromEmptyRow({ date: '2026-02-30', symbol: 5, rr: 1.5 });
  assert.deepEqual([row(store, id3).date, row(store, id3).symbol, row(store, id3).rr], ['2026-10-05', 'XAUUSD', 1.5], '不合规的字段忽略，保留默认值');
});

test('updateTrade：改字段、没变化不发事件、清洗文字、保留不认识的字段', () => {
  const j = sample();
  j.rows[1].custom = { keep: true };
  const { store, events, a } = setup(j);
  assert.equal(a.updateTrade('t_01', { symbol: 'GOLD', note: '改' + String.fromCharCode(0) + '过' }), true);
  const t = row(store, 't_01');
  assert.equal(t.symbol, 'GOLD');
  assert.equal(t.note, '改过');
  assert.deepEqual(t.custom, { keep: true });
  assert.equal(t.updatedAt, isoNow(NOW()), '记下修改时间');
  assert.deepEqual(events.at(-1), { type: 'row', ids: ['t_01'], reason: 'update', fields: ['symbol', 'note'] });
  const rev = store.get().ui.localRev;
  assert.equal(a.updateTrade('t_01', { symbol: 'GOLD' }), false, '值没变');
  assert.equal(store.get().ui.localRev, rev);
  assert.equal(events.length, 1);
  assert.equal(a.updateTrade('t_01', { rr: 0 }), true);
  assert.equal(row(store, 't_01').rr, null, '盈亏比填 0 当作清空');
  assert.equal(item(store, 't_01').d.outcome, 'invalid', '结果已选但缺盈亏比：不进统计');
  assert.equal(store.get().derived.all.n, 14);
  assert.equal(a.updateTrade('t_01', { id: 't_zz', type: 'system' }), false, 'id 和类型不能改');
  assert.equal(a.updateTrade('sys_a', { symbol: 'x' }), false, '系统行不是交易');
  assert.equal(a.updateTrade('t_nope', { symbol: 'x' }), false);
  checkInvariants(store);
});

test('结果格：空 → 盈 → 亏 → 空 循环，每次都清掉手改金额', () => {
  const { store, a } = setup();
  assert.equal(row(store, 't_06').pnlOverride, -50);
  a.cycleResult('t_06'); // 亏 → 空
  assert.deepEqual([row(store, 't_06').result, row(store, 't_06').pnlOverride], [null, null]);
  assert.equal(item(store, 't_06').d.outcome, 'open');
  a.cycleResult('t_06');
  assert.equal(row(store, 't_06').result, 'win');
  assert.equal(item(store, 't_06').d.pnl, 200);
  a.cycleResult('t_06');
  assert.equal(row(store, 't_06').result, 'loss');
  assert.equal(item(store, 't_06').d.pnl, -100);
  a.cycleResult('t_06');
  assert.equal(row(store, 't_06').result, null);

  assert.equal(a.setResult('t_10', 'win'), true, '同一个结果也会清掉手改金额');
  assert.deepEqual([row(store, 't_10').result, row(store, 't_10').pnlOverride], ['win', null]);
  assert.equal(item(store, 't_10').d.pnl, 300);
  assert.equal(a.setResult('t_10', 'win'), false, '没有变化');
  assert.equal(a.setResult('t_10', null), true);
  assert.equal(a.setResult('t_10', 'draw'), false);
  checkInvariants(store);
});

test('结果变化后小计、合计、曲线同时更新', () => {
  const { store, a } = setup();
  a.cycleResult('t_16'); // 持仓中 → 盈 +2R
  const { all, segStats } = store.get().derived;
  assert.equal(all.n, 16);
  assert.equal(all.open, 0);
  assert.ok(Math.abs(all.totalR - 5) < 1e-9);
  assert.equal(all.cumulative.length, 17);
  assert.equal(segStats.get('sys_b').n, 4);
  assert.equal(segStats.get('sys_a').n, 12, '别的系统不受影响');
});

test('盈亏金额格（6.2）：手改、等于自动值、按正负定结果、清空', () => {
  const { store, events, a } = setup();
  // t_01：盈，止盈 200
  assert.equal(a.setPnlInput('t_01', '200'), true);
  assert.equal(row(store, 't_01').pnlOverride, null, '和自动值相等：不算手改');
  assert.equal(events.length, 0, '没有变化就不发事件');

  assert.equal(a.setPnlInput('t_01', '150'), true);
  assert.deepEqual([row(store, 't_01').result, row(store, 't_01').pnlOverride], ['win', 150]);
  assert.equal(item(store, 't_01').d.edited, true, '显示"改"');
  assert.equal(item(store, 't_01').d.r, 1.5, '统计按改后的数算');
  assert.deepEqual(events.at(-1), { type: 'row', ids: ['t_01'], reason: 'pnl', fields: ['pnlOverride'] });

  assert.equal(a.setPnlInput('t_01', ''), true);
  assert.equal(row(store, 't_01').pnlOverride, null, '清空回到自动值');
  assert.equal(item(store, 't_01').d.pnl, 200);
  assert.equal(item(store, 't_01').d.edited, false);

  assert.equal(a.setPnlInput('t_01', M + '80'), true);
  assert.deepEqual([row(store, 't_01').result, row(store, 't_01').pnlOverride], ['loss', -80], '负数把结果设成亏');

  assert.equal(a.setPnlInput('t_01', '-100'), true);
  assert.deepEqual([row(store, 't_01').result, row(store, 't_01').pnlOverride], ['loss', null], '等于亏损时的自动值 −100：不算手改');

  assert.equal(a.setPnlInput('t_01', '0'), true);
  assert.deepEqual([row(store, 't_01').result, row(store, 't_01').pnlOverride], ['loss', 0], '输入 0：结果不变');
  assert.equal(item(store, 't_01').d.outcome, 'breakeven');

  assert.equal(a.setPnlInput('t_01', '$1,250'), true);
  assert.deepEqual([row(store, 't_01').result, row(store, 't_01').pnlOverride], ['win', 1250]);

  assert.equal(a.setPnlInput('t_01', null), true);
  assert.equal(row(store, 't_01').pnlOverride, null);

  const before = store.get();
  assert.equal(a.setPnlInput('t_01', 'abc'), false, '看不懂的输入：界面恢复原值');
  assert.equal(store.get(), before);

  // 持仓中的 t_16（止盈 200）：直接填 200 就是按计划止盈，不显示"改"
  assert.equal(a.setPnlInput('t_16', '200'), true);
  assert.deepEqual([row(store, 't_16').result, row(store, 't_16').pnlOverride], ['win', null]);
  a.setResult('t_16', null);
  a.setPnlInput('t_16', '0');
  assert.deepEqual([row(store, 't_16').result, row(store, 't_16').pnlOverride], [null, 0]);
  assert.equal(item(store, 't_16').d.outcome, 'breakeven');

  // 1.8 × 100 的浮点误差不影响"相等"的判断
  assert.equal(a.setPnlInput('t_12', '180'), true);
  assert.equal(row(store, 't_12').pnlOverride, null);
  checkInvariants(store);
});

test('删除一笔并撤销：放回原位，行号跟着变', () => {
  const { store, events, a } = setup();
  a.select('t_05');
  const before = ids(store);
  const undo = a.deleteTrade('t_05');
  assert.equal(typeof undo, 'function');
  assert.equal(row(store, 't_05'), undefined);
  assert.equal(item(store, 't_06').no, 5, '后面的行号前移');
  assert.equal(store.get().ui.selectedId, null, '删掉的是选中行时取消选中');
  assert.deepEqual(events.at(-1), { type: 'rows', ids: ['t_05'], reason: 'delete' });
  assert.equal(store.get().derived.segStats.get('sys_a').n, 11);
  checkInvariants(store);

  assert.equal(undo(), true);
  assert.deepEqual(ids(store), before);
  assert.equal(item(store, 't_05').no, 5);
  assert.deepEqual(events.at(-1), { type: 'rows', ids: ['t_05'], reason: 'undo' });
  assert.equal(undo(), false, '只能撤销一次');
  assert.deepEqual(ids(store), before);
  checkInvariants(store);
});

test('撤销：原来的上一行也被删了时，放在原来的下一行前面', () => {
  const { store, a } = setup();
  const undo5 = a.deleteTrade('t_05');
  a.deleteTrade('t_04');
  assert.equal(undo5(), true);
  const list = ids(store);
  assert.equal(list.indexOf('t_05') + 1, list.indexOf('t_06'));
  assert.equal(a.deleteTrade('sys_a'), null, '系统行不能用 deleteTrade 删');
  assert.equal(a.deleteTrade('t_nope'), null);
  checkInvariants(store);
});

test('撤销：整份数据换过（恢复、进出示例）以后失效', () => {
  const { store, a } = setup();
  const undo = a.deleteTrade('t_02');
  a.replaceJournal(sample(), { demo: true });
  a.exitDemo();
  assert.equal(undo(), false);
  assert.equal(row(store, 't_02'), undefined);

  const { store: s2, a: a2 } = setup();
  const undoDemo = (a2.replaceJournal(sample(), { demo: true }), a2.deleteTrade('t_03'));
  a2.exitDemo();
  assert.equal(undoDemo(), false, '示例模式里的撤销不能落到真实数据上');
  assert.ok(row(s2, 't_03'), '真实数据没被动过');
});

test('在上方插入系统行：分段、字母、小计', () => {
  const { store, events, a } = setup();
  const sid = a.insertSystemRowAbove('t_05');
  assert.match(sid, /^sys_[0-9a-f]{12}$/);
  const list = ids(store);
  assert.equal(list.indexOf(sid) + 1, list.indexOf('t_05'));
  const segs = store.get().derived.grouped.segments;
  assert.deepEqual(segs.map((s) => s.letter), ['A', 'B', 'C']);
  assert.deepEqual(segs.map((s) => s.trades.length), [4, 8, 4]);
  assert.equal(row(store, sid).name, '');
  assert.equal(store.get().derived.segStats.get('sys_a').n, 4);
  assert.deepEqual(events.at(-1), { type: 'rows', ids: [sid], reason: 'insertSystem' });
  assert.equal(a.insertSystemRowAbove('sys_b'), null, '只能插在交易行上方');
  assert.equal(a.insertSystemRowAbove('t_nope'), null);
  checkInvariants(store);
});

test('换交易系统：末尾加系统行，新交易算在它名下，上面系统的小计不再变化', () => {
  const { store, events, a } = setup();
  const before = store.get().derived.segStats.get('sys_b');
  const sid = a.appendSystemRow();
  assert.equal(ids(store).at(-1), sid);
  assert.deepEqual(events.at(-1), { type: 'rows', ids: [sid], reason: 'appendSystem' });
  const rev = store.get().ui.localRev;
  assert.equal(a.appendSystemRow(), sid, '末尾已经是空的系统行：直接用它');
  assert.equal(store.get().ui.localRev, rev);

  const tid = a.createTradeFromEmptyRow({ rr: 3 });
  a.cycleResult(tid);
  const seg = store.get().derived.segmentById.get(sid);
  assert.equal(seg.letter, 'C');
  assert.deepEqual(seg.trades.map((it) => it.t.id), [tid]);
  assert.equal(store.get().derived.segStats.get(sid).n, 1);
  assert.deepEqual(store.get().derived.segStats.get('sys_b'), before);

  const fresh = createStore(null, { now: NOW });
  const first = fresh.get().journal.rows[0].id;
  assert.equal(fresh.actions.appendSystemRow(), first, '还没有交易时就是第一行的系统');
  checkInvariants(store);
});

test('系统行改名', () => {
  const { store, events, a } = setup();
  assert.equal(a.updateSystem('sys_b', { name: '假突破 v2', desc: '新说明' }), true);
  assert.deepEqual([row(store, 'sys_b').name, row(store, 'sys_b').desc], ['假突破 v2', '新说明']);
  assert.deepEqual(events.at(-1), { type: 'row', ids: ['sys_b'], reason: 'update', fields: ['name', 'desc'] });
  assert.equal(a.updateSystem('sys_b', { name: '假突破 v2' }), false);
  assert.equal(a.updateSystem('t_01', { name: 'x' }), false);
  assert.equal(a.updateSystem('sys_a', { name: '' }), true, '第一行可以改名（包括清空）');
  checkInvariants(store);
});

test('删除系统行：下面的交易并入上一个系统；第一行删不掉；可撤销', () => {
  const { store, events, a } = setup();
  assert.equal(a.deleteSystemRow('sys_a'), null, '第一行的系统行删不掉');
  assert.equal(row(store, 'sys_a').type, 'system');
  assert.equal(events.length, 0);

  const undo = a.deleteSystemRow('sys_b');
  assert.equal(typeof undo, 'function');
  const segs = store.get().derived.grouped.segments;
  assert.equal(segs.length, 1);
  assert.equal(store.get().derived.segStats.get('sys_a').n, 15, 't_13–t_15 并入系统 A');
  assert.equal(store.get().derived.segStats.has('sys_b'), false);
  assert.deepEqual(events.at(-1), { type: 'rows', ids: ['sys_b'], reason: 'deleteSystem' });
  checkInvariants(store);

  assert.equal(undo(), true);
  assert.equal(ids(store).indexOf('sys_b'), 13);
  assert.equal(store.get().derived.segStats.get('sys_a').n, 12);
  assert.equal(store.get().derived.segStats.get('sys_b').n, 3);
  assert.equal(a.deleteSystemRow('t_01'), null);
  checkInvariants(store);
});

test('金额单位', () => {
  const { store, events, a } = setup();
  assert.equal(a.setCurrency('  元 '), true);
  assert.equal(store.get().journal.currency, '元');
  assert.equal(events.at(-1).type, 'rows');
  assert.equal(events.at(-1).reason, 'currency');
  assert.deepEqual(events.at(-1).ids, ids(store));
  assert.equal(a.setCurrency('元'), false);
  a.setCurrency('ABCDEFGHIJK');
  assert.equal(store.get().journal.currency, 'ABCDEFGH', '最多 8 个字符');
  a.setCurrency('');
  assert.equal(store.get().journal.currency, '');
  a.setCurrency('元');
  assert.equal(a.setPnlInput('t_01', '150元'), true, '解析金额时忽略设置的单位');
  assert.equal(row(store, 't_01').pnlOverride, 150);
});

test('示例模式：数据只在内存，修改不标 dirty，退出后回到自己的数据', () => {
  const { store, events, a } = setup(smallJournal());
  const realBefore = store.realJournal();
  assert.equal(a.replaceJournal(sample(), { demo: true }), true);
  let { journal, ui } = store.get();
  assert.equal(ui.demo, true);
  assert.equal(ui.dirty, false);
  assert.equal(ui.localRev, 1);
  assert.equal(journal.rows.length, 18);
  assert.deepEqual(events.at(-1), { type: 'journal', ids: [], reason: 'demo' });

  const id = a.createTradeFromEmptyRow({ rr: 2 });
  a.cycleResult(id);
  a.updateSystem('sys_a', { name: '随便改' });
  const undo = a.deleteTrade('t_01');
  a.setCurrency('¥');
  ({ ui } = store.get());
  assert.equal(ui.dirty, false, '示例模式下不标 dirty');
  assert.equal(ui.localRev, 6, '但 localRev 照样加');
  assert.equal(store.realJournal(), realBefore, '真实数据原封不动');
  assert.equal(typeof undo, 'function');

  assert.equal(a.exitDemo(), true);
  ({ journal, ui } = store.get());
  assert.equal(journal, realBefore);
  assert.equal(ui.demo, false);
  assert.equal(ui.dirty, false);
  assert.deepEqual(events.at(-1), { type: 'journal', ids: [], reason: 'exitDemo' });
  assert.equal(a.exitDemo(), false);
  checkInvariants(store);
});

test('示例模式：进入前还没保存完的真实修改，保存完照样清 dirty', () => {
  const { store, a } = setup(smallJournal());
  a.updateTrade('t_r1', { note: '真实修改' });
  const rev = store.get().ui.localRev;
  assert.equal(store.get().ui.dirty, true);
  a.replaceJournal(sample(), { demo: true });
  a.updateTrade('t_01', { note: '示例修改' });
  assert.equal(a.markSaved(rev), true);
  assert.equal(store.get().ui.dirty, false);
  a.exitDemo();
  assert.equal(row(store, 't_r1').note, '真实修改');
});

test('示例模式：另一个标签页的新数据只替换留着的真实数据；恢复备份会退出示例', () => {
  const { store, a } = setup(smallJournal());
  a.replaceJournal(sample(), { demo: true });
  const external = smallJournal();
  external.rows[1].note = '另一个标签页写的';
  assert.equal(a.replaceJournal(external, { external: true }), true);
  assert.equal(store.get().ui.demo, true);
  assert.equal(store.get().journal.rows.length, 18, '还在看示例数据');
  a.exitDemo();
  assert.equal(row(store, 't_r1').note, '另一个标签页写的');
  assert.equal(store.get().ui.dirty, false);

  a.replaceJournal(sample(), { demo: true });
  assert.equal(a.replaceJournal(smallJournal()), true);
  assert.equal(store.get().ui.demo, false, '恢复备份时退出示例模式');
  assert.equal(store.get().ui.dirty, true, '恢复的数据要写进本机存储');
  assert.equal(store.get().journal.rows.length, 2);
  assert.throws(() => a.replaceJournal({ schemaVersion: 1, currency: '$', rows: 'x' }), (e) => e.code === 'INVALID');
});

test('只读（另一个标签页在写）：修改一律拒绝，示例模式仍可用', () => {
  const { store, events, a } = setup(sample(), { readOnly: 'other-tab' });
  const before = store.get().journal;
  assert.equal(store.canEdit(), false);
  assert.equal(a.createTradeFromEmptyRow({ rr: 2 }), null);
  assert.equal(a.updateTrade('t_01', { note: 'x' }), false);
  assert.equal(a.cycleResult('t_01'), false);
  assert.equal(a.setResult('t_01', null), false);
  assert.equal(a.setPnlInput('t_01', '5'), false);
  assert.equal(a.deleteTrade('t_01'), null);
  assert.equal(a.insertSystemRowAbove('t_02'), null);
  assert.equal(a.appendSystemRow(), null);
  assert.equal(a.updateSystem('sys_a', { name: 'x' }), false);
  assert.equal(a.deleteSystemRow('sys_b'), null);
  assert.equal(a.setCurrency('¥'), false);
  assert.equal(a.replaceJournal(smallJournal()), false, '只读时不能恢复备份');
  assert.equal(store.get().journal, before);
  assert.equal(events.length, 0);

  assert.equal(a.replaceJournal(sample(), { demo: true }), true);
  assert.equal(store.canEdit(), true);
  assert.ok(a.createTradeFromEmptyRow({ rr: 2 }));
  a.exitDemo();
  assert.equal(store.canEdit(), false);
  assert.equal(store.get().journal, before);

  assert.equal(a.replaceJournal(smallJournal(), { external: true }), true, '只读页面跟着别的标签页更新');
  assert.equal(a.setReadOnly(null), true);
  assert.deepEqual(events.at(-1), { type: 'ui', ids: [], reason: 'readOnly' });
  assert.equal(a.updateTrade('t_r1', { note: '现在可以写了' }), true);
});

test('保存状态：markSaved 只在之后没有新修改时清 dirty', () => {
  const { store, events, a } = setup();
  a.updateTrade('t_01', { note: 'a' });
  const rev1 = store.get().ui.localRev;
  a.updateTrade('t_01', { note: 'b' });
  assert.equal(a.markSaved(rev1), false, '保存期间又改过');
  assert.equal(store.get().ui.dirty, true);
  assert.equal(a.markSaved(store.get().ui.localRev), true);
  assert.equal(store.get().ui.dirty, false);
  assert.deepEqual(events.at(-1), { type: 'ui', ids: [], reason: 'saved' });
  assert.equal(a.markSaved(store.get().ui.localRev), false, '已经是干净的');
});

test('选中行', () => {
  const { store, events, a } = setup();
  assert.equal(a.select('t_07'), true);
  assert.deepEqual(events.at(-1), { type: 'ui', ids: ['t_07'], reason: 'select' });
  assert.equal(a.select('t_08'), true);
  assert.deepEqual(events.at(-1), { type: 'ui', ids: ['t_07', 't_08'], reason: 'select' });
  assert.equal(a.select('t_08'), false);
  assert.equal(a.select('sys_a'), false, '系统行不能选中');
  assert.equal(a.select('t_nope'), false);
  assert.equal(a.select(null), true);
  assert.deepEqual(events.at(-1), { type: 'ui', ids: ['t_08'], reason: 'select' });
  assert.equal(store.get().ui.localRev, 0, '选中不算数据修改');
  assert.equal(store.get().ui.dirty, false);
});

test('订阅：取消订阅；一个监听出错不影响其他监听', () => {
  const store = createStore(sample(), { now: NOW });
  const got = [];
  const off = store.subscribe((ev) => got.push(ev.reason));
  const reported = [];
  const saved = globalThis.reportError;
  globalThis.reportError = (err) => reported.push(err.message);
  try {
    store.subscribe(() => { throw new Error('界面出错'); });
    const after = [];
    store.subscribe((ev) => after.push(ev.reason));
    store.actions.updateTrade('t_01', { note: 'x' });
    assert.deepEqual(got, ['update']);
    assert.deepEqual(after, ['update']);
    assert.deepEqual(reported, ['界面出错']);
    off();
    store.actions.updateTrade('t_01', { note: 'y' });
    assert.deepEqual(got, ['update']);
  } finally {
    if (saved === undefined) delete globalThis.reportError; else globalThis.reportError = saved;
  }
});

test('随机操作 600 步：约束始终成立', () => {
  let seed = 20261005;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const { store, a } = setup();
  const undos = [];
  for (let step = 0; step < 600; step++) {
    const { journal } = store.get();
    const tradeIds = journal.rows.filter((r) => r.type === 'trade').map((r) => r.id);
    const sysIds = journal.rows.filter((r) => r.type === 'system').map((r) => r.id);
    const t = tradeIds.length ? pick(tradeIds) : null;
    switch (Math.floor(rnd() * 11)) {
      case 0: a.createTradeFromEmptyRow(pick([{ rr: 2 }, { reason: 'x' }, { risk: 50 }, { result: 'win' }, {}])); break;
      case 1: if (t) a.updateTrade(t, pick([{ rr: rnd() * 4 }, { risk: pick([null, 0, 80, 120]) }, { direction: 'short' }, { date: '2026-09-30' }])); break;
      case 2: if (t) a.cycleResult(t); break;
      case 3: if (t) a.setPnlInput(t, pick(['', '0', '-37.5', '120', M + '100', 'abc', null])); break;
      case 4: if (t) undos.push(a.deleteTrade(t)); break;
      case 5: if (t) a.insertSystemRowAbove(t); break;
      case 6: a.appendSystemRow(); break;
      case 7: undos.push(a.deleteSystemRow(pick(sysIds))); break;
      case 8: if (undos.length) { const u = undos.splice(Math.floor(rnd() * undos.length), 1)[0]; if (u) u(); } break;
      case 9: a.updateSystem(pick(sysIds), { name: pick(['', 'A', '趋势']) }); break;
      default: if (t) a.setResult(t, pick(['win', 'loss', null]));
    }
    checkInvariants(store);
  }
  const all = store.get().journal.rows.map((r) => r.id);
  assert.equal(new Set(all).size, all.length, 'id 不重复');
});
