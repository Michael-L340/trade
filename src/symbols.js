// 品种的候选项：表格里已经用过的品种，按最近 30 天用过的次数从多到少排；
// 次数一样时按全部次数，再一样按最近一次的日期（新的在前）。纯函数，不碰 DOM。

const DAY_MS = 86400000;

function dayNumber(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : null;
}

/**
 * @param {Array} rows journal.rows
 * @param {string} today 'YYYY-MM-DD'（本地日期）
 * @param {number} [days] 统计窗口，默认 30 天
 * @returns {string[]} 品种列表（原样大小写，同名只出现一次）
 */
export function symbolOptions(rows, today, days = 30) {
  const t = dayNumber(today);
  const stats = new Map();
  for (const r of rows || []) {
    if (!r || r.type !== 'trade') continue;
    const sym = typeof r.symbol === 'string' ? r.symbol.trim() : '';
    if (!sym) continue;
    const s = stats.get(sym) || { recent: 0, total: 0, last: '' };
    s.total += 1;
    const d = dayNumber(r.date);
    if (t !== null && d !== null && d <= t && t - d < days) s.recent += 1;
    if ((r.date || '') > s.last) s.last = r.date || '';
    stats.set(sym, s);
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].recent - a[1].recent || b[1].total - a[1].total || (a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : 0))
    .map(([sym]) => sym);
}
