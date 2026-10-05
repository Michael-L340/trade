// @ts-check
// 云端（Supabase）的项目地址和 publishable key。两者都是公开级别的值，可以放进公开仓库（8.8）；
// 数据靠数据库的行级安全策略（RLS）保护。secret key、service_role key、密码永远不写进这里或任何文件。
//
// 填法见 README"连接云端"：
//   SUPABASE_URL             控制台 Connect 弹窗或 Project Settings → Data API 里的 Project URL，形如 https://abcdefghijklmnop.supabase.co
//   SUPABASE_PUBLISHABLE_KEY Project Settings → API Keys 里 sb_publishable_ 开头的那个
// 填好后把 index.html 内容安全策略（CSP）里的 https://*.supabase.co 换成同一个地址（tests/guard.test.js 会检查两边一致）。

export const SUPABASE_URL = 'https://rmzabflrcojcrghgqnsq.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_s31gRT2Ucxt5-FrfczLqSQ_RKpt_dbA';

/** 两个值都填了、样子也对，才算配置好了 */
export function cloudConfigured(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
}
