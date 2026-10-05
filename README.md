# 交易日志

只给自己用的交易日志网站。像 Excel 一样一行记一笔交易；换交易系统时插入一整行"系统行"，之后的交易记在它下面、各系统单独统计；自动算胜率、实际盈亏比、期望值等，并画累计 R 曲线。红色表示盈利，绿色表示亏损。

纯静态网页（原生 HTML/CSS/JavaScript，没有构建步骤、没有框架、不装依赖），部署在 GitHub Pages：<https://michael-l340.github.io/trade-journal/>。

数据只保存在你当前这个浏览器里（IndexedDB）。换浏览器、换电脑或清除网站数据都会看不到原来的记录，所以请在设置页定期"导出 journal.json"备份，需要时再"从 journal.json 恢复"。

## 本地预览

ES 模块不能双击 `index.html` 用 `file://` 打开，要先起一个本地服务器。在这个目录里运行：

```bash
python3 -m http.server
```

然后用浏览器打开 <http://localhost:8000/>。

如果浏览器控制台提示 MIME type 错误（Windows 上的 Python 偶尔会把 `.js` 当成 `text/plain`），改在 WSL 里运行同一条命令。

## 跑测试

需要 Node.js 20 或更新版本，不用安装任何东西：

```bash
node --test tests/
```

- `tests/index.js` 只负责把所有 `*.test.js` 汇总起来，让这条命令在 Node 22 上也能直接用。
- `package.json` 只是告诉 Node 这些 `.js` 文件是 ES 模块，里面没有任何依赖。
- `fixtures/sample-journal.json` 是交接文档附录 A 的示例数据，`fixtures/sample-expected.json` 是附录 B 的预期结果，计算模块的测试逐项对照它们。

## 注意

- 这是公开仓库：不要把导出的 `journal.json`、CSV 或截图放进这个目录（`.gitignore` 已经挡掉了常见的文件名）。
- 浏览器的 localStorage 只用来放设置，键名一律以 `tj_` 开头。
