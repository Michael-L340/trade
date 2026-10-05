// @ts-check
// 云端错误分类（交接文档 8.4 的表），纯函数，不碰网络和 DOM。
// 不照抄记账 api.ts 的 isPermanentError：那里把 42 开头的错误码一律当"数据被拒"，这里会把登录失效当成永久失败。
//
// 输入是 remote.js 归一过的错误：
//   { source: 'db'|'rpc'|'storage'|'auth', network?: boolean, status?: number, code?: string, statusCode?: string, message?: string }
//   - db / rpc（PostgREST）：status 是真实的 HTTP 状态，code 是 SQLSTATE 或 PGRST 码；fetch 抛错或超时时 status 为 0、network 为真。
//   - storage：业务错误回 HTTP 400，真实错误码在返回体的 statusCode（字符串）里；5xx、429 是真实的 HTTP 状态。
//
// 输出（kind）：
//   'network'   断网、超时、5xx、429：自动退避重试
//   'auth'      可能要重新登录：401（含没会话时的 42501）、PGRST301、PGRST303；先核对会话
//   'grant'     缺授权：403 加 42501（已登录）；停下，提示再跑一遍 tj_0001_init.sql
//   'conflict'  PT409（触发器拒绝了不是加 1 的 rev，HTTP 409）：先核对"保存响应丢失"
//   'duplicate' 第一次保存撞主键 23505：同上
//   'badText'   22P05、22P02：文本里有存不进去的字符，停下并指出是哪一格
//   'quota'     402，或写入报 25006（数据库只读）：额度超限，停下
//   'exists'    截图已存在（Storage statusCode '409'）：当成已上传
//   'denied'    截图被拒（Storage statusCode '403'）：查用量分辨是会话、空间满还是缺授权
//   'tooBig'    截图太大或类型不对（Storage statusCode '413'、'415'）：标成被拒，不自动重传
//   'notFound'  云端没有这张图（Storage statusCode '404'）：先查一次 rev 分辨是不是会话问题
//   'other'     都对不上：停止自动重试，"保存失败，点击重试"

/** @typedef {{source?: string, network?: boolean, status?: number, code?: string, statusCode?: string, message?: string}} RemoteError */

/** 停下来等用户动手的几种（不再自动重试） */
export const STOPPING_KINDS = Object.freeze(['grant', 'badText', 'quota', 'other']);

/**
 * @param {RemoteError|null|undefined} e
 * @returns {'network'|'auth'|'grant'|'conflict'|'duplicate'|'badText'|'quota'|'exists'|'denied'|'tooBig'|'notFound'|'other'|null}
 */
export function classifyError(e) {
  if (!e) return null;
  const status = typeof e.status === 'number' ? e.status : 0;
  const code = typeof e.code === 'string' ? e.code : '';
  const sc = e.statusCode === undefined || e.statusCode === null ? '' : String(e.statusCode);

  if (e.network || (status === 0 && !sc)) return 'network';
  if (status >= 500 || status === 429) return 'network';

  if (e.source === 'storage') {
    if (/^5\d\d$/.test(sc) || sc === '429') return 'network';
    if (status === 401 || sc === '401') return 'auth';
    if (sc === '409') return 'exists';
    if (sc === '403') return 'denied';
    if (sc === '413' || sc === '415') return 'tooBig';
    if (sc === '404') return 'notFound';
    if (status === 402 || sc === '402') return 'quota';
    return 'other';
  }

  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') return 'auth';
  if (code === '42501') return status === 403 ? 'grant' : 'auth';
  if (status === 403) return 'grant';
  if (code === 'PT409') return 'conflict';
  if (code === '23505') return 'duplicate';
  if (code === '22P05' || code === '22P02') return 'badText';
  if (status === 402 || code === '25006') return 'quota';
  if (e.source === 'auth' && status === 400) return 'auth';
  return 'other';
}

/**
 * 给设置页看的原始信息："HTTP 403 · 42501 · permission denied for table tj_journal"
 * @param {RemoteError|null|undefined} e
 */
export function describeError(e) {
  if (!e) return '';
  const parts = [];
  parts.push(e.network ? '网络错误（没连上或超时）' : 'HTTP ' + (e.status || 0));
  if (e.code) parts.push('错误码 ' + e.code);
  if (e.statusCode) parts.push('statusCode ' + e.statusCode);
  if (e.message) parts.push(String(e.message));
  return parts.join(' · ');
}
