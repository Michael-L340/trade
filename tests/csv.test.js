// 导出 CSV（第 9.3 节）：BOM、CRLF、引号规则、列顺序、系统名写在每笔的"系统"列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCsv, csvFileName, CSV_COLUMNS, CSV_MIME } from '../src/csv.js';

const sample = () => JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));

/** 按 RFC 4180 解析（只用于测试）：支持引号里的逗号、引号和换行 */
function parseCsv(text) {
  assert.equal(text.charCodeAt(0), 0xFEFF, '开头要有 BOM');
  const s = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i += 1; continue; }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && s[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    assert.notEqual(c, '\n', `第 ${rows.length + 1} 行有不在引号里的单独 LF`);
    field += c; i += 1;
  }
  assert.equal(field, '', '最后一行后面要有 CRLF');
  assert.equal(row.length, 0);
  return rows;
}

function trade(id, fields) {
  return { type: 'trade', id, date: '2026-10-01', symbol: 'XAUUSD', direction: 'long', rr: 2, risk: 100, result: null, pnlOverride: null, reason: '', note: '', shots: [], ...fields };
}

test('附录 A：BOM、CRLF、表头、一笔一行', () => {
  const text = toCsv(sample());
  assert.ok(text.startsWith('\u{FEFF}序号,系统,日期,'));
  assert.ok(text.endsWith('\r\n'));
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], ['序号', '系统', '日期', '品种', '方向', '盈亏比', '止损金额', '止盈金额', '结果', '盈亏金额', '是否手改', 'R', '开仓理由', '备注', '截图数']);
  assert.deepEqual(rows[0], [...CSV_COLUMNS]);
  assert.equal(rows.length - 1, 16, '行数等于交易数，系统行不单独成行');
  assert.ok(rows.every((r) => r.length === 15));
  assert.equal(CSV_MIME, 'text/csv;charset=utf-8');
});

test('附录 A：逐列的值', () => {
  const rows = parseCsv(toCsv(sample()));
  const byNo = new Map(rows.slice(1).map((r) => [r[0], r]));
  assert.deepEqual(byNo.get('1'), ['1', '趋势回调', '2026-09-01', 'XAUUSD', '多', '2', '100', '200', '盈', '200', '否', '2',
    '日线上升结构（HH/HL），H1 回踩前高 4105 转支撑，收出看涨吞没后进场。', '按计划 2 倍止盈。', '0']);
  assert.deepEqual(byNo.get('6').slice(0, 12), ['6', '趋势回调', '2026-09-09', 'NAS100', '多', '2', '100', '200', '亏', '-50', '是', '-0.5']);
  assert.deepEqual(byNo.get('10').slice(7, 12), ['300', '盈', '120', '是', '1.2']);
  assert.deepEqual(byNo.get('12').slice(5, 12), ['1.8', '100', '180', '盈', '180', '否', '1.8']);
  assert.deepEqual(byNo.get('13').slice(1, 5), ['区间假突破', '2026-09-22', 'XAUUSD', '多']);
  assert.deepEqual(byNo.get('14').slice(4, 5), ['空']);
  assert.deepEqual(byNo.get('16').slice(7, 12), ['200', '持仓中', '', '否', ''], '持仓中的盈亏和 R 留空');
  assert.equal(byNo.get('11')[13], '', '空备注');
  const text = toCsv(sample());
  assert.equal(text.includes('\u{2212}'), false, '数字列用 ASCII 负号，Excel 才能当数字');
});

test('引号规则：逗号、引号、换行', () => {
  const j = {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_1', name: '突破, 回踩', desc: '' },
      trade('t_1', { reason: '他说 "等一等"', note: '第一行\n第二行', symbol: 'EUR,USD' }),
      trade('t_2', { reason: 'a\r\nb' }),
    ],
  };
  const text = toCsv(j);
  assert.ok(text.includes('"突破, 回踩"'));
  assert.ok(text.includes('"他说 ""等一等"""'));
  assert.ok(text.includes('"第一行\n第二行"'));
  assert.ok(text.includes('"EUR,USD"'));
  const rows = parseCsv(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], '突破, 回踩');
  assert.equal(rows[1][3], 'EUR,USD');
  assert.equal(rows[1][12], '他说 "等一等"');
  assert.equal(rows[1][13], '第一行\n第二行');
  assert.equal(rows[2][12], 'a\r\nb');
});

test('文字列以 = + - @ 开头时加 \' 防止被当成公式', () => {
  const j = {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_1', name: '=SUM(A1)', desc: '' },
      trade('t_1', { reason: '-50 提前平仓', note: '+1 加仓', symbol: '@ES' }),
      trade('t_2', { reason: '正常文字 -50', note: '=1+1' }),
    ],
  };
  const rows = parseCsv(toCsv(j));
  assert.equal(rows[1][1], "'=SUM(A1)");
  assert.equal(rows[1][3], "'@ES");
  assert.equal(rows[1][12], "'-50 提前平仓");
  assert.equal(rows[1][13], "'+1 加仓");
  assert.equal(rows[2][12], '正常文字 -50', '不在开头的符号不处理');
  assert.equal(rows[2][13], "'=1+1");
});

test('系统名为空时写系统标签；缺数、保本、截图数', () => {
  const j = {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_1', name: '', desc: '' },
      trade('t_1', { rr: null, result: 'win' }),
      { type: 'system', id: 'sys_2', name: '', desc: '' },
      trade('t_2', { result: 'win', pnlOverride: 0, shots: [{ id: 'sh_1', label: 'open', file: 'a' }, { id: 'sh_2', label: '', file: 'b' }] }),
      trade('t_3', { direction: 'short', rr: 2.25, risk: 33.33, result: 'win' }),
    ],
  };
  const rows = parseCsv(toCsv(j));
  assert.deepEqual(rows.slice(1).map((r) => r[1]), ['系统 A', '系统 B', '系统 B']);
  assert.deepEqual(rows[1].slice(5, 12), ['', '100', '', '缺数', '', '否', '']);
  assert.deepEqual(rows[2].slice(8, 12), ['平', '0', '是', '0']);
  assert.equal(rows[2][14], '2');
  assert.deepEqual(rows[3].slice(4, 12), ['空', '2.25', '33.33', '74.9925', '盈', '74.9925', '否', '2.25']);
});

test('没有交易时只有表头', () => {
  assert.equal(toCsv({ schemaVersion: 1, currency: '$', rows: [{ type: 'system', id: 'sys_1', name: '', desc: '' }] }), '\u{FEFF}' + CSV_COLUMNS.join(',') + '\r\n');
});

test('文件名按本地日期', () => {
  assert.equal(csvFileName(new Date(2026, 9, 5, 0, 10)), '交易日志-2026-10-05.csv');
});
