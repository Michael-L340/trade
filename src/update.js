// @ts-check
// 网站更新：看线上 src/version.js 的版本号，比这个页面新就提示；点"更新"时把本页用到的文件都重新下载一遍再刷新。
// 不用 Service Worker（和记账同源），浏览器按 HTTP 缓存（GitHub Pages 默认 10 分钟）可能还拿着旧文件，所以要逐个 cache: 'reload'。

/** 从 version.js 的源码里取出版本号；取不到返回 null */
export function parseVersion(text) {
  const m = /APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(typeof text === 'string' ? text : '');
  return m ? m[1] : null;
}

/** a 比 b 新返回 true（三段数字逐段比） */
export function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** 线上最新的版本号；网络不通返回 null */
export async function fetchLatestVersion(base = document.baseURI) {
  try {
    const res = await fetch(new URL('src/version.js', base), { cache: 'no-store' });
    return res.ok ? parseVersion(await res.text()) : null;
  } catch (err) {
    return null;
  }
}

/** 本页加载过的同源文件（页面、脚本、样式、图标），逐个绕过缓存重新下载，然后刷新页面 */
export async function reloadFresh() {
  const urls = new Set([location.href.split('#')[0]]);
  for (const e of performance.getEntriesByType('resource')) {
    try {
      const u = new URL(e.name);
      if (u.origin === location.origin && /\.(js|css|svg|html)$/.test(u.pathname)) urls.add(u.href);
    } catch (err) { /* 忽略 */ }
  }
  await Promise.all([...urls].map((u) => fetch(u, { cache: 'reload' }).catch(() => null)));
  location.reload();
}
