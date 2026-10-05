# 交易日志每日备份

每天北京时间 02:17，GitHub Actions 用你的交易日志账号登录 Supabase，把整本日志存成 `journal.json`，把新截图下载到 `shots/`，提交进私有仓库 `Michael-L340/trade-journal-backup`。旧截图只增不删，已经备份过的不会重下。

这个目录里的文件：

| 文件 | 放到备份仓库的哪里 |
|---|---|
| `backup.mjs` | 根目录 |
| `backup.test.mjs` | 根目录（每次备份前先跑它自测） |
| `backup.yml` | `.github/workflows/backup.yml` |

`index.js` 和这份 README 不用放。

## 一、第一次配置（照着做一遍）

### 1. 新建私有仓库

GitHub 右上角 **+ → New repository**：

- Owner 选 `Michael-L340`，名字填 `trade-journal-backup`
- 选 **Private**（必须私有，脚本发现仓库是公开的会拒绝备份）
- 勾上 **Add a README file**
- 点 **Create repository**

### 2. 放进三个文件

在新仓库页面：

1. **Add file → Upload files**，把 `backup.mjs`、`backup.test.mjs` 拖进去，点 **Commit changes**。
2. **Add file → Create new file**，文件名一栏输入 `.github/workflows/backup.yml`（输入 `/` 时会自动变成文件夹），把 `backup.yml` 的全部内容粘贴进去，点 **Commit changes**。

### 3. 设四个 Secret

仓库 **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Name | Secret 填什么 |
|---|---|
| `TJ_SUPABASE_URL` | Supabase 项目地址，形如 `https://xxxx.supabase.co`（控制台 Project Settings → API） |
| `TJ_SUPABASE_KEY` | publishable key（`sb_publishable_` 开头，API Keys 页），和网站 `src/config.js` 里的是同一个 |
| `TJ_EMAIL` | 交易日志的登录邮箱 |
| `TJ_PASSWORD` | 交易日志的登录密码 |

密码也可以在自己电脑的终端里设，不经过任何文件：

```
gh secret set TJ_PASSWORD -R Michael-L340/trade-journal-backup
```

运行后按提示粘贴密码，回车。

### 4. 手动跑一次，看结果

仓库 **Actions** 页 → 左边点 **每日备份** → 右边 **Run workflow**（allow_drop 保持 `no`）→ 绿色按钮 **Run workflow**。

一两分钟后刷新，应该看到：

- 这次运行是绿色的对勾；
- 仓库里出现 `journal.json`、`state.json`，有截图的话还有 `shots/` 文件夹；
- 网站设置页"每日备份"那一块显示了刚才的备份时间。

之后每天自动跑，不用管。失败时 GitHub 会发邮件；网站设置页超过 48 小时没备份会变黄。

### 5. 演练一次恢复

没验过的备份等于没有备份。配好后照下面"从备份恢复"走一遍，确认数据一致。

## 二、变红了怎么办

点开失败的那次运行，看红色那一步的最后几行：

| 看到的话 | 怎么办 |
|---|---|
| 不是私有的，拒绝备份 | Settings → General 最下面 Change visibility 改回 Private，再手动跑一次 |
| 登录失败 | 改过密码？重新设 `TJ_PASSWORD`（上面第 3 步） |
| 交易笔数从 X 降到 Y … 拒绝提交 | 先去网站看数据还在不在。确实是自己删了一批：Actions → 每日备份 → Run workflow，allow_drop 选 `yes` |
| 交易一笔都不剩了 | 云端可能被清空了，不会放行。去网站看，必要时从备份恢复 |
| 有 N 个截图文件没备份到 | journal.json 和其他图已经提交了。缺的清单在 `state.json` 的 `missing` 里。常见原因是当时空间满了图没传上去；桶里补上之后，下一次备份会自动下载 |
| schemaVersion … 备份脚本只认识 1 | 网站升级了数据格式，`backup.mjs` 要跟着更新 |
| `git push` 报 403 | Settings → Actions → General → Workflow permissions 选 **Read and write permissions** |

## 三、从备份恢复

### 日志（journal.json）

1. 在备份仓库里点开 `journal.json` → 右上角 **Download raw file**。想回到某一天：点 **History** 找到那天的提交，再下载那个版本。
2. 打开交易日志网站 → 设置页 → **从 journal.json 恢复** → 选刚下载的文件。

### 截图

`journal.json` 里只记了有哪些截图，图本身在 Supabase 的 `tj-shots` 桶里。

- **桶里的图还在**（多数情况，比如只是误删了几笔）：恢复完日志就能看到图，不用做别的。
- **桶没了**（换了 Supabase 项目）：要把备份仓库的 `shots/` 传回桶里。
  1. 备份仓库首页 **Code → Download ZIP**，解压，里面有 `shots/` 文件夹。
  2. Supabase 控制台 → Authentication → Users，复制交易日志账号的 User UID。
  3. Storage → `tj-shots` 桶 → 新建一个文件夹，名字就是这个 UID → 进入它 → 把整个 `shots` 文件夹拖进去上传。
  4. 上传完的路径应该是 `tj-shots/<UID>/shots/<交易 id>/<截图 id>.webp`，和 `journal.json` 里的 `file` 字段对得上。

  图多的时候手动传很慢；规格 8.7 里的 `restore-shots` 自动上传脚本还没写，需要时再加。

## 四、它做了什么、靠什么防坏数据

每天分两步：

1. `node backup.mjs`：确认仓库是私有的 → 登录 → 读 `tj_journal` 那一行（必须正好 1 行）→ 结构检查（第一行是系统行、字段合法、id 不重复、截图路径都在自己那笔交易的文件夹下）→ 笔数闸门（比上次少超过 max(3 笔, 5%) 就拒绝）→ 写 `journal.json`（固定格式：每笔一行，改一笔就是一行 diff）→ 下载仓库里还没有的截图（大图要和记录的字节数一致）→ 写 `state.json`。任何一道检查没过，什么都不写、不提交。
2. 有变化才提交推送（只添加，不删除任何文件）。
3. `node backup.mjs --report`：推送成功之后，把 `{at, rev, trades, shots, missing}` 写进账号的 `user_metadata.tj_backup`，网站设置页读它显示备份状态。有缺图时这一步以失败结束。

`state.json` 里的 `at` 是内容最后一次变化的时间；没有变化的日子文件一个字节都不变，不会产生空提交。检出时不下载以前的截图（`filter: blob:none` + 稀疏检出排除 `shots/`），仓库再大每天也只下载新图。

**局限**：备份状态存在 Supabase 里，它能告诉你"备份没跑"，告诉不了你"整个项目没了"；GitHub 账号出事时代码和备份会一起没。所以每季度在网站设置页导出一份 `journal.json` 存到本机或网盘。

改了交易日志的密码，记得同时更新 `TJ_PASSWORD`，否则第二天起备份会登录失败。
