// 单笔详情（交接文档 7.7）：盖在页面上的弹层，宽约 1120px。
//
// mountDetail(root, store) → { open(id), close(), isOpen(), destroy() }
//   - root 是放弹层的地方（一般传 document.body）；root 本身带 overlay 类时就拿它当弹层（里面原有内容会被替换）。
//   - open(id)：打开这一笔（已经开着时切换过去），并 store.actions.select(id) 让表格高亮这一行；
//     id 不是现有的交易就什么都不做，返回 false。
//     close()：关闭并 store.actions.select(null)。焦点回到打开前的地方；换过笔时优先回到当前这一笔的
//     行号按钮（表格里的 [data-open="交易 id"]，找不到就回到打开前的地方）。
//   - 顶部：第 n 笔、日期和品种、方向（只显示"多"/"空"两个字）、结果、盈亏金额；
//     右边"上一笔"、"下一笔"（只在交易行之间跳，跳过系统行）和"关闭"。
//   - 左栏是截图区域。截图功能下一步接入：现在显示大图占位"这一笔还没有截图"和虚线框
//     "Ctrl+V 粘贴截图（下一步接入）"；点虚线框（或弹层开着时粘贴图片）会提示功能还没接。
//   - 右栏：所属系统；盈亏比、止损、止盈、结果、盈亏、R 倍数六个数；开仓理由、备注两个多行文本框。
//     文本框失焦时 store.actions.updateTrade；关闭、换笔、页面切到后台时也先把还没交的文字交给 store。
//     有焦点的文本框不会被数据刷新改写（不打断输入法组字）。只读时文本框只能看。
//   - 键盘：Esc 关闭（输入法正在组字时的 Esc 不算）；焦点不在文本框里时 ← → 切换上一笔、下一笔；
//     Tab 只在弹层里循环。在弹层外的暗色区域按下并松开也会关闭。
//   - 打开期间数据有任何变化都会刷新显示（序号、系统名、金额单位都可能变）；这一笔被删掉就关闭。
//   - 全部用 createElement / textContent，不拼 HTML。样式类名沿用预览稿：overlay、dialog、dlg-head、dlg-no、
//     dlg-meta、dir、chip、dlg-pnl、pnl、dlg-nav、btn small、dlg-body、dlg-left、bigshot、none、thumbs、
//     paste-box、dlg-right、kv-sys、kv-grid、kv、k、v、auto-tag、edited-tag、field、panel-sub。
//     依赖样式表里预览稿的 [hidden] { display: none !important; }（.overlay 本身是 display: flex）。

import { fmtR, fmtMoney, fmtRR, fmtDirection, OUTCOME_LABEL, DASH } from '../format.js';

const CHIP_CLASS = Object.freeze({ win: 'win', loss: 'loss', breakeven: 'flat', open: 'open', invalid: 'open' });
const READ_ONLY_TITLE = Object.freeze({
  'other-tab': '已在另一个标签页打开，这里只能看，不能改',
  'newer-schema': '数据是更新版本的网站写的，这里只能看；请刷新页面',
});
/** 大图区域的占位文字 */
export const NO_SHOT_TEXT = '这一笔还没有截图';
const PASTE_BOX_TEXT = 'Ctrl+V 粘贴截图（下一步接入）';
const HINT_NOT_READY = '截图功能还没接入，下一步再做。';
const HINT_PASTED = '截图功能还没接入（下一步做），刚才粘贴的图片没有保存。';
const HINT_MS = 4000;

let mountCount = 0;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls, text, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, cls) {
  if (node.className !== cls) node.className = cls;
}

/** 红盈绿亏：盈利 ' win'、亏损 ' loss'，其他空串 */
function tone(d) {
  return d.outcome === 'win' ? ' win' : d.outcome === 'loss' ? ' loss' : '';
}

/** 结果已选但算不出 R 时，缺的是哪一项 */
function missingText(t, d) {
  const need = [];
  if (d.missing.risk) need.push('止损金额');
  if (d.missing.rr && !d.edited && t.result === 'win') need.push('盈亏比');
  return need.length ? '缺' + need.join('和') + '，算不出 R，这一笔不进统计' : '';
}

function setChip(chip, t, d) {
  setClass(chip, 'chip ' + (CHIP_CLASS[d.outcome] || 'open'));
  setText(chip, OUTCOME_LABEL[d.outcome] || '');
  const why = d.outcome === 'invalid' ? missingText(t, d) : '';
  if (why) chip.setAttribute('title', why);
  else chip.removeAttribute('title');
}

/** textarea 的 value 会把 \r\n 统一成 \n；比较时同样处理，免得没改也算改了 */
const lf = (s) => s.replace(/\r\n?/g, '\n');

function isTextField(node) {
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || node.isContentEditable === true;
}

/** CSS 属性选择器里的字符串 */
function cssString(s) {
  return '"' + String(s).replace(/["\\]/g, '\\$&') + '"';
}

/**
 * 挂载单笔详情弹层。
 * @param {HTMLElement} root
 * @param {ReturnType<import('../state.js').createStore>} store
 * @returns {{open: (id: string) => boolean, close: () => boolean, isOpen: () => boolean, destroy: () => void}}
 */
export function mountDetail(root, store) {
  const uid = 'tj-detail-' + (++mountCount);

  // ---------- DOM 只建一次 ----------
  let overlay = root;
  if (root.classList && root.classList.contains('overlay')) root.textContent = '';
  else overlay = root.appendChild(el('div', 'overlay'));
  overlay.hidden = true;

  const dialog = overlay.appendChild(el('div', 'dialog'));
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', uid + '-no');
  dialog.tabIndex = -1;

  const head = dialog.appendChild(el('div', 'dlg-head'));
  const noEl = head.appendChild(el('span', 'dlg-no'));
  noEl.id = uid + '-no';
  const metaEl = head.appendChild(el('span', 'dlg-meta'));
  const dirEl = head.appendChild(el('span', 'dir'));
  const headChip = head.appendChild(el('span', 'chip'));
  const headPnl = head.appendChild(el('span', 'dlg-pnl'));
  const nav = head.appendChild(el('div', 'dlg-nav'));
  const prevBtn = nav.appendChild(button('btn small', '← 上一笔', '上一笔'));
  const nextBtn = nav.appendChild(button('btn small', '下一笔 →', '下一笔'));
  const closeBtn = nav.appendChild(button('btn small', '关闭'));

  const body = dialog.appendChild(el('div', 'dlg-body'));

  // 左栏：截图区域（下一步接入）
  const left = body.appendChild(el('div', 'dlg-left'));
  const big = left.appendChild(el('div', 'bigshot'));
  const bigText = big.appendChild(el('div', 'none', NO_SHOT_TEXT));
  const thumbs = left.appendChild(el('div', 'thumbs'));
  const pasteBox = thumbs.appendChild(button('paste-box', PASTE_BOX_TEXT));
  const hint = thumbs.appendChild(el('span', 'panel-sub'));
  hint.setAttribute('role', 'status');

  // 右栏：所属系统、六个数、两个文本框
  const right = body.appendChild(el('div', 'dlg-right'));
  const sysBox = right.appendChild(el('div', 'kv-sys', '所属系统：'));
  const sysName = sysBox.appendChild(el('b'));
  const grid = right.appendChild(el('div', 'kv-grid'));
  const kv = (label, auto) => {
    const box = grid.appendChild(el('div', 'kv'));
    const k = box.appendChild(el('div', 'k', label));
    if (auto) k.appendChild(el('span', 'auto-tag', '自动'));
    return box.appendChild(el('div', 'v'));
  };
  const rrEl = kv('盈亏比');
  const riskEl = kv('止损');
  const tpEl = kv('止盈', true);
  const resultChip = kv('结果').appendChild(el('span', 'chip'));
  const pnlEl = kv('盈亏', true);
  const editedTag = pnlEl.appendChild(el('span', 'edited-tag', '改'));
  editedTag.setAttribute('title', '手改过的盈亏金额');
  const pnlText = pnlEl.appendChild(document.createTextNode(''));
  const rEl = kv('R 倍数', true);

  const field = (key, label) => {
    const box = right.appendChild(el('div', 'field'));
    const lab = box.appendChild(el('label', null, label));
    const ta = box.appendChild(document.createElement('textarea'));
    ta.id = uid + '-' + key;
    lab.htmlFor = ta.id;
    return { key, ta, boundId: null }; // boundId：文本框里现在是哪一笔的内容
  };
  const fields = [field('reason', '开仓理由'), field('note', '备注')];

  // ---------- 状态 ----------
  let openId = null; // 正在显示的交易 id；null 表示关着
  let openedWith = null; // 打开时是哪一笔（决定关闭后焦点回哪）
  let opener = null; // 打开前有焦点的元素
  let hintTimer = 0;

  const tradeItem = (id) => store.get().derived.tradeById.get(id) || null;

  /** 把文本框里还没交给 store 的文字交上去 */
  function commitField(f) {
    const id = f.boundId;
    if (id === null || !store.canEdit()) return;
    const it = tradeItem(id);
    if (!it) return;
    const saved = typeof it.t[f.key] === 'string' ? it.t[f.key] : '';
    if (f.ta.value !== lf(saved)) store.actions.updateTrade(id, { [f.key]: f.ta.value });
  }

  function commitAll() {
    for (const f of fields) commitField(f);
  }

  function syncReadOnly() {
    const readOnly = !store.canEdit();
    const title = readOnly ? READ_ONLY_TITLE[store.get().ui.readOnly] || '现在只能看，不能改' : '';
    for (const f of fields) {
      if (f.ta.readOnly !== readOnly) f.ta.readOnly = readOnly;
      if (title) f.ta.setAttribute('title', title);
      else f.ta.removeAttribute('title');
    }
  }

  /** 按当前数据填一遍。fresh：刚打开或换了一笔，文本框整个换成这一笔的内容。 */
  function fill(fresh) {
    const { journal, derived } = store.get();
    const it = derived.tradeById.get(openId);
    if (!it) return false;
    const { t, d } = it;
    const currency = journal.currency;
    const trades = derived.grouped.trades;
    const i = trades.indexOf(it);

    setText(noEl, '第 ' + it.no + ' 笔');
    setText(metaEl, [t.date, t.symbol].filter(Boolean).join(' · '));
    setText(dirEl, fmtDirection(t.direction));
    setChip(headChip, t, d);
    setClass(headPnl, 'dlg-pnl pnl' + tone(d));
    setText(headPnl, fmtMoney(d.pnl, { sign: true, currency, blank: true }));
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i < 0 || i >= trades.length - 1;

    const seg = derived.grouped.segments[it.segIndex];
    setText(sysName, '系统 ' + (seg ? seg.letter : 'A') + (seg && seg.sys && seg.sys.name ? ' · ' + seg.sys.name : ''));
    setText(rrEl, fmtRR(t.rr) || DASH);
    setText(riskEl, fmtMoney(t.risk, { currency }));
    setText(tpEl, fmtMoney(d.takeProfit, { currency }));
    setChip(resultChip, t, d);
    editedTag.hidden = !d.edited;
    const pnl = fmtMoney(d.pnl, { sign: true, currency });
    if (pnlText.data !== pnl) pnlText.data = pnl;
    setClass(pnlEl, 'v pnl' + tone(d));
    setText(rEl, fmtR(d.r, 1));
    setClass(rEl, 'v pnl' + tone(d));

    const shots = Array.isArray(t.shots) ? t.shots.length : 0;
    setText(bigText, shots ? '这一笔有 ' + shots + ' 张截图，截图功能下一步接入后在这里显示' : NO_SHOT_TEXT);

    for (const f of fields) {
      const saved = lf(typeof t[f.key] === 'string' ? t[f.key] : '');
      if (fresh || f.boundId !== openId) {
        f.ta.value = saved;
        f.boundId = openId;
      } else if (document.activeElement !== f.ta && f.ta.value !== saved) {
        f.ta.value = saved; // 别处改了（例如另一个标签页），这里没在编辑就跟着换
      }
    }
    syncReadOnly();
    return true;
  }

  function showHint(text) {
    hint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.textContent = ''; }, HINT_MS);
  }

  function clearHint() {
    clearTimeout(hintTimer);
    if (hint.textContent) hint.textContent = '';
  }

  function open(id) {
    if (id === null || id === undefined || !tradeItem(id)) return false;
    if (openId === null) {
      opener = document.activeElement;
      openedWith = id;
    } else if (id !== openId) {
      commitAll();
    }
    const fresh = id !== openId;
    openId = id;
    if (fresh) clearHint();
    fill(fresh);
    if (store.get().ui.selectedId !== id) store.actions.select(id);
    if (overlay.hidden) {
      overlay.hidden = false;
      closeBtn.focus();
    }
    return true;
  }

  function focusable(node) {
    return !!node && node !== document.body && node.isConnected === true && !overlay.contains(node) && typeof node.focus === 'function';
  }

  function restoreFocus(lastId) {
    const candidates = [];
    if (lastId === openedWith) candidates.push(opener);
    try {
      candidates.push(document.querySelector('[data-open=' + cssString(lastId) + ']'));
    } catch {
      // 选择器不合法就跳过
    }
    candidates.push(opener);
    for (const c of candidates) {
      if (!focusable(c)) continue;
      c.focus();
      if (document.activeElement === c) return;
    }
  }

  function close() {
    if (openId === null) return false;
    commitAll();
    const lastId = openId;
    openId = null;
    for (const f of fields) f.boundId = null;
    clearHint();
    const active = document.activeElement;
    const focusWasInside = !active || active === document.body || overlay.contains(active);
    overlay.hidden = true;
    if (store.get().ui.selectedId !== null) store.actions.select(null);
    // 等这一轮事件处理完（表格可能正在按 id 增删行）再放焦点
    if (focusWasInside) queueMicrotask(() => { if (openId === null) restoreFocus(lastId); });
    return true;
  }

  function step(delta) {
    if (openId === null) return;
    const { derived } = store.get();
    const trades = derived.grouped.trades;
    const i = trades.indexOf(derived.tradeById.get(openId));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= trades.length) return;
    const active = document.activeElement;
    open(trades[j].t.id);
    // 用按钮翻到头时这个按钮变灰、拿不住焦点：把焦点挪到另一个还能用的按钮上
    if ((active === prevBtn || active === nextBtn) && active.disabled) {
      const other = active === prevBtn ? nextBtn : prevBtn;
      (other.disabled ? closeBtn : other).focus();
    }
  }

  // ---------- 事件 ----------
  const focusOrder = () => [prevBtn, nextBtn, closeBtn, pasteBox, fields[0].ta, fields[1].ta].filter((x) => !x.disabled);

  function onKeydown(e) {
    if (openId === null) return;
    if (e.isComposing || e.keyCode === 229) return; // 输入法正在组字：Esc 是取消候选词，不是关闭
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusOrder();
      const k = list.indexOf(document.activeElement);
      let target = null;
      if (k === -1) target = e.shiftKey ? list[list.length - 1] : list[0];
      else if (e.shiftKey && k === 0) target = list[list.length - 1];
      else if (!e.shiftKey && k === list.length - 1) target = list[0];
      if (target) {
        e.preventDefault();
        target.focus();
      }
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTextField(e.target)) return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  }

  /** 截图功能还没接：弹层开着时粘贴的是图片（不是文字），就提示一句，不拦截 */
  function onPaste(e) {
    if (openId === null || !e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const types = Array.from(e.clipboardData.types || []);
    const hasImage = items.some((x) => x.kind === 'file' && /^image\//.test(x.type));
    if (hasImage && types.indexOf('text/plain') === -1) showHint(HINT_PASTED);
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') commitAll();
  };
  const onPageHide = () => commitAll();

  let downOnBackdrop = false; // 在文本框里按下、拖到外面松开（选文字）不算点外面
  const onDown = (e) => { downOnBackdrop = e.target === overlay; };
  const onBackdropClick = (e) => {
    if (e.target === overlay && downOnBackdrop) close();
    downOnBackdrop = false;
  };

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  closeBtn.addEventListener('click', () => close());
  pasteBox.addEventListener('click', () => showHint(HINT_NOT_READY));
  for (const f of fields) f.ta.addEventListener('blur', () => commitField(f));
  overlay.addEventListener('mousedown', onDown);
  overlay.addEventListener('click', onBackdropClick);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('paste', onPaste);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  const unsubscribe = store.subscribe((ev) => {
    if (openId === null) return;
    if (ev.type === 'ui') {
      if (ev.reason === 'readOnly') syncReadOnly();
      return;
    }
    if (!tradeItem(openId)) {
      close(); // 这一笔被删掉了，或者整份数据换了、里面没有这一笔
      return;
    }
    fill(false);
    if (ev.type === 'journal') {
      // 整份换数据会清掉选中行；等其他订阅者都处理完这次事件再选回来
      const id = openId;
      queueMicrotask(() => {
        if (openId === id && store.get().ui.selectedId !== id) store.actions.select(id);
      });
    }
  });

  return {
    open,
    close,
    isOpen: () => openId !== null,
    destroy() {
      close();
      unsubscribe();
      clearTimeout(hintTimer);
      overlay.removeEventListener('mousedown', onDown);
      overlay.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (overlay !== root && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
  };
}
