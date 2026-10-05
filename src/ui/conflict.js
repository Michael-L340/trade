// @ts-check
// 冲突对话框（交接文档 8.5）：写明两边各改了什么，二选一，不自动合并。
// 无论选哪边，落败的一份先存进本机的冲突留底并自动下载一份（由 store/sync.js 的 resolveConflict 做），然后才执行。
// 用原生 <dialog>；全部 createElement / textContent。

let openOne = null;

/**
 * 打开冲突对话框。同一时间只开一个；已经开着时直接返回那一个的 Promise。
 * @param {{summary: {text: string, local: string, remote: string}, remoteRev: number}} conflict sync.state.conflict
 * @param {{resolveConflict: (choice: 'remote'|'local') => Promise<boolean>}} sync
 * @param {{onDone?: (choice: string|null) => void}} [opts]
 * @returns {Promise<'remote'|'local'|null>} 选了哪边；点"先不处理"或 Esc 为 null
 */
export function openConflictDialog(conflict, sync, opts = {}) {
  if (openOne) return openOne;
  const doc = globalThis.document;
  if (!doc || !doc.body || !conflict) return Promise.resolve(null);
  openOne = new Promise((resolve) => {
    const h = (tag, cls, text) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined && text !== null) el.textContent = text;
      return el;
    };
    const prevFocus = doc.activeElement;
    const dlg = /** @type {HTMLDialogElement} */ (h('dialog', 'confirm-dialog conflict-dialog'));
    dlg.setAttribute('aria-labelledby', 'tj-conflict-title');
    const body = h('div', 'confirm-body');
    const title = h('h2', 'confirm-title', '云端也改过');
    title.id = 'tj-conflict-title';
    const msg = h('p', 'confirm-msg', `这份日志在另一台设备上也改过。${conflict.summary.text}`);
    const list = h('ul', 'confirm-list');
    list.append(
      h('li', null, '不会自动合并：选一份用。'),
      h('li', null, '没选中的那一份会先存进"设置 → 冲突留底"，并自动下载一份 journal.json，不会丢。'),
    );
    const status = h('p', 'form-msg');
    status.setAttribute('role', 'status');
    body.append(title, msg, list, status);
    const actions = h('div', 'confirm-actions');
    const later = h('button', 'btn', '先不处理');
    const useRemote = h('button', 'btn', '用云端的');
    const useLocal = h('button', 'btn primary', '用这台电脑上的');
    for (const b of [later, useRemote, useLocal]) /** @type {HTMLButtonElement} */ (b).type = 'button';
    actions.append(later, useRemote, useLocal);
    dlg.append(body, actions);
    doc.body.appendChild(dlg);

    let busy = false;
    const finish = (choice) => {
      try { if (dlg.open) dlg.close(); } catch (err) { /* 已经关了 */ }
      dlg.remove();
      openOne = null;
      if (prevFocus && /** @type {any} */ (prevFocus).isConnected && typeof /** @type {any} */ (prevFocus).focus === 'function') {
        /** @type {any} */ (prevFocus).focus({ preventScroll: true });
      }
      if (opts.onDone) opts.onDone(choice);
      resolve(choice);
    };
    const choose = async (choice) => {
      if (busy) return;
      busy = true;
      for (const b of [later, useRemote, useLocal]) b.setAttribute('aria-disabled', 'true');
      status.textContent = '正在处理…';
      try {
        await sync.resolveConflict(choice);
        finish(choice);
      } catch (err) {
        busy = false;
        for (const b of [later, useRemote, useLocal]) b.removeAttribute('aria-disabled');
        status.textContent = '没能处理：' + (err && err.message ? err.message : String(err));
      }
    };
    later.addEventListener('click', () => { if (!busy) finish(null); });
    useRemote.addEventListener('click', () => choose('remote'));
    useLocal.addEventListener('click', () => choose('local'));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) finish(null); });
    try {
      dlg.showModal();
    } catch (err) {
      dlg.setAttribute('open', '');
      dlg.classList.add('fallback');
    }
    later.focus();
  });
  return openOne;
}
