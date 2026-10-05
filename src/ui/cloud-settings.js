// @ts-check
// 设置页里和云端有关的几块（交接文档 7.10）：登录、同步、截图空间、每日备份、冲突留底、第一次怎么配置。
// 由 ui/settings.js 挂在设置页最上面。云端没配置（src/config.js 留空）时只显示"还没连接云端"和配置说明。
// 全部 createElement / textContent；模块加载时不碰 DOM。下面几个纯函数在 tests/cloud-settings.test.js 里测。

import { formatJournal } from '../journal-format.js';
import { describeError } from '../store/errors.js';
import { confirmDialog, showToast } from './toast.js';

export const MB = 1000000;
/** doc 超过这么大（字节）时提醒按年分段（8.6） */
export const DOC_WARN_BYTES = 800 * 1000;
export const BACKUP_STALE_MS = 48 * 3600 * 1000;

/** 本地时间 2026-10-05 14:30 */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 字节 → "12.3 MB"（1 MB = 100 万字节） */
export function fmtMB(bytes) {
  const n = Number(bytes) || 0;
  return (n / MB).toFixed(n >= 100 * MB ? 0 : 1) + ' MB';
}

/**
 * 截图空间这一块的说法（7.10）。
 * @returns {{level: ''|'warn'|'full', text: string, full: boolean}}
 */
export function usageView(u) {
  const text = `截图已用 ${fmtMB(u.tj_shots_bytes)}，共 ${u.tj_shots_files} 个文件（含没被引用的）；本项目 Storage 合计 ${fmtMB(u.project_bytes)}。到 ${fmtMB(u.warn_bytes)} 提醒，到 ${fmtMB(u.limit_bytes)} 服务端不再接收新截图。（1 MB = 100 万字节）`;
  if (u.project_bytes >= u.limit_bytes) return { level: 'full', text, full: true };
  if (u.project_bytes >= u.warn_bytes) return { level: 'warn', text, full: false };
  return { level: '', text, full: false };
}

/**
 * 每日备份这一块的说法（7.10）。r 是 sync.backupStatus() 的结果。
 * @returns {Array<{level: ''|'warn', text: string}>}
 */
export function backupLines(r, now = Date.now()) {
  if (!r || !r.ok) return [{ level: '', text: (r && r.message) || '读不到备份状态' }];
  const b = r.backup;
  if (!b || !b.at) return [{ level: '', text: '还没有过自动备份' }];
  const lines = [{ level: '', text: `上次自动备份：${fmtTime(b.at)}，${Number(b.trades) || 0} 笔、${Number(b.shots) || 0} 张截图` }];
  const age = now - new Date(b.at).getTime();
  if (age > BACKUP_STALE_MS) {
    lines.push({ level: 'warn', text: `已 ${Math.floor(age / 86400000)} 天没有自动备份，去 GitHub 的 trade-journal-backup 看看 Actions` });
  }
  if (Number(b.missing) > 0) {
    lines.push({ level: 'warn', text: `日志已备份，${Number(b.missing)} 张截图没备份（多半是空间满时没传上去，见"截图空间"）` });
  }
  return lines;
}

/** 同步出问题时给用户的说明（8.4 的表） */
export function problemText(state) {
  switch (state.status) {
    case 'missingRemote': return '云端没有你的日志，本机数据还在。可能登错了账号、换了项目，或者那一行被删了。';
    case 'otherOwner': return '这个浏览器里的日志属于另一个账号。要换成当前账号的云端数据吗？换之前，本机数据会先存进冲突留底并下载一份。';
    case 'grant': return '云端权限没配好：到 Supabase 的 SQL Editor 再跑一遍 supabase/tj_0001_init.sql（可以重复运行，不丢数据）。跑完点"立即同步"。';
    case 'badText': {
      const b = state.badText;
      const where = b ? (b.tradeNo ? `第 ${b.tradeNo} 笔的"${b.label}"` : `系统行的"${b.label}"`) : '某一格';
      return `${where}里有存不进去的字符，改掉后会自动重试。`;
    }
    case 'quota': return 'Supabase 免费额度超了，去控制台的 Usage 页看看。本机照常记，额度恢复后点"立即同步"。';
    case 'paused': return '云端连不上。如果收到了 Supabase 的暂停邮件，去控制台点 Resume。本机照常记，会每分钟自动再试。';
    case 'error': return '保存失败，已停止自动重试。点"立即同步"再试；还不行就把下面这行原始信息发出来。';
    case 'needLogin': return '登录已失效，需要重新登录（本机修改已保留，登录后自动补传）。';
    case 'conflict': return '云端也改过，需要你选用哪一份。';
    case 'newer': return '云端的数据是更新版本的网站写的：网站已更新，刷新页面后才能保存。';
    default: return '';
  }
}

/** 一份留底的说明："2026-10-05 14:30 · 本机 · 16 笔" */
export function conflictEntryText(e) {
  const src = e.source === 'remote' ? '云端' : e.source === 'restore' ? '恢复前的数据' : '本机';
  const n = e.doc && Array.isArray(e.doc.rows) ? e.doc.rows.filter((r) => r && r.type === 'trade').length : 0;
  return `${fmtTime(e.at)} · ${src} · ${n} 笔`;
}

/**
 * 把云端几块画进 root（追加在最前面）。
 * @param {HTMLElement} root
 * @param {object} ctx
 * @param {any} ctx.store
 * @param {any} ctx.sync createSync 的返回值（没配置云端时 state.configured 为 false）
 * @param {any} [ctx.localdb]
 * @param {(name: string, text: string) => void} ctx.download
 * @param {() => void} [ctx.openConflict] 打开冲突对话框
 * @param {(tag: string, cls?: string|null, text?: string|null) => HTMLElement} ctx.h
 * @param {(title: string, desc?: string|null) => HTMLElement} ctx.section
 * @param {(cls: string, text: string) => HTMLButtonElement} ctx.button
 * @param {Node} [ctx.before] 插在它前面（默认最前面）
 */
export function mountCloudSections(root, ctx) {
  const { store, sync, localdb, h, section, button } = ctx;
  const doc = root.ownerDocument;
  const ac = new AbortController();
  const listen = (t, type, fn) => t.addEventListener(type, fn, { signal: ac.signal });
  const configured = !!(sync && sync.state.configured);
  const first = ctx.before || root.firstChild;
  const insert = (el) => root.insertBefore(el, first);
  const uid = 'tj-cloud-' + Math.random().toString(36).slice(2, 8);

  // ---------- 登录 ----------
  const secLogin = section('登录和云端同步');
  insert(secLogin);
  if (!configured) {
    secLogin.appendChild(h('p', 'note warn', '还没连接云端：现在数据只保存在这个浏览器里。'));
    secLogin.appendChild(h('p', 'section-desc', '连接云端以后，每个浏览器登录一次，数据就会自动同步到 Supabase（和记账共用的那个项目），截图也会传上去；换电脑登录就能看到全部数据。配置步骤：'));
    const ol = h('ol', 'steps');
    for (const s of [
      '在 Supabase 控制台进入记账在用的那个项目，Authentication → Users → Add user → Create new user，填交易日志专用的邮箱（和记账的不同，例如自己的邮箱名加 +tj）和密码，勾 Auto Confirm User。',
      '在 Authentication 的登录设置里关掉 Allow new users to sign up 和 Allow anonymous sign-ins。',
      'SQL Editor → New query → 粘贴仓库里 supabase/tj_0001_init.sql 的全文 → Run（弹出 destructive operation 提示时点 Run this query）。',
      'Storage 页确认有私有桶 tj-shots，单个文件上限 300 KB，只收 image/webp 和 image/jpeg。',
      '把项目地址（Project URL）和 publishable key（sb_publishable_ 开头）交给开发者，填进 src/config.js 和 index.html；不要给 secret key、service_role key 或密码。',
      '发布新版本后回到这里登录。详细步骤见仓库 README 的"连接云端"。',
    ]) ol.appendChild(h('li', null, s));
    secLogin.appendChild(ol);
    return { refresh() {}, destroy() { ac.abort(); } };
  }

  const loginForm = h('form', 'login-form');
  const emailLabel = h('label', null, '邮箱');
  const email = /** @type {HTMLInputElement} */ (h('input', 'text-input'));
  email.type = 'email';
  email.id = uid + '-email';
  email.autocomplete = 'username';
  emailLabel.htmlFor = email.id;
  const pwLabel = h('label', null, '密码');
  const pw = /** @type {HTMLInputElement} */ (h('input', 'text-input'));
  pw.type = 'password';
  pw.id = uid + '-pw';
  pw.autocomplete = 'current-password';
  pwLabel.htmlFor = pw.id;
  const loginBtn = h('button', 'btn primary', '登录');
  /** @type {HTMLButtonElement} */ (loginBtn).type = 'submit';
  const loginMsg = h('p', 'form-msg');
  loginMsg.setAttribute('role', 'status');
  const rowA = h('div', 'field-row');
  rowA.append(emailLabel, email);
  const rowB = h('div', 'field-row');
  rowB.append(pwLabel, pw, loginBtn);
  loginForm.append(rowA, rowB, loginMsg,
    h('p', 'note', '每个浏览器登录一次，之后一直保持。不登录也能记，数据只在这个浏览器里。'),
    h('p', 'note', '忘记密码、改密码：网站不提供，也收不到重置邮件。到 Supabase 控制台 Authentication → Users 给这个用户设新密码（做法见 README"换电脑、改密码、忘记密码"），然后更新备份仓库的 TJ_PASSWORD，在显示"需要重新登录"的浏览器里重新登录。'));
  const signedBox = h('div', 'signed-box');
  const signedText = h('p', null, '');
  const signOutBtn = button('btn', '退出登录（只退出这个浏览器）');
  signedBox.append(signedText, signOutBtn);

  const syncBox = h('dl', 'about-list');
  const dItem = (label) => {
    syncBox.append(h('dt', null, label));
    const dd = h('dd');
    syncBox.append(dd);
    return dd;
  };
  const ddState = dItem('同步状态');
  const ddLast = dItem('上次同步成功');
  const ddRev = dItem('云端版本号');
  const ddSize = dItem('日志大小');
  const syncBtnRow = h('div', 'btn-row');
  const syncNowBtn = button('btn', '立即同步');
  syncBtnRow.append(syncNowBtn);
  const problem = h('div', 'problem-box');
  problem.setAttribute('role', 'status');
  secLogin.append(loginForm, signedBox, syncBox, syncBtnRow, problem);

  listen(loginForm, 'submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !pw.value) {
      loginMsg.textContent = '请填邮箱和密码';
      return;
    }
    loginBtn.setAttribute('aria-disabled', 'true');
    loginMsg.className = 'form-msg';
    loginMsg.textContent = '正在登录…';
    const r = await sync.signIn(email.value, pw.value);
    loginBtn.removeAttribute('aria-disabled');
    if (r.ok) {
      pw.value = '';
      loginMsg.textContent = '';
      showToast('已登录，开始同步');
    } else {
      loginMsg.className = 'form-msg warn';
      loginMsg.textContent = r.message;
    }
    refresh();
  });
  listen(signOutBtn, 'click', async () => {
    const ok = await confirmDialog({
      title: '退出登录？',
      message: '只退出这个浏览器：本机数据都留着，别的电脑上的交易日志不受影响，记账也不受影响。没同步的修改要等下次登录后才会传上去。',
      confirmText: '退出登录',
      initialFocus: 'cancel',
    });
    if (!ok) return;
    await sync.signOut();
    showToast('已退出登录（只退出了这个浏览器）');
    refresh();
  });
  listen(syncNowBtn, 'click', async () => {
    syncNowBtn.setAttribute('aria-disabled', 'true');
    await sync.syncNow({ force: true });
    syncNowBtn.removeAttribute('aria-disabled');
    refresh();
  });

  // ---------- 截图空间 ----------
  const secUsage = section('截图空间');
  insert(secUsage);
  const usageText = h('p', 'note');
  const usageSteps = h('ol', 'steps');
  usageSteps.hidden = true;
  for (const s of [
    '确认要删的旧图已经在备份仓库 trade-journal-backup 的 shots/ 里（最近一次备份在 48 小时内即可）。',
    '在 Supabase 的 SQL Editor 运行 README"桶满后的出路"里那句只读查询，列出最早的一批交易文件夹；到控制台 Storage → tj-shots → <你的 user_id>/shots/ 删掉最早的一批，删到 800 MB 以下。',
    '回到这里看用量降下来，点"重试上传"，把空间满时没传上去的图补上（不点也会在下次同步时自动补）。',
  ]) usageSteps.appendChild(h('li', null, s));
  const rejectedText = h('p', 'note warn');
  const retryBtn = button('btn', '重试上传');
  const rejectedRow = h('div', 'btn-row');
  rejectedRow.append(rejectedText, retryBtn);
  secUsage.append(usageText, usageSteps, rejectedRow);
  listen(retryBtn, 'click', async () => {
    retryBtn.setAttribute('aria-disabled', 'true');
    await sync.retryRejected();
    retryBtn.removeAttribute('aria-disabled');
    refresh();
  });

  // ---------- 每日备份 ----------
  const secBackup = section('每日备份', '每天北京时间 2 点多，GitHub 私有仓库 trade-journal-backup 自动备份一次日志和新截图（配置见 backup/README.md）。');
  insert(secBackup);
  const backupBox = h('div', 'backup-lines');
  backupBox.appendChild(h('p', 'note', '正在读…'));
  secBackup.appendChild(backupBox);
  async function loadBackup() {
    const r = await sync.backupStatus();
    if (ac.signal.aborted) return;
    backupBox.textContent = '';
    for (const line of backupLines(r)) backupBox.appendChild(h('p', 'note' + (line.level ? ' ' + line.level : ''), line.text));
  }

  // ---------- 冲突留底 ----------
  const secKept = section('冲突留底', '冲突时没选中的那一份、从 journal.json 恢复前的数据，都存在这个浏览器里，可以下载下来用"从 journal.json 恢复"放回去。');
  insert(secKept);
  const keptList = h('ul', 'kept-list');
  secKept.appendChild(keptList);
  async function loadKept() {
    if (!localdb || typeof localdb.listConflicts !== 'function') return;
    let list = [];
    try { list = await localdb.listConflicts(); } catch (err) { list = []; }
    if (ac.signal.aborted) return;
    keptList.textContent = '';
    if (!list.length) {
      keptList.appendChild(h('li', 'note', '没有留底'));
      return;
    }
    for (const e of list) {
      const li = h('li', 'kept-item');
      const dl = button('btn', '下载');
      const del = button('btn', '删除');
      li.append(h('span', null, conflictEntryText(e)), dl, del);
      dl.addEventListener('click', () => {
        const stamp = String(e.at || '').replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
        ctx.download(`journal-留底-${e.source === 'remote' ? '云端' : e.source === 'restore' ? '恢复前' : '本机'}-${stamp}.json`, formatJournal(e.doc));
      });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: '删除这份留底？', message: conflictEntryText(e) + '。删除后不能恢复，建议先下载。', confirmText: '删除', danger: true, initialFocus: 'cancel' });
        if (!ok) return;
        try {
          await localdb.deleteConflict(e.key);
        } catch (err) {
          showToast('没能删除：' + (err && err.message ? err.message : String(err)));
        }
        loadKept();
      });
      keptList.appendChild(li);
    }
  }

  // ---------- 刷新 ----------
  const statusText = {
    off: '没配置云端', signedOut: '没登录：只保存在这个浏览器里', needLogin: '需要重新登录（本机修改已保留）', synced: '已保存到云端',
    syncing: '保存中…', pending: '有未同步的修改（自动重试中）', paused: '云端暂时存不进去', conflict: '云端也改过，等你处理',
    grant: '云端权限没配好', badText: '有存不进去的字符', quota: '云端暂时存不进去（额度）', error: '保存失败',
    missingRemote: '云端找不到日志', otherOwner: '本机日志属于另一个账号', newer: '网站已更新，刷新页面后才能保存',
  };

  let lastStatus = null;
  function refresh() {
    const st = sync.state;
    const hasSession = sync.hasSession();
    const signedIn = hasSession && st.status !== 'needLogin';
    loginForm.hidden = signedIn;
    signedBox.hidden = !signedIn;
    signedText.textContent = st.email ? `已登录：${st.email}` : '已登录（正在核对账号…）';
    syncBox.hidden = !hasSession && st.status === 'signedOut';
    ddState.textContent = (statusText[st.status] || st.status) + (st.pending && st.status === 'synced' ? '（有未同步的修改）' : '');
    ddLast.textContent = st.lastSyncAt ? fmtTime(st.lastSyncAt) : '还没有';
    ddRev.textContent = st.remoteRev === null || st.remoteRev === undefined ? '—' : String(st.remoteRev);
    let bytes = 0;
    try { bytes = new TextEncoder().encode(formatJournal(store.realJournal())).length; } catch (err) { bytes = 0; }
    ddSize.textContent = `${(bytes / 1000).toFixed(1)} KB` + (bytes > DOC_WARN_BYTES ? '：日志快到 1 MB 了，该按年分段存了（见 README）' : '');
    ddSize.className = bytes > DOC_WARN_BYTES ? 'warn' : '';
    syncBtnRow.hidden = !hasSession;

    problem.textContent = '';
    const text = problemText(st);
    if (text && st.status !== 'signedOut') {
      problem.appendChild(h('p', 'note warn', text));
      if (st.status === 'missingRemote') {
        const b = button('btn', '用本机数据重建云端');
        b.addEventListener('click', async () => { await sync.rebuildCloud(); refresh(); });
        problem.appendChild(b);
      } else if (st.status === 'otherOwner') {
        const a = button('btn', '换成当前账号的云端数据');
        a.addEventListener('click', async () => { await sync.adoptAccountData(); refresh(); loadKept(); });
        const b = button('btn', '退出当前账号');
        b.addEventListener('click', async () => { await sync.signOut(); refresh(); });
        const row = h('div', 'btn-row');
        row.append(a, b);
        problem.appendChild(row);
      } else if (st.status === 'conflict' && ctx.openConflict) {
        const b = button('btn primary', '处理冲突');
        b.addEventListener('click', () => ctx.openConflict && ctx.openConflict());
        problem.appendChild(b);
      }
      if (st.error && ['grant', 'badText', 'quota', 'paused', 'error'].includes(st.status)) {
        problem.appendChild(h('p', 'note mono', '原始信息：' + describeError(st.error)));
      }
    }

    // 截图空间
    if (!hasSession) {
      usageText.className = 'note';
      usageText.textContent = '登录后显示云端截图空间的用量。';
      usageSteps.hidden = true;
    } else if (st.usage) {
      const v = usageView(st.usage);
      usageText.className = 'note' + (v.level === 'full' ? ' full' : v.level === 'warn' ? ' warn' : '');
      usageText.textContent = (v.full ? '截图空间已满：服务端不再接收新截图。' : '') + v.text;
      usageSteps.hidden = !v.full && v.level !== 'warn';
    } else {
      usageText.className = 'note';
      usageText.textContent = st.usageError ? '读不到用量' : '正在读用量…';
      usageSteps.hidden = true;
    }
    rejectedRow.hidden = !(st.rejectedShots > 0);
    rejectedText.textContent = `${st.rejectedShots} 张截图没传上去（空间满时被拒的会在空间回落后自动重传；提示"太大或类型不对"的，请在单笔详情里删掉重新粘贴）`;

    if (st.status !== lastStatus) {
      lastStatus = st.status;
      loadKept();
    }
  }

  const off = sync.subscribe(() => refresh());
  const offStore = store.subscribe((ev) => { if (ev.type !== 'ui') refresh(); });
  refresh();
  loadBackup();
  loadKept();
  if (sync.hasSession()) sync.refreshUsage();

  return {
    refresh,
    destroy() {
      off();
      offStore();
      ac.abort();
    },
  };
}
