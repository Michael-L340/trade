// 启动和路由：把各个模块接成一个能用的网站（交接文档 7.1、7.11、7.13、9.4）。
//
// 启动顺序：
//   1. 打开本机存储（IndexedDB；打不开就只在内存里，顶上提示"刷新会丢"），申请长期保存（navigator.storage.persist）。
//   2. 用 Web Locks 申请"写者"：拿不到锁说明网站已在另一个标签页打开，这一页只读；那一页关掉后自动接手。
//   3. 读出保存的数据，createStore（没有数据就建一个名称为空的系统行）。
//      数据是更新版本的网站写的 → 只读并提示刷新；读不出来或数据有问题 → 只读，不覆盖原来的数据。
//   4. 挂上顶部统计、曲线、交易表、单笔详情；connectStore 负责自动保存（示例模式不写）、
//      用 BroadcastChannel 通知其他标签页重读。
//   5. hash 路由：#/ 是交易表，#/settings 是设置页。
//   6. 关页面或切到后台时，立刻把还没写的修改写进 IndexedDB。
//
// 这个模块加载时自动启动。导出的 ready 是启动的结果（{ store, db, ... }，出错时为 null），只给测试和调试用。
// 不碰 localStorage；全部用 createElement / textContent，不拼 HTML。

import { createStore } from './state.js';
import { APP_VERSION, SCHEMA_VERSION } from './model.js';
import { claimWriter, connectStore, openLocalDb, requestPersist } from './store/localdb.js';
import { mountSummary } from './ui/summary.js';
import { mountChart } from './ui/chart.js';
import { mountSheet, readOnlyMessage } from './ui/sheet.js';
import { mountDetail } from './ui/detail.js';
import { downloadText, exportCsv, JSON_MIME, mountSettings } from './ui/settings.js';
import { showToast } from './ui/toast.js';

/** 示例数据（交接文档附录 A），相对这个文件定位，部署在子路径下也对 */
const DEMO_URL = new URL('../fixtures/sample-journal.json', import.meta.url);
const TITLE = '交易日志';

const messageOf = (err) => (err && err.message ? err.message : String(err));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(cls, text) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/** 启动失败：顶上写明原因，"正在载入…"换成同样的话 */
function showFatal(err) {
  console.error('交易日志启动失败', err);
  const text = '页面没能启动：' + messageOf(err) + '。请按 Ctrl+F5 强制刷新；还是不行的话，按 F12 打开控制台，把红字截图发出来。';
  const host = document.getElementById('banners');
  if (host) {
    const box = el('div', 'banner warn', text);
    box.setAttribute('role', 'alert');
    host.textContent = '';
    host.appendChild(box);
  }
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = text;
}

async function boot() {
  const $ = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error('index.html 里缺少 #' + id);
    return node;
  };
  const els = {
    demoTag: $('demo-tag'),
    demoExit: $('demo-exit'),
    saveState: $('save-state'),
    exportCsv: $('export-csv'),
    openSettings: $('open-settings'),
    banners: $('banners'),
    pageSheet: $('page-sheet'),
    pageSettings: $('page-settings'),
    summary: $('summary'),
    chart: $('chart'),
    sheet: $('sheet'),
    detail: $('detail'),
    version: $('app-version'),
  };
  els.version.textContent = `网站版本 ${APP_VERSION} · 数据格式 ${SCHEMA_VERSION}`;

  /** 不在 store 里的界面状态 */
  const env = {
    blocked: false, // 打开数据库被别的标签页挡住
    dbClosed: false, // 新版本网站升级了数据库，这一页不能再写
    saveError: null, // 最近一次保存失败的错误（成功保存后清掉）
    loadError: null, // 读本机数据失败
    badData: null, // 本机数据校验没过：{ raw, error }
  };
  let store = null;
  let renderChrome = () => {};

  // ---------- 1. 本机存储 ----------
  const db = await openLocalDb({
    onBlocked: () => { env.blocked = true; renderChrome(); },
    onVersionChange: () => {
      env.dbClosed = true;
      if (store) store.actions.setReadOnly('newer-schema');
      renderChrome();
    },
  });
  requestPersist(); // 不等结果；设置页会显示浏览器答应了没有

  // ---------- 2. 唯一写者 ----------
  const writer = await claimWriter();

  // ---------- 3. 读数据、建 store ----------
  let raw = null;
  try {
    raw = await db.loadJournal();
  } catch (err) {
    env.loadError = err;
  }
  const initialReadOnly = env.loadError ? 'load-failed' : writer.isWriter ? null : 'other-tab';
  try {
    store = createStore(env.loadError ? null : raw, { readOnly: initialReadOnly });
  } catch (err) {
    if (err && err.code === 'NEWER_SCHEMA') {
      store = createStore(null, { readOnly: 'newer-schema' });
    } else {
      env.badData = { raw, error: err };
      store = createStore(null, { readOnly: 'bad-data' });
    }
  }

  // ---------- 4. 界面 ----------
  const detail = mountDetail(els.detail, store);
  const openDetail = (id) => { detail.open(id); };
  const summary = mountSummary(els.summary, store);
  const chart = mountChart(els.chart, store, { openDetail });
  const sheet = mountSheet(els.sheet, store, { openDetail, onLoadDemo: loadDemo });

  const link = connectStore(store, db, {
    writer,
    onError(err) {
      if (err && err.name === 'ModelError') {
        // 另一个标签页存的数据读进来时没通过校验（或比本网站新）：这一页的数据不动
        if (err.code !== 'NEWER_SCHEMA') showToast('没能读入另一个标签页保存的数据：' + messageOf(err));
      } else if (!(err && err.code === 'NEWER_SCHEMA')) {
        const first = !env.saveError;
        env.saveError = err;
        if (first) showToast('保存到浏览器失败：' + messageOf(err));
      }
      renderChrome();
    },
    onSaved() {
      if (env.saveError) {
        env.saveError = null;
        renderChrome();
      }
    },
  });

  // 关页面、切到后台：立刻写盘。这两个监听注册在单笔详情之后，所以详情里还没交的文字会先交给 store，
  // 这里再把它写掉（本机存储自己的 pagehide 监听注册得更早，那时详情的文字还没交）。
  const flushNow = () => { db.flush(); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', onVisibility);

  // ---------- 示例模式（7.13） ----------
  async function loadDemo() {
    const res = await fetch(DEMO_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('示例数据下载失败（HTTP ' + res.status + '）');
    const json = await res.json();
    detail.close();
    store.actions.replaceJournal(json, { demo: true });
    focusSheetStart();
    showToast('已载入示例数据：只在这个页面里，随便改都不会保存。点顶上的"退出示例"回到你自己的数据。');
  }

  function exitDemo() {
    detail.close();
    if (!store.actions.exitDemo()) return;
    focusSheetStart();
    showToast('已退出示例，回到你自己的数据');
  }

  /**
   * 整份换数据后，刚点的按钮会被藏起来、焦点掉到 body：放到第一笔的行号上；
   * 没有交易时放到表格底栏最后一个看得见的按钮（退出示例后就是"看看示例数据"）。
   */
  function focusSheetStart() {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.closest('[hidden]')) return;
    const target = els.sheet.querySelector('[data-open]')
      || Array.from(els.sheet.querySelectorAll('.sheet-footer button')).filter((b) => !b.hidden).pop();
    if (target) target.focus({ preventScroll: true });
  }

  els.demoExit.addEventListener('click', exitDemo);

  // ---------- 导出 CSV（顶栏；示例模式下导出的是示例数据，文件名带"示例"） ----------
  function onExportCsv() {
    const st = store.get();
    try {
      const name = exportCsv(st.journal, { demo: st.ui.demo });
      const n = st.derived.grouped.trades.length;
      showToast(`已导出 ${name}（${n} 笔交易${st.ui.demo ? '，示例数据' : ''}），在浏览器的下载里`);
    } catch (err) {
      showToast('导出失败：' + messageOf(err));
    }
  }
  els.exportCsv.addEventListener('click', onExportCsv);

  // ---------- 顶栏的保存状态（7.11）和横幅 ----------
  function saveStateView(ui) {
    if (ui.demo) return { key: 'demo', text: '示例数据：不会保存', cls: '', title: '示例模式下的修改只在这个页面里，退出示例或刷新后就没了' };
    if (ui.readOnly === 'other-tab') return { key: 'other-tab', text: '只读：已在另一个标签页打开', cls: 'warn', title: '在那个标签页里修改；关掉它以后这里会自动变成可以修改' };
    if (ui.readOnly) return { key: 'ro:' + ui.readOnly, text: '只读：这一页不会保存', cls: 'warn', title: readOnlyMessage(ui.readOnly) };
    if (env.saveError) return { key: 'error', text: '保存失败，点击重试', cls: 'error', retry: true, title: messageOf(env.saveError) };
    if (db.kind === 'memory') return { key: 'memory', text: '只在内存里，刷新会丢（点击去设置导出）', cls: 'warn', link: true, title: db.fallbackReason || '' };
    return { key: 'local', text: '只保存在这个浏览器里（点击去设置）', cls: '', link: true, title: '数据只存在这个浏览器的 IndexedDB 里，没有同步到别处。到设置页可以导出 journal.json 备份。' };
  }

  let saveKey = null;
  function renderSaveState(ui) {
    const v = saveStateView(ui);
    if (v.key === saveKey) return;
    saveKey = v.key;
    const box = els.saveState;
    const hadFocus = box.contains(document.activeElement);
    box.className = 'save-state' + (v.cls ? ' ' + v.cls : '');
    box.textContent = '';
    let inner;
    if (v.retry) {
      inner = button('btn link save-retry', v.text);
      inner.addEventListener('click', retrySave);
    } else if (v.link) {
      inner = el('a', 'save-link', v.text);
      inner.href = '#/settings';
    } else {
      inner = el('span', null, v.text);
    }
    if (v.title) inner.title = v.title;
    box.appendChild(inner);
    if (hadFocus && (v.retry || v.link)) inner.focus({ preventScroll: true });
  }

  async function retrySave() {
    const ok = await link.saveNow();
    if (ok) {
      env.saveError = null;
      showToast('已保存');
    } else if (!store.get().ui.dirty) {
      env.saveError = null; // 没有要存的了（例如别处已经存过）
    }
    renderChrome();
  }

  function bannerList(ui) {
    const list = [];
    if (env.dbClosed) {
      list.push({ key: 'db-closed', warn: true, text: '网站在另一个标签页里更新了版本。为了不弄坏数据，这一页现在只能看。请按 Ctrl+F5 刷新这个页面。' });
    } else if (ui.readOnly === 'newer-schema') {
      list.push({ key: 'newer', warn: true, text: '浏览器里的数据是更新版本的网站保存的。为了不覆盖它，这一页只能看、不会写入。请按 Ctrl+F5 刷新页面，加载最新版网站。' });
    }
    if (ui.readOnly === 'other-tab') {
      list.push({ key: 'other-tab', warn: false, text: '已在另一个标签页打开：这里只能看，不能改。请在那个标签页里修改；关掉它以后，这里会自动变成可以修改。' });
    }
    if (ui.readOnly === 'load-failed') {
      list.push({ key: 'load-failed', warn: true, text: '没能读出浏览器里保存的数据（' + messageOf(env.loadError) + '）。为了不覆盖它，这一页现在只能看。请刷新页面再试。' });
    }
    if (ui.readOnly === 'bad-data' && env.badData) {
      list.push({
        key: 'bad-data',
        warn: true,
        text: '浏览器里保存的数据有问题，读不进来（' + messageOf(env.badData.error) + '）。为了不覆盖它，这一页只能看。可以先把原始数据下载下来留底。',
        action: { text: '下载原始数据', run: downloadBadData },
      });
    }
    if (env.blocked && !env.dbClosed) {
      list.push({ key: 'blocked', warn: true, text: '这个网站的其他标签页挡住了本机存储的升级。请关掉其他标签页，然后刷新这个页面。' });
    }
    if (db.kind === 'memory') {
      list.push({
        key: 'memory',
        warn: true,
        text: '没能使用浏览器的本机存储（' + (db.fallbackReason || '原因不明') + '）。现在数据只在内存里，刷新或关掉页面就没了。请记完后到设置页导出 journal.json。',
      });
    }
    return list;
  }

  let bannerKey = null;
  function renderBanners(ui) {
    const list = bannerList(ui);
    const key = list.map((b) => b.key + ':' + b.text).join('|');
    if (key === bannerKey) return;
    bannerKey = key;
    els.banners.textContent = '';
    for (const b of list) {
      const box = el('div', b.warn ? 'banner warn' : 'banner');
      box.setAttribute('role', 'status');
      box.appendChild(el('span', null, b.text));
      if (b.action) {
        const act = button('btn', b.action.text);
        act.addEventListener('click', b.action.run);
        box.appendChild(act);
      }
      els.banners.appendChild(box);
    }
  }

  function downloadBadData() {
    const data = env.badData ? env.badData.raw : null;
    let text;
    try {
      text = JSON.stringify(data, null, 2) + '\n';
    } catch (err) {
      text = String(data);
    }
    downloadText('journal-原始数据.json', text, JSON_MIME);
  }

  let lastReadOnly = store.get().ui.readOnly;
  renderChrome = function render() {
    const { ui } = store.get();
    els.demoTag.hidden = !ui.demo;
    els.demoExit.hidden = !ui.demo;
    renderSaveState(ui);
    renderBanners(ui);
    if (lastReadOnly === 'other-tab' && !ui.readOnly) showToast('另一个标签页已经关了，这里现在可以修改');
    lastReadOnly = ui.readOnly;
  };
  const offChrome = store.subscribe((ev) => {
    if (ev.type === 'ui' || ev.type === 'journal') renderChrome();
  });
  renderChrome();

  // ---------- 5. 路由：#/ 交易表，#/settings 设置页 ----------
  let page = null;
  let settingsView = null;
  let sheetScrollY = 0;

  const routeOf = (hash) => (String(hash || '').replace(/^#\/?/, '').replace(/\/+$/, '') === 'settings' ? 'settings' : 'sheet');

  function route() {
    const next = routeOf(location.hash);
    if (next === page) return;
    const first = page === null;
    const active = document.activeElement;
    if (next === 'settings') {
      if (!first) sheetScrollY = window.scrollY || 0;
      detail.close();
      els.pageSheet.hidden = true;
      els.pageSettings.hidden = false;
      settingsView = mountSettings(els.pageSettings, store, { localdb: db });
      els.openSettings.setAttribute('aria-current', 'page');
      document.title = '设置 · ' + TITLE;
      window.scrollTo(0, 0);
      const heading = els.pageSettings.querySelector('.settings-title');
      if (heading && !first) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    } else {
      const focusWasInSettings = !first && (els.pageSettings.contains(active) || active === document.body || !active);
      if (settingsView) {
        settingsView.destroy();
        settingsView = null;
      }
      els.pageSettings.hidden = true;
      els.pageSheet.hidden = false;
      els.openSettings.removeAttribute('aria-current');
      document.title = TITLE;
      if (!first) window.scrollTo(0, sheetScrollY);
      if (focusWasInSettings) els.openSettings.focus({ preventScroll: true });
    }
    page = next;
  }
  window.addEventListener('hashchange', route);
  route();

  return {
    store,
    db,
    link,
    writer,
    sheet,
    detail,
    chart,
    summary,
    route,
    page: () => page,
    /** 拆掉全部界面和监听（测试用） */
    destroy() {
      window.removeEventListener('hashchange', route);
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      els.demoExit.removeEventListener('click', exitDemo);
      els.exportCsv.removeEventListener('click', onExportCsv);
      offChrome();
      if (settingsView) settingsView.destroy();
      link.stop();
      sheet.destroy();
      detail.destroy();
      chart.destroy();
      summary.destroy();
      writer.release();
    },
  };
}

export const ready = boot().catch((err) => {
  showFatal(err);
  return null;
});
