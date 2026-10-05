// 设置页（#/settings，交接文档 7.10 里这一步要做的部分）：金额单位、导出 journal.json、从 journal.json 恢复、
// 导出 CSV、关于。连接 GitHub 是第 3 步的事，这里不做。
// - 金额单位是数据的一部分（journal.currency，第 5 节），改了会跟着数据一起存进本机、一起导出；不放 localStorage。
// - 导出的是此刻表格里显示的数据：示例模式下导出的是示例数据（文件名带"示例"，页面上有说明）。
// - 从 journal.json 恢复替换的是你自己的数据：先解析、迁移、逐条校验，再页内确认，最后 replaceJournal；
//   示例模式下恢复会同时退出示例。只读（网站在另一个标签页打开）时不能恢复。
// 模块加载时不碰 DOM；上面几个纯函数在 tests/settings.test.js 里测。

import { APP_VERSION, parseJournalText, SCHEMA_VERSION, serialize } from '../model.js';
import { CSV_MIME, csvFileName, toCsv } from '../csv.js';
import { todayLocal } from '../format.js';
import { confirmDialog, showToast } from './toast.js';
import { readOnlyMessage } from './sheet.js';

export const JSON_MIME = 'application/json';
/** 恢复时最多读多大的文件（一万笔交易的 journal.json 也只有几 MB） */
export const MAX_RESTORE_BYTES = 50 * 1024 * 1024;

// ---------- 纯函数 ----------

/** 导出 journal.json 的文件名：journal-2026-10-05.json；示例数据是 journal-示例-2026-10-05.json */
export function journalFileName(now = new Date(), demo = false) {
  return 'journal-' + (demo ? '示例-' : '') + todayLocal(now) + '.json';
}

/** 导出 CSV 的文件名：交易日志-2026-10-05.csv；示例数据是 交易日志-示例-2026-10-05.csv */
export function exportCsvFileName(now = new Date(), demo = false) {
  const name = csvFileName(now);
  return demo ? name.replace(/^交易日志-/, '交易日志-示例-') : name;
}

/** 数一数有几笔交易、几个系统 */
export function countRows(journal) {
  let trades = 0;
  let systems = 0;
  for (const r of journal && Array.isArray(journal.rows) ? journal.rows : []) {
    if (r && r.type === 'trade') trades += 1;
    else if (r && r.type === 'system') systems += 1;
  }
  return { trades, systems };
}

/**
 * 恢复前检查 journal.json 的文字：解析 JSON、迁移版本、逐条校验（validateJournal）、清洗文字。
 * @returns {{ok: true, journal: object, counts: {trades: number, systems: number}}
 *   | {ok: false, code: string, title: string, message: string, errors: string[]}}
 */
export function checkRestoreText(text) {
  const r = parseJournalText(text);
  if (r.ok) return { ok: true, journal: r.journal, counts: countRows(r.journal) };
  const errors = Array.isArray(r.errors) ? r.errors.map((e) => e.message) : [];
  if (r.code === 'NEWER_SCHEMA') {
    return { ok: false, code: r.code, title: '这份文件是更新版本的网站导出的，没有恢复', message: r.message, errors: [] };
  }
  if (r.code === 'BAD_JSON') {
    return { ok: false, code: r.code, title: '这不是一份有效的 journal.json，没有恢复', message: r.message, errors: [] };
  }
  return { ok: false, code: r.code, title: '文件里的数据有问题，没有恢复', message: errors.length ? `一共 ${errors.length} 处：` : r.message, errors };
}

// ---------- 下载 ----------

/** 让浏览器把一段文字存成文件（UTF-8） */
export function downloadText(filename, text, mime, doc = globalThis.document) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * 导出 journal.json（固定格式：每行一个 row、键顺序固定、末尾换行，见 model.serialize）。返回文件名。
 * @param {object} journal 要导出的数据，通常是 store.get().journal
 * @param {{demo?: boolean, now?: Date}} [opts]
 */
export function exportJournalJson(journal, opts = {}) {
  const name = journalFileName(opts.now || new Date(), !!opts.demo);
  downloadText(name, serialize(journal), JSON_MIME);
  return name;
}

/** 导出 CSV（第 9.3 节：BOM、CRLF，Excel 打开中文不乱码）。返回文件名。 */
export function exportCsv(journal, opts = {}) {
  const name = exportCsvFileName(opts.now || new Date(), !!opts.demo);
  downloadText(name, toCsv(journal), CSV_MIME);
  return name;
}

// ---------- 页面 ----------

/**
 * 把设置页画进 container，并接上 store。
 * @param {HTMLElement} container
 * @param {object} store createStore 的返回值
 * @param {{localdb?: object}} [opts] localdb 是 openLocalDb 的返回值（看存储方式：IndexedDB 还是只在内存）
 * @returns {{refresh: () => void, destroy: () => void}}
 */
export function mountSettings(container, store, opts = {}) {
  if (!container || !store) throw new TypeError('mountSettings(container, store) 缺参数');
  const doc = container.ownerDocument;
  const win = doc.defaultView || globalThis;
  const localdb = opts.localdb || null;
  const ac = new AbortController();
  const listen = (target, type, fn, options) => target.addEventListener(type, fn, { ...(options || {}), signal: ac.signal });
  const uid = 'tj-set-' + Math.random().toString(36).slice(2, 8);

  function h(tag, cls, text) {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function button(cls, text) {
    const b = h('button', cls, text);
    b.type = 'button';
    return b;
  }
  function section(title, desc) {
    const sec = h('section', 'panel settings-section');
    const id = uid + '-' + Math.random().toString(36).slice(2, 6);
    const h3 = h('h3', 'section-title', title);
    h3.id = id;
    sec.setAttribute('aria-labelledby', id);
    sec.appendChild(h3);
    if (desc) sec.appendChild(h('p', 'section-desc', desc));
    return sec;
  }
  function setDisabled(btn, reason) {
    if (reason) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = reason;
    } else {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('title');
    }
  }

  container.textContent = '';
  const root = h('div', 'settings');

  // ---------- 标题 ----------
  const head = h('div', 'settings-head');
  const title = h('h2', 'settings-title', '设置');
  const back = h('a', 'btn link back-link', '← 返回交易表');
  back.href = '#/';
  head.append(title, back);

  // ---------- 金额单位 ----------
  const secCur = section('金额单位', '显示在表头（例如"止损 ($)"）和统计里，只是一个标签，不做汇率换算。可以写 $、¥、元、USD 等，最多 8 个字。');
  const curRow = h('div', 'field-row');
  const curLabel = h('label', null, '金额单位');
  curLabel.htmlFor = uid + '-currency';
  const curInput = doc.createElement('input');
  curInput.type = 'text';
  curInput.id = uid + '-currency';
  curInput.className = 'text-input';
  curInput.maxLength = 8;
  curInput.setAttribute('autocomplete', 'off');
  curInput.spellcheck = false;
  const curSave = button('btn', '保存');
  const curMsg = h('span', 'form-msg');
  curMsg.setAttribute('role', 'status');
  curRow.append(curLabel, curInput, curSave, curMsg);
  secCur.appendChild(curRow);

  // ---------- 备份和导出 ----------
  const secData = section('备份和导出', '数据只保存在这个浏览器里。请定期导出 journal.json 备份；换浏览器、换电脑时，用"从 journal.json 恢复"载入。CSV 给 Excel 用，不能拿来恢复。');
  const demoNote = h('p', 'note warn');
  demoNote.hidden = true;
  const btnRow = h('div', 'btn-row');
  const bJson = button('btn', '导出 journal.json');
  const bRestore = button('btn', '从 journal.json 恢复…');
  const bCsv = button('btn', '导出 CSV');
  btnRow.append(bJson, bRestore, bCsv);
  const file = doc.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  file.tabIndex = -1;
  const dataMsg = h('p', 'form-msg');
  dataMsg.setAttribute('role', 'status');
  const errBox = h('div', 'error-box');
  errBox.hidden = true;
  errBox.setAttribute('role', 'alert');
  secData.append(demoNote, btnRow, file, dataMsg, errBox);

  // ---------- 关于 ----------
  const secAbout = section('关于', null);
  const dl = h('dl', 'about-list');
  const item = (label) => {
    dl.append(h('dt', null, label));
    const dd = h('dd');
    dl.append(dd);
    return dd;
  };
  const ddVersion = item('版本');
  const ddWhere = item('数据存在哪');
  const ddKeep = item('长期保存');
  const ddData = item('你的数据');
  const ddTab = item('这个标签页');
  ddVersion.textContent = `网站 ${APP_VERSION}，数据格式 ${SCHEMA_VERSION}`;
  ddKeep.textContent = '正在查询…';
  secAbout.appendChild(dl);
  secAbout.appendChild(h('p', 'note', '同步到 GitHub 私有仓库是后面的步骤，现在还没有。数据不会发到任何地方。'));

  root.append(head, secCur, secData, secAbout);
  container.appendChild(root);

  // ---------- 刷新显示 ----------
  function refresh() {
    const st = store.get();
    const demo = st.ui.demo;
    const ro = st.ui.readOnly;
    if (doc.activeElement !== curInput && curInput.value !== st.journal.currency) curInput.value = st.journal.currency;
    const canEditNow = store.canEdit();
    curInput.readOnly = !canEditNow;
    setDisabled(curSave, canEditNow ? null : readOnlyMessage(ro));

    if (demo) {
      demoNote.hidden = false;
      demoNote.textContent = '现在看的是示例数据：导出的也是示例数据（文件名带"示例"）。要备份你自己的数据，请先退出示例。';
    } else {
      demoNote.hidden = true;
      demoNote.textContent = '';
    }
    setDisabled(bRestore, ro ? readOnlyMessage(ro) : null);

    if (!localdb) {
      ddWhere.textContent = '这个浏览器里';
      ddWhere.className = '';
    } else if (localdb.kind === 'memory') {
      ddWhere.textContent = `只在内存里：${localdb.fallbackReason || '没能使用浏览器的本机存储'}。刷新或关掉页面数据就没了，请马上导出 journal.json。`;
      ddWhere.className = 'warn';
    } else {
      ddWhere.textContent = '这个浏览器的 IndexedDB（只在这个浏览器里；换浏览器、清除网站数据或用无痕窗口都看不到）';
      ddWhere.className = '';
    }

    const mine = countRows(store.realJournal());
    ddData.textContent = `${mine.trades} 笔交易、${mine.systems} 个系统${demo ? '（现在看的是示例数据，不算在内）' : ''}`;

    if (ro === 'other-tab') {
      ddTab.textContent = '只读：网站已在另一个标签页打开。关掉那个标签页后，这里会自动变成可以修改。';
      ddTab.className = 'warn';
    } else if (ro) {
      ddTab.textContent = readOnlyMessage(ro);
      ddTab.className = 'warn';
    } else {
      ddTab.textContent = '可以修改';
      ddTab.className = '';
    }
  }

  // 浏览器是否答应长期保存（启动时 main 已经申请过 navigator.storage.persist()）
  (async () => {
    let text = '这个浏览器不支持查询。请定期导出 journal.json 备份。';
    try {
      const s = win.navigator && win.navigator.storage;
      if (s && typeof s.persisted === 'function') {
        text = (await s.persisted())
          ? '浏览器已答应长期保存：空间紧张时也不会自动清掉本站数据。'
          : '浏览器没有答应长期保存：空间紧张时可能清掉本站数据，请定期导出 journal.json 备份。';
      }
    } catch (err) { /* 用上面的默认说法 */ }
    if (!ac.signal.aborted) ddKeep.textContent = text;
  })();

  // ---------- 金额单位 ----------
  function applyCurrency(fromButton) {
    const st = store.get();
    const wanted = Array.from(curInput.value.trim()).slice(0, 8).join('');
    if (wanted === st.journal.currency) {
      // 点"保存"时输入框先失焦、change 已经存过了；这里只确认一下，不要盖掉"已保存"
      curInput.value = st.journal.currency;
      if (fromButton) {
        curMsg.className = 'form-msg';
        curMsg.textContent = `已保存：金额单位是"${st.journal.currency || '（空）'}"`;
      }
      return;
    }
    if (!store.canEdit()) {
      curMsg.textContent = readOnlyMessage(st.ui.readOnly);
      curMsg.className = 'form-msg warn';
      curInput.value = st.journal.currency;
      return;
    }
    store.actions.setCurrency(wanted);
    const now = store.get().journal.currency;
    curInput.value = now;
    curMsg.className = 'form-msg';
    curMsg.textContent = store.get().ui.demo ? `已改成"${now || '（空）'}"（只改了示例数据）` : `已保存：金额单位是"${now || '（空）'}"`;
  }
  listen(curInput, 'keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      applyCurrency(true);
    } else if (e.key === 'Escape' && !e.isComposing) {
      curInput.value = store.get().journal.currency;
    }
  });
  listen(curInput, 'change', () => applyCurrency(false));
  listen(curSave, 'click', () => {
    if (curSave.getAttribute('aria-disabled') === 'true') {
      showToast(readOnlyMessage(store.get().ui.readOnly));
      return;
    }
    applyCurrency(true);
  });

  // ---------- 导出 ----------
  function clearMessages() {
    dataMsg.textContent = '';
    dataMsg.className = 'form-msg';
    errBox.hidden = true;
    errBox.textContent = '';
  }
  function showError(titleText, message, errors = []) {
    errBox.textContent = '';
    errBox.appendChild(h('b', null, titleText));
    if (message) errBox.appendChild(h('p', null, message));
    if (errors.length) {
      const ul = h('ul');
      for (const m of errors.slice(0, 20)) ul.appendChild(h('li', null, m));
      if (errors.length > 20) ul.appendChild(h('li', null, `……还有 ${errors.length - 20} 处`));
      errBox.appendChild(ul);
    }
    errBox.hidden = false;
  }
  function doExport(kind) {
    clearMessages();
    const st = store.get();
    try {
      const name = kind === 'csv'
        ? exportCsv(st.journal, { demo: st.ui.demo })
        : exportJournalJson(st.journal, { demo: st.ui.demo });
      const n = countRows(st.journal).trades;
      dataMsg.textContent = `已导出 ${name}（${n} 笔交易${st.ui.demo ? '，示例数据' : ''}），在浏览器的下载里。`;
    } catch (err) {
      showError('导出失败', err && err.message ? err.message : String(err));
    }
  }
  listen(bJson, 'click', () => doExport('json'));
  listen(bCsv, 'click', () => doExport('csv'));

  // ---------- 恢复 ----------
  listen(bRestore, 'click', () => {
    const ro = store.get().ui.readOnly;
    if (ro) {
      showToast(readOnlyMessage(ro));
      return;
    }
    clearMessages();
    file.value = '';
    file.click();
  });
  listen(file, 'change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    clearMessages();
    if (f.size > MAX_RESTORE_BYTES) {
      showError('文件太大，没有恢复', `这个文件有 ${(f.size / 1048576).toFixed(1)} MB，不像是交易日志导出的 journal.json。`);
      return;
    }
    let text;
    try {
      text = await f.text();
    } catch (err) {
      showError('没能读出这个文件', err && err.message ? err.message : String(err));
      return;
    }
    const res = checkRestoreText(text);
    if (!res.ok) {
      showError(res.title, res.message, res.errors);
      return;
    }
    const st = store.get();
    const mine = countRows(store.realJournal());
    const details = [
      `文件"${f.name}"里：${res.counts.trades} 笔交易、${res.counts.systems} 个系统，金额单位"${res.journal.currency}"`,
      `你现在的数据：${mine.trades} 笔交易、${mine.systems} 个系统，会被整份替换，不能撤销`,
      st.ui.demo
        ? '要先留一份现在的数据：取消，退出示例后点"导出 journal.json"'
        : '要先留一份现在的数据：取消，先点"导出 journal.json"',
    ];
    if (st.ui.demo) details.push('恢复后会退出示例模式');
    const ok = await confirmDialog({
      title: '用这份文件替换你现在的全部数据？',
      details,
      confirmText: '替换',
      danger: true,
      initialFocus: 'cancel',
    });
    if (!ok) return;
    let done = false;
    try {
      done = store.actions.replaceJournal(res.journal);
    } catch (err) {
      showError('恢复失败', err && err.message ? err.message : String(err), err && Array.isArray(err.errors) ? err.errors.map((e) => e.message) : []);
      return;
    }
    if (!done) {
      showError('没有恢复', readOnlyMessage(store.get().ui.readOnly));
      return;
    }
    dataMsg.textContent = `已恢复：${res.counts.trades} 笔交易、${res.counts.systems} 个系统（来自 ${f.name}）。`;
    showToast(`已从 ${f.name} 恢复 ${res.counts.trades} 笔交易`);
  });

  const off = store.subscribe(() => refresh());
  refresh();

  return {
    refresh,
    destroy() {
      off();
      ac.abort();
      container.textContent = '';
    },
  };
}
