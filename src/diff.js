// @ts-check
// 按行 id 的差异摘要（交接文档 8.5），冲突对话框用。纯函数。
// "改了"指同一个 id 的行按 5.2 的写法（formatRow）逐字比较不一样。系统行单独计数；顺序变了也提一句。

import { formatRow } from './journal-format.js';

/**
 * @typedef {{added: number, changed: number, removed: number, sysAdded: number, sysChanged: number, sysRemoved: number, reordered: boolean, study?: object}} RowDiff
 */

const rowsOf = (doc) => (doc && Array.isArray(doc.rows) ? doc.rows.filter((r) => r && typeof r === 'object' && typeof r.id === 'string') : []);

/**
 * base → other 的变化。
 * @returns {RowDiff}
 */
export function diffRows(base, other) {
  const a = rowsOf(base);
  const b = rowsOf(other);
  const before = new Map(a.map((r) => [r.id, r]));
  const after = new Map(b.map((r) => [r.id, r]));
  const out = { added: 0, changed: 0, removed: 0, sysAdded: 0, sysChanged: 0, sysRemoved: 0, reordered: false };
  for (const r of b) {
    const old = before.get(r.id);
    const sys = r.type === 'system';
    if (!old) { if (sys) out.sysAdded += 1; else out.added += 1; continue; }
    if (formatRow(old) !== formatRow(r)) { if (sys) out.sysChanged += 1; else out.changed += 1; }
  }
  for (const r of a) {
    if (!after.has(r.id)) { if (r.type === 'system') out.sysRemoved += 1; else out.removed += 1; }
  }
  // 两边都有的行，先后顺序变了没有
  const common = (list, other) => list.filter((r) => other.has(r.id)).map((r) => r.id).join('\n');
  out.reordered = common(a, after) !== common(b, before);
  return out;
}

/**
 * 学习板块 base → other 的变化：学习卡多了、改了、删了几张；主题和知识点（含要点）有没有改。
 * @returns {{cardsAdded: number, cardsChanged: number, cardsRemoved: number, topicsChanged: boolean}}
 */
export function diffStudy(base, other) {
  const cards = (doc) => {
    const st = doc && doc.study;
    return new Map((st && Array.isArray(st.cards) ? st.cards : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, JSON.stringify(c)]));
  };
  const topics = (doc) => JSON.stringify(doc && doc.study && Array.isArray(doc.study.topics) ? doc.study.topics : []);
  const a = cards(base);
  const b = cards(other);
  const out = { cardsAdded: 0, cardsChanged: 0, cardsRemoved: 0, topicsChanged: topics(base) !== topics(other) };
  for (const [id, text] of b) {
    if (!a.has(id)) out.cardsAdded += 1;
    else if (a.get(id) !== text) out.cardsChanged += 1;
  }
  for (const id of a.keys()) if (!b.has(id)) out.cardsRemoved += 1;
  return out;
}

/** 一段变化写成一句话："多了 2 笔，改了 1 笔"；没变化写"没有改动" */
export function describeDiff(d) {
  const parts = [];
  if (d.added) parts.push(`多了 ${d.added} 笔`);
  if (d.changed) parts.push(`改了 ${d.changed} 笔`);
  if (d.removed) parts.push(`删了 ${d.removed} 笔`);
  if (d.sysAdded) parts.push(`多了 ${d.sysAdded} 个系统行`);
  if (d.sysChanged) parts.push(`改了 ${d.sysChanged} 个系统行`);
  if (d.sysRemoved) parts.push(`删了 ${d.sysRemoved} 个系统行`);
  if (d.reordered) parts.push('顺序变了');
  const s = d.study;
  if (s) {
    if (s.cardsAdded) parts.push(`多了 ${s.cardsAdded} 张学习卡`);
    if (s.cardsChanged) parts.push(`改了 ${s.cardsChanged} 张学习卡`);
    if (s.cardsRemoved) parts.push(`删了 ${s.cardsRemoved} 张学习卡`);
    if (s.topicsChanged) parts.push('学习目录改了');
  }
  return parts.length ? parts.join('，') : '没有改动';
}

const tradeCount = (doc) => rowsOf(doc).filter((r) => r.type === 'trade').length;

/**
 * 冲突对话框里的两句话。base 为空（这个浏览器从没同步过）时只写两边各有几笔。
 * @returns {{local: string, remote: string, text: string, localDiff: RowDiff|null, remoteDiff: RowDiff|null}}
 */
export function conflictSummary(base, local, remote) {
  if (!base) {
    const l = `${tradeCount(local)} 笔`;
    const r = `${tradeCount(remote)} 笔`;
    return { local: l, remote: r, text: `这台电脑：${l}。云端：${r}。`, localDiff: null, remoteDiff: null };
  }
  const localDiff = { ...diffRows(base, local), study: diffStudy(base, local) };
  const remoteDiff = { ...diffRows(base, remote), study: diffStudy(base, remote) };
  const l = describeDiff(localDiff);
  const r = describeDiff(remoteDiff);
  return { local: l, remote: r, text: `这台电脑：${l}。云端：${r}。`, localDiff, remoteDiff };
}
