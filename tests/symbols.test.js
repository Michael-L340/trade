import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolOptions } from '../src/symbols.js';

const tr = (symbol, date) => ({ type: 'trade', symbol, date });

test('品种候选：按近 30 天次数排序，再按总次数、最近日期', () => {
  const rows = [
    { type: 'system' },
    tr('EURUSD', '2026-08-01'), tr('EURUSD', '2026-08-02'), tr('EURUSD', '2026-08-03'), // 早于 30 天
    tr('XAUUSD', '2026-09-20'), tr('XAUUSD', '2026-10-01'),
    tr('NAS100', '2026-10-04'),
    tr(' XAUUSD ', '2026-10-05'), tr('', '2026-10-05'),
  ];
  assert.deepEqual(symbolOptions(rows, '2026-10-05'), ['XAUUSD', 'NAS100', 'EURUSD']);
});

test('品种候选：近 30 天次数相同按总次数，再按最近日期', () => {
  const rows = [tr('A', '2026-01-01'), tr('A', '2026-10-01'), tr('B', '2026-10-02'), tr('C', '2026-10-03')];
  assert.deepEqual(symbolOptions(rows, '2026-10-05'), ['A', 'C', 'B']);
});

test('filterSymbols：没打字列全部；打了字按字筛，开头对得上的在前，打全的不再列', async () => {
  const { filterSymbols } = await import('../src/symbols.js');
  const opts = ['XAUUSD', 'EURUSD', 'USDJPY', 'NAS100'];
  assert.deepEqual(filterSymbols(opts, 'XAUUSD', false), opts);
  assert.deepEqual(filterSymbols(opts, 'us', true), ['USDJPY', 'XAUUSD', 'EURUSD']);
  assert.deepEqual(filterSymbols(opts, 'xauusd', true), []);
  assert.deepEqual(filterSymbols(opts, '  ', true), opts);
});
