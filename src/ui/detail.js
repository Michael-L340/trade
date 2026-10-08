// 单笔详情（交接文档 7.7、7.8）：盖在页面上的弹层，宽约 1120px。
//
// mountDetail(root, store, opts) → { open(id), close(), isOpen(), destroy() }
//   - root 是放弹层的地方（一般传 document.body）；root 本身带 overlay 类时就拿它当弹层（里面原有内容会被替换）。
//   - open(id)：打开这一笔（已经开着时切换过去），并 store.actions.select(id) 让表格高亮这一行；
//     id 不是现有的交易就什么都不做，返回 false。
//     close()：关闭并 store.actions.select(null)。焦点回到打开前的地方；换过笔时优先回到当前这一笔的
//     行号按钮（表格里的 [data-open="交易 id"]，找不到就回到打开前的地方）。
//   - 顶部：第 n 笔、日期和品种、方向（只显示"多"/"空"两个字）、结果、盈亏金额；
//     右边"上一笔"、"下一笔"（只在交易行之间跳，跳过系统行）和"关闭"。
//   - 左栏是截图。传了 opts.shots（main.js 给，怎么传见 sheet.js 的 shotApi）才是真的截图功能：
//     · 当前选中的那张在 16:9 的区域里完整显示，点它在新标签页打开原图（<a target="_blank">，blob: 地址）；
//     · 下面一排 150×84 的缩略图，每张下面是它的标签（开仓时 / 平仓后 / 自己打的字 / 无）。点缩略图换大图，
//       点标签变成文本框直接打字（回车或点别处保存，Esc 不改；清空就是"无"）；鼠标移上去（或用键盘移到上面）出现"删除"：页内确认，删了显示 10 秒内可以撤销的提示，
//       撤销把文件和记录都放回来；
//     · 缩略图右边是虚线框"Ctrl+V 粘贴截图"：点它选图片文件（可以多选），也可以把图片文件拖进弹层；
//       弹层开着时在页面上任何地方按 Ctrl+V，剪贴板里有图片就加到这一笔（光标在文本框里、剪贴板里又有文字时
//       照常粘贴，只在收图时 preventDefault）。新截图的标签：还没出场是"开仓时"，已出场是"平仓后"；
//     · 图片的 Blob 地址从 urlCache 取，不再显示（换一张、换一笔、关闭、删掉）就 release；
//       文件不在本机（例如从 journal.json 恢复的）显示"文件不在本机"，不报错；
//     · 只读时不收图、不能删、不能改标签。
//     没传 opts.shots 时是占位：大图位置"这一笔还没有截图"，虚线框"Ctrl+V 粘贴截图（下一步接入）"，点了只提示一句。
//   - 右栏：所属系统；盈亏比、止损、止盈、结果、盈亏、R 倍数六个数；开仓理由、备注两个多行文本框。
//     文本框失焦时 store.actions.updateTrade；关闭、换笔、页面切到后台时也先把还没交的文字交给 store。
//     有焦点的文本框不会被数据刷新改写（不打断输入法组字）。只读时文本框只能看。
//   - 键盘：Esc 关闭（输入法正在组字时的 Esc 不算；页内确认框开着时归确认框）；焦点不在文本框里时
//     ← → 切换上一笔、下一笔；Tab 只在弹层里循环。在弹层外的暗色区域按下并松开也会关闭。
//   - 打开期间数据有任何变化都会刷新显示（序号、系统名、金额单位、截图都可能变）；这一笔被删掉就关闭。
//   - 全部用 createElement / textContent，不拼 HTML。样式类名沿用预览稿：overlay、dialog、dlg-head、dlg-no、
//     dlg-meta、dir、chip、dlg-pnl、pnl、dlg-nav、btn small、dlg-body、dlg-left、bigshot、none、thumbs、
//     thumb-item、current、lab、paste-box、dlg-right、kv-sys、kv-grid、kv、k、v、auto-tag、edited-tag、field、panel-sub。
//     依赖样式表里预览稿的 [hidden] { display: none !important; }（.overlay 本身是 display: flex）。

import { fmtR, fmtMoney, fmtRR, fmtDirection, OUTCOME_LABEL, DASH } from '../format.js';
import { confirmDialog, showToast } from './toast.js';
import {
  errorText, hasShotLabel, pasteWantsImage, readTransfer, shotApi, shotFilePath, shotLabelText, shotThumbPath,
} from './sheet.js';
import { LABEL_MAX } from '../shots.js';

const CHIP_CLASS = Object.freeze({ win: 'win', loss: 'loss', breakeven: 'flat', open: 'open', invalid: 'open' });
const READ_ONLY_TITLE = Object.freeze({
  'other-tab': '已在另一个标签页打开，这里只能看，不能改',
  'newer-schema': '数据是更新版本的网站写的，这里只能看；请刷新页面',
});
/** 大图区域的占位文字 */
export const NO_SHOT_TEXT = '这一笔还没有截图';
/** 截图文件不在这个浏览器里时，缩略图和大图位置的占位文字 */
export const MISSING_SHOT_TEXT = '文件不在本机';
const NO_SHOT_HELP = '按 Ctrl+V 粘贴，或点下面的虚线框选图片，也可以把图片文件拖进来。';
const MISSING_SHOT_HELP = '这张截图的图片文件不在这个浏览器里。journal.json 只记录有哪些截图、不含图片，从它恢复的截图会这样显示。';
const PASTE_BOX_TEXT = 'Ctrl+V 粘贴截图（下一步接入）';
const HINT_NOT_READY = '截图功能还没接入，下一步再做。';
const HINT_PASTED = '截图功能还没接入（下一步做），刚才粘贴的图片没有保存。';
const HINT_MS = 4000;
const HINT_ERROR_MS = 8000;
const LABEL_TITLE = '点一下改标签：直接打字，回车保存，Esc 取消';

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

/** 蓝盈橙亏：盈利 ' win'、亏损 ' loss'，其他空串 */
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

/** 拖进来的东西里有没有文件 */
function hasFiles(dt) {
  return !!dt && Array.from(dt.types || []).indexOf('Files') !== -1;
}

/**
 * 截图列表变了以后，大图该显示哪一张：
 * 原来那张还在就还是它；原来那张没了（删掉了），显示补到它位置上的那张，它原来是最后一张就显示新的最后一张；
 * 原来没选（或者认不出来）显示第一张；没有截图返回 null。
 * @param {string[]} prevIds 变化前的截图 id（按顺序）
 * @param {string|null} curId 变化前大图显示的那张
 * @param {string[]} ids 现在的截图 id（按顺序）
 * @returns {string|null}
 */
export function pickCurrentShot(prevIds, curId, ids) {
  if (!ids.length) return null;
  if (curId !== null && ids.indexOf(curId) !== -1) return curId;
  const k = curId === null ? -1 : prevIds.indexOf(curId);
  if (k === -1) return ids[0];
  for (let i = k + 1; i < prevIds.length; i++) if (ids.indexOf(prevIds[i]) !== -1) return prevIds[i];
  for (let i = k - 1; i >= 0; i--) if (ids.indexOf(prevIds[i]) !== -1) return prevIds[i];
  return ids[0];
}

/**
 * 挂载单笔详情弹层。
 * @param {HTMLElement} root
 * @param {ReturnType<import('../state.js').createStore>} store
 * @param {{shots?: object}} [opts] shots：截图功能（main.js 传入）{ addShot, deleteShot, setShotLabel, urlCache, defaultLabel }，
 *   怎么传见 sheet.js 的 shotApi；不传时左栏是占位
 * @returns {{open: (id: string) => boolean, close: () => boolean, isOpen: () => boolean, destroy: () => void}}
 */
export function mountDetail(root, store, opts = {}) {
  const uid = 'tj-detail-' + (++mountCount);
  const shotsApi = shotApi(opts && opts.shots);
  const urls = shotsApi ? shotsApi.urls : null;

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

  // 左栏：截图。大图（16:9）→ 一排缩略图 → 虚线框 → 提示
  const left = body.appendChild(el('div', 'dlg-left'));
  const big = left.appendChild(el('div', 'bigshot'));
  const bigLink = big.appendChild(el('a', 'bigshot-link'));
  bigLink.target = '_blank';
  bigLink.rel = 'noopener';
  bigLink.hidden = true;
  const bigText = big.appendChild(el('div', 'none'));
  const bigMain = bigText.appendChild(el('span', null, NO_SHOT_TEXT));
  const bigSub = bigText.appendChild(el('small', 'none-sub'));
  bigSub.hidden = true;
  const thumbs = left.appendChild(el('div', 'thumbs'));
  const pasteBox = thumbs.appendChild(button('paste-box'));
  pasteBox.appendChild(el('span', null, shotsApi ? 'Ctrl+V 粘贴截图' : PASTE_BOX_TEXT));
  if (shotsApi) pasteBox.appendChild(el('small', null, '或点这里选图片'));
  const hint = thumbs.appendChild(el('span', 'panel-sub shot-hint'));
  hint.setAttribute('role', 'status');
  let fileInput = null;
  if (shotsApi) {
    fileInput = left.appendChild(document.createElement('input'));
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.tabIndex = -1;
  }

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
  let destroyed = false;
  // 截图
  let curShotId = null; // 大图显示的那张
  let shownIds = []; // 上一次显示的截图 id（按顺序）
  const items = new Map(); // 截图 id → 缩略图那一格 { id, root, pick, lab, del, path, held }
  let bigShow = { path: null, held: false }; // 大图现在显示（或正在读）的文件；held：要过地址、用完要 release
  let bigAlt = '';
  let busy = 0; // 正在处理的加图批次
  let dragTimer = 0;

  const tradeItem = (id) => store.get().derived.tradeById.get(id) || null;
  const readOnlyText = () => READ_ONLY_TITLE[store.get().ui.readOnly] || '现在只能看，不能改';

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
    const title = readOnly ? readOnlyText() : '';
    for (const f of fields) {
      if (f.ta.readOnly !== readOnly) f.ta.readOnly = readOnly;
      if (title) f.ta.setAttribute('title', title);
      else f.ta.removeAttribute('title');
    }
  }

  /** 按当前数据填一遍。fresh：刚打开或换了一笔，文本框和截图整个换成这一笔的。 */
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

    if (shotsApi) {
      renderShots(it, fresh);
    } else {
      const n = Array.isArray(t.shots) ? t.shots.length : 0;
      setText(bigMain, n ? '这一笔有 ' + n + ' 张截图，截图功能下一步接入后在这里显示' : NO_SHOT_TEXT);
    }

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

  /** 左栏下面那一行提示；ms 为 0 时一直留着（例如"正在处理截图…"） */
  function showHint(text, ms = HINT_MS) {
    hint.textContent = text;
    clearTimeout(hintTimer);
    if (ms > 0) hintTimer = setTimeout(() => { hint.textContent = ''; }, ms);
  }

  function clearHint() {
    clearTimeout(hintTimer);
    if (hint.textContent) hint.textContent = '';
  }

  /** 弹层开着就写在提示行里，关了就用页面底部的提示 */
  function tell(text, ms) {
    if (openId !== null) showHint(text, ms);
    else showToast(text);
  }

  // ---------- 截图：缩略图一排 ----------
  function letGo(path) {
    if (urls && path) urls.release(path);
  }

  function shotOf(tradeId, shotId) {
    const it = tradeItem(tradeId);
    const list = it && Array.isArray(it.t.shots) ? it.t.shots : [];
    return list.find((s) => s && s.id === shotId) || null;
  }

  /** 截图跟着数据刷新：缩略图按 id 增删、原地更新（有焦点的按钮不重建），大图跟着当前选中的那张 */
  function renderShots(it, fresh) {
    const list = (Array.isArray(it.t.shots) ? it.t.shots : []).filter((s) => s && typeof s.id === 'string');
    const ids = list.map((s) => s.id);
    if (fresh) {
      clearShots();
      curShotId = ids.length ? ids[0] : null;
    } else {
      curShotId = pickCurrentShot(shownIds, curShotId, ids);
    }
    shownIds = ids;
    for (const item of Array.from(items.values())) {
      if (ids.indexOf(item.id) === -1) removeItem(item);
    }
    let cursor = thumbs.firstChild;
    list.forEach((shot, k) => {
      const item = items.get(shot.id) || buildItem(shot.id);
      updateItem(item, shot, k);
      if (item.root === cursor) cursor = cursor.nextSibling;
      else thumbs.insertBefore(item.root, cursor);
    });
    const k = ids.indexOf(curShotId);
    renderBig(k === -1 ? null : list[k], k, it);
    syncShotsEditable();
  }

  function buildItem(id) {
    const itemRoot = el('div', 'thumb-item');
    const pick = itemRoot.appendChild(button('thumb-pick'));
    const lab = itemRoot.appendChild(button('lab'));
    lab.title = LABEL_TITLE;
    const del = itemRoot.appendChild(button('thumb-del', '删除'));
    const item = { id, root: itemRoot, pick, lab, del, path: null, held: false, edit: null };
    pick.addEventListener('click', () => selectShot(id));
    lab.addEventListener('click', () => editLabel(item));
    del.addEventListener('click', () => { deleteShotFlow(id); });
    items.set(id, item);
    return item;
  }

  function updateItem(item, shot, k) {
    const current = shot.id === curShotId;
    const named = hasShotLabel(shot.label);
    const text = shotLabelText(shot.label);
    item.root.classList.toggle('current', current);
    item.pick.setAttribute('aria-pressed', current ? 'true' : 'false');
    item.pick.setAttribute('aria-label', `第 ${k + 1} 张截图${named ? '（' + text + '）' : ''}：在上面看大图`);
    setText(item.lab, text);
    item.lab.classList.toggle('unset', !named);
    item.lab.setAttribute('aria-label', `第 ${k + 1} 张的标签：${text}。点一下改`);
    item.del.setAttribute('aria-label', `删除第 ${k + 1} 张截图`);
    const path = shotThumbPath(shot);
    if (item.path !== path) setItemPath(item, path);
  }

  /** 缩略图格子换成另一张图（第一次显示、或者路径变了）：先放掉原来的地址，再要新的 */
  function setItemPath(item, path) {
    if (item.held) letGo(item.path);
    item.held = false;
    item.path = path;
    item.pick.textContent = '';
    item.pick.classList.remove('note');
    item.pick.removeAttribute('title');
    if (!path || !urls) return;
    item.held = true;
    const live = () => item.path === path && items.get(item.id) === item;
    urls.acquire(path).then((url) => {
      if (!live()) return; // 已经换了图或删掉了（那时已经 release 过）
      if (!url) {
        noteIn(item.pick, MISSING_SHOT_TEXT);
        item.pick.title = MISSING_SHOT_HELP;
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => { if (live()) noteIn(item.pick, '图片打不开'); }, { once: true });
      img.src = url;
      item.pick.textContent = '';
      item.pick.appendChild(img);
    }, () => {
      if (live()) noteIn(item.pick, '读不出这张图');
    });
  }

  function noteIn(btn, text) {
    btn.textContent = '';
    btn.classList.add('note');
    btn.appendChild(el('span', 'thumb-note', text));
  }

  function removeItem(item) {
    if (items.get(item.id) === item) items.delete(item.id);
    if (item.held) letGo(item.path);
    item.held = false;
    item.path = null;
    item.root.remove();
  }

  /** 换一笔、关闭时：拿掉全部缩略图和大图，地址都 release */
  function clearShots() {
    for (const item of Array.from(items.values())) removeItem(item);
    setBig(null);
    shownIds = [];
    curShotId = null;
  }

  // ---------- 截图：大图 ----------
  function renderBig(shot, k, it) {
    if (!shot) {
      setBig(null);
      showBigText(NO_SHOT_TEXT, store.canEdit() ? NO_SHOT_HELP : '');
      return;
    }
    const named = hasShotLabel(shot.label);
    bigAlt = `第 ${it.no} 笔的第 ${k + 1} 张截图${named ? '（' + shotLabelText(shot.label) + '）' : ''}`;
    bigLink.setAttribute('aria-label', bigAlt + '：在新标签页打开原图');
    bigLink.title = '点一下在新标签页打开原图';
    const img = bigLink.firstChild;
    if (img && img.alt !== bigAlt) img.alt = bigAlt;
    const path = shotFilePath(shot);
    if (bigShow.path !== path) setBig(path);
  }

  function setBig(path) {
    if (bigShow.held) letGo(bigShow.path);
    const show = { path, held: false };
    bigShow = show;
    bigLink.hidden = true;
    bigLink.removeAttribute('href');
    bigLink.textContent = '';
    if (!path) return;
    if (!urls) {
      showBigText('这张截图现在显示不了', '');
      return;
    }
    bigText.hidden = true; // 本机读图很快，读的时候只留灰底
    show.held = true;
    urls.acquire(path).then((url) => {
      if (bigShow !== show) return;
      if (!url) {
        showBigText(MISSING_SHOT_TEXT, MISSING_SHOT_HELP);
        return;
      }
      const img = document.createElement('img');
      img.alt = bigAlt;
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('error', () => {
        if (bigShow !== show) return;
        bigLink.hidden = true;
        showBigText('这张截图打不开', '图片文件可能坏了，可以删掉它重新贴一张。');
      }, { once: true });
      img.src = url;
      bigLink.textContent = '';
      bigLink.appendChild(img);
      bigLink.href = url; // 点大图在新标签页打开原图
      bigLink.hidden = false;
      bigText.hidden = true;
    }, (err) => {
      if (bigShow === show) showBigText('读不出这张截图', errorText(err));
    });
  }

  function showBigText(main, sub) {
    setText(bigMain, main);
    setText(bigSub, sub || '');
    bigSub.hidden = !sub;
    bigText.hidden = false;
  }

  // ---------- 截图：操作 ----------
  function selectShot(id) {
    if (openId === null || id === curShotId) return;
    curShotId = id;
    fill(false);
  }

  /** 点标签：标签变成文本框，回车或点别处保存，Esc 不改。清空保存就是"无" */
  function editLabel(item) {
    if (openId === null || !shotsApi.setShotLabel || item.edit) return;
    if (!store.canEdit()) {
      showHint(readOnlyText());
      return;
    }
    const tradeId = openId;
    const shot = shotOf(tradeId, item.id);
    if (!shot) return;
    const input = el('input', 'lab-input');
    input.type = 'text';
    input.maxLength = LABEL_MAX;
    input.value = hasShotLabel(shot.label) ? shotLabelText(shot.label) : '';
    input.placeholder = '写个标签';
    input.setAttribute('aria-label', '截图标签，回车保存，Esc 不改');
    item.edit = input;
    item.lab.hidden = true;
    item.root.insertBefore(input, item.lab);
    input.focus();
    input.select();
    let done = false;
    // byKey：按回车、Esc 结束的，焦点回到标签上；点别处结束的，焦点留在点到的地方
    const finish = (save, byKey) => {
      if (done) return;
      done = true;
      const text = input.value;
      item.edit = null;
      item.lab.hidden = false;
      if (byKey) item.lab.focus();
      input.remove();
      if (save) saveLabel(tradeId, item.id, text);
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 输入法组字时的回车、Esc 归输入法
      if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
    });
    input.addEventListener('blur', () => finish(true, false));
  }

  function saveLabel(tradeId, shotId, text) {
    if (!store.canEdit()) return;
    const fail = (err) => showHint('标签没改成：' + errorText(err), HINT_ERROR_MS);
    let r;
    try {
      r = shotsApi.setShotLabel(tradeId, shotId, text);
    } catch (err) {
      fail(err);
      return;
    }
    if (r && typeof r.then === 'function') r.then(null, fail);
  }

  /** 删除一张：页内确认 → 删 → 10 秒内可以撤销（文件和记录都放回来） */
  async function deleteShotFlow(id) {
    if (openId === null || !shotsApi.deleteShot) return;
    if (!store.canEdit()) {
      showHint(readOnlyText());
      return;
    }
    const tradeId = openId;
    const it = tradeItem(tradeId);
    const list = it && Array.isArray(it.t.shots) ? it.t.shots : [];
    const k = list.findIndex((s) => s && s.id === id);
    if (k === -1) return;
    const named = hasShotLabel(list[k].label);
    const what = `第 ${it.no} 笔的第 ${k + 1} 张截图${named ? '（' + shotLabelText(list[k].label) + '）' : ''}`;
    const ok = await confirmDialog({
      title: `删除第 ${k + 1} 张截图？`,
      message: what + '。\n删除后 10 秒内可以撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok || destroyed) return;
    if (!store.canEdit()) {
      tell(readOnlyText());
      return;
    }
    let undo = null;
    try {
      undo = await shotsApi.deleteShot(tradeId, id);
    } catch (err) {
      tell('没删成：' + errorText(err), HINT_ERROR_MS);
      return;
    }
    if (destroyed) return;
    if (typeof undo !== 'function') {
      tell('没删成：这张截图已经不在了，或者现在只能看', HINT_ERROR_MS);
      return;
    }
    if (openId === tradeId) keepFocusNear(k);
    showToast('已删除' + what, { undo: () => undoDelete(undo, tradeId, id) });
  }

  /** 撤销删除。shots.js 的撤销函数同步放回记录并返回 true / false，文件写回的结果在 undo.done 里 */
  function undoDelete(undo, tradeId, shotId) {
    const r = undo();
    if (r && typeof r.then === 'function') {
      r.then((done) => {
        if (done === false) showToast('没能撤销：数据已经变了');
        else showRestored(tradeId, shotId);
      }, (err) => showToast('没能撤销：' + errorText(err)));
      return true;
    }
    if (r === false) return false;
    showRestored(tradeId, shotId);
    const done = undo.done;
    if (done && typeof done.then === 'function') {
      done.then((fine) => {
        if (fine === false) showToast('截图放回去了，但图片文件没能写回这个浏览器');
      }, () => {});
    }
    return true;
  }

  /** 撤销回来的那张：详情还开着这一笔就显示它 */
  function showRestored(tradeId, shotId) {
    if (openId === tradeId && shotOf(tradeId, shotId)) {
      curShotId = shotId;
      fill(false);
    }
  }

  /** 删掉后焦点没地方放了：放到补上来的那张（没有就放到虚线框） */
  function keepFocusNear(k) {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const id = shownIds[Math.min(k, shownIds.length - 1)];
    const item = id !== undefined ? items.get(id) : null;
    (item ? item.pick : pasteBox).focus();
  }

  /** 加图（粘贴、选文件、拖放）：一张一张交给 shots.addShot，加完大图显示最后加上的那张 */
  async function addFiles(files) {
    if (openId === null || !files.length) return;
    if (!shotsApi.addShot) {
      showHint('现在还不能加截图');
      return;
    }
    if (!store.canEdit()) {
      showHint(readOnlyText());
      return;
    }
    const tradeId = openId;
    busy += 1;
    syncShotsEditable();
    showHint(files.length > 1 ? `正在处理 ${files.length} 张截图…` : '正在处理截图…', 0);
    let added = 0;
    let last = null;
    let label = 'open';
    let failure = null;
    for (const f of files) {
      const it = tradeItem(tradeId);
      if (!it) {
        failure = failure || new Error('这一笔已经删掉了');
        break;
      }
      label = shotsApi.labelFor(it);
      try {
        const shot = await shotsApi.addShot(tradeId, f, label);
        if (shot && typeof shot.id === 'string') {
          added += 1;
          last = shot;
        } else {
          failure = failure || new Error('没有加上');
        }
      } catch (err) {
        failure = failure || err;
      }
      if (destroyed) return;
    }
    busy -= 1;
    syncShotsEditable();
    if (last && openId === tradeId && shotOf(tradeId, last.id)) {
      curShotId = last.id;
      fill(false);
    }
    let msg = added ? `加上了 ${added} 张截图（${shotLabelText(label)}）` : '';
    if (failure) msg += (added ? `；另有 ${files.length - added} 张没加上：` : '截图没加上：') + errorText(failure);
    if (openId === tradeId) {
      showHint(msg, failure ? HINT_ERROR_MS : HINT_MS);
    } else {
      const it = tradeItem(tradeId);
      showToast((it ? `第 ${it.no} 笔` : '') + msg);
    }
  }

  /** 只读时：虚线框变灰、删除按钮藏起来、标签点不动 */
  function syncShotsEditable() {
    if (!shotsApi) return;
    const can = store.canEdit();
    const why = can ? '' : readOnlyText();
    if (can) pasteBox.removeAttribute('aria-disabled');
    else pasteBox.setAttribute('aria-disabled', 'true');
    pasteBox.title = can ? '点这里选图片文件（可以多选），也可以把图片文件拖进来；弹层开着时在任何地方按 Ctrl+V 都行' : why;
    pasteBox.classList.toggle('busy', busy > 0);
    pasteBox.setAttribute('aria-busy', busy > 0 ? 'true' : 'false');
    for (const item of items.values()) {
      if (item.del.hidden !== !can) item.del.hidden = !can;
      if (can) item.lab.removeAttribute('aria-disabled');
      else item.lab.setAttribute('aria-disabled', 'true');
      item.lab.title = can ? LABEL_TITLE : why;
    }
    if (openId !== null && curShotId === null) showBigText(NO_SHOT_TEXT, can ? NO_SHOT_HELP : '');
  }

  // ---------- 打开、关闭、换笔 ----------
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
    const active = document.activeElement;
    const focusWasInside = !active || active === document.body || overlay.contains(active);
    openId = null;
    for (const f of fields) f.boundId = null;
    clearHint();
    if (shotsApi) {
      clearShots();
      endDrag();
    }
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
  /** 弹层里能用 Tab 停留的地方，按页面上的先后（截图一排会增减，所以每次现找） */
  function focusOrder() {
    return Array.from(dialog.querySelectorAll('a[href], button, textarea, input'))
      .filter((x) => !x.disabled && x.tabIndex >= 0 && !x.closest('[hidden]'));
  }

  /** 事件发生在弹层外的另一个对话框里（删除截图的页内确认框）：归那个对话框管 */
  function inOtherDialog(node) {
    if (!node || typeof node.closest !== 'function' || overlay.contains(node)) return false;
    return !!node.closest('dialog');
  }

  function onKeydown(e) {
    if (openId === null) return;
    if (e.isComposing || e.keyCode === 229) return; // 输入法正在组字：Esc 是取消候选词，不是关闭
    if (inOtherDialog(e.target)) return;
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

  /**
   * 弹层开着时的粘贴（7.8）：剪贴板里有图片就加到这一笔；是文字（或图文都有、光标在文本框里）照常粘贴。
   * 只有收图时才 preventDefault。没传 opts.shots 时只提示一句，不拦截。
   */
  function onPaste(e) {
    if (openId === null || !e.clipboardData || e.defaultPrevented) return;
    if (inOtherDialog(e.target)) return;
    if (!shotsApi) {
      const clip = Array.from(e.clipboardData.items || []);
      const types = Array.from(e.clipboardData.types || []);
      const hasImage = clip.some((x) => x.kind === 'file' && /^image\//.test(x.type));
      if (hasImage && types.indexOf('text/plain') === -1) showHint(HINT_PASTED);
      return;
    }
    const info = readTransfer(e.clipboardData);
    if (!pasteWantsImage(info, isTextField(e.target))) return;
    e.preventDefault();
    addFiles(info.images);
  }

  // 拖放：弹层上任何地方都接住文件（免得浏览器自己打开图片、离开网站），虚线框高亮
  function onDragOver(e) {
    if (openId === null || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const can = store.canEdit();
    try {
      e.dataTransfer.dropEffect = can ? 'copy' : 'none';
    } catch (err) { /* 有的浏览器不让改 */ }
    if (!can) return;
    pasteBox.classList.add('drag-over');
    clearTimeout(dragTimer);
    dragTimer = setTimeout(endDrag, 200); // 拖走了（不再收到 dragover）就取消高亮
  }

  function endDrag() {
    clearTimeout(dragTimer);
    dragTimer = 0;
    pasteBox.classList.remove('drag-over');
  }

  function onDrop(e) {
    if (openId === null || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    endDrag();
    if (!store.canEdit()) {
      showHint(readOnlyText());
      return;
    }
    const { images } = readTransfer(e.dataTransfer);
    if (!images.length) {
      showHint('只能放图片文件（PNG、JPG、WebP 等）');
      return;
    }
    addFiles(images);
  }

  function onPasteBoxClick() {
    if (!shotsApi) {
      showHint(HINT_NOT_READY);
      return;
    }
    if (!store.canEdit()) {
      showHint(readOnlyText());
      return;
    }
    fileInput.value = '';
    fileInput.click();
  }

  function onFilesChosen() {
    const chosen = Array.from(fileInput.files || []);
    const images = chosen.filter((f) => f && typeof f.type === 'string' && /^image\//i.test(f.type));
    fileInput.value = '';
    if (!images.length) {
      if (chosen.length) showHint('只能选图片文件（PNG、JPG、WebP 等）');
      return;
    }
    addFiles(images);
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
  pasteBox.addEventListener('click', onPasteBoxClick);
  if (fileInput) fileInput.addEventListener('change', onFilesChosen);
  for (const f of fields) f.ta.addEventListener('blur', () => commitField(f));
  overlay.addEventListener('mousedown', onDown);
  overlay.addEventListener('click', onBackdropClick);
  if (shotsApi) {
    overlay.addEventListener('dragenter', onDragOver);
    overlay.addEventListener('dragover', onDragOver);
    overlay.addEventListener('drop', onDrop);
  }
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('paste', onPaste);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  const unsubscribe = store.subscribe((ev) => {
    if (openId === null) return;
    if (ev.type === 'ui') {
      if (ev.reason === 'readOnly') {
        syncReadOnly();
        syncShotsEditable();
      }
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
      destroyed = true;
      unsubscribe();
      clearTimeout(hintTimer);
      if (shotsApi) endDrag();
      overlay.removeEventListener('mousedown', onDown);
      overlay.removeEventListener('click', onBackdropClick);
      overlay.removeEventListener('dragenter', onDragOver);
      overlay.removeEventListener('dragover', onDragOver);
      overlay.removeEventListener('drop', onDrop);
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (overlay !== root && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
  };
}
