// 冲突摘要（8.5）和找坏字符（8.4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffRows, describeDiff, conflictSummary } from '../src/diff.js';
import { findBadText, deepCleanText, hasBadText } from '../src/model.js';

const sample = () => JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));

test('diffRows：多了、改了、删了，系统行单独计数，顺序变了也提一句', () => {
  const base = sample();
  const local = structuredClone(base);
  local.rows.push({ ...structuredClone(local.rows[1]), id: 't_new1' }, { ...structuredClone(local.rows[1]), id: 't_new2' });
  local.rows[1].note = '改过';
  const d = diffRows(base, local);
  assert.deepEqual(d, { added: 2, changed: 1, removed: 0, sysAdded: 0, sysChanged: 0, sysRemoved: 0, reordered: false });
  assert.equal(describeDiff(d), '多了 2 笔，改了 1 笔');

  const remote = structuredClone(base);
  remote.rows.splice(2, 1);
  remote.rows[0].name = '改名';
  remote.rows.push({ type: 'system', id: 'sys_new', name: '', desc: '' });
  [remote.rows[3], remote.rows[4]] = [remote.rows[4], remote.rows[3]];
  const r = diffRows(base, remote);
  assert.equal(r.removed, 1);
  assert.equal(r.sysChanged, 1);
  assert.equal(r.sysAdded, 1);
  assert.equal(r.reordered, true);
  assert.equal(describeDiff(diffRows(base, base)), '没有改动');
});

test('conflictSummary：对话框原文；base 为空时只写两边各有几笔', () => {
  const base = sample();
  const local = structuredClone(base);
  local.rows.push({ ...structuredClone(local.rows[1]), id: 't_x' });
  const remote = structuredClone(base);
  remote.rows[1].reason = '云端改的';
  assert.equal(conflictSummary(base, local, remote).text, '这台电脑：多了 1 笔。云端：改了 1 笔。');
  assert.equal(conflictSummary(null, local, remote).text, '这台电脑：17 笔。云端：16 笔。');
});

test('findBadText：指出第几笔哪个字段；deepCleanText 清掉 U+0000 和半个 emoji', () => {
  const j = sample();
  j.rows[3].reason = 'a\u0000b';
  const bad = findBadText(j);
  assert.equal(bad.tradeNo, 3);
  assert.equal(bad.field, 'reason');
  assert.equal(bad.label, '开仓理由');
  const cleaned = deepCleanText(j);
  assert.equal(findBadText(cleaned), null);
  assert.equal(cleaned.rows[3].reason, 'ab');
  assert.equal(j.rows[3].reason, 'a\u0000b', '不改入参');
  j.rows[3].reason = 'x';
  j.rows[0].extra = { t: '\uD83D' };
  assert.equal(findBadText(j).field, 'extra', '不认识的字段里的也找得到');
  assert.equal(hasBadText('😀'), false, '完整的 emoji 没问题');
  assert.equal(deepCleanText({ a: ['\uD83D'] }).a[0], '�');
});
