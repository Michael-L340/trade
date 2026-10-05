// @ts-check
// 网站版本号（三段式，和 package.json 的 version 保持一致）。页面底部、设置页"关于"、写进数据的 appVersion 都从这里读。
// 不要手改：发布脚本 scripts/deploy.sh 会把 package.json 和这个文件一起改（第三位 +1，或传 minor），并打 tag。
// tests/version.test.js 检查两处一致。
export const APP_VERSION = '0.3.0';
