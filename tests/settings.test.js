// 设置页的纯逻辑（src/ui/settings.js）：导出文件名、数行数、恢复前的检查。不碰 DOM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { journalFileName, exportCsvFileName, countRows, checkRestoreText } from '../src/ui/settings.js';
import { serialize } from '../src/model.js';

const sampleText = readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);
const NOW = new Date(2026, 9, 5, 23, 30, 0);

test('导出文件名：按本地日期；示例数据带"示例"', () => {
  assert.equal(journalFileName(NOW), 'journal-2026-10-05.json');
  assert.equal(journalFileName(NOW, true), 'journal-示例-2026-10-05.json');
  assert.equal(exportCsvFileName(NOW), '交易日志-2026-10-05.csv');
  assert.equal(exportCsvFileName(NOW, true), '交易日志-示例-2026-10-05.csv');
});

test('数行数', () => {
  assert.deepEqual(countRows(sample()), { trades: 16, systems: 2 });
  assert.deepEqual(countRows({ rows: [] }), { trades: 0, systems: 0 });
  assert.deepEqual(countRows(null), { trades: 0, systems: 0 });
});

test('恢复：导出的 journal.json 原样读回来；开头有 BOM 也行；不认识的字段保留', () => {
  const j = sample();
  j.rows[1].myTag = '自己加的字段';
  const text = serialize(j);
  const r = checkRestoreText(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { trades: 16, systems: 2 });
  assert.equal(serialize(r.journal), text, '读回来再导出，一字不差');
  assert.equal(r.journal.rows[1].myTag, '自己加的字段');
  assert.equal(checkRestoreText('\u{FEFF}' + text).ok, true);
});

test('恢复：不是 JSON、数据比网站新、字段不合规时不恢复，并说清楚哪一行哪个字段', () => {
  const bad = checkRestoreText('这不是 JSON');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_JSON');
  assert.match(bad.title, /不是一份有效的 journal\.json/);

  const newer = checkRestoreText(JSON.stringify({ ...sample(), schemaVersion: 2 }));
  assert.equal(newer.ok, false);
  assert.equal(newer.code, 'NEWER_SCHEMA');
  assert.match(newer.message, /刷新/);

  const j = sample();
  j.rows[2].rr = -1;
  j.rows[3].date = '2026-02-30';
  const invalid = checkRestoreText(JSON.stringify(j));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID');
  assert.equal(invalid.errors.length, 2);
  assert.match(invalid.errors[0], /第 3 行.*盈亏比/);
  assert.match(invalid.errors[1], /第 4 行.*日期/);
  assert.match(invalid.message, /2 处/);
});

test('恢复：第一行不是系统行时整份拒收；文字里的 U+0000 去掉', () => {
  const j = sample();
  j.rows = j.rows.slice(1); // 去掉第一行的系统行
  const r = checkRestoreText(JSON.stringify(j));
  assert.equal(r.ok, false);
  const k = sample();
  k.rows[1].note = 'a\u{0000}b';
  const r2 = checkRestoreText(JSON.stringify(k));
  assert.equal(r2.ok, true);
  assert.equal(r2.journal.rows[1].note, 'ab');
  assert.deepEqual(r2.counts, { trades: 16, systems: 2 });
});
