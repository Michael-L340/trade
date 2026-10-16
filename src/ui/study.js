// 「学习」板块的界面：左边目录（主题 › 知识点），右边按知识点分段铺开学习卡；墙 / 分栏 / 对比三种看法；
// 点卡片进编辑：图上画批注（编号点、框、箭头、水平线）、写结论和编号说明、选主题和知识点。
//
// mountStudy(root, store, opts) → { open(), close(), newCard(fields), openCard(id), destroy() }
//   opts.shots = { addStudyImage(cardId, blob), urlCache }（main.js 绑好 ctx 的 shots.js 接口）
//   opts.openTrade(tradeId)：卡片上「第 n 笔」点了去复盘打开那一笔
//
// 数据只通过 store.actions 改（addTopic、addItem、updateItem、addCard、updateCard、deleteCard……）。
// 编辑框开着的时候，后面的卡片墙不跟着每个字重画，关掉时再画一次（不打断输入法、不反复要图片地址）。
// 全部用 createElement / textContent，不拼 HTML；颜色、位置用 element.style 或 SVG 属性（页面有内容安全策略）。

import { MARK_W, MARK_H, MARK_COLORS, MAX_PAGES, cardPages, findItem, pagesPatch, LONG_MAX, SHORT_MAX } from '../study.js';
import { confirmDialog, showToast } from './toast.js';
import { errorText, readTransfer, readOnlyMessage, shotUrls } from './sheet.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const COLOR_HEX = Object.freeze({ red: '#E5484D', blue: '#1F4FD1', amber: '#D99A0B', green: '#1E9E6A' });
const COLOR_NAME = Object.freeze({ red: '红', blue: '蓝', amber: '黄', green: '绿' });
const KIND_TEXT = Object.freeze({ good: '正例', bad: '反例' });
const TOOLS = Object.freeze([['pin', '编号点'], ['rect', '框'], ['arrow', '箭头'], ['hline', '水平线'], ['select', '选中']]);
const TOOL_HINT = Object.freeze({
  pin: '在图上点一下放一个编号点，说明栏里会多一条对应的说明。',
  rect: '按住拖出一个框，圈出关键区域。',
  arrow: '按住从起点拖到终点。',
  hline: '在价位上点一下画一条水平线，说明栏里可以给它起名字。',
  select: '点一下选中某个批注，再按 Delete 或点「删除选中」；选中后点颜色可以换色。',
});
const ICON = Object.freeze({
  pin: 'M8 1.5a4.5 4.5 0 0 1 4.5 4.5c0 3.4-4.5 8.5-4.5 8.5S3.5 9.4 3.5 6A4.5 4.5 0 0 1 8 1.5z',
  rect: 'M2 3.5h12v9H2z',
  arrow: 'M2.5 13.5L13 3M7 3h6v6',
  hline: 'M1 8h14',
  select: 'M3 2l9 6-4 1 2.5 5-1.8.8L6.2 10 3 13z',
});
const TF_OPTIONS = Object.freeze(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);
const SOURCE_OPTIONS = Object.freeze(['自己的交易', '课程笔记', '书', '视频']);

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

/** 把批注画进一个 viewBox 为 1000×562 的 svg（selected 是选中的那个的下标） */
export function drawMarks(svg, marks, selected = -1) {
  svg.textContent = '';
  (marks || []).forEach((m, i) => {
    const col = COLOR_HEX[m.c] || COLOR_HEX.red;
    const g = sv('g', { 'data-i': i });
    const sel = i === selected;
    if (m.t === 'rect') {
      g.appendChild(sv('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: col, 'fill-opacity': 0.14, stroke: col, 'stroke-width': sel ? 4 : 2.5, 'vector-effect': 'non-scaling-stroke' }));
    } else if (m.t === 'arrow') {
      const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      const L = 22;
      g.appendChild(sv('line', { x1: m.x1, y1: m.y1, x2: m.x2 - Math.cos(a) * 10, y2: m.y2 - Math.sin(a) * 10, stroke: col, 'stroke-width': sel ? 6 : 4, 'stroke-linecap': 'round' }));
      const p = [[m.x2, m.y2], [m.x2 - L * Math.cos(a - 0.45), m.y2 - L * Math.sin(a - 0.45)], [m.x2 - L * Math.cos(a + 0.45), m.y2 - L * Math.sin(a + 0.45)]];
      g.appendChild(sv('polygon', { points: p.map((q) => q.join(',')).join(' '), fill: col }));
    } else if (m.t === 'hline') {
      g.appendChild(sv('line', { x1: 0, y1: m.y, x2: MARK_W, y2: m.y, stroke: col, 'stroke-width': sel ? 4 : 2.5, 'stroke-dasharray': '10 6', 'vector-effect': 'non-scaling-stroke' }));
      if (m.label) {
        const t = sv('text', { x: MARK_W - 12, y: m.y - 8, 'text-anchor': 'end', 'font-size': 24, 'font-weight': 600, fill: col, 'paint-order': 'stroke', stroke: '#FFFFFF', 'stroke-width': 5 });
        t.textContent = m.label;
        g.appendChild(t);
      }
    } else if (m.t === 'pin') {
      g.appendChild(sv('circle', { cx: m.x, cy: m.y, r: sel ? 27 : 23, fill: col, stroke: '#FFFFFF', 'stroke-width': 4 }));
      const t = sv('text', { x: m.x, y: m.y + 9, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700, fill: '#FFFFFF' });
      t.textContent = String(m.n);
      g.appendChild(t);
    }
    svg.appendChild(g);
  });
}

function marksSvg(marks, selected) {
  const svg = sv('svg', { viewBox: `0 0 ${MARK_W} ${MARK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  drawMarks(svg, marks, selected);
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
 * @param {{shots?: {addStudyImage?: Function, urlCache?: object}, openTrade?: (id: string) => void}} [opts]
 */
export function mountStudy(root, store, opts = {}) {
  const shots = opts.shots || {};
  const urls = shotUrls(shots.urlCache);
  const openTrade = typeof opts.openTrade === 'function' ? opts.openTrade : null;

  /** 界面状态（不进数据） */
  const view = {
    scope: 'all', // 'all' | 'loose'（未归类） | 主题 id | 知识点 id
    mode: 'wall', // 'wall' | 'cols' | 'compare'
    q: '',
    symbol: '',
    kind: '',
    compare: new Set(),
    shown: new Map(), // 卡片 id → 墙上正在看第几张图
    sideOpen: true,
    folded: new Set(),
    adding: null, // 'topic' | 主题 id（正在这个主题下加知识点）
    editingNote: null, // 正在改要点的知识点 id
    renaming: null, // 正在改名的主题或知识点 id
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
  function shotBox(card, { full = false, selected = -1, extra = null, page = 0 } = {}) {
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
    box.appendChild(marksSvg(pg ? pg.marks : card.marks, selected));
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
    return [c.title, c.take, c.symbol, c.tf, c.source, where ? where.item.name : '', where ? where.item.note : '', where ? where.topic.name : '', ...c.notes.map((n) => n.text)]
      .join(' ').toLowerCase().includes(q);
  }
  const countItem = (id) => st().cards.filter((c) => c.item === id).length;
  const countTopic = (t) => t.items.reduce((n, it) => n + countItem(it.id), 0);
  const looseCount = () => st().cards.filter(isLoose).length;

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

  function navBtn(cls, text, count, current, onClick) {
    const b = button(cls);
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
      row.appendChild(navBtn('st-topic', topic.name, countTopic(topic), view.scope === topic.id, () => pick(topic.id)));
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
    const chip = (text, current, onClick) => {
      const b = button('st-chip', text);
      b.setAttribute('aria-pressed', String(current));
      b.addEventListener('click', onClick);
      return b;
    };
    const curTopic = s.topics.find((t) => t.id === view.scope || t.items.some((it) => it.id === view.scope));
    row1.appendChild(chip('全部', view.scope === 'all', () => pick('all')));
    for (const t of s.topics) row1.appendChild(chip(t.name, curTopic === t, () => pick(t.id)));
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
    const head = el('div', 'st-head');
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
      const inp = el('input', 'st-rename');
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
      head.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      head.appendChild(el('h2', 'st-title', titleText));
    }
    const subs = itemsInScope();
    const cards = cardsInScope();
    const count = view.scope === 'loose' ? `${cards.length} 张卡` : `${target && target.kind === 'item' ? '' : subs.length + ' 个知识点 · '}${cards.length} 张卡`;
    head.appendChild(el('span', 'st-count', count));
    if (target && canEdit() && view.renaming !== target.id) {
      const ren = button('btn link st-mini', '改名');
      ren.addEventListener('click', () => { view.renaming = target.id; render(); });
      const del = button('btn link st-mini', '删除');
      del.addEventListener('click', () => deleteTarget(target));
      head.appendChild(ren);
      head.appendChild(del);
    }
    return head;
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
    view.scope = 'all';
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
    const bar = el('div', 'st-bar');
    const seg = el('div', 'st-seg');
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
    if (canEdit()) {
      const add = button('btn primary', '＋ 新建学习卡');
      add.addEventListener('click', () => newCard());
      bar.appendChild(add);
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
    // 好几张图：上面一张大图（左下角写标签、右上角 2/3），下面一排小图，点小图换大图（只换这张卡，不进数据）
    const pages = cardPages(card);
    let k = view.shown.get(card.id) || 0;
    if (k >= pages.length) k = 0;
    const extra = [cmp];
    if (pages.length > 1) {
      extra.push(el('span', 'st-cap', pageName(pages[k], k)));
      extra.push(el('span', 'st-count', `${k + 1}/${pages.length}`));
    }
    art.appendChild(shotBox(card, { full: big, extra, page: k }));
    if (pages.length > 1) {
      const strip = el('div', 'st-strip');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '这张卡的几张图');
      pages.forEach((p, i) => {
        const b = button('st-strip-btn', null, `看${pageName(p, i)}`);
        b.setAttribute('aria-pressed', String(i === k));
        b.appendChild(shotBox(card, { page: i }));
        b.appendChild(el('span', null, pageName(p, i)));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          view.shown.set(card.id, i);
          const next = cardEl(card, { compact, big });
          art.replaceWith(next);
          const again = next.querySelectorAll('.st-strip-btn')[i];
          if (again) again.focus({ preventScroll: true });
        });
        strip.appendChild(b);
      });
      art.appendChild(strip);
    }
    const body = el('div', 'st-card-body');
    const tr = el('div', 'st-card-title');
    tr.appendChild(el('h3', null, card.title || '（还没写标题）'));
    tr.appendChild(el('span', 'st-kind ' + card.kind, KIND_TEXT[card.kind] || ''));
    body.appendChild(tr);
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

  function pointsEl(item) {
    const box = el('div', 'st-points');
    box.appendChild(el('b', null, '要点'));
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
      box.appendChild(el('span', item.note ? null : 'st-muted', item.note || '还没写。点右边「改」写下这个知识点的规则。'));
      if (canEdit()) {
        const b = button('btn link st-mini', '改', `改「${item.name}」的要点`);
        b.addEventListener('click', () => { view.editingNote = item.id; render(); });
        box.appendChild(b);
      }
    }
    return box;
  }

  function wallEl(content) {
    const shown = cardsInScope();
    if (view.scope === 'loose') {
      content.appendChild(sectionEl(null, null, shown));
      return;
    }
    const subs = itemsInScope();
    if (!subs.length && view.scope !== 'all') {
      content.appendChild(el('div', 'st-empty', '这个主题下还没有知识点。点左边的「＋ 知识点」加一个。'));
      return;
    }
    let any = false;
    for (const { topic, item } of subs) {
      const list = shown.filter((c) => c.item === item.id);
      if ((view.q || view.symbol || view.kind) && !list.length) continue;
      any = true;
      content.appendChild(sectionEl(topic, item, list));
    }
    if (view.scope === 'all') {
      const loose = shown.filter(isLoose);
      if (loose.length) { any = true; content.appendChild(sectionEl(null, null, loose)); }
    }
    if (!any) content.appendChild(el('div', 'st-empty', '没有符合条件的学习卡。'));
  }

  function sectionEl(topic, item, list) {
    const sec = el('section', 'st-sect');
    const head = el('div', 'st-sect-head');
    head.appendChild(el('h3', null, item ? item.name : '未归类'));
    if (topic && (view.scope === 'all')) head.appendChild(el('span', 'st-sect-topic', topic.name));
    head.appendChild(el('span', 'st-count', list.length + ' 张'));
    sec.appendChild(head);
    if (item) sec.appendChild(pointsEl(item));
    if (list.length) {
      const wall = el('div', 'st-wall');
      for (const c of list) wall.appendChild(cardEl(c));
      sec.appendChild(wall);
    } else {
      sec.appendChild(el('p', 'st-muted', '还没有卡片。点上面的「＋ 新建学习卡」，或者在复盘的截图下面点「收进学习」。'));
    }
    return sec;
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
  /** 默认放进现在看的知识点；看的是主题就放进它的第一个知识点 */
  function defaultItem() {
    const s = st();
    if (findItem(s, view.scope)) return view.scope;
    const tp = s.topics.find((t) => t.id === view.scope);
    return tp && tp.items.length ? tp.items[0].id : '';
  }

  function newCard(fields = {}) {
    if (!canEdit()) { readOnlyHint(); return null; }
    const id = store.actions.addCard({ item: defaultItem(), ...fields });
    if (!id) return null;
    view.mode = 'wall';
    render();
    openCard(id);
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
    ed.destroy();
    render();
    const back = Array.from(root.querySelectorAll('.st-card')).find((n) => n.dataset.id === ed.id);
    if (back) back.focus({ preventScroll: true });
  }

  function createEditor(cardId) {
    const local = { tool: 'pin', color: 'red', selected: -1, undo: [], busy: false, page: 0, target: 0 };
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

    async function removePage(i) {
      const c = card();
      if (!c) return;
      const pages = cardPages(c);
      const ok = await confirmDialog({ title: `从这张卡里拿掉${pageName(pages[i], i)}？`, message: '这张图上的批注和编号说明会一起去掉。', confirmText: '拿掉', danger: true, initialFocus: 'cancel' });
      if (!ok) return;
      const cur = card();
      if (!cur) return;
      const now = cardPages(cur);
      if (now[i] && now[i].img.file === pages[i].img.file) {
        now.splice(i, 1);
        local.selected = -1;
        local.undo = [];
        savePages(now);
        if (local.page >= now.length) local.page = Math.max(0, now.length - 1);
      }
      paint();
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
          const b = button('st-page-tab', null, `编辑${pageName(p, i)}`);
          b.id = 'st-pg-' + i;
          b.setAttribute('aria-pressed', String(i === cur));
          b.appendChild(shotBox(c, { page: i }));
          b.appendChild(el('span', null, pageName(p, i)));
          b.addEventListener('click', () => { local.page = i; local.selected = -1; local.undo = []; paint('#st-pg-' + i); });
          tabs.appendChild(b);
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
          b.addEventListener('click', () => { local.tool = t; local.selected = -1; paint('#st-tool-' + t); });
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
        if (local.tool === 'select' && local.selected >= 0) {
          const del = button('st-tool', '删除选中');
          del.addEventListener('click', deleteSelected);
          tools.appendChild(del);
        }
        const swap = button('st-tool', local.busy ? '处理中…' : pages.length > 1 ? '换这张图' : '换图');
        swap.disabled = local.busy;
        swap.addEventListener('click', () => pickImage(cur));
        tools.appendChild(swap);
        left.appendChild(tools);
      }
      const stage = shotBox(c, { full: true, selected: local.selected, page: cur });
      stage.classList.add('st-stage');
      if (local.tool === 'select') stage.classList.add('select');
      const svg = stage.querySelector('svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '在图上画批注');
      svg.removeAttribute('aria-hidden');
      if (editable()) bindDraw(svg);
      left.appendChild(stage);
      if (editable()) left.appendChild(el('p', 'st-hint', TOOL_HINT[local.tool]));
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
        if (pages.length > 1) {
          const moves = el('div', 'st-page-moves');
          const lb = button('btn', '← 往前');
          lb.id = 'st-pg-left';
          lb.disabled = cur === 0;
          lb.addEventListener('click', () => movePage(cur, cur - 1));
          const rb = button('btn', '往后 →');
          rb.id = 'st-pg-right';
          rb.disabled = cur === pages.length - 1;
          rb.addEventListener('click', () => movePage(cur, cur + 1));
          const rm = button('btn', '从卡里拿掉这张');
          rm.addEventListener('click', () => removePage(cur));
          moves.append(lb, rb, rm);
          row.appendChild(moves);
        }
        left.appendChild(row);
      } else if (pages[cur].img.label) left.appendChild(el('p', 'st-hint', '这张图：' + pages[cur].img.label));
      return left;
    }

    function bindDraw(svg) {
      let start = null;
      let temp = null;
      const pt = (e) => {
        const p = svg.createSVGPoint();
        p.x = e.clientX;
        p.y = e.clientY;
        const q = p.matrixTransform(svg.getScreenCTM().inverse());
        return { x: Math.max(0, Math.min(MARK_W, q.x)), y: Math.max(0, Math.min(MARK_H, q.y)) };
      };
      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // 不让点图把焦点从右边的说明框抢走
        const c = card();
        if (!c) return;
        const p = pt(e);
        if (local.tool === 'select') {
          const g = e.target.closest && e.target.closest('g[data-i]');
          local.selected = g ? Number(g.getAttribute('data-i')) : -1;
          paint();
          return;
        }
        if (local.tool === 'pin') {
          snapshot();
          const marks = pageMarks(c);
          const n = pinsBefore(c) + marks.filter((m) => m.t === 'pin').length + 1;
          setMarks([...marks, { t: 'pin', n: 999, x: p.x, y: p.y, c: local.color }], [...c.notes, { n: 999, text: '' }], '#st-note-' + n);
          return;
        }
        if (local.tool === 'hline') {
          snapshot();
          const marks = pageMarks(c);
          setMarks([...marks, { t: 'hline', y: p.y, c: local.color, label: '' }], null, '#st-line-' + marks.length);
          return;
        }
        start = p;
        svg.setPointerCapture(e.pointerId);
      });
      svg.addEventListener('pointermove', (e) => {
        if (!start) return;
        const c = card();
        if (!c) return;
        const p = pt(e);
        temp = local.tool === 'rect'
          ? { t: 'rect', x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y), c: local.color }
          : { t: 'arrow', x1: start.x, y1: start.y, x2: p.x, y2: p.y, c: local.color };
        drawMarks(svg, [...pageMarks(c), temp]);
      });
      const end = () => {
        if (!start) return;
        start = null;
        const c = card();
        const ok = temp && (temp.t === 'rect' ? temp.w > 8 && temp.h > 8 : Math.hypot(temp.x2 - temp.x1, temp.y2 - temp.y1) > 20);
        if (c && ok) { snapshot(); setMarks([...pageMarks(c), temp]); } else paint();
        temp = null;
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
      right.appendChild(field('一句话结论（墙上会加粗显示）', take));

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
        const dot = el('span', 'st-dot', String(n.n));
        dot.style.background = pinColor(c, n.n);
        row.appendChild(dot);
        const ta = el('textarea');
        ta.id = 'st-note-' + n.n;
        ta.rows = 2;
        ta.maxLength = LONG_MAX;
        ta.value = n.text;
        ta.placeholder = `编号 ${n.n} 想说什么`;
        ta.readOnly = !editable();
        ta.setAttribute('aria-label', `编号 ${n.n} 的说明`);
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
      if (!c.notes.length) notesBox.appendChild(el('p', 'st-hint', c.img ? '还没有编号点。选「编号点」在图上点一下。' : '放了图以后，可以在图上放编号点，对应这里的说明。'));
      const nf = el('div', 'st-field');
      nf.appendChild(el('span', null, '编号说明（和图上的编号点一一对应）'));
      nf.appendChild(notesBox);
      right.appendChild(nf);

      pageMarks(c).forEach((m, i) => {
        if (m.t !== 'hline') return;
        const inp = textInput('st-line-' + i, m.label || '', (v) => {
          const cur = card();
          if (!cur || !pageMarks(cur)[i]) return;
          const marks = pageMarks(cur).slice();
          marks[i] = { ...marks[i], label: v };
          const ps = cardPages(cur);
          if (ps.length) { ps[pageAt(cur)] = { ...ps[pageAt(cur)], marks }; savePages(ps); } else update({ marks });
          const svg = dlg.querySelector('.st-stage svg');
          if (svg) drawMarks(svg, pageMarks(card()), local.selected);
        }, { placeholder: '比如：颈线、前高' });
        right.appendChild(field('水平线的名字', inp));
      });

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
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
      if (isTyping(e.target)) return;
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
