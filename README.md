# 交易日志

只给自己用的交易日志网站。像 Excel 一样一行记一笔交易；可以同时用几个交易系统，每个系统一块（深蓝色系统行 + 它的交易），各系统单独统计，顶部统计和曲线按日期合起来算；盈亏格右边的小字是这一笔实际赚了几个 R；自动算胜率、实际盈亏比、期望值等，并画累计 R 曲线。蓝色表示盈利，橙色表示亏损。

纯静态网页（原生 HTML/CSS/JavaScript，没有构建步骤、没有框架、不装依赖），部署在 GitHub Pages：<https://michael-l340.github.io/trade-journal/>。

数据先存在这个浏览器里（IndexedDB），断网照常记。连接云端（Supabase，和记账共用同一个项目，见下面"连接云端"）并登录后，自动同步到云端，换电脑登录就能看到全部数据和截图。没连接、没登录时数据只在这个浏览器里，请在设置页定期"导出 journal.json"备份。

## 怎么用

- 在哪个系统下面点「＋ 记一笔」，就在那个系统最后加一行，填盈亏比后止盈金额立刻算出。出场后在"盈亏"格打「盈」或「亏」（按系统止盈或止损），也可以点"结果"格选；打实际金额表示没按系统做，会标「改」。
- 日期默认今天，品种和止损金额沿用上一笔，方向默认"多"（点一下切换）。
- 新建系统：点表格下面的"＋ 新建一个系统"；要把一个系统从中间拆开，在某一笔的行号上点右键"在上方插入系统行"。
- 点行号打开单笔详情，写开仓理由和备注。
- 还没有交易时，表格下面有"看看示例数据"：载入一份编好的示例随便试，不会保存，点顶上的"退出示例"回到自己的数据。
- 同时开了两个标签页时，后打开的那个只能看（顶上有提示），关掉前一个后它自动变成可以修改。

## 截图

- **加图**：打开单笔详情后，在页面任何地方按 Ctrl+V，剪贴板里的图片就加到这一笔；也可以点详情里的虚线框"Ctrl+V 粘贴截图"选图片文件，或者把图片文件拖进详情。在交易表里，光标在某一行任意一格时按 Ctrl+V，图片加到这一行。剪贴板里只有文字时照常粘贴文字。
- **标签**：新截图默认是"开仓时"（这一笔还没出场）或"平仓后"（已出场）。在详情里点缩略图下面的标签，在 开仓时 → 平仓后 → 无 之间切换。
- **压缩**：图片在浏览器里处理，长边超过 1920 像素的等比缩小，存成 WebP（浏览器不支持时存 JPEG），单张尽量压到 250 KB 以内，另存一张宽 240 像素的缩略图。
- **存在哪**：图片文件存在这个浏览器的 IndexedDB 里（和交易数据在同一个本机数据库），交易数据里只记截图的编号、标签、尺寸和文件路径（`shots/<交易 id>/<截图 id>.webp`）。登录后会传到云端的私有桶 `tj-shots`（先传图、再存日志）。示例模式里贴的图只在内存里，退出示例或刷新就没了。
- **导出不含图片**：导出的 `journal.json` 只记录有哪些截图，不含图片本身。在别的浏览器或电脑上恢复后，截图位置显示"文件不在本机"，不影响其他数据。登录云端后，截图会传到私有桶 `tj-shots`，别的电脑登录后点开时自动下载。
- **怎么删**：在详情里把鼠标移到缩略图上，点出现的"删除"，页内确认后删掉；底部提示 10 秒内点"撤销"可以把图片和记录原样放回来。删除整笔交易时，它的截图文件暂时留在浏览器里（这一版不做清理），撤销删除交易后截图照常显示。

## 连接云端（第一次，照着做）

云端还没配置时（`src/config.js` 里是空的），网站照常只存本机，设置页显示"还没连接云端"。下面标 **你** 的步骤在网页上点，标 **开发者** 的交给 AI 做。

1. **你**：登录 Supabase 控制台，进入记账在用的那个项目。先打开组织的 Usage 页，记下 Storage 和 Egress 的用量，确认还有余量；再确认这个组织里除了记账这个项目，没有别的项目在用 Storage（截图 900 MB 的上限只数得到本项目）。
2. **你**：建交易日志专用的用户：Authentication → Users → Add user → Create new user。邮箱用和记账**不同**的（例如自己的邮箱名加 `+tj`），密码自己生成、存进密码管理器（不要发给 AI，也不要写进任何文件），勾选 **Auto Confirm User**。
3. **你**：关注册和匿名登录：Authentication 的登录设置（控制台版本不同，叫 Sign In / Providers 或 Settings）里关掉 **Allow new users to sign up** 和 **Allow anonymous sign-ins**。这两项对整个项目生效，记账是单用户，不受影响。
4. **你**：建表：SQL Editor → New query → 把仓库里 [`supabase/tj_0001_init.sql`](supabase/tj_0001_init.sql) 全文粘贴进去 → Run。弹出 destructive operation 提示时点 **Run this query**（脚本里删掉重建的只有策略和触发器，不动任何数据；可以重复运行）。看到 Success 后跑文件末尾的"自检"：把那几句开头的 `-- ` 去掉，**逐句选中后点 Run selected**，每句结果都要和注释写的一致；`storage.objects` 上多出别的策略就停下告诉开发者。
5. **你**：检查截图桶：Storage 页能看到 `tj-shots`（Private），打开桶的设置，确认单个文件上限 300 KB、允许的类型是 `image/webp` 和 `image/jpeg`。以第 4 步自检查到的 `file_size_limit` 为准：不是 307200，就在 SQL Editor 运行 `update storage.buckets set file_size_limit = 307200 where id = 'tj-shots';`。
   - **如果第 4 步停在建桶那一句报错**：在 Storage 页点 New bucket 手工建（名字 `tj-shots`，不勾 Public，打开 Restrict file upload size 填 300 KB，Allowed MIME types 填 `image/webp` 和 `image/jpeg`），再把 SQL 里"4. 截图桶"那一段（`insert into storage.buckets …` 那一句）删掉，整段重跑一遍，让后面的函数和策略建好。
6. **你**：把两样东西告诉开发者：项目地址（控制台顶栏 Connect 弹窗，或 Project Settings → Data API 里的 Project URL，形如 `https://xxxx.supabase.co`）和 publishable key（Project Settings → API Keys，`sb_publishable_` 开头，没有就点创建）。**不要**复制 secret key、service_role key，也不要给密码。
7. **开发者**：把这两个值填进 `src/config.js`，并把 `index.html` 内容安全策略里的 `https://*.supabase.co` 换成同一个项目地址（`tests/guard.test.js` 检查两边一致），测试全绿后提交；经你点头后发布（见"版本号和发布"）。
8. **你 + 开发者**：发布后先用一个临时测试用户、在另一个浏览器配置文件里跑一遍交接文档 10.4 的冒烟测试（截图上传下载、重复上传、会话、桶的限制、900 MB 拒收、用量对得上、注册和匿名登录确实关了）。都通过后，你才在日常浏览器打开网站 → 设置 → 登录交易日志的账号。第一次同步会把这个浏览器里已经记下的数据和截图传上去。
9. **每日备份**：见 [`backup/README.md`](backup/README.md)。

### 同步怎么工作

- 每次修改先存本机，停手 2 秒后（连续修改最长 10 秒）传到云端；截图先传，传完才存日志，云端的日志不会引用云端没有的图。
- 页面打开着、看得见时每 60 秒查一次云端的版本号（几十字节），变了才拉整份。
- 顶栏的状态文字可以点：去设置页对应的那一块；"云端也改过"打开冲突框；"保存失败"立即重试。
- 两台设备都改过（冲突）：弹框写明两边各多了、改了几笔，选"用云端的"或"用这台电脑上的"。没选中的那一份先存进设置页"冲突留底"，并自动下载一份 `journal-落选-….json`，不会丢。
- 退出登录只退出这个浏览器，本机数据都在；别的电脑和记账都不受影响。

### 换电脑、改密码、忘记密码

- **换电脑**：在新浏览器打开网址，设置页登录一次。数据马上拉下来，截图点开时下载并存在本机。
- **改密码、忘记密码**：网站不提供，交易日志的邮箱也收不到重置邮件，两种情况走同一条路：在控制台给这个用户设新密码。先看 Authentication → Users → 这个用户，有没有直接设新密码的入口；没有的话在 SQL Editor 运行下面这句（里面有明文密码，跑完到 SQL Editor 的历史里删掉它）：

  ```sql
  update auth.users
     set encrypted_password = extensions.crypt('<新密码>', extensions.gen_salt('bf'))
   where email = '<交易日志的邮箱>';
  ```

  改完还要：在自己电脑的终端运行 `gh secret set TJ_PASSWORD -R Michael-L340/trade-journal-backup` 粘贴新密码（否则第二天起备份登录失败）；哪个浏览器显示"需要重新登录"，就在那里登录一次。（这条做法要在冒烟测试时用测试用户实际走一遍，确认后再信它。）

### 历史版本

云端每次保存前，旧的那份自动存进 `tj_journal_history`，只留最近 30 份。网站里不做浏览，要用时在 SQL Editor 里取：

```sql
-- 最近 30 份旧版本，新的在上面
select id, rev, saved_at, replaced_at, length(doc::text) as bytes
  from public.tj_journal_history
 where user_id = (select id from auth.users where email = '<交易日志的邮箱>')
 order by id desc;

-- 取出某一版（id 用上面查到的）：把结果复制存成 journal.json，再走设置页的"从 journal.json 恢复"
select doc from public.tj_journal_history where id = 123;
```

### 截图空间满了怎么办

截图服务端硬上限：本项目 Storage 合计到 800 MB 设置页变黄提醒，到 900 MB 服务端拒收新截图（保证撑不爆和记账共用的 1 GB）。拒收期间贴的图留在本机、日志照常同步，顶栏显示"n 张截图没传上去"。腾地方：

1. 确认要删的旧图已经在备份仓库 `trade-journal-backup` 的 `shots/` 里（最近一次备份在 48 小时内即可）。
2. 在 SQL Editor 运行下面这句（只读），列出最早的一批交易文件夹和各占多少空间；照这张单子，到控制台 Storage → `tj-shots` → `<你的 user_id>/shots/` 删掉最早的一批，删到 800 MB 以下（网站本身删不了云端截图）：

   ```sql
   select split_part(name, '/', 3) as trade_id,
          min(created_at)          as first_at,
          count(*)                 as files,
          round(sum((metadata ->> 'size')::bigint) / 1e6, 1) as mb
     from storage.objects
    where bucket_id = 'tj-shots'
      and name like (select id::text from auth.users where email = '<交易日志的邮箱>') || '/%'
    group by 1
    order by 2
    limit 100;
   ```

3. 回设置页，看用量降下来，点"重试上传"把没传上去的图补上（不点也会在下次同步时自动补）。

日志（doc）每次保存整份上传，设置页显示它的大小；超过 800 KB 变黄时，就该改成按年分段存了（还没做）。

## 本地预览

ES 模块不能双击 `index.html` 用 `file://` 打开，要先起一个本地服务器。在这个目录里运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

然后用浏览器打开 <http://localhost:8000/>。看完在终端按 Ctrl+C 关掉服务器。

如果浏览器控制台提示 MIME type 错误（Windows 上的 Python 偶尔会把 `.js` 当成 `text/plain`），改在 WSL 里运行同一条命令。

本地预览的数据存在 `localhost:8000` 这个地址下，和 GitHub Pages 上的网站是两份，互不影响。要在本地连云端调试，请在控制台另建一个测试用户，不要用真账号；测完按交接文档 10.4 第 11 条的顺序清理（先删它在两张表里的行，再删它的截图文件夹，最后删用户）。

## 跑测试

需要 Node.js 20 或更新版本，不用安装任何东西：

```bash
node --test tests/
```

- 云端同步用 `tests/fake-supabase.js` 里的假 supabase（内存里模拟表、rev 乐观锁、历史表、截图桶、登录）跑各条时序：第一次同步、正常保存、拉取、冲突两种选法、保存响应丢失后核对、同 rev 重发、存上后别处又存、云端那一行没了、23505、401 换令牌、换令牌碰上断网、SIGNED_OUT、403 缺授权、坏字符、先图后文、断网补传、截图 409/403/413、版本守卫、只读不发请求。`tests/remote.contract.test.js` 用 `node:vm` 加载真的 `vendor/supabase.js`，检查发出去的请求长什么样。`tests/guard.test.js` 守源码规矩（只有 remote.js 碰 supabase、退出必须 scope local、没有密钥样子的字符串、CSP 和 config 一致等）。
- 测的是不碰页面的部分：计算（附录 A 的示例数据逐项对照附录 B 的预期结果）、显示格式和输入解析、数据校验和序列化、CSV、内存状态、本机存储（用 `tests/fakes.js` 里的假 IndexedDB 和 Web Locks）、表格的键盘规则、设置页的检查逻辑、截图的缩放规划和降质步骤、截图增删和撤销（假的图片处理和假 IndexedDB）、Blob 地址的释放。
- `tests/index.js` 只负责把所有 `*.test.js` 汇总起来，让这条命令在 Node 22 上也能直接用；`package.json` 只是告诉 Node 这些 `.js` 文件是 ES 模块，里面没有任何依赖。

## 版本号和发布

- 版本号是三段式，写在 `package.json` 的 `version`，`src/version.js` 是给浏览器读的同一个数（测试检查两处一致）。页面底部、设置页"关于"都显示它；每次保存会把它写进数据的 `appVersion`。
- 版本守卫：读到 `appVersion` 比这个页面新的数据（开了几天没刷新的旧标签页），或者 `schemaVersion` 更大的数据，这一页只读，顶上显示"网站已更新，刷新页面后才能保存"。按 Ctrl+F5 刷新就好，本机修改不会丢。
- GitHub Pages 从 `main` 分支根目录发布：**推到 `main` 就是上线**。平时的改动提交在 `dev` 分支，不会上线。
- **发布前要先问用户，用户点头后才运行**：

  ```bash
  bash scripts/deploy.sh          # 第三位 +1，例如 0.2.0 → 0.2.1
  bash scripts/deploy.sh minor    # 大功能：第二位 +1，例如 0.2.5 → 0.3.0
  ```

  脚本按顺序：检查工作区干净、当前提交包含线上的 `main` → 跑测试 → 改版本号、提交、打 tag → `git push origin HEAD:main --follow-tags` → 等 Pages 构建完成、确认网站 200 并且线上版本号是新的。哪一步不过就停下。不要手改版本号。
- 改坏了用 `git revert` 生成新提交，再发布一次（版本号照常 +1）；不要 `reset` 加 force push。

## 文件结构

```
index.html            页面骨架（内容安全策略、顶栏、概览、表格、设置页、详情弹层的位置）
styles.css            全部样式（第一部分取自认可过的预览稿）
favicon.svg           浏览器标签页上的小图标
.nojekyll             让 GitHub Pages 不经过 Jekyll 处理
src/
  version.js          网站版本号（和 package.json 一致，发布脚本一起改）
  journal-format.js   journal.json 的固定写法（导出、算哈希、备份共用）
  main.js             启动和路由：打开本机存储、选出唯一写者、挂上各部分界面、#/ 和 #/settings
  state.js            内存状态和全部修改操作（界面只能通过它改数据）
  model.js            id、新建行、文字清洗、数据校验、版本迁移、固定格式的 journal.json
  calc.js             计算：单笔止盈/盈亏/R、按系统分段、统计、样本提示
  format.js           数字和日期的显示与解析（负号用 −）
  csv.js              导出 CSV（Excel 打开中文不乱码）
  config.js           云端的项目地址和 publishable key（公开级别；现在留空）
  diff.js             冲突摘要：按行 id 比两边多了、改了、删了几笔
  store/localdb.js    IndexedDB 存取、自动保存、多标签页（Web Locks、BroadcastChannel）、同步状态、冲突留底
  store/remote.js     唯一碰 supabase-js 的文件：登录、查 rev、带版本保存、截图上传下载、用量
  store/sync.js       同步状态机：先图后文、rev 乐观锁、保存响应丢失的核对、冲突、出错分类和退避重试
  store/errors.js     云端错误分类（交接文档 8.4 的表）
  images.js           截图压缩：缩放、WebP/JPEG 编码、降质和缩小、缩略图
  shots.js            截图的增删改、示例模式的内存文件、Blob 地址缓存
  ui/sheet.js         交易表：格子编辑、键盘、中文输入法、系统行、行操作和撤销、截图格和行内粘贴
  ui/summary.js       顶部统计
  ui/chart.js         累计 R 曲线（SVG）
  ui/detail.js        单笔详情弹层：截图大图、缩略图、标签、删除和撤销、粘贴/选文件/拖放
  ui/settings.js      设置页：金额单位、导出/恢复 journal.json、导出 CSV、关于
  ui/cloud-settings.js 设置页的云端几块：登录、同步、截图空间、每日备份、冲突留底、配置说明
  ui/conflict.js      冲突对话框
  ui/toast.js         底部提示（可撤销）和页内确认框
vendor/supabase.js    官方 supabase-js 2.117.2 单文件（来源和 sha256 见 vendor/README.md）
supabase/tj_0001_init.sql 云端建表 SQL（在 Supabase 的 SQL Editor 里跑）
scripts/deploy.sh     发布脚本（用户点头后才运行）
fixtures/
  sample-journal.json 示例数据（交接文档附录 A），"看看示例数据"和测试都用它
  sample-journal.formatted.json 附录 A 按固定格式写出的结果（4,831 字节），格式的金标准
  sample-expected.json 附录 B 的预期结果
tests/                node --test 的测试
```

## 还没做的功能

- 每日备份到私有仓库 `trade-journal-backup`：见 `backup/README.md`。
- 发布时的版本号盖章、只有测试通过才发布的 GitHub Actions（交接文档 9.5）：现在用 `scripts/deploy.sh` 在本机跑测试后再推。
- 日志按年分段存（doc 接近 1 MB 前要做）；网站里浏览历史版本、清理旧截图。

## 注意

- 这是公开仓库：不要把导出的 `journal.json`、CSV 或截图放进这个目录（`.gitignore` 已经挡掉了常见的文件名）。
- 浏览器的 localStorage 只放登录会话（键 `tj-auth`）和几项 `tj_` 开头的设置；交易数据和截图只在 IndexedDB 里。从不调用 `localStorage.clear()`（记账也在这个网址下）。
- 代码里只放项目地址和 publishable key（公开级别）；secret key、service_role key、`sbp_` 令牌和密码永远不进任何文件。
- 网站更新后如果看到的还是旧版本，按 Ctrl+F5 强制刷新；页面最下面的版本号可以用来确认。
