# vendor/

## supabase.js

- 是什么：官方 `@supabase/supabase-js` **2.117.2** 的 UMD 单文件，原样放进来，一个字节都没改。
- 来源：<https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js>（只用固定版本号的地址，不用 `@2` 这种会自己变的）
- 大小：217,945 字节
- sha256：`59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd`（2026-10-05 下载后核对，和交接文档 9.5 写的一致）
- 文件里没有 `eval` 和 `new Function`，在 `index.html` 的内容安全策略（不允许 unsafe-eval）下能跑。

为什么用它：网站不构建、不装 npm 包；supabase-js 是唯一的第三方库，用官方单文件、放在自己仓库里，不从 CDN 现拉（同源的其他站点也在这个源下，第三方脚本不进来）。`index.html` 先用普通 `<script>` 加载它（定义全局变量 `supabase`），再加载 `src/main.js`；只有 `src/store/remote.js` 读 `globalThis.supabase`。

核对办法：

```bash
sha256sum vendor/supabase.js
# 59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd  vendor/supabase.js
```

`tests/guard.test.js` 也会核对这个 sha256。升级时：下载新版本 → 重新算 sha256 → 改这里和 `tests/guard.test.js` 里的值 → 跑 `node --test tests/`（`tests/remote.contract.test.js` 用真的这个文件检查请求的样子）。
