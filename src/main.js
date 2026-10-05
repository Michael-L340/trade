// 启动和路由：把各个模块接成一个能用的网站（交接文档 7.1、7.11、7.13、9.4）。
//
// 启动顺序：
//   1. 打开本机存储（IndexedDB；打不开就只在内存里，顶上提示"刷新会丢"），申请长期保存（navigator.storage.persist）。
//   2. 用 Web Locks 申请"写者"：拿不到锁说明网站已在另一个标签页打开，这一页只读；那一页关掉后自动接手。
//   3. 读出保存的数据，createStore（没有数据就建一个名称为空的系统行）。
//      数据是更新版本的网站写的 → 只读并提示刷新；读不出来或数据有问题 → 只读，不覆盖原来的数据。
//   4. 挂上顶部统计、曲线、交易表、单笔详情；connectStore 负责自动保存（示例模式不写）、
//      用 BroadcastChannel 通知其他标签页重读。
//      截图（7.7、7.8）：建一个 shots.js 的 ctx 和一个 Blob 地址缓存，表格和详情共用（共用同一套地址计数）。
//      进出示例模式时内存里的示例截图由 shots.js 自己清空，这里把缓存里的 Blob 地址全部释放。
//   5. hash 路由：#/ 是交易表，#/settings 是设置页。
//   6. 关页面或切到后台时，立刻把还没写的修改写进 IndexedDB。
//   7. 云端（第 8 节）：src/config.js 配好了就建 remote（唯一碰 supabase-js 的模块）和同步状态机 sync；
//      只有能写的标签页启动同步。本机每写完一次修改通知 sync（2 秒后发，最长 10 秒）；
//      同步把云端数据写进本机后，通知其他标签页重读；出现冲突时弹冲突对话框。顶栏状态照 7.11。
//
// 这个模块加载时自动启动。导出的 ready 是启动的结果（{ store, db, ... }，出错时为 null），只给测试和调试用。
// 不碰 localStorage；全部用 createElement / textContent，不拼 HTML。

import { createStore } from './state.js';
import { APP_VERSION, SCHEMA_VERSION, versionGuard } from './model.js';
import { claimWriter, connectStore, openLocalDb, requestPersist } from './store/localdb.js';
import { mountSummary } from './ui/summary.js';
import { mountChart } from './ui/chart.js';
import { mountSheet, readOnlyMessage } from './ui/sheet.js';
import { mountDetail } from './ui/detail.js';
import * as Shots from './shots.js';
import { downloadText, exportCsv, JSON_MIME, mountSettings } from './ui/settings.js';
import { showToast } from './ui/toast.js';
import { cloudConfigured, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';
import { createRemote } from './store/remote.js';
import { createSync } from './store/sync.js';
import { openConflictDialog } from './ui/conflict.js';

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
    cloudError: null, // 云端配置了，supabase-js 却没加载上
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
    // 版本守卫（5.1）：本机数据是更新版本的网站写的，照常显示，但只读、提示刷新
    if (raw && versionGuard(raw)) store.actions.setReadOnly('newer-schema');
  } catch (err) {
    if (err && err.code === 'NEWER_SCHEMA') {
      store = createStore(null, { readOnly: 'newer-schema' });
    } else {
      env.badData = { raw, error: err };
      store = createStore(null, { readOnly: 'bad-data' });
    }
  }

  // ---------- 云端（第 8 节） ----------
  let remote = null;
  if (cloudConfigured(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)) {
    try {
      remote = createRemote({ url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY });
    } catch (err) {
      env.cloudError = err; // vendor/supabase.js 没加载上：照常只存本机
    }
  }
  let link = null;
  const sync = createSync({
    remote,
    db,
    store,
    download: (name, text) => downloadText(name, text, JSON_MIME),
    onPulled: () => { if (link) link.notifyOthers(); },
    onConflict: () => { openConflict(); },
  });
  function openConflict() {
    if (sync.state.conflict) openConflictDialog(sync.state.conflict, sync);
  }

  // ---------- 4. 界面 ----------
  // 截图：表格和详情只通过这里的函数和地址缓存存取截图，不直接碰 IndexedDB。示例模式以 store 的 ui.demo 为准。
  const shotCtx = {
    store,
    db,
    // 撤销删除截图时文件写回失败（几乎不会）：元数据已经放回，这里告诉用户
    onError(err) { showToast('撤销删除时截图文件没能写回（缩略图会显示"文件不在本机"）：' + messageOf(err)); },
    // 本机没有的截图：登录了就从云端桶里取，存进本机（7.8）
    fetchRemote: remote ? (path) => sync.fetchShot(path) : undefined,
  };
  const urlCache = Shots.createUrlCache(shotCtx);
  const shots = {
    addShot: (tradeId, blob, label) => Shots.addShot(shotCtx, tradeId, blob, label),
    deleteShot: (tradeId, shotId) => Shots.deleteShot(shotCtx, tradeId, shotId),
    setShotLabel: (tradeId, shotId, label) => Shots.setShotLabel(shotCtx, tradeId, shotId, label),
    defaultLabel: Shots.defaultLabel,
    urlCache,
  };
  // 进出示例模式：旧数据的 Blob 地址全部释放。这个订阅要排在表格之前：表格整表重建时
  // （没有 IntersectionObserver 的浏览器）可能马上要新地址，先放掉旧的，免得把新要的也放掉。
  const offDemoUrls = store.subscribe((ev) => {
    if (ev.type === 'journal' && (ev.reason === 'demo' || ev.reason === 'exitDemo')) urlCache.releaseAll();
  });

  const detail = mountDetail(els.detail, store, { shots });
  const openDetail = (id) => { detail.open(id); };
  const summary = mountSummary(els.summary, store);
  const chart = mountChart(els.chart, store, { openDetail });
  const sheet = mountSheet(els.sheet, store, { openDetail, onLoadDemo: loadDemo, shots });

  link = connectStore(store, db, {
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
      if (!store.get().ui.demo) sync.notifyLocalChange();
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
  /** 顶栏状态（7.11）。kind：link 去设置页；retry 立即重试；conflict 打开冲突框；badText 跳到那一格 */
  function saveStateView(ui) {
    const st = sync.state;
    if (ui.demo) return { key: 'demo', text: '示例数据，不保存', cls: '', title: '示例模式下的修改只在这个页面里，退出示例或刷新后就没了' };
    if (ui.readOnly === 'other-tab') return { key: 'other-tab', text: '另一个标签页正在编辑，这里只读', cls: 'warn', title: '在那个标签页里修改；关掉它以后这里会自动变成可以修改' };
    if (ui.readOnly === 'newer-schema' || st.status === 'newer') return { key: 'newer', text: '网站已更新，刷新页面后才能保存', cls: 'warn', title: '按 Ctrl+F5 刷新页面，加载最新版网站。本机修改还在，刷新后照常同步。' };
    if (ui.readOnly) return { key: 'ro:' + ui.readOnly, text: '只读：这一页不会保存', cls: 'warn', title: readOnlyMessage(ui.readOnly) };
    if (env.saveError) return { key: 'error', text: '保存失败，点击重试', cls: 'error', kind: 'retry', title: messageOf(env.saveError) };
    if (db.kind === 'memory') return { key: 'memory', text: '只在内存里，刷新会丢（点击去设置导出）', cls: 'warn', kind: 'link', title: db.fallbackReason || '' };
    const pendingText = { key: 'pending', text: '有未同步的修改', cls: '', kind: 'link', title: '本机已经存好，等着传到云端（断网、超时时会自动重试）' };
    switch (st.status) {
      case 'synced':
        if (st.pending) return pendingText;
        if (st.rejectedShots > 0) return { key: 'synced-rej:' + st.rejectedShots, text: `已保存到云端，${st.rejectedShots} 张截图没传上去（点击查看）`, cls: 'warn', kind: 'link' };
        return { key: 'synced', text: '已保存到云端', cls: 'ok', kind: 'link', title: '本机和云端一致' };
      case 'syncing': return { key: 'syncing', text: '保存中…', cls: '', kind: 'link' };
      case 'pending': return pendingText;
      case 'needLogin': return { key: 'needLogin', text: '需要重新登录（本机修改已保留）', cls: 'warn', kind: 'link' };
      case 'conflict': return { key: 'conflict', text: '云端也改过，点击处理', cls: 'warn', kind: 'conflict' };
      case 'grant': return { key: 'grant', text: '云端权限没配好（点击查看）', cls: 'warn', kind: 'link' };
      case 'badText': {
        const b = st.badText;
        return { key: 'badText', text: b && b.tradeNo ? `第 ${b.tradeNo} 笔有存不进去的字符（点击定位）` : '有存不进去的字符（点击定位）', cls: 'warn', kind: 'badText' };
      }
      case 'missingRemote': return { key: 'missingRemote', text: '云端找不到日志（点击处理）', cls: 'warn', kind: 'link' };
      case 'otherOwner': return { key: 'otherOwner', text: '本机日志属于另一个账号（点击处理）', cls: 'warn', kind: 'link' };
      case 'quota':
      case 'paused': return { key: 'quota', text: '云端暂时存不进去（点击查看）', cls: 'warn', kind: 'link' };
      case 'error': return { key: 'sync-error', text: '保存失败，点击重试', cls: 'error', kind: 'retry' };
      default:
        return { key: 'local', text: '只保存在这个浏览器里（点击登录）', cls: '', kind: 'link', title: st.configured ? '到设置页登录后，数据会同步到云端' : '云端还没配置：数据只存在这个浏览器的 IndexedDB 里。到设置页可以导出 journal.json 备份。' };
    }
  }

  /** 截图空间过了 800 MB：状态旁边多一行小字（7.11） */
  function usageNote() {
    const u = sync.state.usage;
    if (!u || !sync.state.configured) return null;
    if (u.project_bytes >= u.limit_bytes) return { cls: 'full', text: '截图空间已满' };
    if (u.project_bytes >= u.warn_bytes) return { cls: 'warn', text: `截图空间已用 ${Math.round(u.project_bytes / 1000000)} MB` };
    return null;
  }

  let saveKey = null;
  function renderSaveState(ui) {
    const v = saveStateView(ui);
    const note = usageNote();
    const key = v.key + '|' + (note ? note.text : '');
    if (key === saveKey) return;
    saveKey = key;
    const box = els.saveState;
    const hadFocus = box.contains(document.activeElement);
    box.className = 'save-state' + (v.cls ? ' ' + v.cls : '');
    box.textContent = '';
    let inner;
    if (v.kind === 'retry') {
      inner = button('btn link save-retry', v.text);
      inner.addEventListener('click', retrySave);
    } else if (v.kind === 'conflict') {
      inner = button('btn link save-retry', v.text);
      inner.addEventListener('click', openConflict);
    } else if (v.kind === 'badText') {
      inner = button('btn link save-retry', v.text);
      inner.addEventListener('click', jumpToBadText);
    } else if (v.kind === 'link') {
      inner = el('a', 'save-link', v.text);
      inner.href = '#/settings';
    } else {
      inner = el('span', null, v.text);
    }
    if (v.title) inner.title = v.title;
    box.appendChild(inner);
    if (note) box.appendChild(el('span', 'usage-note ' + note.cls, note.text));
    if (hadFocus && v.kind) inner.focus({ preventScroll: true });
  }

  /** 坏字符：跳到那一格（交易表里的格子；系统行跳到名称或说明） */
  function jumpToBadText() {
    const b = sync.state.badText;
    if (!b) { location.hash = '#/settings'; return; }
    if (routeOf(location.hash) !== 'sheet') location.hash = '#/';
    const colMap = { symbol: 'symbol', reason: 'reason', note: 'note', name: 'name', desc: 'desc', date: 'date' };
    const col = colMap[b.field];
    if (col) sheet.focusCell(b.id, col);
    else detail.open(b.id);
    showToast(`第 ${b.tradeNo || '?'} 笔的"${b.label}"里有存不进去的字符，改掉后会自动重试`);
  }

  async function retrySave() {
    if (!env.saveError && sync.state.status === 'error') {
      await sync.syncNow({ force: true });
      renderChrome();
      return;
    }
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
    if (env.cloudError) {
      list.push({ key: 'cloud-error', warn: true, text: '云端同步没能启动（' + messageOf(env.cloudError) + '）。数据照常存在这个浏览器里。请按 Ctrl+F5 刷新页面。' });
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
  const offSync = sync.subscribe(() => renderChrome());
  renderChrome();

  // ---------- 7. 同步：只有能写的标签页启动 ----------
  const startSync = () => { if (!store.get().ui.readOnly) sync.start(); };
  const offSyncStart = store.subscribe((ev) => { if (ev.type === 'ui' && ev.reason === 'readOnly') startSync(); });
  startSync();

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
      settingsView = mountSettings(els.pageSettings, store, { localdb: db, sync, openConflict });
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
    sync,
    writer,
    sheet,
    detail,
    chart,
    shots,
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
      offSync();
      offSyncStart();
      sync.destroy();
      if (settingsView) settingsView.destroy();
      link.stop();
      sheet.destroy();
      detail.destroy();
      chart.destroy();
      summary.destroy();
      offDemoUrls();
      urlCache.releaseAll();
      writer.release();
    },
  };
}

export const ready = boot().catch((err) => {
  showFatal(err);
  return null;
});
