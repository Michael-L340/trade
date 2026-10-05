// 顶部统计（交接文档 7.9）：左边的"全部交易"面板——标题旁一行副标题，下面两排数字。
//
// mountSummary(container, store) → { update, destroy }
//   - container 本身就是面板：加上 panel、stats 两个类，里面原有的内容替换掉（传一个空 div 或 div.panel 都行）。
//     只有传进来的是概览区 .overview（预览稿里统计和曲线的外层）时，才在它末尾加一个 div.panel.stats。
//   - DOM 只在挂载时建一次。之后每次数据变化（row / rows / journal 事件）只改文本节点，
//     文字没变的不碰；ui 事件（选中行、保存状态、只读）和统计无关，不处理。
//   - 全部用 createElement / textContent，不拼 HTML。样式类名沿用预览稿：
//     panel、stats、panel-head、panel-title、panel-sub、stats-grid、stat、label、big、small、foot、stats-divider。
//
// summaryTexts(derived, currency) 是纯函数：只算要显示的文字，不碰 DOM，方便测试。

import { fmtPct, fmtCi, fmtTwo, fmtR, fmtMoney } from '../format.js';

/** 第一排：标题、大数字的键、小字的键 */
const ROW1 = [
  ['胜率', 'winRate', 'winRateFoot'],
  ['实际盈亏比', 'payoff', 'payoffFoot'],
  ['期望值', 'expectancy', 'expectancyFoot'],
  ['累计', 'total', 'totalFoot'],
];

/** 第二排（小一号）：标题、数字的键 */
const ROW2 = [
  ['盈利因子', 'profitFactor'],
  ['最大回撤', 'maxDrawdown'],
  ['最大连亏', 'lossStreak'],
  ['持仓中', 'open'],
];

/**
 * 顶部统计要显示的全部文字（7.9；附录 B 的"全部"一列）。
 * - 副标题：15 笔已平仓，1 笔持仓中 · 2026-09-01 至今（日期取表格里第一笔交易的日期）。
 *   有"已选结果但缺数、不进统计"的交易时，加一句"，n 笔缺数"，免得笔数对不上。
 * - 胜率下面：6 胜 9 负，误差 ±25%（n < 5 不显示误差；有打平的交易时加"n 平"）。
 * - 实际盈亏比下面：平均赚 $200，亏 $100。期望值下面：每笔平均 +$20。累计下面：金额 +$300。
 * - 没法算的数显示"—"。
 * @param {{all: object, grouped: {trades: Array}}} derived store.get().derived
 * @param {string} [currency] 金额单位
 * @returns {Record<string, string>}
 */
export function summaryTexts(derived, currency = '') {
  const s = derived.all;
  const trades = derived.grouped.trades;
  const n = s.n;
  const money = (v, sign = false) => fmtMoney(v, { sign, currency });

  let sub = '还没有交易';
  if (trades.length) {
    const invalid = trades.filter((it) => it.d.outcome === 'invalid').length;
    sub = n + ' 笔已平仓，' + s.open + ' 笔持仓中';
    if (invalid) sub += '，' + invalid + ' 笔缺数';
    if (trades[0].t.date) sub += ' · ' + trades[0].t.date + ' 至今';
  }

  let winRateFoot = '还没有已出场的交易';
  if (n) {
    const flat = n - s.wins - s.losses;
    winRateFoot = s.wins + ' 胜 ' + s.losses + ' 负' + (flat ? ' ' + flat + ' 平' : '');
    const ci = fmtCi(s.ciHalfWidth);
    if (ci) winRateFoot += '，误差 ' + ci;
  }

  let payoffFoot = '';
  if (s.avgWinMoney !== null && s.avgLossMoney !== null) {
    payoffFoot = '平均赚 ' + money(s.avgWinMoney) + '，亏 ' + money(s.avgLossMoney);
  } else if (s.avgWinMoney !== null) {
    payoffFoot = '平均赚 ' + money(s.avgWinMoney) + '，还没有亏损的交易';
  } else if (s.avgLossMoney !== null) {
    payoffFoot = '还没有盈利的交易，平均亏 ' + money(s.avgLossMoney);
  }

  return {
    sub,
    winRate: fmtPct(s.winRate),
    winRateFoot,
    payoff: fmtTwo(s.payoff),
    payoffFoot,
    expectancy: fmtR(s.expectancy, 2),
    expectancyFoot: n ? '每笔平均 ' + money(s.totalMoney / n, true) : '',
    total: fmtR(n ? s.totalR : null, 1),
    totalFoot: n ? '金额 ' + money(s.totalMoney, true) : '',
    profitFactor: fmtTwo(s.profitFactor),
    maxDrawdown: fmtR(n ? s.maxDrawdownR : null, 1),
    lossStreak: s.maxLossStreak + ' 笔',
    open: s.open + ' 笔',
  };
}

function div(cls, text) {
  const node = document.createElement('div');
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** container 本身就是面板（清空了用）；是概览区 .overview 时在它末尾加一个面板 */
function takePanel(container, extra) {
  let panel = container;
  if (container.classList.contains('overview')) panel = container.appendChild(document.createElement('div'));
  else container.textContent = '';
  panel.classList.add('panel');
  if (extra) panel.classList.add(extra);
  return panel;
}

/**
 * 挂载顶部统计。
 * @param {HTMLElement} container
 * @param {ReturnType<import('../state.js').createStore>} store
 * @returns {{update: () => void, destroy: () => void}}
 */
export function mountSummary(container, store) {
  const panel = takePanel(container, 'stats');
  const nodes = {}; // 键 → 文本节点；之后只改这些节点的 data

  const textBox = (cls, key) => {
    const box = div(cls);
    nodes[key] = box.appendChild(document.createTextNode(''));
    return box;
  };
  const stat = (label, boxes) => {
    const box = div('stat');
    box.appendChild(div('label', label));
    for (const b of boxes) box.appendChild(b);
    return box;
  };

  const head = div('panel-head');
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = '全部交易';
  const sub = document.createElement('span');
  sub.className = 'panel-sub';
  nodes.sub = sub.appendChild(document.createTextNode(''));
  head.appendChild(title);
  head.appendChild(sub);

  const grid1 = div('stats-grid');
  for (const [label, big, foot] of ROW1) grid1.appendChild(stat(label, [textBox('big', big), textBox('foot', foot)]));
  const divider = document.createElement('hr');
  divider.className = 'stats-divider';
  const grid2 = div('stats-grid');
  for (const [label, key] of ROW2) grid2.appendChild(stat(label, [textBox('small', key)]));

  panel.appendChild(head);
  panel.appendChild(grid1);
  panel.appendChild(divider);
  panel.appendChild(grid2);

  function update() {
    const { journal, derived } = store.get();
    const texts = summaryTexts(derived, journal.currency);
    for (const key of Object.keys(nodes)) {
      const text = texts[key] ?? '';
      if (nodes[key].data !== text) nodes[key].data = text;
    }
  }

  update();
  const unsubscribe = store.subscribe((ev) => {
    if (ev.type !== 'ui') update();
  });

  return { update, destroy: unsubscribe };
}
