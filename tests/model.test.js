// 数据模型：id、新建行、清洗、校验、迁移、固定格式序列化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCHEMA_VERSION, APP_VERSION, DEFAULT_CURRENCY, TRADE_KEYS, SYSTEM_KEYS, ModelError,
  newId, isoNow, cleanText, newSystemRow, newTrade, emptyJournal, sanitizeTradePatch, sanitizeSystemPatch,
  validateJournal, migrate, ensureFirstSystemRow, normalizeJournal, parseJournalText, serialize,
} from '../src/model.js';

const sampleText = readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);
const NOW = new Date(2026, 9, 5, 9, 30, 15, 123); // 本地时间 2026-10-05 09:30:15.123
const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xD800);
const LOW = String.fromCharCode(0xDC00);
const REPLACEMENT = '\u{FFFD}';

test('版本常量', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(DEFAULT_CURRENCY, '$');
});

test('newId：前缀 + 12 位十六进制，随机且不重复，避开已有 id', () => {
  assert.match(newId('t_'), /^t_[0-9a-f]{12}$/);
  assert.match(newId('sys_'), /^sys_[0-9a-f]{12}$/);
  assert.match(newId('sh_'), /^sh_[0-9a-f]{12}$/);
  const ids = new Set(Array.from({ length: 5000 }, () => newId('t_')));
  assert.equal(ids.size, 5000);
  let calls = 0;
  const id = newId('t_', () => ++calls < 4); // 前三次都说"已占用"
  assert.equal(calls, 4);
  assert.match(id, /^t_[0-9a-f]{12}$/);
  const taken = new Set(['t_x']);
  assert.notEqual(newId('t_', taken), 't_x');
});

test('isoNow 精确到秒', () => {
  assert.equal(isoNow(new Date(Date.UTC(2026, 8, 10, 14, 30, 0, 999))), '2026-09-10T14:30:00Z');
  assert.match(isoNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('cleanText：去掉 U+0000，修复孤立代理项，保留正常字符', () => {
  assert.equal(cleanText('a' + NUL + 'b' + NUL), 'ab');
  assert.equal(cleanText('x' + HIGH + 'y'), 'x' + REPLACEMENT + 'y');
  assert.equal(cleanText(LOW + 'z'), REPLACEMENT + 'z');
  assert.equal(cleanText('止损 😀 ok'), '止损 😀 ok', '成对的代理项（表情）不动');
  assert.equal(cleanText('  前后空格  '), '  前后空格  ', '不 trim');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(12), '');
  // 没有 toWellFormed 的旧浏览器走备用实现，结果一样
  const saved = String.prototype.toWellFormed;
  try {
    delete String.prototype.toWellFormed;
    assert.equal(cleanText('x' + HIGH + 'y' + LOW + '😀' + NUL), 'x' + REPLACEMENT + 'y' + REPLACEMENT + '😀');
  } finally {
    String.prototype.toWellFormed = saved;
  }
});

test('newSystemRow / emptyJournal', () => {
  const s = newSystemRow({ name: '趋势' + NUL, desc: '说明' }, { now: NOW });
  assert.deepEqual(Object.keys(s), SYSTEM_KEYS);
  assert.equal(s.type, 'system');
  assert.match(s.id, /^sys_/);
  assert.equal(s.name, '趋势');
  assert.equal(s.createdAt, isoNow(NOW));
  const blank = newSystemRow();
  assert.equal(blank.name, '');
  assert.equal(blank.desc, '');
  const j = emptyJournal();
  assert.equal(j.schemaVersion, SCHEMA_VERSION);
  assert.equal(j.currency, '$');
  assert.equal(j.rows.length, 1);
  assert.equal(j.rows[0].type, 'system');
  assert.equal(j.rows[0].name, '');
  assert.deepEqual(validateJournal(j), []);
});

test('newTrade：默认值、字段顺序、清洗', () => {
  const t = newTrade({}, { now: NOW });
  assert.deepEqual(Object.keys(t), TRADE_KEYS);
  assert.match(t.id, /^t_[0-9a-f]{12}$/);
  assert.equal(t.date, '2026-10-05', '日期是本地的今天');
  assert.equal(t.direction, 'long');
  assert.deepEqual([t.symbol, t.rr, t.risk, t.result, t.pnlOverride, t.reason, t.note], ['', null, null, null, null, '', '']);
  assert.deepEqual(t.shots, []);
  assert.equal(t.createdAt, t.updatedAt);

  const u = newTrade({ rr: 2, risk: 100, symbol: 'XAUUSD', reason: '理由' + NUL, direction: 'up', date: '2026-02-30', foo: 1 }, { now: NOW });
  assert.deepEqual(Object.keys(u), TRADE_KEYS, '不认识的字段不进新交易');
  assert.equal(u.rr, 2);
  assert.equal(u.risk, 100);
  assert.equal(u.symbol, 'XAUUSD');
  assert.equal(u.reason, '理由');
  assert.equal(u.direction, 'long', '不合规的方向被忽略');
  assert.equal(u.date, '2026-10-05', '不存在的日期被忽略');
  assert.deepEqual(validateJournal({ schemaVersion: 1, currency: '$', rows: [newSystemRow(), u] }), []);
});

test('sanitizeTradePatch：只留认识且合规的字段', () => {
  const { patch, rejected } = sanitizeTradePatch({
    date: '2026-09-01', symbol: 'EURUSD', direction: 'short', rr: 1.5, risk: 0, result: 'loss', pnlOverride: -0,
    reason: 'r', note: 'n', shots: [{ id: 'sh_1' }], id: 't_hack', type: 'system', createdAt: 'x', bogus: 1,
  });
  assert.deepEqual(patch, {
    date: '2026-09-01', symbol: 'EURUSD', direction: 'short', rr: 1.5, risk: null, result: 'loss', pnlOverride: 0,
    reason: 'r', note: 'n', shots: [{ id: 'sh_1' }],
  });
  assert.equal(Object.is(patch.pnlOverride, 0), true, '−0 归成 0');
  assert.deepEqual(rejected.sort(), ['bogus', 'createdAt', 'id', 'type']);
  assert.deepEqual(sanitizeTradePatch({ rr: -2, risk: Infinity }).patch, { rr: null, risk: null }, '0、负数、无穷当作清空');
  const bad = sanitizeTradePatch({ rr: '2', risk: NaN, result: 'draw', pnlOverride: Infinity, date: '9-1', symbol: 5, direction: null, shots: 'x' });
  assert.deepEqual(bad.patch, {});
  assert.deepEqual(bad.rejected.sort(), ['date', 'direction', 'pnlOverride', 'result', 'risk', 'rr', 'shots', 'symbol']);
  assert.deepEqual(sanitizeTradePatch({ result: null, rr: null }).patch, { result: null, rr: null });
  assert.deepEqual(sanitizeTradePatch(null), { patch: {}, rejected: [] });
});

test('sanitizeSystemPatch', () => {
  assert.deepEqual(sanitizeSystemPatch({ name: 'A' + NUL, desc: 'B', id: 'sys_x' }), { patch: { name: 'A', desc: 'B' }, rejected: ['id'] });
  assert.deepEqual(sanitizeSystemPatch({ name: 3 }), { patch: {}, rejected: ['name'] });
});

test('validateJournal：附录 A 没有问题', () => {
  assert.deepEqual(validateJournal(sample()), []);
});

test('validateJournal：错误指到第几行哪个字段', () => {
  const j = sample();
  j.rows[3].rr = -1; // 第 4 行 t_03
  j.rows[5].date = '2026-9-8'; // 第 6 行 t_05
  j.rows[7].direction = 'up'; // 第 8 行 t_07
  j.rows[9].result = 'draw'; // 第 10 行 t_09
  j.rows[13].name = 7; // 第 14 行 sys_b
  j.rows[14].id = 't_01'; // 第 15 行：和 t_01 重复
  const errs = validateJournal(j);
  const brief = errs.map((e) => [e.row, e.field]);
  assert.deepEqual(brief, [[4, 'rr'], [6, 'date'], [8, 'direction'], [10, 'result'], [14, 'name'], [15, 'id']]);
  assert.equal(errs[0].id, 't_03');
  assert.equal(errs[0].message, '第 4 行（t_03）盈亏比（rr）必须是大于 0 的数字或 null');
  assert.equal(errs[5].message, '第 15 行（t_01）id（id）和前面的行重复');
});

test('validateJournal：各种结构错误', () => {
  assert.equal(validateJournal(null).length, 1);
  assert.equal(validateJournal([]).length, 1);
  const top = validateJournal({ schemaVersion: '1', currency: 5, rows: {} });
  assert.deepEqual(top.map((e) => e.field), ['schemaVersion', 'currency', 'rows']);
  assert.ok(top.every((e) => e.row === null));
  const rows = validateJournal({
    schemaVersion: 1, currency: '$',
    rows: [
      'oops',
      { type: 'memo', id: 'm_1' },
      { type: 'system', id: 'x_1', name: '', desc: '' },
      { type: 'trade', id: 't_a', date: '2026-09-01', symbol: '', direction: 'long', rr: null, risk: null, result: null, pnlOverride: null, reason: '', note: '', shots: [{ id: 'bad', label: 'mid', file: 3, width: -1 }] },
      { type: 'trade', id: 't_b', date: '2026-09-01', symbol: '', direction: 'long', rr: null, risk: null, result: null, pnlOverride: 'x', reason: '', note: null },
    ],
  });
  const fields = rows.map((e) => `${e.row}:${e.field}`);
  assert.deepEqual(fields, ['1:null', '2:type', '3:id', '4:shots', '4:shots', '4:shots', '4:shots', '5:pnlOverride', '5:note', '5:shots']);
  assert.equal(rows[3].message, '第 4 行（t_a）截图（shots）的第 1 张的 id 必须以 sh_ 开头');
  assert.deepEqual(validateJournal({ schemaVersion: 2, currency: '$', rows: [] }).map((e) => e.field), ['schemaVersion']);
});

test('validateJournal：不认识的字段不算错', () => {
  const j = sample();
  j.extra = { a: 1 };
  j.rows[0].color = 'blue';
  j.rows[1].tags = ['x'];
  assert.deepEqual(validateJournal(j), []);
});

test('migrate：当前版本原样返回；更新的版本拒绝；无效版本报错', () => {
  const j = sample();
  assert.equal(migrate(j), j);
  assert.throws(() => migrate({ ...j, schemaVersion: 2 }), (e) => e instanceof ModelError && e.code === 'NEWER_SCHEMA' && /刷新/.test(e.message));
  for (const v of [0, -1, 1.5, '1', null, undefined]) {
    assert.throws(() => migrate({ ...j, schemaVersion: v }), (e) => e.code === 'INVALID', `schemaVersion = ${String(v)}`);
  }
  assert.throws(() => migrate('x'), (e) => e.code === 'INVALID');
});

test('ensureFirstSystemRow：第一行永远是系统行', () => {
  const ok = sample();
  assert.equal(ensureFirstSystemRow(ok), ok, '已经是系统行时原样返回');
  const noRows = ensureFirstSystemRow({ schemaVersion: 1, currency: '$', rows: [] });
  assert.equal(noRows.rows.length, 1);
  assert.equal(noRows.rows[0].type, 'system');
  const j = sample();
  j.rows.shift();
  const fixed = ensureFirstSystemRow(j);
  assert.equal(fixed.rows.length, j.rows.length + 1);
  assert.equal(fixed.rows[0].type, 'system');
  assert.equal(fixed.rows[0].name, '');
  assert.equal(fixed.rows[1], j.rows[0]);
  assert.equal(j.rows[0].type, 'trade', '不改动入参');
});

test('normalizeJournal：深拷贝、清洗文字、保留不认识的字段、补第一行', () => {
  const raw = sample();
  raw.rows[1].reason = '带' + NUL + '空字符' + HIGH;
  raw.rows[1].custom = { z: 1, a: [1, 2] };
  raw.future = 'keep';
  const before = JSON.stringify(raw);
  const j = normalizeJournal(raw);
  assert.equal(JSON.stringify(raw), before, '不改动入参');
  assert.notEqual(j.rows[1], raw.rows[1]);
  assert.equal(j.rows[1].reason, '带空字符' + REPLACEMENT);
  assert.deepEqual(j.rows[1].custom, { z: 1, a: [1, 2] });
  assert.equal(j.future, 'keep');
  raw.rows.shift();
  assert.equal(normalizeJournal(raw).rows[0].type, 'system');
  assert.throws(() => normalizeJournal({ schemaVersion: 1, currency: '$', rows: [{ type: 'trade', id: 't_1' }] }), (e) => e.code === 'INVALID' && e.errors.length > 0);
  assert.throws(() => normalizeJournal({ ...sample(), schemaVersion: 9 }), (e) => e.code === 'NEWER_SCHEMA');
});

test('parseJournalText：去 BOM、坏 JSON、版本太新', () => {
  const ok = parseJournalText('\u{FEFF}' + sampleText);
  assert.equal(ok.ok, true);
  assert.equal(ok.journal.rows.length, 18);
  const bad = parseJournalText('{ not json');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_JSON');
  const newer = parseJournalText(JSON.stringify({ ...sample(), schemaVersion: 3 }));
  assert.equal(newer.code, 'NEWER_SCHEMA');
  const invalid = parseJournalText('{"schemaVersion":1,"currency":"$","rows":[{"type":"trade","id":"t_1"}]}');
  assert.equal(invalid.code, 'INVALID');
  assert.ok(invalid.errors.length >= 1);
  assert.match(invalid.errors[0].message, /^第 1 行（t_1）/);
});

test('serialize：固定格式（每个 row 一行、键顺序固定、末尾换行）', () => {
  const j = {
    rows: [
      { createdAt: '2026-09-01T08:00:00Z', desc: '说明', name: '趋势', id: 'sys_a', type: 'system' },
      {
        zeta: 1, shots: [{ height: 1080, width: 1920, file: 'shots/t_1/sh_1.webp', label: 'open', id: 'sh_1', extra: { b: 2, a: 1 } }],
        note: '', reason: '理由，"引号"', pnlOverride: null, result: 'win', risk: 100, rr: 2, direction: 'long', symbol: 'XAUUSD',
        date: '2026-09-10', id: 't_1', type: 'trade', alpha: [3, { y: 1, x: 2 }], skipped: undefined,
      },
    ],
    currency: '$',
    schemaVersion: 1,
    zzz: { b: 1, a: 2 },
  };
  const expected = [
    '{',
    '  "schemaVersion": 1,',
    '  "currency": "$",',
    '  "rows": [',
    '    {"type":"system","id":"sys_a","name":"趋势","desc":"说明","createdAt":"2026-09-01T08:00:00Z"},',
    '    {"type":"trade","id":"t_1","date":"2026-09-10","symbol":"XAUUSD","direction":"long","rr":2,"risk":100,"result":"win","pnlOverride":null,"reason":"理由，\\"引号\\"","note":"","shots":[{"id":"sh_1","label":"open","file":"shots/t_1/sh_1.webp","width":1920,"height":1080,"extra":{"a":1,"b":2}}],"alpha":[3,{"x":2,"y":1}],"zeta":1}',
    '  ],',
    '  "zzz": {"a":2,"b":1}',
    '}',
    '',
  ].join('\n');
  assert.equal(serialize(j), expected);
});

test('serialize：附录 A 往返不丢内容，结果稳定，和键的先后无关', () => {
  const j = sample();
  const text = serialize(j);
  assert.ok(text.endsWith('}\n'));
  assert.equal(text.indexOf('\r'), -1);
  assert.equal(text.split('\n').length, j.rows.length + 7, '{、两行顶层字段、rows 开头、每行一个 row、]、}、末尾换行');
  assert.deepEqual(JSON.parse(text), j);
  assert.equal(serialize(JSON.parse(text)), text, '再序列化一遍结果不变');
  assert.ok(text.includes('"name":"趋势回调"'), '中文原样写出，不转义');
  const shuffled = JSON.parse(text, function (key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).reverse());
    }
    return value;
  });
  assert.equal(serialize(shuffled), text);
});

test('serialize：数字键和空 rows', () => {
  const t = serialize({ schemaVersion: 1, currency: '', rows: [{ 0: 'x', type: 'system', id: 'sys_1', name: '', desc: '' }] });
  assert.ok(t.includes('{"type":"system","id":"sys_1","name":"","desc":"","0":"x"}'), '数字样子的键也排在已知字段后面');
  assert.equal(serialize({ schemaVersion: 1, currency: '$', rows: [] }), '{\n  "schemaVersion": 1,\n  "currency": "$",\n  "rows": []\n}\n');
});
