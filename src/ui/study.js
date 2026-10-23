// 「学习」板块的界面：左边目录（主题 › 知识点），右边按主题分组、一个知识点一块（能收起成小方块）铺开学习卡；墙 / 分栏 / 对比三种看法；
// 点卡片进编辑：图上画批注（编号点、框、箭头、水平线）、写结论和编号说明、选主题和知识点。
//
// mountStudy(root, store, opts) → { open(), close(), newCard(fields), openCard(id), destroy() }
//   opts.shots = { addStudyImage(cardId, blob), urlCache }（main.js 绑好 ctx 的 shots.js 接口）
//   opts.openTrade(tradeId)：卡片上「第 n 笔」点了去复盘打开那一笔
//   opts.fold = { load(), save(keys) }：墙上收起了哪些知识点存哪（main.js 给本机 meta 存储，每台设备各记各的）
//
// 数据只通过 store.actions 改（addTopic、addItem、updateItem、addCard、updateCard、deleteCard……）。
// 编辑框开着的时候，后面的卡片墙不跟着每个字重画，关掉时再画一次（不打断输入法、不反复要图片地址）。
// 全部用 createElement / textContent，不拼 HTML；颜色、位置用 element.style 或 SVG 属性（页面有内容安全策略）。

import { MARK_W, MARK_H, MARK_COLORS, MARK_SIZE_MAX, MARK_SIZE_MIN, MAX_PAGES, cardPages, coverIndex, findItem, isDashed, pagesPatch, withCover, LONG_MAX, SHORT_MAX } from '../study.js';
import { confirmDialog, showToast } from './toast.js';
import { errorText, readTransfer, readOnlyMessage, shotUrls } from './sheet.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const COLOR_HEX = Object.freeze({ red: '#E5484D', blue: '#1F4FD1', amber: '#D99A0B', green: '#1E9E6A' });
const COLOR_NAME = Object.freeze({ red: '红', blue: '蓝', amber: '黄', green: '绿' });
const KIND_TEXT = Object.freeze({ good: '正例', bad: '反例' });
const TOOLS = Object.freeze([['pin', '编号点'], ['rect', '框'], ['arrow', '箭头'], ['hline', '水平线']]);
const MOUSE_HINT = '现在是鼠标：点图上已有的批注选中它，可以拖动、改大小。要画新的，先点上面的工具；再点一下那个工具就回到鼠标。';
const TOOL_HINT = Object.freeze({
  pin: '点空白处放一个编号点，说明栏里会多一条对应的说明。',
  rect: '在空白处按住拖出一个框，圈出关键区域。',
  arrow: '在空白处按住从起点拖到终点。',
  hline: '在价位上点一下画一条水平线。',
});
const MARK_NAME = Object.freeze({ pin: '编号点', rect: '框', arrow: '箭头', hline: '水平线' });
const ICON = Object.freeze({
  pin: 'M8 1.5a4.5 4.5 0 0 1 4.5 4.5c0 3.4-4.5 8.5-4.5 8.5S3.5 9.4 3.5 6A4.5 4.5 0 0 1 8 1.5z',
  rect: 'M2 3.5h12v9H2z',
  arrow: 'M2.5 13.5L13 3M7 3h6v6',
  hline: 'M1 8h14',
  select: 'M3 2l9 6-4 1 2.5 5-1.8.8L6.2 10 3 13z',
});
const TF_OPTIONS = Object.freeze(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);
const SOURCE_OPTIONS = Object.freeze(['自己的交易', '课程笔记', '书', '视频']);
// 主题的识别色，按主题顺序轮流用；不用蓝和橙（网站里蓝橙代表赚和亏）
const TOPIC_COLORS = Object.freeze(['#127C74', '#6046B8', '#9A6A12', '#A83A5E', '#55761F', '#3D6A8F']);
const LOOSE_COLOR = '#5E6A85';
const AUTO_ITEM = '未分类'; // 主题下还没有知识点时新建学习卡，自动建的知识点叫这个
const FOLD_MAX = 1000;

// ---------- 小工具 ----------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(cls, text, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

function sv(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
  return node;
}

function icon(d, box = 16) {
  const s = sv('svg', { viewBox: `0 0 ${box} ${box}`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  s.appendChild(sv('path', { d }));
  return s;
}

function panelIcon() {
  const s = sv('svg', { viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  s.appendChild(sv('rect', { x: 2, y: 3, width: 14, height: 12, rx: 1.5 }));
  s.appendChild(sv('path', { d: 'M7 3v12M3.8 6.5h1.6M3.8 9h1.6M3.8 11.5h1.6' }));
  return s;
}

const caretIcon = () => icon('M4.5 6.5L8 10l3.5-3.5');
const isTyping = (node) => !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);

/**
 * 把批注画进一个 viewBox 为 1000×562 的 svg。
 * opts.edit（编辑框里）：细线外面加一圈看不见的感应区（data-band，好点中），选中的那个（selected 是下标）
 * 画虚线外框和拖动用的小方块（data-h）。
 */
export function drawMarks(svg, marks, selected = -1, opts = {}) {
  const edit = !!opts.edit;
  svg.textContent = '';
  (marks || []).forEach((m, i) => {
    const col = COLOR_HEX[m.c] || COLOR_HEX.red;
    const s = typeof m.s === 'number' && m.s > 0 ? m.s : 1;
    const dash = isDashed(m) ? { 'stroke-dasharray': `${10 * s} ${6 * s}` } : {};
    const g = sv('g', { 'data-i': i });
    if (m.t === 'rect') {
      g.appendChild(sv('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: col, 'fill-opacity': 0.14, stroke: col, 'stroke-width': 2.5 * s, 'vector-effect': 'non-scaling-stroke', ...dash }));
    } else if (m.t === 'arrow') {
      const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      const L = 22 * s;
      if (edit) g.appendChild(sv('line', { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, stroke: 'transparent', 'stroke-width': 22, 'data-band': '' }));
      g.appendChild(sv('line', { x1: m.x1, y1: m.y1, x2: m.x2 - Math.cos(a) * L * 0.5, y2: m.y2 - Math.sin(a) * L * 0.5, stroke: col, 'stroke-width': 4 * s, 'stroke-linecap': dash['stroke-dasharray'] ? 'butt' : 'round', ...dash }));
      const p = [[m.x2, m.y2], [m.x2 - L * Math.cos(a - 0.45), m.y2 - L * Math.sin(a - 0.45)], [m.x2 - L * Math.cos(a + 0.45), m.y2 - L * Math.sin(a + 0.45)]];
      g.appendChild(sv('polygon', { points: p.map((q) => q.join(',')).join(' '), fill: col }));
    } else if (m.t === 'hline') {
      if (edit) g.appendChild(sv('line', { x1: 0, y1: m.y, x2: MARK_W, y2: m.y, stroke: 'transparent', 'stroke-width': 18, 'data-band': '' }));
      g.appendChild(sv('line', { x1: 0, y1: m.y, x2: MARK_W, y2: m.y, stroke: col, 'stroke-width': 2.5 * s, 'vector-effect': 'non-scaling-stroke', ...dash }));
      if (m.label) {
        const t = sv('text', { x: MARK_W - 12, y: m.y - 8 * s, 'text-anchor': 'end', 'font-size': 24 * s, 'font-weight': 600, fill: col, 'paint-order': 'stroke', stroke: '#FFFFFF', 'stroke-width': 5 });
        t.textContent = m.label;
        g.appendChild(t);
      }
    } else if (m.t === 'pin') {
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: 23 * s, fill: col, stroke: '#FFFFFF', 'stroke-width': 4 }));
      const t = sv('text', { x: m.x, y: m.y + 9 * s, 'text-anchor': 'middle', 'font-size': 26 * s, 'font-weight': 700, fill: '#FFFFFF', 'pointer-events': 'none' });
      t.textContent = String(m.n);
      g.appendChild(t);
    }
    svg.appendChild(g);
  });
  const m = edit ? (marks || [])[selected] : null;
  if (!m) return;
  const s = typeof m.s === 'number' && m.s > 0 ? m.s : 1;
  const SEL = '#1F4FD1';
  const box = (x, y, w, h) => svg.appendChild(sv('rect', { x, y, width: w, height: h, fill: 'none', stroke: SEL, 'stroke-width': 1.5, 'stroke-dasharray': '6 4', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }));
  const handle = (x, y, k, cursor) => svg.appendChild(sv('rect', { x: x - 9, y: y - 9, width: 18, height: 18, fill: '#FFFFFF', stroke: SEL, 'stroke-width': 2.5, 'data-h': k, style: 'cursor:' + cursor }));
  if (m.t === 'rect') {
    box(m.x - 6, m.y - 6, m.w + 12, m.h + 12);
    handle(m.x, m.y, 'nw', 'nwse-resize');
    handle(m.x + m.w, m.y, 'ne', 'nesw-resize');
    handle(m.x, m.y + m.h, 'sw', 'nesw-resize');
    handle(m.x + m.w, m.y + m.h, 'se', 'nwse-resize');
  } else if (m.t === 'arrow') {
    handle(m.x1, m.y1, 'p1', 'grab');
    handle(m.x2, m.y2, 'p2', 'grab');
  } else if (m.t === 'pin') {
    const r = 23 * s + 8;
    box(m.x - r, m.y - r, 2 * r, 2 * r);
    handle(m.x + r, m.y + r, 'size', 'nwse-resize');
  } else if (m.t === 'hline') {
    box(0, m.y - 12 * s, MARK_W, 24 * s);
    handle(MARK_W - 14, m.y, 'y', 'ns-resize');
  }
}

function marksSvg(marks, selected, edit = false) {
  const svg = sv('svg', { viewBox: `0 0 ${MARK_W} ${MARK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  drawMarks(svg, marks, selected, { edit });
  return svg;
}

/** 编号点的颜色（在卡片的哪张图上都找） */
const pinColor = (card, n) => {
  const all = [card.marks || [], ...cardPages(card).slice(1).map((p) => p.marks)].flat();
  const p = all.find((m) => m.t === 'pin' && m.n === n);
  return COLOR_HEX[p ? p.c : 'red'];
};

/** 编号 → 在第几张图上（从 0 数）；说明分组用 */
export function pinPages(card) {
  const out = new Map();
  cardPages(card).forEach((p, i) => { for (const m of p.marks) if (m.t === 'pin') out.set(m.n, i); });
  return out;
}

/** 第 i 张图叫什么：有标签用标签，没有就「第 n 张」 */
export const pageName = (page, i) => (page && page.img && page.img.label) || `第 ${i + 1} 张`;

// ---------- 挂载 ----------

/**
 * @param {HTMLElement} root  #page-study
 * @param {ReturnType<import('../state.js').createStore>} store
 * @param {{shots?: {addStudyImage?: Function, urlCache?: object}, openTrade?: (id: string) => void,
 *   fold?: {load: () => Promise<any>, save: (keys: string[]) => Promise<any>}}} [opts]
 */
export function mountStudy(root, store, opts = {}) {
  const shots = opts.shots || {};
  const urls = shotUrls(shots.urlCache);
  const openTrade = typeof opts.openTrade === 'function' ? opts.openTrade : null;
  const foldStore = opts.fold && typeof opts.fold.load === 'function' && typeof opts.fold.save === 'function' ? opts.fold : null;

  /** 界面状态（不进数据） */
  const view = {
    scope: 'all', // 'all' | 'loose'（未归类） | 主题 id | 知识点 id
    mode: 'wall', // 'wall' | 'cols' | 'compare'
    q: '',
    symbol: '',
    kind: '',
    compare: new Set(),
    shown: new Map(), // 卡片 id → 墙上翻到了第几张图（没翻过就显示封面）
    sideOpen: true,
    folded: new Set(),
    shut: new Set(), // 墙上收起来的知识点 id（未归类是 'loose'）
    adding: null, // 'topic' | 主题 id（正在这个主题下加知识点）
    editingNote: null, // 正在改要点的知识点 id
    renaming: null, // 正在改名的主题或知识点 id；墙上标题里改名的是 'wall:' + id
  };
  let visible = false;
  let stale = true; // 数据变了还没重画
  let held = []; // 这一次画面要过的图片路径（下次重画后放掉）

  root.textContent = '';
  root.classList.add('study-page');

  const st = () => store.get().journal.study || { topics: [], cards: [] };
  const canEdit = () => store.canEdit();
  const tradeNo = (tradeId) => {
    const it = tradeId ? store.get().derived.tradeById.get(tradeId) : null;
    return it ? it.no : null;
  };
  const readOnlyHint = () => {
    const ui = store.get().ui;
    showToast(readOnlyMessage(ui.readOnly) || '现在只能看、不能改');
  };

  // ---------- 图片 ----------
  /** 一个 16:9 的图框：卡片第 page 张图（异步取地址）+ 这张图的批注。没有图时显示"还没放图"。extra 是叠在图上的东西 */
  function shotBox(card, { full = false, selected = -1, extra = null, page = 0, edit = false } = {}) {
    const box = el('div', 'st-shot');
    const pg = cardPages(card)[page] || null;
    const img = pg ? pg.img : null;
    const path = img ? (full ? img.file : img.thumb || img.file) : null;
    if (path && urls) {
      const pic = el('img');
      pic.alt = (card.title || '学习卡') + '的图';
      pic.decoding = 'async';
      box.appendChild(pic);
      held.push(path);
      urls.acquire(path).then((u) => {
        if (u) pic.src = u;
        else { pic.remove(); box.insertBefore(el('span', 'st-shot-note', '图片文件不在本机'), box.firstChild); }
      }, () => { pic.remove(); box.insertBefore(el('span', 'st-shot-note', '图片读不出来'), box.firstChild); });
    } else {
      box.classList.add('empty');
      box.appendChild(el('span', 'st-shot-note', '还没放图'));
    }
    box.appendChild(marksSvg(pg ? pg.marks : card.marks, selected, edit));
    for (const x of [].concat(extra || [])) if (x) box.appendChild(x);
    return box;
  }

  function releaseHeld(list) {
    if (!urls) return;
    for (const p of list) urls.release(p);
  }

  // ---------- 查询 ----------
  function itemsInScope() {
    const s = st();
    const out = [];
    for (const topic of s.topics) {
      if (view.scope !== 'all' && view.scope !== topic.id && !topic.items.some((it) => it.id === view.scope)) continue;
      for (const item of topic.items) {
        if (view.scope === item.id || view.scope === topic.id || view.scope === 'all') out.push({ topic, item });
      }
    }
    return out;
  }
  const isLoose = (c) => !c.item || !findItem(st(), c.item);
  function matches(c) {
    if (view.symbol && c.symbol !== view.symbol) return false;
    if (view.kind && c.kind !== view.kind) return false;
    const q = view.q.trim().toLowerCase();
    if (!q) return true;
    const where = findItem(st(), c.item);
    return [c.title, c.take, c.memo || '', c.symbol, c.tf, c.source, where ? where.item.name : '', where ? where.item.note : '', where ? where.topic.name : '', ...c.notes.map((n) => n.text)]
      .join(' ').toLowerCase().includes(q);
  }
  const countItem = (id) => st().cards.filter((c) => c.item === id).length;
  const countTopic = (t) => t.items.reduce((n, it) => n + countItem(it.id), 0);
  const looseCount = () => st().cards.filter(isLoose).length;
  const topicColor = (topic) => {
    const i = st().topics.findIndex((t) => t.id === topic.id);
    return i < 0 ? LOOSE_COLOR : TOPIC_COLORS[i % TOPIC_COLORS.length];
  };
  function swatch(color) {
    const sw = el('i', 'st-sw');
    sw.style.background = color;
    sw.setAttribute('aria-hidden', 'true');
    return sw;
  }

  // ---------- 收起 ----------
  /** 墙上这一页能收起的块：知识点 id，未归类是 'loose' */
  function foldKeys() {
    if (view.scope === 'loose') return ['loose'];
    const keys = itemsInScope().map((x) => x.item.id);
    if (view.scope === 'all' && looseCount()) keys.push('loose');
    return keys;
  }
  /** 收起状态存到本机（只读的标签页存不进去，这次照样生效） */
  function saveFold() {
    if (!foldStore) return;
    const keys = Array.from(view.shut).slice(-FOLD_MAX);
    Promise.resolve().then(() => foldStore.save(keys)).catch(() => {});
  }
  function toggleFold(key) {
    if (view.shut.has(key)) view.shut.delete(key); else view.shut.add(key);
    saveFold();
    render();
    const f = document.getElementById('st-fold-' + key);
    if (f) f.focus({ preventScroll: true });
  }

  // ---------- 画整页 ----------
  function render() {
    if (!visible) { stale = true; return; }
    stale = false;
    const before = held;
    held = [];
    const keepFocus = document.activeElement && root.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null;
    const caret = keepFocus && document.activeElement.selectionStart !== undefined ? document.activeElement.selectionStart : null;
    const scrollY = window.scrollY;
    root.textContent = '';
    const s = st();
    if (view.scope !== 'all' && view.scope !== 'loose' && !s.topics.some((t) => t.id === view.scope || t.items.some((it) => it.id === view.scope))) view.scope = 'all';
    const layout = el('div', 'st-layout' + (view.sideOpen ? '' : ' closed'));
    if (view.sideOpen) layout.appendChild(sideEl());
    const content = el('div', 'st-content');
    layout.appendChild(content);
    root.appendChild(layout);
    content.appendChild(phoneChips());
    content.appendChild(headEl());
    content.appendChild(barEl());
    if (!s.topics.length && !s.cards.length) content.appendChild(welcomeEl());
    else if (view.mode === 'wall') wallEl(content);
    else if (view.mode === 'cols') content.appendChild(colsEl());
    else content.appendChild(compareEl());
    releaseHeld(before);
    if (keepFocus) {
      const f = document.getElementById(keepFocus);
      if (f) {
        f.focus({ preventScroll: true });
        if (caret !== null && typeof f.setSelectionRange === 'function' && f.type !== 'select-one') { try { f.setSelectionRange(caret, caret); } catch (e) { /* 有的输入框不支持 */ } }
      }
    }
    window.scrollTo(window.scrollX, scrollY);
  }

  function pick(scope) {
    view.scope = scope;
    view.adding = null;
    view.renaming = null;
    render();
  }

  // ---------- 左边目录 ----------
  function sideToggle(open) {
    const label = open ? '收起目录' : '展开目录';
    const b = button('st-side-btn', null, label);
    b.id = open ? 'st-side-close' : 'st-side-open';
    b.title = label;
    b.setAttribute('aria-expanded', String(open));
    b.appendChild(panelIcon());
    b.addEventListener('click', () => {
      view.sideOpen = !open;
      render();
      const t = document.getElementById(open ? 'st-side-open' : 'st-side-close');
      if (t) t.focus();
    });
    return b;
  }

  function navBtn(cls, text, count, current, onClick, color) {
    const b = button(cls);
    if (color) b.appendChild(swatch(color));
    b.appendChild(el('span', 'st-nav-name', text));
    b.appendChild(el('span', 'st-n', String(count)));
    b.setAttribute('aria-current', current ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  function sideEl() {
    const s = st();
    const side = el('nav', 'st-side');
    side.setAttribute('aria-label', '学习目录');
    const head = el('div', 'st-side-head');
    head.appendChild(el('span', null, '目录'));
    head.appendChild(sideToggle(true));
    side.appendChild(head);
    side.appendChild(navBtn('st-all', '全部', s.cards.length, view.scope === 'all', () => pick('all')));
    for (const topic of s.topics) {
      const open = !view.folded.has(topic.id);
      const row = el('div', 'st-topic-row');
      const caret = button('st-caret', null, (open ? '折叠' : '展开') + topic.name);
      caret.id = 'st-caret-' + topic.id;
      caret.setAttribute('aria-expanded', String(open));
      caret.appendChild(caretIcon());
      caret.addEventListener('click', () => {
        if (open) view.folded.add(topic.id); else view.folded.delete(topic.id);
        render();
        const c = document.getElementById('st-caret-' + topic.id);
        if (c) c.focus();
      });
      row.appendChild(caret);
      row.appendChild(navBtn('st-topic', topic.name, countTopic(topic), view.scope === topic.id, () => pick(topic.id), topicColor(topic)));
      side.appendChild(row);
      if (!open) continue;
      for (const item of topic.items) side.appendChild(navBtn('st-item', item.name, countItem(item.id), view.scope === item.id, () => pick(item.id)));
      if (view.adding === topic.id) side.appendChild(addInput('item', topic));
      else if (canEdit()) {
        const add = button('st-add', '＋ 知识点');
        add.addEventListener('click', () => { view.adding = topic.id; render(); focusId('st-add-input'); });
        side.appendChild(add);
      }
    }
    const loose = looseCount();
    if (loose) side.appendChild(navBtn('st-all st-loose', '未归类', loose, view.scope === 'loose', () => pick('loose')));
    if (view.adding === 'topic') side.appendChild(addInput('topic'));
    else if (canEdit()) {
      const add = button('st-add big', '＋ 新建主题');
      add.addEventListener('click', () => { view.adding = 'topic'; render(); focusId('st-add-input'); });
      side.appendChild(add);
    }
    return side;
  }

  function focusId(id) {
    const n = document.getElementById(id);
    if (n) n.focus();
  }

  function addInput(kind, topic) {
    const inp = el('input', 'st-add-input' + (kind === 'topic' ? ' big' : ''));
    inp.id = 'st-add-input';
    inp.placeholder = kind === 'topic' ? '主题名字，回车添加' : '知识点名字，回车添加';
    inp.maxLength = SHORT_MAX;
    inp.setAttribute('aria-label', inp.placeholder);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      view.adding = null;
      const name = inp.value.trim();
      if (save && name) {
        if (kind === 'topic') {
          const id = store.actions.addTopic(name);
          if (id) { view.scope = id; showToast(`加了主题「${name}」，接着点「＋ 知识点」`); }
        } else {
          const id = store.actions.addItem(topic.id, name);
          if (id) view.scope = id;
        }
      }
      render();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    return inp;
  }

  /** 手机上：目录换成两排横着滑的按钮 */
  function phoneChips() {
    const s = st();
    const wrap = el('div', 'st-phone-nav');
    const row1 = el('div', 'st-chips');
    const chip = (text, current, onClick, color) => {
      const b = button('st-chip');
      if (color) b.appendChild(swatch(color));
      b.appendChild(document.createTextNode(text));
      b.setAttribute('aria-pressed', String(current));
      b.addEventListener('click', onClick);
      return b;
    };
    const curTopic = s.topics.find((t) => t.id === view.scope || t.items.some((it) => it.id === view.scope));
    row1.appendChild(chip('全部', view.scope === 'all', () => pick('all')));
    for (const t of s.topics) row1.appendChild(chip(t.name, curTopic === t, () => pick(t.id), topicColor(t)));
    if (looseCount()) row1.appendChild(chip('未归类', view.scope === 'loose', () => pick('loose')));
    wrap.appendChild(row1);
    if (curTopic && curTopic.items.length) {
      const row2 = el('div', 'st-chips');
      row2.appendChild(chip('全部', view.scope === curTopic.id, () => pick(curTopic.id)));
      for (const it of curTopic.items) row2.appendChild(chip(it.name, view.scope === it.id, () => pick(it.id)));
      wrap.appendChild(row2);
    }
    return wrap;
  }

  // ---------- 标题行：当前看的是什么，改名、删除 ----------
  function headEl() {
    const s = st();
    const row = el('div', 'st-head');
    const head = el('div', 'st-head-l');
    row.appendChild(head);
    if (!view.sideOpen) head.appendChild(sideToggle(false));
    const topic = s.topics.find((t) => t.id === view.scope);
    const where = findItem(s, view.scope);
    let titleText = '全部';
    let target = null; // { kind: 'topic'|'item', id, name }
    if (view.scope === 'loose') titleText = '未归类';
    else if (topic) { titleText = topic.name; target = { kind: 'topic', id: topic.id, name: topic.name }; }
    else if (where) target = { kind: 'item', id: where.item.id, name: where.item.name };
    if (where) {
      head.appendChild(el('span', 'st-crumb-topic', where.topic.name + ' ›'));
      titleText = where.item.name;
    }
    if (target && view.renaming === target.id) {
      head.appendChild(renameInput(target));
    } else {
      head.appendChild(el('h2', 'st-title', titleText));
    }
    const subs = itemsInScope();
    const cards = cardsInScope();
    const count = view.scope === 'loose' ? `${cards.length} 张卡` : `${target && target.kind === 'item' ? '' : subs.length + ' 个知识点 · '}${cards.length} 张卡`;
    head.appendChild(el('span', 'st-head-meta', count));
    if (target && canEdit() && view.renaming !== target.id) {
      const ren = button('btn link st-mini', '改名');
      ren.addEventListener('click', () => { view.renaming = target.id; render(); });
      const del = button('btn link st-mini', '删除');
      del.addEventListener('click', () => deleteTarget(target));
      head.appendChild(ren);
      head.appendChild(del);
    }
    if (canEdit()) {
      const add = button('btn primary st-new', '＋ 新建学习卡');
      add.addEventListener('click', () => newCard());
      row.appendChild(add);
    }
    return row;
  }

  /** 墙上主题、知识点标题旁边的「改名」「删除」；只读时不显示 */
  function manageEl(target) {
    const box = el('span', 'st-manage');
    if (!canEdit()) return box;
    const what = target.kind === 'topic' ? '主题' : '';
    const ren = button('btn link st-mini', '改名', `给${what}「${target.name}」改名`);
    ren.addEventListener('click', (e) => { e.stopPropagation(); view.renaming = 'wall:' + target.id; render(); });
    const del = button('btn link st-mini', '删除', `删除${what}「${target.name}」`);
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTarget(target); });
    box.appendChild(ren);
    box.appendChild(del);
    return box;
  }

  /** 改名输入框：回车或点别处保存，Esc 取消 */
  function renameInput(target, cls = 'st-rename') {
    const inp = el('input', cls);
    inp.id = 'st-rename';
    inp.value = target.name;
    inp.maxLength = SHORT_MAX;
    inp.setAttribute('aria-label', '新名字，回车保存');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      view.renaming = null;
      if (save) {
        if (target.kind === 'topic') store.actions.renameTopic(target.id, inp.value);
        else store.actions.updateItem(target.id, { name: inp.value });
      }
      render();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', (e) => e.stopPropagation()); // 墙上的知识点标题：点输入框别收起
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    return inp;
  }

  async function deleteTarget(target) {
    if (!canEdit()) { readOnlyHint(); return; }
    const s = st();
    let n = 0;
    let items = 0;
    if (target.kind === 'topic') {
      const tp = s.topics.find((t) => t.id === target.id);
      items = tp ? tp.items.length : 0;
      n = tp ? countTopic(tp) : 0;
    } else n = countItem(target.id);
    const what = target.kind === 'topic' ? `主题「${target.name}」` : `知识点「${target.name}」`;
    const parts = [];
    if (items) parts.push(`${items} 个知识点`);
    if (n) parts.push(`${n} 张学习卡`);
    const ok = await confirmDialog({
      title: `删除${what}？`,
      message: (parts.length ? `下面的 ${parts.join('、')}会一起删掉。` : '') + '删除后 10 秒内可以撤销。',
      confirmText: '删除',
      danger: true,
      initialFocus: 'cancel',
    });
    if (!ok) return;
    const undo = target.kind === 'topic' ? store.actions.deleteTopic(target.id) : store.actions.deleteItem(target.id);
    if (!undo) return;
    const s2 = st(); // 删的是正在看的（或它所在的主题）才回到「全部」；在墙上删别的，留在原地
    if (view.scope !== 'all' && view.scope !== 'loose' && !s2.topics.some((t) => t.id === view.scope) && !findItem(s2, view.scope)) view.scope = 'all';
    render();
    showToast(`已删除${what}`, { undo });
  }

  function cardsInScope() {
    const s = st();
    if (view.scope === 'all') return s.cards.filter(matches);
    if (view.scope === 'loose') return s.cards.filter((c) => isLoose(c) && matches(c));
    const ids = new Set(itemsInScope().map((x) => x.item.id));
    return s.cards.filter((c) => ids.has(c.item) && matches(c));
  }

  // ---------- 工具条 ----------
  function barEl() {
    const bar = el('div', 'st-tb');
    const seg = el('div', 'st-views');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', '看法');
    for (const [m, t] of [['wall', '墙'], ['cols', '分栏'], ['compare', `对比（${view.compare.size}）`]]) {
      const b = button(null, t);
      b.setAttribute('aria-pressed', String(view.mode === m));
      b.addEventListener('click', () => { view.mode = m; render(); });
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    const search = el('input', 'st-search');
    search.id = 'st-search';
    search.type = 'search';
    search.placeholder = '搜标题、要点、结论、说明…';
    search.value = view.q;
    search.setAttribute('aria-label', '搜索学习卡');
    search.addEventListener('input', () => { view.q = search.value; render(); });
    bar.appendChild(search);
    const symbols = Array.from(new Set(st().cards.map((c) => c.symbol).filter(Boolean))).sort();
    const sym = el('select', 'st-select');
    sym.id = 'st-sym';
    sym.setAttribute('aria-label', '品种');
    for (const [v, t] of [['', '全部品种'], ...symbols.map((x) => [x, x])]) {
      const o = el('option', null, t);
      o.value = v;
      o.selected = view.symbol === v;
      sym.appendChild(o);
    }
    sym.addEventListener('change', () => { view.symbol = sym.value; render(); });
    bar.appendChild(sym);
    const kind = el('select', 'st-select');
    kind.id = 'st-kind';
    kind.setAttribute('aria-label', '正例或反例');
    for (const [v, t] of [['', '正例和反例'], ['good', '只看正例'], ['bad', '只看反例']]) {
      const o = el('option', null, t);
      o.value = v;
      o.selected = view.kind === v;
      kind.appendChild(o);
    }
    kind.addEventListener('change', () => { view.kind = kind.value; render(); });
    bar.appendChild(kind);
    const keys = view.mode === 'wall' ? foldKeys() : [];
    if (keys.length) {
      const allShut = keys.every((k) => view.shut.has(k));
      const fa = button('st-foldall' + (allShut ? '' : ' up'));
      fa.id = 'st-foldall';
      fa.appendChild(caretIcon());
      fa.appendChild(el('span', null, allShut ? '全部展开' : '全部收起'));
      fa.addEventListener('click', () => {
        for (const k of keys) { if (allShut) view.shut.delete(k); else view.shut.add(k); }
        saveFold();
        render();
      });
      bar.appendChild(fa);
    }
    return bar;
  }

  function welcomeEl() {
    const box = el('div', 'st-welcome');
    box.appendChild(el('h3', null, '先建一个主题'));
    box.appendChild(el('p', null, '主题是一门功课，比如「价格行为」；主题下面加知识点，比如「双底 / 双顶」，每个知识点顶上可以写要点。'));
    box.appendChild(el('p', null, '然后点「＋ 新建学习卡」放图、在图上画批注、写结论；复盘里每张截图下面也能「收进学习」。'));
    if (canEdit()) {
      const b = button('btn primary', '＋ 新建主题');
      b.addEventListener('click', () => { view.adding = 'topic'; view.sideOpen = true; render(); focusId('st-add-input'); });
      box.appendChild(b);
    }
    return box;
  }

  // ---------- 卡片 ----------
  function cardEl(card, { compact = false, big = false } = {}) {
    const art = el('article', 'st-card' + (compact ? ' compact' : ''));
    art.dataset.id = card.id;
    art.tabIndex = 0;
    art.setAttribute('aria-label', `${card.title || '没写标题的学习卡'}，按回车编辑`);
    let cmp = null;
    if (!big) {
      cmp = el('label', 'st-cmp');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = view.compare.has(card.id);
      if (box.checked) cmp.classList.add('on');
      box.setAttribute('aria-label', '加入对比');
      box.addEventListener('change', () => {
        if (box.checked && view.compare.size >= 4) { box.checked = false; showToast('最多同时对比 4 张'); return; }
        if (box.checked) view.compare.add(card.id); else view.compare.delete(card.id);
        render();
      });
      cmp.appendChild(box);
      cmp.appendChild(document.createTextNode('对比'));
      cmp.addEventListener('click', (e) => e.stopPropagation());
    }
    // 好几张图：卡片上只放一张大图，右下角 1/3；鼠标移到图上左右出现 ‹ › 翻页（只换这张卡显示哪张，不进数据）
    const pages = cardPages(card);
    let k = view.shown.has(card.id) ? view.shown.get(card.id) : coverIndex(card);
    if (!(k >= 0 && k < pages.length)) k = coverIndex(card);
    const extra = [cmp];
    if (pages.length > 1) {
      if (big && pages[k].img.label) extra.push(el('span', 'st-cap', pages[k].img.label)); // 对比里才写标签；没起标签不写「第 n 张」
      extra.push(el('span', 'st-pgn', `${k + 1}/${pages.length}`));
      for (const [d, cls, text, label] of [[-1, 'prev', '‹', '上一张图'], [1, 'next', '›', '下一张图']]) {
        const b = button('st-flip ' + cls, text, label);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          view.shown.set(card.id, (k + d + pages.length) % pages.length);
          const next = cardEl(card, { compact, big });
          art.replaceWith(next);
          const again = next.querySelector('.st-flip.' + cls);
          if (again) again.focus({ preventScroll: true });
        });
        extra.push(b);
      }
    }
    art.appendChild(shotBox(card, { full: big, extra, page: k }));
    // 墙和分栏上的卡片只放 图 + 标题 + 结论，别的（正例/反例、知识点、品种周期、编号说明）点进去才看到；
    // 对比（big）是拿来逐条比的，照旧全显示
    const body = el('div', 'st-card-body');
    const tr = el('div', 'st-card-title');
    tr.appendChild(el('h3', null, card.title || '（还没写标题）'));
    if (big) tr.appendChild(el('span', 'st-kind ' + card.kind, KIND_TEXT[card.kind] || ''));
    body.appendChild(tr);
    if (!big) {
      if (card.take) body.appendChild(el('p', 'st-take', card.take));
      art.appendChild(body);
      art.addEventListener('click', () => openCard(card.id));
      art.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === art) openCard(card.id); });
      return art;
    }
    const tags = el('div', 'st-tags');
    const where = findItem(st(), card.item);
    if (where) tags.appendChild(el('b', null, where.item.name));
    for (const x of [card.symbol, card.tf, card.source]) if (x) tags.appendChild(el('span', null, x));
    const no = tradeNo(card.trade);
    if (no && openTrade) {
      const link = button('st-trade-link', `第 ${no} 笔`, `去复盘看第 ${no} 笔`);
      link.addEventListener('click', (e) => { e.stopPropagation(); openTrade(card.trade); });
      tags.appendChild(link);
    }
    if (tags.childNodes.length) body.appendChild(tags);
    if (card.take) body.appendChild(el('p', 'st-take', card.take));
    if (card.memo) body.appendChild(el('p', 'st-memo', card.memo));
    const notes = card.notes.filter((n) => n.text);
    if (notes.length) {
      const ol = el('ol', 'st-notes');
      const pinAt = pinPages(card);
      let lastPage = -1;
      for (const n of notes) {
        const pi = pinAt.has(n.n) ? pinAt.get(n.n) : -1;
        if (pages.length > 1 && pi !== lastPage && pi >= 0) {
          ol.appendChild(el('li', 'st-notes-grp', pageName(pages[pi], pi)));
          lastPage = pi;
        }
        const li = el('li');
        const dot = el('span', 'st-dot', String(n.n));
        dot.style.background = pinColor(card, n.n);
        li.appendChild(dot);
        li.appendChild(el('span', null, n.text));
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }
    art.appendChild(body);
    art.addEventListener('click', () => openCard(card.id));
    art.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === art) openCard(card.id); });
    return art;
  }

  /** 知识点名字下面的要点；「改要点」点了就地改 */
  function pointsEl(item) {
    const box = el('div', 'st-kp-pt');
    if (view.editingNote === item.id) {
      const ta = el('textarea');
      ta.id = 'st-note-' + item.id;
      ta.rows = 2;
      ta.maxLength = LONG_MAX;
      ta.value = item.note;
      ta.placeholder = '这个知识点的规则，几句话就行';
      ta.setAttribute('aria-label', `「${item.name}」的要点，回车保存`);
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        view.editingNote = null;
        if (save) store.actions.updateItem(item.id, { note: ta.value.trim() });
        render();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      ta.addEventListener('blur', () => finish(true));
      box.appendChild(ta);
      setTimeout(() => ta.focus(), 0);
    } else {
      box.appendChild(el('span', item.note ? null : 'st-muted', item.note || '还没写要点。'));
      if (canEdit()) {
        const b = button('btn link st-mini', '改要点', `改「${item.name}」的要点`);
        b.addEventListener('click', () => { view.editingNote = item.id; render(); });
        box.appendChild(b);
      }
    }
    return box;
  }

  /** 墙：「全部」按主题分组；每个知识点一块，收起的并排成小方块，展开的占满一行 */
  function wallEl(content) {
    const s = st();
    const topic = s.topics.find((t) => t.id === view.scope);
    if (topic && !topic.items.length) {
      const box = el('div', 'st-empty');
      box.appendChild(el('b', null, `「${topic.name}」下面还没有知识点`));
      if (canEdit()) box.appendChild(el('span', null, `直接点右上角「＋ 新建学习卡」，卡会先放进自动建的「${AUTO_ITEM}」，以后再挪；也可以点「＋ 知识点」自己起名。`));
      content.appendChild(box);
      return;
    }
    const shown = cardsInScope();
    const narrow = !!(view.q.trim() || view.symbol || view.kind); // 搜索、筛选时没有符合的知识点就不显示
    const listOf = (id) => shown.filter((c) => c.item === id);
    const groups = el('div', 'st-groups');
    const topicHead = (color, name, meta, t) => {
      const h = el('div', 'st-tp-head');
      h.appendChild(swatch(color));
      const target = t ? { kind: 'topic', id: t.id, name: t.name } : null;
      if (target && view.renaming === 'wall:' + t.id) h.appendChild(renameInput(target, 'st-rename st-wall-rename'));
      else h.appendChild(el('h3', null, name));
      h.appendChild(el('span', 'st-tp-meta', meta));
      if (target && view.renaming !== 'wall:' + t.id) h.appendChild(manageEl(target));
      return h;
    };
    if (view.scope === 'all') {
      for (const t of s.topics) {
        const items = t.items.filter((it) => !narrow || listOf(it.id).length);
        if (narrow && !items.length) continue;
        const sec = el('section', 'st-tp');
        sec.appendChild(topicHead(topicColor(t), t.name, t.items.length ? `${t.items.length} 个知识点 · ${countTopic(t)} 张` : '还没有知识点', t));
        if (items.length) {
          const grid = el('div', 'st-kps');
          for (const it of items) grid.appendChild(kpEl(it.id, it, listOf(it.id)));
          sec.appendChild(grid);
        }
        groups.appendChild(sec);
      }
      const loose = shown.filter(isLoose);
      if (loose.length) {
        const sec = el('section', 'st-tp');
        sec.appendChild(topicHead(LOOSE_COLOR, '未归类', `不属于任何主题 · ${loose.length} 张`));
        const grid = el('div', 'st-kps');
        grid.appendChild(kpEl('loose', null, loose));
        sec.appendChild(grid);
        groups.appendChild(sec);
      }
    } else {
      const grid = el('div', 'st-kps');
      if (view.scope === 'loose') {
        if (!narrow || shown.length) grid.appendChild(kpEl('loose', null, shown));
      } else {
        for (const { item } of itemsInScope()) {
          const list = listOf(item.id);
          if (!narrow || list.length) grid.appendChild(kpEl(item.id, item, list));
        }
      }
      if (grid.firstChild) groups.appendChild(grid);
    }
    if (!groups.firstChild) {
      content.appendChild(el('div', 'st-empty', narrow ? '没有符合条件的学习卡。' : '这里还没有知识点。'));
      return;
    }
    content.appendChild(groups);
  }

  /** 一个知识点（或未归类）：收起时只剩名字、张数和一行卡片标题，点名字展开 */
  function kpEl(key, item, list) {
    const open = !view.shut.has(key);
    const name = item ? item.name : '还没归类的卡';
    const box = el('article', 'st-kp' + (open ? ' open' : ''));
    const head = el('div', 'st-kp-head');
    const fold = button('st-fold', null, `${open ? '收起' : '展开'}「${name}」`);
    fold.id = 'st-fold-' + key;
    fold.setAttribute('aria-expanded', String(open));
    fold.appendChild(caretIcon());
    head.appendChild(fold);
    const target = item ? { kind: 'item', id: item.id, name: item.name } : null;
    if (target && view.renaming === 'wall:' + item.id) head.appendChild(renameInput(target, 'st-rename st-wall-rename'));
    else {
      head.appendChild(el('h4', null, name));
      if (target && view.scope !== item.id) head.appendChild(manageEl(target)); // 点进这个知识点时标题行已经有「改名」「删除」
    }
    head.appendChild(el('span', 'st-kp-n', list.length + ' 张'));
    if (canEdit()) {
      const add = button('st-kp-add', '＋', item ? `在「${item.name}」里新建学习卡` : '新建一张未归类的学习卡');
      add.title = add.getAttribute('aria-label');
      add.addEventListener('click', (e) => { e.stopPropagation(); newCard({ item: item ? item.id : '' }); });
      head.appendChild(add);
    }
    head.addEventListener('click', () => toggleFold(key));
    box.appendChild(head);
    if (!open) {
      const peek = el('div', 'st-kp-peek', list.length ? list.slice(0, 8).map((c) => c.title || '（还没写标题）').join(' · ') : '还没有卡片');
      peek.addEventListener('click', () => toggleFold(key));
      box.appendChild(peek);
      return box;
    }
    box.appendChild(item ? pointsEl(item) : el('div', 'st-kp-pt st-muted', '还没放进任何知识点的卡。'));
    if (list.length) {
      const wall = el('div', 'st-kp-cards');
      for (const c of list) wall.appendChild(cardEl(c));
      box.appendChild(wall);
    } else {
      box.appendChild(el('p', 'st-kp-empty', '还没有卡片。点上面的「＋ 新建学习卡」，或者在复盘的截图下面点「收进学习」。'));
    }
    return box;
  }

  function colsEl() {
    const shown = cardsInScope();
    const wrap = el('div', 'st-cols-wrap');
    wrap.appendChild(el('p', 'st-muted', '一个知识点一栏，左右滑动看完；每栏只显示图、标题和结论，点卡片看全部说明。'));
    const cols = el('div', 'st-cols');
    const groups = view.scope === 'loose' ? [] : itemsInScope().map(({ item }) => ({ name: item.name, note: item.note, list: shown.filter((c) => c.item === item.id) }));
    const loose = shown.filter(isLoose);
    if ((view.scope === 'all' || view.scope === 'loose') && loose.length) groups.push({ name: '未归类', note: '', list: loose });
    for (const g of groups) {
      const col = el('section', 'st-col');
      const h = el('div', 'st-col-head');
      h.appendChild(el('h3', null, g.name));
      h.appendChild(el('span', 'st-count', g.list.length + ' 张'));
      col.appendChild(h);
      if (g.note) col.appendChild(el('p', 'st-col-note', g.note));
      for (const c of g.list) col.appendChild(cardEl(c, { compact: true }));
      cols.appendChild(col);
    }
    if (!groups.length) wrap.appendChild(el('div', 'st-empty', '这里还没有知识点。'));
    wrap.appendChild(cols);
    return wrap;
  }

  function compareEl() {
    const wrap = el('div', 'st-compare-wrap');
    const all = st().cards;
    for (const id of Array.from(view.compare)) if (!all.some((c) => c.id === id)) view.compare.delete(id);
    const picked = all.filter((c) => view.compare.has(c.id));
    if (picked.length < 2) {
      wrap.appendChild(el('div', 'st-empty', '在「墙」或「分栏」里勾选卡片右上角的「对比」，选 2～4 张就会在这里并排显示（可以跨主题）。'));
      return wrap;
    }
    const bar = el('div', 'st-bar');
    bar.appendChild(el('span', 'st-count', `正在对比 ${picked.length} 张`));
    const clear = button('btn small', '清空对比');
    clear.addEventListener('click', () => { view.compare.clear(); render(); });
    bar.appendChild(clear);
    wrap.appendChild(bar);
    const grid = el('div', 'st-compare');
    for (const c of picked) grid.appendChild(cardEl(c, { big: true }));
    wrap.appendChild(grid);
    return wrap;
  }

  // ---------- 新建、打开学习卡 ----------
  /**
   * 默认放进现在看的知识点；看的是主题就放进它的第一个知识点；
   * 这个主题下还没有知识点，就自动建一个「未分类」放进去（made 是主题名，用来提示）
   */
  function defaultItem() {
    const s = st();
    if (findItem(s, view.scope)) return { item: view.scope };
    const tp = s.topics.find((t) => t.id === view.scope);
    if (!tp) return { item: '' };
    if (tp.items.length) return { item: tp.items[0].id };
    const id = store.actions.addItem(tp.id, AUTO_ITEM);
    return { item: id || '', made: id ? tp.name : null };
  }

  function newCard(fields = {}) {
    if (!canEdit()) { readOnlyHint(); return null; }
    const def = fields.item === undefined ? defaultItem() : { item: fields.item };
    const id = store.actions.addCard({ ...fields, item: def.item });
    if (!id) return null;
    if (view.shut.delete(def.item || 'loose')) saveFold(); // 放进收起的那块：自动展开
    view.mode = 'wall';
    render();
    openCard(id);
    if (def.made) showToast(`「${def.made}」还没有知识点，新卡放进了自动建的「${AUTO_ITEM}」`);
    return id;
  }

  // ---------- 编辑框 ----------
  let editor = null;

  function openCard(id) {
    const card = st().cards.find((c) => c.id === id);
    if (!card) return false;
    if (editor) closeEditor();
    editor = createEditor(id);
    return true;
  }

  function closeEditor() {
    if (!editor) return;
    const ed = editor;
    editor = null;
    view.shown.delete(ed.id); // 关掉后墙上回到封面
    ed.destroy();
    render();
    const back = Array.from(root.querySelectorAll('.st-card')).find((n) => n.dataset.id === ed.id);
    if (back) back.focus({ preventScroll: true });
  }

  function createEditor(cardId) {
    // 从墙上点进来：墙上翻到第几张图，就打开第几张
    // 打开时是鼠标（tool 为 null）：点图只选中、拖动，不画；点一下工具开始画，再点一下回到鼠标
    const local = { tool: null, color: 'red', selected: -1, undo: [], busy: false, page: view.shown.has(cardId) ? view.shown.get(cardId) : coverIndex(st().cards.find((c) => c.id === cardId)), target: 0 };
    let edHeld = [];
    const wrap = el('div', 'st-ed-wrap');
    const dlg = el('div', 'st-ed');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', '编辑学习卡');
    wrap.appendChild(dlg);
    document.body.appendChild(wrap);
    const prevFocus = document.activeElement;
    const card = () => st().cards.find((c) => c.id === cardId) || null;
    const editable = () => canEdit();
    const update = (patch) => {
      if (!editable()) { readOnlyHint(); return false; }
      return store.actions.updateCard(cardId, patch);
    };
    /** 正在编辑第几张图（图被删了、挪了以后拉回范围里） */
    const pageAt = (c) => {
      const n = cardPages(c).length;
      if (local.page >= n) local.page = Math.max(0, n - 1);
      return local.page;
    };
    /** 正在编辑的那张图上的批注 */
    const pageMarks = (c) => { const p = cardPages(c)[pageAt(c)]; return p ? p.marks : c.marks; };
    /** 编号点在这张图之前一共有几个（新放的编号点是几号要用） */
    const pinsBefore = (c) => cardPages(c).slice(0, pageAt(c)).reduce((k, p) => k + p.marks.filter((m) => m.t === 'pin').length, 0);

    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (!files.length) return;
      if (local.target === 'new') putImages(files);
      else putImage(files[0], local.target);
    });
    /** 选图片：page 是 'new' 时加在最后（可以多选），是数字时换掉那一张 */
    const pickImage = (page) => { local.target = page; fileInput.multiple = page === 'new'; fileInput.click(); };
    /** 几张图一张一张加在最后（粘贴、拖进来、多选文件） */
    let queue = Promise.resolve();
    const putImages = (blobs) => { for (const b of blobs) queue = queue.then(() => putImage(b, 'new')); return queue; };

    async function putImage(blob, page = 'new') {
      if (!editable()) { readOnlyHint(); return; }
      if (!shots.addStudyImage) { showToast('图片功能没接上'); return; }
      if (local.busy) return;
      const c0 = card();
      const count = c0 ? cardPages(c0).length : 0;
      if (page === 'new' && count >= MAX_PAGES) { showToast(`一张学习卡最多放 ${MAX_PAGES} 张图`); return; }
      local.busy = true;
      paint();
      try {
        await shots.addStudyImage(cardId, blob, { page: count ? page : 0 });
        if (page === 'new' && count) local.page = count; // 加完直接看新加的那张
      } catch (err) {
        showToast('图没放上：' + errorText(err));
      } finally {
        local.busy = false;
        if (editor && editor.id === cardId) paint();
      }
    }

    function snapshot() {
      const c = card();
      if (!c) return;
      local.undo.push(JSON.stringify({ lists: cardPages(c).map((p) => p.marks), notes: c.notes }));
      if (local.undo.length > 50) local.undo.shift();
    }

    /** 几张图（可能换了顺序、改了某张的批注）连同说明一起存 */
    function savePages(pages, notes) {
      const c = card();
      if (!c) return false;
      return update({ ...pagesPatch(pages), notes: notes || c.notes });
    }

    /** 改正在编辑的那张图上的批注 */
    function setMarks(marks, notes, focusSel) {
      const c = card();
      if (!c) return;
      const pages = cardPages(c);
      if (!pages.length) update({ marks, notes: notes || c.notes });
      else {
        pages[pageAt(c)] = { ...pages[pageAt(c)], marks };
        savePages(pages, notes);
      }
      paint(focusSel);
    }

    function deleteSelected() {
      const c = card();
      if (!c || local.selected < 0) return;
      snapshot();
      const marks = pageMarks(c).filter((m, i) => i !== local.selected);
      local.selected = -1;
      setMarks(marks);
    }

    function undoMarks() {
      const s = local.undo.pop();
      if (!s) return;
      const v = JSON.parse(s);
      local.selected = -1;
      const c = card();
      const pages = c ? cardPages(c) : [];
      if (pages.length && pages.length === v.lists.length) savePages(pages.map((p, i) => ({ ...p, marks: v.lists[i] })), v.notes);
      else if (!pages.length) update({ marks: v.lists[0] || [], notes: v.notes });
      paint('#st-ed-undo');
    }

    /** 删掉整张卡里第 n 号编号点（不管在哪张图上）和它的说明 */
    function deletePin(n) {
      const c = card();
      if (!c) return;
      snapshot();
      let k = 0;
      const drop = (marks) => marks.filter((m) => !(m.t === 'pin' && ++k === n));
      const pages = cardPages(c);
      const notes = c.notes.filter((x) => x.n !== n);
      if (!pages.length) update({ marks: drop(c.marks), notes });
      else savePages(pages.map((p) => ({ ...p, marks: drop(p.marks) })), notes);
      paint();
    }

    /** 切到第 i 张图编辑（超出两头就绕回来） */
    function goPage(i, focusSel) {
      const c = card();
      const n = c ? cardPages(c).length : 0;
      if (n < 2) return;
      local.page = ((i % n) + n) % n;
      local.selected = -1;
      local.undo = [];
      paint(focusSel || '#st-pg-' + local.page);
    }

    /** 换图的顺序：第 i 张和第 j 张对调 */
    function movePage(i, j) {
      const c = card();
      if (!c) return;
      const pages = cardPages(c);
      if (j < 0 || j >= pages.length) return;
      [pages[i], pages[j]] = [pages[j], pages[i]];
      local.page = j;
      local.selected = -1;
      local.undo = [];
      savePages(pages);
      paint(j < i ? '#st-pg-left' : '#st-pg-right');
    }

    /** 删掉第 i 张图（连同它上面的批注和编号说明）。和复盘删截图一样：马上删，10 秒内可以撤销 */
    function removePage(i) {
      if (!editable()) { readOnlyHint(); return; }
      const c = card();
      if (!c) return;
      const pages = cardPages(c);
      if (!pages[i]) return;
      const before = { ...pagesPatch(pages), notes: c.notes };
      const name = pageName(pages[i], i);
      pages.splice(i, 1);
      local.selected = -1;
      local.undo = [];
      if (!savePages(pages)) return;
      if (local.page > i || local.page >= pages.length) local.page = Math.max(0, local.page - 1);
      paint();
      showToast(`已删除${name}`, {
        undo: () => {
          if (!store.actions.updateCard(cardId, before)) return false;
          local.page = i;
          local.selected = -1;
          if (editor && editor.id === cardId) paint();
          return true;
        },
      });
    }

    /** 把第 from 张挪到第 to 个位置（拖缩略图） */
    function movePageTo(from, to) {
      const c = card();
      if (!c || from === to) return;
      const pages = cardPages(c);
      if (!pages[from] || to < 0 || to >= pages.length) return;
      const [p] = pages.splice(from, 1);
      pages.splice(to, 0, p);
      local.page = to;
      local.selected = -1;
      local.undo = [];
      savePages(pages);
      paint('#st-pg-' + to);
    }

    /** 缩略图按住拖到别的位置换顺序；只是点一下就切过去编辑那张 */
    function bindReorder(tabs, item, tab, i, count) {
      let d = null;
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || count < 2 || !editable()) return;
        d = { x0: e.clientX, y0: e.clientY, on: false, to: i, id: e.pointerId };
      });
      tab.addEventListener('pointermove', (e) => {
        if (!d || e.pointerId !== d.id) return;
        if (!d.on) {
          if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
          d.on = true;
          try { tab.setPointerCapture(e.pointerId); } catch { /* 没有也能拖 */ }
          item.classList.add('dragging');
        }
        item.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px)`;
        // 落在哪张缩略图上：鼠标在它左半边就插到它前面，右半边插到它后面
        const items = Array.from(tabs.querySelectorAll('.st-page-item'));
        let best = null;
        for (const it of items) {
          if (it === item) continue;
          const r = it.getBoundingClientRect();
          const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
          if (!best || dist < best.dist) best = { it, r, dist };
        }
        for (const it of items) it.classList.remove('ins-before', 'ins-after');
        if (!best) return;
        const k = Number(best.it.dataset.i);
        const after = e.clientX > best.r.left + best.r.width / 2;
        best.it.classList.add(after ? 'ins-after' : 'ins-before');
        let to = after ? k + 1 : k;
        if (to > i) to -= 1;
        d.to = to;
      });
      const end = (e) => {
        if (!d || (e && e.pointerId !== d.id)) return;
        const done = d;
        d = null;
        if (!done.on) return;
        item.classList.remove('dragging');
        item.style.removeProperty('transform');
        for (const it of tabs.querySelectorAll('.st-page-item')) it.classList.remove('ins-before', 'ins-after');
        tab.dataset.dragged = '1'; // 松手后浏览器还会补一个 click，别让它当成"切过去"
        movePageTo(i, done.to);
      };
      tab.addEventListener('pointerup', end);
      tab.addEventListener('pointercancel', end);
    }

    // ---------- 画编辑框 ----------
    function paint(focusSel) {
      const c = card();
      if (!c) { closeEditor(); return; }
      const active = document.activeElement;
      const keep = focusSel || (active && dlg.contains(active) && active.id ? '#' + active.id : null);
      const scrollTop = dlg.scrollTop;
      const before = edHeld;
      edHeld = [];
      const outer = held;
      held = edHeld;
      dlg.textContent = '';
      dlg.appendChild(headEl2(c));
      const body = el('div', 'st-ed-body');
      body.appendChild(leftEl(c));
      body.appendChild(rightEl(c));
      dlg.appendChild(body);
      dlg.appendChild(fileInput);
      held = outer;
      releaseHeld(before);
      dlg.scrollTop = scrollTop;
      const f = keep ? dlg.querySelector(keep) : null;
      if (f) f.focus({ preventScroll: true });
      else if (!dlg.contains(document.activeElement)) {
        const t = dlg.querySelector('#st-ed-title');
        if (t) t.focus({ preventScroll: true });
      }
    }

    function headEl2(c) {
      const head = el('div', 'st-ed-head');
      const title = el('input', 'st-ed-title');
      title.id = 'st-ed-title';
      title.value = c.title;
      title.placeholder = '给这张卡起个标题';
      title.maxLength = SHORT_MAX;
      title.readOnly = !editable();
      title.setAttribute('aria-label', '标题');
      title.addEventListener('input', () => update({ title: title.value }));
      head.appendChild(title);
      if (editable()) {
        const del = button('btn', '删除这张');
        del.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: '删除这张学习卡？', message: '删除后 10 秒内可以撤销。', confirmText: '删除', danger: true, initialFocus: 'cancel' });
          if (!ok) return;
          const undo = store.actions.deleteCard(cardId);
          if (!undo) return;
          view.compare.delete(cardId);
          closeEditor();
          showToast('已删除学习卡', { undo });
        });
        head.appendChild(del);
      }
      const done = button('btn primary', '完成');
      done.addEventListener('click', closeEditor);
      head.appendChild(done);
      return head;
    }

    function leftEl(c) {
      const left = el('div', 'st-ed-left');
      if (!c.img) {
        const drop = el('div', 'st-drop');
        drop.appendChild(el('strong', null, local.busy ? '正在处理图片…' : '先放一张图'));
        drop.appendChild(el('span', null, '点下面的按钮选图片，也可以按 Ctrl+V 粘贴截图，或者把图片拖进来'));
        if (editable() && !local.busy) {
          const pickBtn = button('btn primary', '选图片');
          pickBtn.id = 'st-ed-pick';
          pickBtn.addEventListener('click', () => pickImage(0));
          drop.appendChild(pickBtn);
        }
        left.appendChild(drop);
        left.appendChild(el('p', 'st-hint', '没有图也可以只写文字，比如一条规则。'));
        return left;
      }
      const pages = cardPages(c);
      const cur = pageAt(c);
      // 这张卡的几张图：点一张切过去编辑它；最后是「＋ 加图」
      if (pages.length > 1 || editable()) {
        const tabs = el('div', 'st-pages');
        tabs.setAttribute('role', 'group');
        tabs.setAttribute('aria-label', '这张卡里的图');
        pages.forEach((p, i) => {
          const item = el('div', 'st-page-item');
          item.dataset.i = String(i);
          const b = button('st-page-tab', null, `编辑${pageName(p, i)}`);
          b.id = 'st-pg-' + i;
          b.setAttribute('aria-pressed', String(i === cur));
          if (editable() && pages.length > 1) b.title = '点一下编辑这张；按住拖动换顺序';
          if (pages.length > 1 && i === coverIndex(c)) b.appendChild(el('b', 'st-cover-tag', '封面'));
          b.appendChild(shotBox(c, { page: i }));
          b.appendChild(el('span', null, pageName(p, i)));
          b.addEventListener('click', () => {
            if (b.dataset.dragged) { delete b.dataset.dragged; return; }
            local.page = i; local.selected = -1; local.undo = []; paint('#st-pg-' + i);
          });
          item.appendChild(b);
          if (editable()) {
            const del = button('st-page-del', '删除', `删除${pageName(p, i)}`);
            del.addEventListener('click', () => removePage(i));
            item.appendChild(del);
            bindReorder(tabs, item, b, i, pages.length);
          }
          tabs.appendChild(item);
        });
        if (editable() && pages.length < MAX_PAGES) {
          const add = button('st-page-add', local.busy ? '处理中…' : '＋ 加图');
          add.id = 'st-pg-add';
          add.disabled = local.busy;
          add.title = '再放一张图：选图片，也可以直接 Ctrl+V 粘贴';
          add.addEventListener('click', () => pickImage('new'));
          tabs.appendChild(add);
        }
        left.appendChild(tabs);
      }
      if (editable()) {
        const tools = el('div', 'st-tools');
        tools.setAttribute('role', 'toolbar');
        tools.setAttribute('aria-label', '批注工具');
        for (const [t, label] of TOOLS) {
          const b = button('st-tool');
          b.id = 'st-tool-' + t;
          b.title = label;
          b.setAttribute('aria-pressed', String(local.tool === t));
          b.appendChild(icon(ICON[t]));
          b.appendChild(el('span', 'st-tool-text', label));
          b.title = label + '：点一下开始画，再点一下回到鼠标';
          b.addEventListener('click', () => { local.tool = local.tool === t ? null : t; local.selected = -1; paint('#st-tool-' + t); });
          tools.appendChild(b);
        }
        tools.appendChild(el('span', 'st-sep'));
        for (const k of MARK_COLORS) {
          const sw = button('st-swatch', null, COLOR_NAME[k] + '色');
          sw.id = 'st-sw-' + k;
          sw.style.background = COLOR_HEX[k];
          sw.setAttribute('aria-pressed', String(local.color === k));
          sw.addEventListener('click', () => {
            local.color = k;
            const cur = card();
            if (cur && local.selected >= 0 && pageMarks(cur)[local.selected]) {
              snapshot();
              const marks = pageMarks(cur).slice();
              marks[local.selected] = { ...marks[local.selected], c: k };
              setMarks(marks, null, '#st-sw-' + k);
            } else paint('#st-sw-' + k);
          });
          tools.appendChild(sw);
        }
        tools.appendChild(el('span', 'st-sep'));
        const undo = button('st-tool', '撤销');
        undo.id = 'st-ed-undo';
        undo.disabled = !local.undo.length;
        undo.addEventListener('click', undoMarks);
        tools.appendChild(undo);
        left.appendChild(tools);
      }
      const stage = shotBox(c, { full: true, selected: local.selected, page: cur, edit: editable() });
      stage.classList.add('st-stage');
      const svg = stage.querySelector('svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '在图上画批注');
      svg.removeAttribute('aria-hidden');
      if (editable()) bindDraw(svg);
      // 好几张图：大图左右的 ‹ › 切到上一张、下一张（和墙上一样；键盘 ← → 也行）
      if (pages.length > 1) {
        for (const [d, cls, text, label] of [[-1, 'prev', '‹', '上一张图'], [1, 'next', '›', '下一张图']]) {
          const b = button('st-flip ' + cls, text, label);
          b.id = 'st-ed-' + cls;
          b.addEventListener('click', () => goPage(cur + d, '#st-ed-' + cls));
          stage.appendChild(b);
        }
      }
      left.appendChild(stage);
      if (editable()) left.appendChild(selBarEl(c));
      // 这张图的标签；几张图时还能左右挪、从卡里拿掉
      if (editable()) {
        const row = el('div', 'st-page-row');
        const lab = textInput('st-pg-label', pages[cur].img.label || '', (v) => {
          const now = card();
          if (!now) return;
          const ps = cardPages(now);
          const i = pageAt(now);
          if (!ps[i]) return;
          ps[i] = { ...ps[i], img: { ...ps[i].img, label: v } };
          savePages(ps);
          for (const t of dlg.querySelectorAll('.st-page-tab')) {
            const k = Number(t.id.slice(6));
            const span = t.querySelector('span:last-child');
            if (k === i && span) span.textContent = pageName({ img: { label: v.trim() } }, i);
          }
        }, { placeholder: '比如：开仓时、持仓中、平仓后' });
        row.appendChild(field('这张图的标签', lab));
        const moves = el('div', 'st-page-moves');
        if (pages.length > 1) {
          const lb = button('btn', '← 往前');
          lb.id = 'st-pg-left';
          lb.disabled = cur === 0;
          lb.addEventListener('click', () => movePage(cur, cur - 1));
          const rb = button('btn', '往后 →');
          rb.id = 'st-pg-right';
          rb.disabled = cur === pages.length - 1;
          rb.addEventListener('click', () => movePage(cur, cur + 1));
          moves.append(lb, rb);
        }
        const rp = button('btn', local.busy ? '处理中…' : '换这张图');
        rp.disabled = local.busy;
        rp.addEventListener('click', () => pickImage(cur));
        const rm = button('btn', '删除这张图');
        rm.addEventListener('click', () => removePage(cur));
        moves.append(rp, rm);
        if (pages.length > 1) {
          const isCover = cur === coverIndex(c);
          const cv = button('btn', isCover ? '已是封面' : '设为封面');
          cv.id = 'st-pg-cover';
          cv.disabled = isCover;
          cv.title = '卡片墙上显示这一张';
          cv.addEventListener('click', () => {
            const now = card();
            if (!now || !savePages(withCover(cardPages(now), cur))) return;
            paint(); // 自己改的卡片不会触发编辑框重画（只有别处改了才会），这里自己画
            showToast(`墙上会显示${pageName(pages[cur], cur)}`);
          });
          moves.append(cv);
        }
        row.appendChild(moves);
        left.appendChild(row);
      } else if (pages[cur].img.label) left.appendChild(el('p', 'st-hint', '这张图：' + pages[cur].img.label));
      return left;
    }

    /** 只换了选中的是哪个（数据没变）：重画图上的批注、换设置条、亮对应的说明，不重建整个编辑框（不打断打字） */
    function refreshSelection() {
      const c = card();
      if (!c) return;
      const svg = dlg.querySelector('.st-stage svg');
      if (svg) drawMarks(svg, pageMarks(c), local.selected, { edit: editable() });
      const bar = dlg.querySelector('.st-selbar');
      if (bar) bar.replaceWith(selBarEl(c));
      const m = pageMarks(c)[local.selected];
      for (const row of dlg.querySelectorAll('.st-pin-note')) row.classList.toggle('on', !!m && m.t === 'pin' && Number(row.dataset.n) === m.n);
    }

    /** 选中整张卡里第 n 号编号点（在别的图上就先切过去） */
    function selectPin(n, focusNote) {
      const c = card();
      if (!c) return;
      let k = 0;
      const pages = cardPages(c);
      for (let pi = 0; pi < pages.length; pi++) {
        const idx = pages[pi].marks.findIndex((m) => m.t === 'pin' && ++k === n);
        if (idx < 0) continue;
        if (pi !== pageAt(c)) {
          local.page = pi;
          local.selected = idx;
          local.undo = [];
          paint(focusNote ? '#st-note-' + n : null);
        } else {
          local.selected = idx;
          refreshSelection();
          if (focusNote) { const t = dlg.querySelector('#st-note-' + n); if (t) t.focus({ preventScroll: true }); }
        }
        return;
      }
    }

    /** 图下面那一条：没选中时是提示；选中了是它的大小、实线 / 虚线、名字（水平线）、删除 */
    function selBarEl(c) {
      const marks = pageMarks(c);
      const m = marks[local.selected];
      const bar = el('div', 'st-selbar' + (m ? '' : ' idle'));
      if (!m) {
        bar.textContent = local.tool ? TOOL_HINT[local.tool] + ' 点图上已有的批注就是选中它；再点一下「' + MARK_NAME[local.tool] + '」回到鼠标。' : MOUSE_HINT;
        return bar;
      }
      const what = el('span', 'st-sel-what', '已选中：');
      what.appendChild(el('b', null, MARK_NAME[m.t] + (m.t === 'pin' ? ' ' + m.n : '')));
      bar.appendChild(what);
      const svgNow = () => dlg.querySelector('.st-stage svg');
      const withChange = (patch) => marks.map((x, i) => (i === local.selected ? { ...x, ...patch } : x));
      const size = el('input');
      size.type = 'range';
      size.id = 'st-sel-size';
      size.min = String(MARK_SIZE_MIN);
      size.max = String(MARK_SIZE_MAX);
      size.step = '0.1';
      size.value = String(m.s || 1);
      size.setAttribute('aria-label', '大小');
      size.addEventListener('input', () => { const svg = svgNow(); if (svg) drawMarks(svg, withChange({ s: Number(size.value) }), local.selected, { edit: true }); });
      size.addEventListener('change', () => { snapshot(); setMarks(withChange({ s: Number(size.value) }), null, '#st-sel-size'); });
      const sl = el('label', 'st-sel-size');
      sl.appendChild(el('span', null, '大小'));
      sl.appendChild(size);
      bar.appendChild(sl);
      if (m.t !== 'pin') {
        const seg = el('span', 'st-seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', '线型');
        for (const [v, t] of [[false, '实线'], [true, '虚线']]) {
          const b = button(null, t);
          b.id = v ? 'st-sel-dash' : 'st-sel-solid';
          b.setAttribute('aria-pressed', String(isDashed(m) === v));
          b.addEventListener('click', () => { if (isDashed(m) === v) return; snapshot(); setMarks(withChange({ dash: v }), null, '#' + b.id); });
          seg.appendChild(b);
        }
        bar.appendChild(seg);
      }
      if (m.t === 'hline') {
        const name = el('input', 'st-sel-name');
        name.id = 'st-sel-name';
        name.value = m.label || '';
        name.maxLength = SHORT_MAX;
        name.placeholder = '名字，比如颈线';
        name.setAttribute('aria-label', '水平线的名字');
        name.addEventListener('input', () => {
          const cur = card();
          if (!cur || !pageMarks(cur)[local.selected]) return;
          const next = pageMarks(cur).map((x, i) => (i === local.selected ? { ...x, label: name.value } : x));
          const ps = cardPages(cur);
          if (ps.length) { ps[pageAt(cur)] = { ...ps[pageAt(cur)], marks: next }; savePages(ps); } else update({ marks: next });
          const svg = svgNow();
          if (svg) drawMarks(svg, next, local.selected, { edit: true });
        });
        bar.appendChild(name);
      }
      const del = button('btn small', '删除');
      del.addEventListener('click', deleteSelected);
      bar.appendChild(del);
      const off = button('btn small', '取消选中');
      off.addEventListener('click', () => { local.selected = -1; refreshSelection(); });
      bar.appendChild(off);
      return bar;
    }

    /**
     * 图上的鼠标、手指：点已有的批注 = 选中它（按住拖动换位置，拖小方块改大小）；点空白处按当前工具画新的。
     * 已经选中一个时，点空白处（包括别的细线外面那圈看不见的感应区）只是取消选中。
     * 拖动时只重画这张图，松手才存一次（存一次就是撤销一步）。
     */
    function bindDraw(svg) {
      let drag = null;
      const pt = (e) => {
        const p = svg.createSVGPoint();
        p.x = e.clientX;
        p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return { x: Math.max(0, Math.min(MARK_W, q.x)), y: Math.max(0, Math.min(MARK_H, q.y)) };
      };
      const redraw = (marks) => drawMarks(svg, marks, local.selected, { edit: true });
      const noteSel = (m) => (m && m.t === 'pin' ? '#st-note-' + m.n : null);
      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // 不让点图把焦点从右边的说明框抢走
        const c = card();
        if (!c) return;
        const marks = pageMarks(c);
        const p = pt(e);
        const t = e.target;
        const h = t && t.getAttribute ? t.getAttribute('data-h') : null;
        const g = t && t.closest ? t.closest('g[data-i]') : null;
        const gi = g ? Number(g.getAttribute('data-i')) : -1;
        const band = !!(t && t.hasAttribute && t.hasAttribute('data-band'));
        const copy = marks.map((m) => ({ ...m }));
        const start = { p0: p, x0: e.clientX, y0: e.clientY, marks: copy, moved: false };
        if (h && marks[local.selected]) {
          drag = { ...start, kind: 'handle', h, o: { ...marks[local.selected] } };
        } else if (gi >= 0 && !(band && local.selected >= 0 && gi !== local.selected)) {
          local.selected = gi;
          drag = { ...start, kind: 'move', o: { ...marks[gi] } };
          redraw(copy);
        } else if (local.selected >= 0) {
          local.selected = -1; // 已经选中了一个：点空白处只是取消选中
          refreshSelection();
          return;
        } else if (!local.tool) {
          return; // 鼠标：点空白什么都不画
        } else if (local.tool === 'pin') {
          snapshot();
          const n = pinsBefore(c) + marks.filter((m) => m.t === 'pin').length + 1;
          local.selected = marks.length;
          setMarks([...marks, { t: 'pin', n: 999, x: p.x, y: p.y, c: local.color }], [...c.notes, { n: 999, text: '' }], '#st-note-' + n);
          return;
        } else if (local.tool === 'hline') {
          snapshot();
          local.selected = marks.length;
          setMarks([...marks, { t: 'hline', y: p.y, c: local.color, label: '' }], null, '#st-sel-name');
          return;
        } else {
          const m = local.tool === 'rect'
            ? { t: 'rect', x: p.x, y: p.y, w: 0, h: 0, c: local.color }
            : { t: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, c: local.color };
          copy.push(m);
          local.selected = copy.length - 1;
          drag = { ...start, kind: 'handle', h: m.t === 'rect' ? 'se' : 'p2', o: { ...m }, fresh: true, moved: true };
        }
        try { svg.setPointerCapture(e.pointerId); } catch { /* 没有也能拖 */ }
      });
      svg.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return; // 手抖一下不算拖
        drag.moved = true;
        const p = pt(e);
        const dx = p.x - drag.p0.x;
        const dy = p.y - drag.p0.y;
        const o = drag.o;
        const m = { ...o };
        if (drag.kind === 'move') {
          if (m.t === 'pin' || m.t === 'rect') { m.x = o.x + dx; m.y = o.y + dy; }
          if (m.t === 'arrow') { m.x1 = o.x1 + dx; m.y1 = o.y1 + dy; m.x2 = o.x2 + dx; m.y2 = o.y2 + dy; }
          if (m.t === 'hline') m.y = o.y + dy;
        } else if (m.t === 'rect') {
          let x1 = o.x;
          let y1 = o.y;
          let x2 = o.x + o.w;
          let y2 = o.y + o.h;
          if (drag.h.includes('w')) x1 += dx;
          if (drag.h.includes('e')) x2 += dx;
          if (drag.h.includes('n')) y1 += dy;
          if (drag.h.includes('s')) y2 += dy;
          m.x = Math.min(x1, x2); m.y = Math.min(y1, y2); m.w = Math.abs(x2 - x1); m.h = Math.abs(y2 - y1);
        } else if (m.t === 'arrow') {
          if (drag.h === 'p1') { m.x1 = o.x1 + dx; m.y1 = o.y1 + dy; } else { m.x2 = o.x2 + dx; m.y2 = o.y2 + dy; }
        } else if (m.t === 'pin') {
          m.s = Math.max(MARK_SIZE_MIN, Math.min(MARK_SIZE_MAX, (o.s || 1) * (1 + (dx + dy) / 80)));
        } else if (m.t === 'hline') {
          m.y = o.y + dy;
        }
        drag.marks[local.selected] = m;
        redraw(drag.marks);
      });
      const end = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        const m = d.marks[local.selected];
        if (d.fresh) {
          const ok = m && (m.t === 'rect' ? m.w > 8 && m.h > 8 : Math.hypot(m.x2 - m.x1, m.y2 - m.y1) > 20);
          if (!ok) { local.selected = -1; refreshSelection(); return; }
          snapshot();
          setMarks(d.marks);
          return;
        }
        if (d.moved) { snapshot(); setMarks(d.marks, null, noteSel(m)); return; }
        refreshSelection(); // 只是点了一下：选中它
        const f = noteSel(m);
        const ta = f && dlg.querySelector(f);
        if (ta) ta.focus({ preventScroll: true });
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);
    }

    function field(label, control) {
      const f = el('label', 'st-field');
      f.appendChild(el('span', null, label));
      f.appendChild(control);
      return f;
    }

    function textInput(id, value, onCommit, { list = null, max = SHORT_MAX, placeholder = '' } = {}) {
      const inp = el('input');
      inp.id = id;
      inp.value = value;
      inp.maxLength = max;
      inp.placeholder = placeholder;
      inp.readOnly = !editable();
      if (list) {
        const dl = el('datalist');
        dl.id = id + '-list';
        for (const v of list) { const o = el('option'); o.value = v; dl.appendChild(o); }
        inp.setAttribute('list', dl.id);
        inp.addEventListener('focus', () => { if (!dl.isConnected) inp.after(dl); }, { once: true });
      }
      inp.addEventListener('input', () => onCommit(inp.value));
      return inp;
    }

    function rightEl(c) {
      const right = el('div', 'st-ed-right');
      const take = el('textarea');
      take.id = 'st-ed-take';
      take.rows = 2;
      take.maxLength = LONG_MAX;
      take.value = c.take;
      take.placeholder = '这张图最想记住的一句话';
      take.readOnly = !editable();
      take.addEventListener('input', () => update({ take: take.value }));
      right.appendChild(field('一句话结论（墙上会显示）', take));

      // 整张卡的批注：切到哪张图都是这一份
      const memo = el('textarea');
      memo.id = 'st-ed-memo';
      memo.rows = 6;
      memo.maxLength = LONG_MAX;
      memo.value = c.memo || '';
      memo.placeholder = '这张卡想记下的东西，写在这里（切到哪张图都是这一份）';
      memo.readOnly = !editable();
      memo.addEventListener('input', () => update({ memo: memo.value }));
      right.appendChild(field('批注', memo));

      const notesBox = el('div', 'st-pin-notes');
      const pages = cardPages(c);
      const pinAt = pinPages(c);
      let lastPage = -1;
      for (const n of c.notes) {
        const pi = pinAt.has(n.n) ? pinAt.get(n.n) : -1;
        if (pages.length > 1 && pi >= 0 && pi !== lastPage) {
          notesBox.appendChild(el('div', 'st-notes-grp', pageName(pages[pi], pi)));
          lastPage = pi;
        }
        const row = el('div', 'st-pin-note');
        row.dataset.n = String(n.n);
        const selM = pageMarks(c)[local.selected];
        if (selM && selM.t === 'pin' && selM.n === n.n) row.classList.add('on');
        const dot = button('st-dot', String(n.n), `在图上选中编号 ${n.n}`);
        dot.style.background = pinColor(c, n.n);
        dot.addEventListener('click', () => selectPin(n.n, true));
        row.appendChild(dot);
        const ta = el('textarea');
        ta.id = 'st-note-' + n.n;
        ta.rows = 2;
        ta.maxLength = LONG_MAX;
        ta.value = n.text;
        ta.placeholder = `编号 ${n.n} 想说什么`;
        ta.readOnly = !editable();
        ta.setAttribute('aria-label', `编号 ${n.n} 的说明`);
        ta.addEventListener('focus', () => { // 写哪条说明，图上就选中哪个点
          const cur = card();
          const m = cur ? pageMarks(cur)[local.selected] : null;
          if (editable() && !(m && m.t === 'pin' && m.n === n.n) && pinPages(cur).get(n.n) === pageAt(cur)) selectPin(n.n, false);
        });
        ta.addEventListener('input', () => {
          const cur = card();
          if (!cur) return;
          update({ notes: cur.notes.map((x) => (x.n === n.n ? { ...x, text: ta.value } : x)) });
        });
        row.appendChild(ta);
        if (editable()) {
          const x = button('st-x', '×', `删除编号 ${n.n}`);
          x.addEventListener('click', () => deletePin(n.n));
          row.appendChild(x);
        }
        notesBox.appendChild(row);
      }
      if (!c.notes.length) notesBox.appendChild(el('p', 'st-hint', c.img ? '还没有编号点。点「编号点」再在图上点一下。' : '放了图以后，可以在图上放编号点，对应这里的说明。'));
      const nf = el('div', 'st-field');
      nf.appendChild(el('span', null, '编号说明（和图上的编号点一一对应）'));
      nf.appendChild(notesBox);
      right.appendChild(nf);

      const kind = el('div', 'st-kind-pick');
      kind.setAttribute('role', 'group');
      kind.setAttribute('aria-label', '正例或反例');
      for (const [k, t] of [['good', '正例：照这样做'], ['bad', '反例：别这样做']]) {
        const b = button(k, t);
        b.id = 'st-kind-' + k;
        b.setAttribute('aria-pressed', String(c.kind === k));
        b.disabled = !editable();
        b.addEventListener('click', () => { update({ kind: k }); paint('#st-kind-' + k); });
        kind.appendChild(b);
      }
      const kf = el('div', 'st-field');
      kf.appendChild(el('span', null, '这是'));
      kf.appendChild(kind);
      right.appendChild(kf);

      right.appendChild(placeFields(c));

      const symbols = Array.from(new Set([
        ...st().cards.map((x) => x.symbol),
        ...store.get().journal.rows.filter((r) => r.type === 'trade').map((r) => r.symbol),
      ].filter(Boolean))).sort();
      const two = el('div', 'st-two');
      two.appendChild(field('品种', textInput('st-ed-symbol', c.symbol, (v) => update({ symbol: v }), { list: symbols })));
      two.appendChild(field('周期', textInput('st-ed-tf', c.tf, (v) => update({ tf: v }), { list: TF_OPTIONS })));
      right.appendChild(two);
      right.appendChild(field('来源', textInput('st-ed-source', c.source, (v) => update({ source: v }), { list: SOURCE_OPTIONS })));

      const no = tradeNo(c.trade);
      if (no) {
        const p = el('p', 'st-link-trade');
        p.appendChild(document.createTextNode('从复盘收进来的：'));
        if (openTrade) {
          const a = button('btn link', `第 ${no} 笔`, `去复盘看第 ${no} 笔`);
          a.addEventListener('click', () => { const id = c.trade; closeEditor(); openTrade(id); });
          p.appendChild(a);
        } else p.appendChild(document.createTextNode(`第 ${no} 笔`));
        right.appendChild(p);
      }
      return right;
    }

    /** 主题、知识点两个下拉框；最后一项是「＋ 新建…」 */
    function placeFields(c) {
      const s = st();
      const where = findItem(s, c.item);
      const two = el('div', 'st-two');
      const topicSel = el('select');
      topicSel.id = 'st-ed-topic';
      topicSel.disabled = !editable();
      const opt = (v, t, sel) => { const o = el('option', null, t); o.value = v; o.selected = !!sel; return o; };
      topicSel.appendChild(opt('', '（未归类）', !where));
      for (const t of s.topics) topicSel.appendChild(opt(t.id, t.name, where && where.topic.id === t.id));
      topicSel.appendChild(opt('+', '＋ 新建主题…'));
      const itemSel = el('select');
      itemSel.id = 'st-ed-item';
      itemSel.disabled = !editable() || !where;
      if (where) {
        for (const it of where.topic.items) itemSel.appendChild(opt(it.id, it.name, it.id === c.item));
        itemSel.appendChild(opt('+', '＋ 新建知识点…'));
      } else itemSel.appendChild(opt('', '先选主题'));

      const askName = (what, onName) => {
        const inp = el('input');
        inp.id = 'st-ed-newname';
        inp.placeholder = what + '的名字，回车添加';
        inp.maxLength = SHORT_MAX;
        inp.setAttribute('aria-label', inp.placeholder);
        let done = false;
        const finish = (save) => {
          if (done) return;
          done = true;
          if (save && inp.value.trim()) onName(inp.value.trim());
          else paint();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        inp.addEventListener('blur', () => finish(true));
        return inp;
      };
      /** 在知识点那一格里问名字：建好后这张卡放进去 */
      const askItem = (topicId, target) => {
        const f = askName('知识点', (name) => {
          const id = store.actions.addItem(topicId, name);
          if (id) update({ item: id });
          paint('#st-ed-item');
        });
        target.replaceWith(f);
        f.focus();
      };
      topicSel.addEventListener('change', () => {
        const v = topicSel.value;
        if (v === '+') {
          const f = askName('主题', (name) => {
            const id = store.actions.addTopic(name);
            paint('#st-ed-topic');
            const sel = id && dlg.querySelector('#st-ed-item');
            if (sel) askItem(id, sel); // 新主题还没有知识点：接着起一个
          });
          topicSel.replaceWith(f);
          f.focus();
          return;
        }
        if (!v) { update({ item: '' }); paint('#st-ed-topic'); return; }
        const tp = st().topics.find((t) => t.id === v);
        if (tp && tp.items.length) { update({ item: tp.items[0].id }); paint('#st-ed-item'); return; }
        askItem(v, itemSel); // 这个主题还没有知识点：直接让用户起一个
      });
      itemSel.addEventListener('change', () => {
        const v = itemSel.value;
        if (v === '+') {
          if (where) askItem(where.topic.id, itemSel);
          return;
        }
        update({ item: v });
      });
      two.appendChild(field('主题', topicSel));
      two.appendChild(field('知识点', itemSel));
      return two;
    }

    // ---------- 键盘、粘贴、拖放、点遮罩 ----------
    function onKeydown(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (document.querySelector('dialog[open]')) return; // 页内确认框开着
      if (e.target && e.target.id === 'st-ed-newname') return; // 正在起名字：Esc 只取消起名
      if (e.key === 'Escape') {
        e.preventDefault();
        if (local.selected >= 0) { local.selected = -1; refreshSelection(); return; } // 先取消选中，再按一次才关
        closeEditor();
        return;
      }
      if (isTyping(e.target)) return;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && local.selected < 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const c = card();
        if (c && cardPages(c).length > 1) { e.preventDefault(); goPage(local.page + (e.key === 'ArrowLeft' ? -1 : 1)); return; }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && local.selected >= 0) { e.preventDefault(); deleteSelected(); return; }
      if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && local.undo.length) { e.preventDefault(); e.stopPropagation(); undoMarks(); }
    }
    function onPaste(e) {
      const info = readTransfer(e.clipboardData);
      if (!info.images.length) return;
      if (isTyping(e.target) && info.hasText) return;
      e.preventDefault();
      putImages(info.images); // 和复盘一样：Ctrl+V 直接加在最后（还没有图就是第一张）
    }
    function onDrop(e) {
      e.preventDefault();
      const info = readTransfer(e.dataTransfer);
      if (info.images.length) putImages(info.images);
    }
    const onDragOver = (e) => { if (Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes('Files')) e.preventDefault(); };
    let downOnWrap = false;
    wrap.addEventListener('mousedown', (e) => { downOnWrap = e.target === wrap; });
    wrap.addEventListener('click', (e) => { if (downOnWrap && e.target === wrap) closeEditor(); });
    wrap.addEventListener('dragover', onDragOver);
    wrap.addEventListener('drop', onDrop);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('paste', onPaste);
    // 数据变了（例如另一个标签页同步过来、撤销删除）：卡片没了就关掉；只读变了重画
    const off = store.subscribe((ev) => {
      if (!card()) { closeEditor(); return; }
      if (ev.type === 'ui' && ev.reason === 'readOnly') paint();
      if (ev.type === 'journal') paint();
    });
    document.body.classList.add('st-ed-open');
    paint();

    return {
      id: cardId,
      page: () => local.page,
      destroy() {
        off();
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('paste', onPaste);
        document.body.classList.remove('st-ed-open');
        releaseHeld(edHeld);
        edHeld = [];
        wrap.remove();
        if (prevFocus && prevFocus.isConnected && !root.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
      },
    };
  }

  if (foldStore) {
    Promise.resolve().then(() => foldStore.load()).then((raw) => {
      if (!Array.isArray(raw)) return;
      for (const k of raw) if (typeof k === 'string') view.shut.add(k);
      if (editor) stale = true; else render();
    }).catch(() => {});
  }

  // ---------- 数据变了 ----------
  const off = store.subscribe((ev) => {
    if (ev.type === 'ui' && ev.reason !== 'readOnly') return;
    if (ev.type === 'row') return; // 改一笔交易的格子和学习页无关（品种候选下次画时再取）
    if (editor) { stale = true; return; }
    render();
  });

  return {
    /** 切到学习页时调用 */
    open() {
      visible = true;
      if (stale || !root.firstChild) render();
    },
    /** 离开学习页 */
    close() {
      if (editor) closeEditor();
      view.shown.clear(); // 墙上翻过的图，下次进来回到封面
      visible = false;
      releaseHeld(held);
      held = [];
      root.textContent = '';
      stale = true;
    },
    newCard,
    openCard,
    isEditing: () => !!editor,
    destroy() {
      off();
      if (editor) { const ed = editor; editor = null; ed.destroy(); }
      releaseHeld(held);
      held = [];
      root.textContent = '';
    },
  };
}
