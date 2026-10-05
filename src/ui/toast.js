// 提示和撤销（交接文档 7.6），以及页内确认框（代替浏览器的 confirm()）。
// 模块加载时不碰 DOM，用到时才建元素，所以在 Node 里也能 import（表格的纯函数测试会间接加载它）。

/** 没有撤销按钮时，提示停留的毫秒数 */
export const TOAST_MS = 2600;
/** 带撤销按钮时，提示停留的毫秒数（7.6：保留 10 秒） */
export const UNDO_MS = 10000;

// 两个位置：main（页面底部）和 aux（main 上面一格）。
// 带"撤销"的提示占 main；它显示着的时候来了普通提示，普通提示放到 aux，不把撤销顶掉（10 秒内还能撤销）。
/** @type {{main: any, aux: any}} */
const slots = { main: null, aux: null };

function currentDocument() {
  return typeof document !== 'undefined' ? document : null;
}

/** 焦点在可以打字的地方（这时 Ctrl+Z 留给浏览器撤销输入） */
function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return !el.readOnly && !el.disabled && !/^(button|checkbox|radio|submit|reset|file|color|range|image|hidden)$/.test(type);
}

function toastHost(doc, slot) {
  const id = slot === 'aux' ? 'toast-aux' : 'toast';
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement('div');
    el.id = id;
    el.hidden = true;
    doc.body.appendChild(el);
  }
  el.classList.add('toast');
  if (slot === 'aux') el.classList.add('toast-aux');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  return el;
}

/**
 * 显示一条提示（页面底部居中），新的提示替换同一位置上旧的。带"撤销"的提示不会被普通提示顶掉：
 * 它显示期间的普通提示显示在它上面一格。
 * @param {string} message
 * @param {object} [opts]
 * @param {() => (boolean|void)} [opts.undo] 有它时显示"撤销"按钮；焦点不在输入框里时按 Ctrl+Z 也一样。
 *   返回 false 表示没能撤销（例如数据已经整份换过），会提示用户。
 * @param {number} [opts.ms] 停留毫秒数。默认带撤销 10 秒、不带 2.6 秒。鼠标停在提示上、焦点在按钮上时暂停计时。
 * @param {string} [opts.undoLabel] 按钮文字，默认"撤销"
 * @param {string} [opts.undoneMessage] 撤销成功后的提示，默认"已撤销"
 * @param {string} [opts.undoFailedMessage] 撤销失败的提示
 * @returns {{close: () => void, undo: () => boolean}}
 */
export function showToast(message, opts = {}) {
  const doc = currentDocument();
  if (!doc || !doc.body) return { close() {}, undo: () => false };

  const undoFn = typeof opts.undo === 'function' ? opts.undo : null;
  let slot = 'main';
  if (undoFn) {
    // 新的撤销提示占 main：旧的（撤销或普通）都换掉；aux 上的普通提示留着
    if (slots.main) slots.main.close();
  } else if (slots.main && slots.main.hasUndo) {
    slot = 'aux';
    if (slots.aux) slots.aux.close();
  } else if (slots.main) {
    slots.main.close();
  }
  const ms = typeof opts.ms === 'number' && opts.ms > 0 ? opts.ms : undoFn ? UNDO_MS : TOAST_MS;
  const el = toastHost(doc, slot);
  const ac = new AbortController();
  const on = (target, type, fn, options) => target.addEventListener(type, fn, { ...(options || {}), signal: ac.signal });

  el.textContent = '';
  const text = doc.createElement('span');
  text.className = 'toast-msg';
  text.textContent = String(message);
  el.appendChild(text);

  let timer = null;
  let remaining = ms;
  let startedAt = 0;
  let hovering = false;
  let focused = false;
  let closed = false;
  let used = false;

  const handle = {
    hasUndo: !!undoFn,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ac.abort();
      if (slots[slot] === handle) {
        slots[slot] = null;
        el.hidden = true;
        el.textContent = '';
      }
    },
    undo() {
      if (used || closed || !undoFn) return false;
      used = true;
      handle.close();
      let ok = false;
      try {
        ok = undoFn() !== false;
      } catch (err) {
        ok = false;
        if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
      }
      showToast(ok ? (opts.undoneMessage || '已撤销') : (opts.undoFailedMessage || '没能撤销：数据已经变了'));
      return ok;
    },
  };

  const run = () => {
    if (closed || timer !== null || hovering || focused) return;
    startedAt = Date.now();
    timer = setTimeout(() => { timer = null; handle.close(); }, remaining);
  };
  const pause = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(1500, remaining - (Date.now() - startedAt));
  };

  if (undoFn) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-btn';
    btn.textContent = opts.undoLabel || '撤销';
    btn.setAttribute('aria-keyshortcuts', 'Control+Z');
    on(btn, 'click', () => { handle.undo(); });
    el.appendChild(btn);
    on(doc, 'keydown', (e) => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
      if (String(e.key).toLowerCase() !== 'z' || isEditable(e.target)) return;
      e.preventDefault();
      handle.undo();
    });
  }

  on(el, 'mouseenter', () => { hovering = true; pause(); });
  on(el, 'mouseleave', () => { hovering = false; run(); });
  on(el, 'focusin', () => { focused = true; pause(); });
  on(el, 'focusout', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    focused = false;
    run();
  });

  el.hidden = false;
  slots[slot] = handle;
  run();
  return handle;
}

/** 关掉正在显示的提示（没有就什么都不做） */
export function hideToast() {
  if (slots.aux) slots.aux.close();
  if (slots.main) slots.main.close();
}

/**
 * 页内确认框（7.6：删除前在页面内确认，不用浏览器的 confirm()）。用原生 <dialog> 的模态方式打开：
 * 焦点留在框里，Esc 或点遮罩等于取消；关闭后焦点回到打开前的位置。
 * @param {object} opts
 * @param {string} opts.title 标题，例如"删除第 7 笔？"
 * @param {string} [opts.message] 说明，可以有换行
 * @param {string[]} [opts.details] 逐条列出的补充说明
 * @param {string} [opts.confirmText] 确认按钮文字，默认"确定"
 * @param {string} [opts.cancelText] 取消按钮文字，默认"取消"
 * @param {boolean} [opts.danger] 删除、覆盖数据这类操作：确认按钮用深色
 * @param {'confirm'|'cancel'} [opts.initialFocus] 打开时焦点放在哪个按钮，默认确认按钮
 * @returns {Promise<boolean>} 点确认为 true；取消、Esc、点遮罩为 false
 */
export function confirmDialog(opts = {}) {
  const doc = currentDocument();
  if (!doc || !doc.body) return Promise.resolve(false);
  return new Promise((resolve) => {
    const prevFocus = doc.activeElement;
    const uid = 'confirm-' + Math.random().toString(36).slice(2, 10);
    const dlg = doc.createElement('dialog');
    dlg.className = 'confirm-dialog';
    dlg.setAttribute('aria-labelledby', uid + '-title');

    const body = doc.createElement('div');
    body.className = 'confirm-body';
    const title = doc.createElement('h2');
    title.className = 'confirm-title';
    title.id = uid + '-title';
    title.textContent = opts.title || '确定吗？';
    body.appendChild(title);
    if (opts.message) {
      const msg = doc.createElement('p');
      msg.className = 'confirm-msg';
      msg.id = uid + '-msg';
      msg.textContent = String(opts.message);
      body.appendChild(msg);
      dlg.setAttribute('aria-describedby', msg.id);
    }
    if (Array.isArray(opts.details) && opts.details.length) {
      const ul = doc.createElement('ul');
      ul.className = 'confirm-list';
      for (const line of opts.details) {
        const li = doc.createElement('li');
        li.textContent = String(line);
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }

    const actions = doc.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = opts.cancelText || '取消';
    const ok = doc.createElement('button');
    ok.type = 'button';
    ok.className = opts.danger ? 'btn danger' : 'btn primary';
    ok.textContent = opts.confirmText || '确定';
    actions.append(cancel, ok);
    dlg.append(body, actions);
    doc.body.appendChild(dlg);

    let settled = false;
    let downOnBackdrop = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        if (dlg.open && typeof dlg.close === 'function') dlg.close();
      } catch (err) { /* 已经关了 */ }
      dlg.remove();
      const lost = !doc.activeElement || doc.activeElement === doc.body || !doc.activeElement.isConnected;
      if (lost && prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        prevFocus.focus({ preventScroll: true });
      }
      resolve(value);
    };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc
    dlg.addEventListener('close', () => finish(false));
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); finish(false); }
    });
    // 点遮罩（按下和松开都在框外）等于取消
    dlg.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg && downOnBackdrop) finish(false);
      downOnBackdrop = false;
    });

    let modal = false;
    if (typeof dlg.showModal === 'function') {
      try {
        dlg.showModal();
        modal = true;
      } catch (err) { /* 退回到普通显示 */ }
    }
    if (!modal) {
      dlg.setAttribute('open', '');
      dlg.classList.add('fallback');
    }
    (opts.initialFocus === 'cancel' ? cancel : ok).focus();
  });
}
