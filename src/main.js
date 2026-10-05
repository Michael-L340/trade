// 启动：打开本机存储 → 读数据 → 建 store → 挂载各块界面 → 接上自动保存 → 路由。
// 这一步只有本机（IndexedDB），没有云端同步；顶栏的保存状态照交接文档 7.11 的"没有连接"一档显示。

import { APP_VERSION } from './model.js';
import { createStore } from './state.js';
import { claimWriter, connectStore, openLocalDb, requestPersist } from './store/localdb.js';
import { mountSummary } from './ui/summary.js';
import { mountChart } from './ui/chart.js';
import { mountSheet } from './ui/sheet.js';
import { mountDetail } from './ui/detail.js';
import { exportCsv, mountSettings } from './ui/settings.js';
import { showToast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);

function setBanner(text, warn) {
  const el = $('banner');
  el.textContent = text || '';
  el.classList.toggle('warn', !!warn);
  el.hidden = !text;
}

function route() {
  const settings = location.hash.replace(/^#\/?/, '') === 'settings';
  $('view-main').hidden = settings;
  $('view-settings').hidden = !settings;
  document.title = settings ? '设置 · 交易日志' : '交易日志';
  if (settings) window.scrollTo(0, 0);
}

async function boot() {
  $('version').textContent = '交易日志 v' + APP_VERSION + ' · 第一步：表格与统计 · 数据只保存在这个浏览器里';

  // 本机存储
  const db = await openLocalDb({
    onVersionChange: () => setBanner('交易日志已在另一个标签页升级到新版本，请刷新这个页面。', true),
    onBlocked: () => setBanner('请先关掉其他打开着交易日志的标签页，再刷新这个页面。', true),
  });
  let initial = null;
  let readOnly = null;
  try {
    initial = await db.loadJournal();
  } catch (err) {
    if (err && err.code === 'NEWER_SCHEMA') {
      readOnly = 'newer-schema';
      setBanner(err.message, true);
    } else {
      setBanner('读取本机数据失败：' + (err && err.message ? err.message : err), true);
    }
  }
  const writer = await claimWriter();
  if (!writer.isWriter && !readOnly) readOnly = 'other-tab';

  const store = createStore(initial, { readOnly });

  // 顶栏状态
  const saveState = $('save-state');
  const saveText = $('save-text');
  let lastError = null;
  function renderSaveState() {
    const { ui } = store.get();
    saveState.classList.remove('warn', 'error');
    if (ui.demo) {
      saveText.textContent = '示例数据，不保存';
    } else if (ui.readOnly === 'other-tab') {
      saveText.textContent = '已在另一个标签页打开，这里只能看';
      saveState.classList.add('warn');
    } else if (ui.readOnly === 'newer-schema') {
      saveText.textContent = '数据版本更新，本页不会覆盖';
      saveState.classList.add('warn');
    } else if (lastError) {
      saveText.textContent = '保存失败，点击重试';
      saveState.classList.add('error');
    } else if (db.kind === 'memory') {
      saveText.textContent = '没有可用的本机存储，刷新会丢失';
      saveState.classList.add('warn');
    } else {
      saveText.textContent = ui.dirty ? '保存中…' : '只保存在这个浏览器里';
    }
    const banner = ui.readOnly === 'other-tab'
      ? '交易日志已在另一个标签页打开，这里只能看。关掉那个标签页后，这里会自动变成可以编辑。'
      : null;
    if (banner) setBanner(banner, true);
    else if (ui.readOnly !== 'newer-schema') setBanner(null);
    $('demo-tag').hidden = !ui.demo;
    $('exit-demo').hidden = !ui.demo;
  }

  const conn = connectStore(store, db, {
    writer,
    onError: (err) => { lastError = err; renderSaveState(); showToast(err && err.message ? err.message : '保存失败'); },
    onSaved: () => { lastError = null; renderSaveState(); },
  });
  saveState.addEventListener('click', async () => {
    if (lastError) {
      const ok = await conn.saveNow();
      if (ok) { lastError = null; renderSaveState(); showToast('已保存'); }
    } else {
      location.hash = '#/settings';
    }
  });
  requestPersist();

  // 界面
  const detail = mountDetail($('detail-root'), store);
  const openDetail = (id) => detail.open(id);
  mountSummary($('summary'), store);
  mountChart($('chart'), store, { openDetail });
  mountSheet($('sheet'), store, { openDetail, onLoadDemo: loadDemo });
  mountSettings($('settings'), store, { localdb: db });

  // 示例模式（7.13）：只在内存里，不写本机存储
  async function loadDemo() {
    try {
      const res = await fetch('fixtures/sample-journal.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const sample = await res.json();
      store.actions.replaceJournal(sample, { demo: true });
      showToast('已载入示例数据。随便改，退出示例后回到你自己的数据。');
    } catch (err) {
      showToast('示例数据载入失败：' + (err && err.message ? err.message : err));
    }
  }
  $('exit-demo').addEventListener('click', () => {
    store.actions.exitDemo();
    showToast('已退出示例，回到你自己的数据。');
  });

  // 顶栏按钮
  $('export-csv').addEventListener('click', () => {
    const { journal, ui } = store.get();
    exportCsv(journal, { demo: ui.demo });
  });
  $('go-settings').addEventListener('click', () => { location.hash = '#/settings'; });
  $('back-main').addEventListener('click', () => { location.hash = '#/'; });

  store.subscribe((ev) => { if (ev.type === 'ui' || ev.type === 'journal') renderSaveState(); });
  renderSaveState();

  window.addEventListener('hashchange', route);
  route();
}

boot().catch((err) => {
  setBanner('启动失败：' + (err && err.message ? err.message : err), true);
  console.error(err);
});
