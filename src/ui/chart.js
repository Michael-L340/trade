// 累计 R 曲线（交接文档 7.9）。用 SVG 手画，不引入图表库；从预览稿的 renderChart 移植。
//
// mountChart(container, store, { openDetail }) → { render, destroy }
//   - container 本身就是面板：加上 panel 类，里面原有的内容替换掉（传一个空 div 或 div.panel 都行）；
//     只有传进来的是概览区 .overview 时，才在它末尾加一个 div.panel。面板里是标题"累计 R 曲线"、图例（● 盈利 ○ 亏损）和曲线。
//   - 横轴是已出场交易的顺序，纵轴是累计 R，从 (0, 0) 开始。0 那条横线深一些，其他网格线很淡；
//     纵轴刻度取整数 R，自动选间隔。相邻两个系统之间画竖直虚线，横轴下方标每一段的系统标签，
//     放不下时依次缩短成"系统 B"、"B"，再放不下（或会和左边的标签重叠）就不标。折线末端标出累计值。
//   - 每笔一个点：盈利红色实心圆，亏损绿色空心圆，打平灰色空心圆。鼠标移上去或键盘聚焦时显示
//     "第 7 笔 · XAUUSD 多 · +3.0R · 累计 +4.0R"；点一下（或回车、空格）调用 openDetail(交易 id)。
//     这些点只占一个 Tab 位置：Tab 进来落在最后一笔，← → Home End 在点之间移动。
//   - 超过 200 笔时不画点，只画线。没有已出场的交易时显示一行说明。
//   - 数据变化（row / rows / journal 事件）用 requestAnimationFrame 合并成一次重画；曲线用到的东西
//     （各笔的 R、结果、品种、方向、序号、分段、宽度）都没变就不重画，所以改开仓理由、日期之类不会动曲线。
//     宽度变化由 ResizeObserver 触发重画。
//   - 全部用 createElement(NS) / textContent，不拼 HTML；位置用 SVG 属性和 element.style 设置
//     （CSP 不允许 HTML 里的 style="" 属性）。样式类名沿用预览稿：chart-wrap、chart-svg、chart-empty、
//     grid、zero、divider、tick、seglab、curve、pt win/loss/flat、hit、endlab、tip、legend。
//
// layoutChart(derived, width) 是纯函数：算出全部坐标和文字，不碰 DOM，方便测试。

import { EPS } from '../calc.js';
import { fmtR, fmtDirection, MINUS } from '../format.js';

const NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 256;
/** 超过这么多笔就不画点 */
export const MAX_POINTS = 200;
const FALLBACK_WIDTH = 640; // 容器还没排版（宽度为 0）时先按这个宽度画，ResizeObserver 随后会纠正
const MIN_WIDTH = 240;
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
export const CHART_EMPTY_TEXT = '记下第一笔出场的交易后，这里会画出累计曲线。';

/** 估算文字宽度（像素）：中文按 12px、其他按 7px（12px 字号） */
function textWidth(str) {
  let w = 0;
  for (const ch of str) w += ch.codePointAt(0) > 0x2E7F ? 12 : 7;
  return w;
}

const round1 = (x) => Math.round(x * 10) / 10;
const tickLabel = (v) => (v < 0 ? MINUS : '') + Math.abs(v);

/** 提示文字：第 7 笔 · XAUUSD 多 · +3.0R · 累计 +4.0R（品种为空时省掉） */
function tipText(it, cum) {
  const what = [it.t.symbol, fmtDirection(it.t.direction)].filter(Boolean).join(' ');
  return '第 ' + it.no + ' 笔 · ' + what + ' · ' + fmtR(it.d.r, 1) + ' · 累计 ' + fmtR(cum, 1);
}

/**
 * 算出曲线的全部坐标和文字。
 * @param {{all: {closed: Array, cumulative: number[]}, grouped: {segments: Array}}} derived store.get().derived
 * @param {number} width 容器宽度（像素）
 * @returns {{empty: true, text: string} | {empty: false, W: number, H: number, pad: object, n: number,
 *   ticks: Array<{y: number, label: string, zero: boolean}>, dividers: number[],
 *   segLabels: Array<{x: number, text: string}>, path: string,
 *   points: Array<{x: number, y: number, cls: string, id: string, tip: string}>|null,
 *   end: {x: number, y: number, text: string}, aria: string}}
 */
export function layoutChart(derived, width) {
  const closed = derived.all.closed;
  const cums = derived.all.cumulative;
  const n = closed.length;
  if (!n) return { empty: true, text: CHART_EMPTY_TEXT };

  const W = Math.max(MIN_WIDTH, Math.floor(width) || FALLBACK_WIDTH);
  const H = HEIGHT;

  // 纵轴范围和刻度间隔
  let minV = 0;
  let maxV = 0;
  for (const v of cums) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const span = Math.max(1, maxV - minV);
  const step = STEPS.find((s) => span / s <= 6) || Math.ceil(span / 6);
  let y0 = Math.floor(minV / step + 1e-9) * step; // 1e-9：3.0000000000000004 不多出一格
  let y1 = Math.ceil(maxV / step - 1e-9) * step;
  if (y1 - y0 < step / 2) { y0 -= step; y1 += step; } // 全是 0（只有打平的交易）时让 0 线在中间
  const tickValues = [];
  for (let v = y0; v <= y1 + EPS; v += step) tickValues.push(v);

  const endText = fmtR(cums[n], 1);
  let longestTick = 0;
  for (const v of tickValues) longestTick = Math.max(longestTick, tickLabel(v).length);
  const pad = {
    l: Math.max(44, longestTick * 8 + 14), // 刻度文字写在左边，右对齐
    r: Math.max(64, endText.length * 8 + 17), // 末端标签写在折线右边
    t: 18,
    b: 48, // 横轴下方写系统标签
  };
  const plotW = Math.max(1, W - pad.l - pad.r);
  const plotH = H - pad.t - pad.b;
  const px = (i) => pad.l + plotW * (i / n);
  const py = (v) => pad.t + plotH * ((y1 - v) / (y1 - y0));

  const ticks = tickValues.map((v) => ({ y: round1(py(v)), label: tickLabel(v), zero: Math.abs(v) < EPS }));

  // 系统分段：相邻两段之间的竖直虚线 + 横轴下方的标签
  const dividers = [];
  const segLabels = [];
  let idx = 0;
  let prevHad = false;
  let lastRight = -Infinity;
  // 各系统的交易按日期交错在一起时（几个系统同时用），曲线不再按系统分段标注
  const order = closed.map((it) => it.t.id).join(' ');
  const contiguous = order === derived.grouped.segments.flatMap((seg) => seg.stats.closed.map((it) => it.t.id)).join(' ');
  for (const seg of contiguous ? derived.grouped.segments : []) {
    const list = seg.stats.closed;
    const count = list.length;
    if (!count) continue;
    const start = idx;
    const end = idx + count;
    if (prevHad) dividers.push(round1((px(start) + px(start + 1)) / 2));
    const firstNo = list[0].no;
    const lastNo = list[count - 1].no;
    const range = firstNo === lastNo ? '（第 ' + firstNo + ' 笔）' : '（第 ' + firstNo + '–' + lastNo + ' 笔）';
    const cx = (px(start) + px(end)) / 2;
    const avail = px(end) - px(start) + 16;
    for (const text of ['系统 ' + seg.letter + range, '系统 ' + seg.letter, seg.letter]) {
      const w = textWidth(text);
      if (w <= avail && cx - w / 2 >= lastRight + 6) {
        segLabels.push({ x: round1(cx), text });
        lastRight = cx + w / 2;
        break;
      }
    }
    idx = end;
    prevHad = true;
  }

  let path = '';
  for (let i = 0; i <= n; i++) path += (i ? ' L' : 'M') + round1(px(i)) + ' ' + round1(py(cums[i]));

  const points = n > MAX_POINTS ? null : closed.map((it, i) => ({
    x: round1(px(i + 1)),
    y: round1(py(cums[i + 1])),
    cls: it.d.outcome === 'win' ? 'win' : it.d.outcome === 'loss' ? 'loss' : 'flat',
    id: it.t.id,
    tip: tipText(it, cums[i + 1]),
  }));

  return {
    empty: false,
    W,
    H,
    pad,
    n,
    ticks,
    dividers,
    segLabels,
    path,
    points,
    end: { x: round1(px(n) + 9), y: round1(py(cums[n]) + 4), text: endText },
    aria: '累计 R 曲线：' + n + ' 笔已出场，当前累计 ' + endText,
  };
}

/** 判断要不要重画：曲线用到的输入拼成一个串，和上次一样就不画 */
function inputSignature(derived, width) {
  const parts = [width];
  for (const it of derived.all.closed) parts.push(it.t.id, it.no, it.d.r, it.d.outcome, it.t.symbol, it.t.direction);
  for (const seg of derived.grouped.segments) parts.push(seg.letter, seg.stats.closed.length);
  return JSON.stringify(parts);
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
  return node;
}

function svgText(x, y, str, cls, anchor) {
  const node = svgEl('text', { x, y, class: cls, 'text-anchor': anchor });
  node.textContent = str;
  return node;
}

/** 按 layoutChart 的结果建 SVG。返回 { svg, hits }，hits[i] 是第 i 个点的可点击圆。 */
function drawChart(m, activeId) {
  const svg = svgEl('svg', {
    width: m.W, height: m.H, viewBox: '0 0 ' + m.W + ' ' + m.H, class: 'chart-svg',
    role: m.points ? 'group' : 'img', 'aria-label': m.aria,
  });
  const art = svgEl('g', { 'aria-hidden': 'true' }); // 网格、文字、折线、点：读屏只读整体说明和可点的点
  for (const t of m.ticks) {
    art.appendChild(svgEl('line', { x1: m.pad.l, x2: m.W - m.pad.r, y1: t.y, y2: t.y, class: t.zero ? 'zero' : 'grid' }));
    art.appendChild(svgText(m.pad.l - 8, round1(t.y + 4), t.label, 'tick', 'end'));
  }
  for (const x of m.dividers) art.appendChild(svgEl('line', { x1: x, x2: x, y1: m.pad.t, y2: m.H - m.pad.b, class: 'divider' }));
  for (const s of m.segLabels) art.appendChild(svgText(s.x, m.H - m.pad.b + 22, s.text, 'seglab', 'middle'));
  art.appendChild(svgEl('path', { d: m.path, class: 'curve' }));
  if (m.points) for (const p of m.points) art.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 4, class: 'pt ' + p.cls }));
  art.appendChild(svgText(m.end.x, m.end.y, m.end.text, 'endlab', 'start'));
  svg.appendChild(art);

  const hits = [];
  if (m.points) {
    const active = m.points.some((p) => p.id === activeId) ? activeId : m.points[m.points.length - 1].id;
    m.points.forEach((p, i) => {
      hits.push(svg.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: 11, class: 'hit', role: 'button', tabindex: p.id === active ? 0 : -1,
        'aria-label': p.tip + '，按回车打开详情', 'data-i': i, 'data-id': p.id,
      })));
    });
  }
  return { svg, hits };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** container 本身就是面板（清空了用）；是概览区 .overview 时在它末尾加一个面板 */
function takePanel(container) {
  let panel = container;
  if (container.classList.contains('overview')) panel = container.appendChild(document.createElement('div'));
  else container.textContent = '';
  panel.classList.add('panel');
  return panel;
}

const raf = typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
const cancelRaf = typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

/**
 * 挂载累计 R 曲线。
 * @param {HTMLElement} container
 * @param {ReturnType<import('../state.js').createStore>} store
 * @param {{openDetail?: (id: string) => void}} [opts]
 * @returns {{render: () => void, destroy: () => void}}
 */
export function mountChart(container, store, opts = {}) {
  const openDetail = typeof opts.openDetail === 'function' ? opts.openDetail : null;
  const panel = takePanel(container);

  const head = el('div', 'panel-head');
  head.appendChild(el('h2', 'panel-title', '累计 R 曲线'));
  const legend = el('span', 'legend');
  for (const [cls, text] of [['w', '盈利'], ['l', '亏损']]) {
    const item = el('span');
    const dot = el('i', cls);
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);
    item.appendChild(document.createTextNode(text));
    legend.appendChild(item);
  }
  head.appendChild(legend);

  const wrap = el('div', 'chart-wrap');
  const host = el('div');
  const tip = el('div', 'tip');
  tip.hidden = true;
  wrap.appendChild(host);
  wrap.appendChild(tip);
  panel.appendChild(head);
  panel.appendChild(wrap);

  let model = null; // 最近一次画的布局
  let svg = null;
  let hits = [];
  let lastSig = null;
  let lastWidth = -1;
  let frame = 0;
  let activeId = null; // 能用 Tab 进来的那个点（交易 id）

  const hitOf = (node) => (node && node.classList && node.classList.contains('hit') && host.contains(node) ? node : null);
  const hitId = (hit) => hit.getAttribute('data-id');

  function paint() {
    frame = 0;
    const { derived } = store.get();
    const width = host.clientWidth;
    const sig = inputSignature(derived, width);
    if (sig === lastSig) return;
    lastSig = sig;
    lastWidth = width;
    const focused = hitOf(document.activeElement);
    const focusedId = focused ? hitId(focused) : null;
    tip.hidden = true;
    model = layoutChart(derived, width);
    host.textContent = '';
    svg = null;
    hits = [];
    if (model.empty) {
      host.appendChild(el('p', 'chart-empty', model.text));
      return;
    }
    const drawn = drawChart(model, focusedId || activeId);
    svg = drawn.svg;
    hits = drawn.hits;
    host.appendChild(svg);
    const active = hits.find((h) => h.getAttribute('tabindex') === '0');
    activeId = active ? hitId(active) : null;
    if (focusedId) {
      const again = hits.find((h) => hitId(h) === focusedId);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function schedule() {
    if (!frame) frame = raf(paint);
  }

  function showTip(hit) {
    const i = Number(hit.getAttribute('data-i'));
    const p = model && model.points ? model.points[i] : null;
    if (!p || !svg) return;
    tip.textContent = p.tip;
    tip.hidden = false;
    // 点的坐标是 SVG 内的；换算到 .chart-wrap 里（SVG 被 CSS 缩放时也对）
    const wr = wrap.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    const sx = sr.width ? sr.width / model.W : 1;
    const sy = sr.height ? sr.height / model.H : 1;
    let x = sr.left - wr.left + p.x * sx;
    const y = sr.top - wr.top + p.y * sy;
    // 提示以 x 为中心（样式里 translate(-50%)）：靠近左右边时往里挪，不撑出横向滚动条
    const half = tip.offsetWidth / 2;
    const maxX = wrap.clientWidth;
    if (maxX > 0) x = half * 2 >= maxX ? maxX / 2 : Math.min(Math.max(x, half), maxX - half);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function setActive(hit) {
    for (const h of hits) if (h !== hit && h.getAttribute('tabindex') === '0') h.setAttribute('tabindex', '-1');
    if (hit.getAttribute('tabindex') !== '0') hit.setAttribute('tabindex', '0');
    activeId = hitId(hit);
  }

  function openHit(hit) {
    tip.hidden = true;
    if (openDetail) openDetail(hitId(hit));
  }

  const onOver = (e) => {
    const hit = hitOf(e.target);
    if (hit) showTip(hit);
  };
  const onOut = (e) => {
    const hit = hitOf(e.target);
    if (!hit || hitOf(e.relatedTarget) === hit) return;
    const focused = hitOf(document.activeElement);
    if (focused) showTip(focused);
    else tip.hidden = true;
  };
  const onFocusIn = (e) => {
    const hit = hitOf(e.target);
    if (!hit) return;
    setActive(hit);
    showTip(hit);
  };
  const onFocusOut = (e) => {
    if (hitOf(e.target)) tip.hidden = true;
  };
  const onClick = (e) => {
    const hit = hitOf(e.target);
    if (hit) openHit(hit);
  };
  const onKey = (e) => {
    const hit = hitOf(e.target);
    if (!hit || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = Number(hit.getAttribute('data-i'));
    let j;
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        openHit(hit);
        return;
      case 'ArrowLeft': j = i - 1; break;
      case 'ArrowRight': j = i + 1; break;
      case 'Home': j = 0; break;
      case 'End': j = hits.length - 1; break;
      default: return;
    }
    e.preventDefault();
    if (j >= 0 && j < hits.length) hits[j].focus();
  };
  wrap.addEventListener('mouseover', onOver);
  wrap.addEventListener('mouseout', onOut);
  wrap.addEventListener('focusin', onFocusIn);
  wrap.addEventListener('focusout', onFocusOut);
  wrap.addEventListener('click', onClick);
  wrap.addEventListener('keydown', onKey);

  paint();
  const unsubscribe = store.subscribe((ev) => {
    if (ev.type !== 'ui') schedule();
  });

  const onResize = () => {
    if (host.clientWidth !== lastWidth) schedule();
  };
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(onResize);
    observer.observe(host);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  return {
    /** 立即重画（不管输入有没有变） */
    render() {
      lastSig = null;
      if (frame) cancelRaf(frame);
      paint();
    },
    destroy() {
      unsubscribe();
      if (frame) cancelRaf(frame);
      frame = 0;
      if (observer) observer.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      wrap.removeEventListener('mouseover', onOver);
      wrap.removeEventListener('mouseout', onOut);
      wrap.removeEventListener('focusin', onFocusIn);
      wrap.removeEventListener('focusout', onFocusOut);
      wrap.removeEventListener('click', onClick);
      wrap.removeEventListener('keydown', onKey);
    },
  };
}
