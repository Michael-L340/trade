#!/usr/bin/env bash
# 发布交易日志到 GitHub Pages（Pages 从 main 分支根目录发布，推到 main 就是上线）。
#
# ！！发布前必须先问用户、用户点头后才运行这个脚本。AI 不要自己运行它。！！
#
# 用法（在仓库根目录）：
#   bash scripts/deploy.sh          版本号第三位 +1（0.2.0 → 0.2.1）
#   bash scripts/deploy.sh minor    第二位 +1、第三位归零（0.2.5 → 0.3.0），大功能用
#
# 做的事，按顺序，哪一步不过就停下、不发布：
#   1. 工作区必须干净（先 commit 再发布）；当前提交必须包含 origin/main（不会把线上新提交盖掉）。
#   2. node --test tests/ 全绿。
#   3. package.json 的 version 和 src/version.js 一起改成新版本号，提交"vX.Y.Z"，打 tag vX.Y.Z。
#   4. git push origin HEAD:main --follow-tags（这一步才真正上线）。
#   5. 等 Pages 构建完成（gh api .../pages/builds/latest），再用 curl 确认首页 200、线上 src/version.js 是新版本号。
# 回退只用 git revert 生成新提交再发布一次，版本号照常往上加；不要 reset 加 force push。
set -euo pipefail

REPO="Michael-L340/trade"
SITE="https://michael-l340.github.io/trade/"
BUMP="${1:-patch}"

cd "$(dirname "$0")/.."

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" ]]; then
  echo "参数只能是 patch（默认）或 minor，收到：$BUMP" >&2
  exit 1
fi

echo "== 1/5 检查工作区"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区不干净：先 commit（或丢掉）这些改动再发布。" >&2
  git status --short >&2
  exit 1
fi
git fetch -q origin
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "当前提交不包含 origin/main 的最新提交：先 git rebase origin/main（或 merge）再发布。" >&2
  exit 1
fi

echo "== 2/5 跑测试"
node --test tests/

echo "== 3/5 改版本号并打 tag"
OLD="$(node -p "require('./package.json').version")"
NEW="$(node -e "
const [a, b, c] = '$OLD'.split('.').map(Number);
console.log('$BUMP' === 'minor' ? [a, b + 1, 0].join('.') : [a, b, c + 1].join('.'));
")"
if git rev-parse -q --verify "refs/tags/v$NEW" >/dev/null; then
  echo "tag v$NEW 已经存在，停下。" >&2
  exit 1
fi
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const p = 'src/version.js';
const src = fs.readFileSync(p, 'utf8');
const out = src.replace(/export const APP_VERSION = '[^']*';/, \"export const APP_VERSION = '$NEW';\");
if (out === src && !src.includes(\"'$NEW'\")) { console.error('没能改 src/version.js'); process.exit(1); }
fs.writeFileSync(p, out);
"
node --test tests/version.test.js >/dev/null
git add package.json src/version.js
git commit -q -m "v$NEW"
git tag -a "v$NEW" -m "v$NEW"
echo "版本 $OLD → $NEW"

echo "== 4/5 推到 main（上线）"
git push origin HEAD:main --follow-tags

echo "== 5/5 等 Pages 构建完成"
SHA="$(git rev-parse HEAD)"
for i in $(seq 1 60); do
  read -r STATUS COMMIT < <(gh api "repos/$REPO/pages/builds/latest" --jq '.status + " " + .commit')
  if [[ "$COMMIT" == "$SHA" && "$STATUS" == "built" ]]; then
    break
  fi
  # 推送有时不会自动触发 Pages 构建（2026-10-05 v0.3.0 就遇到过）：30 秒后还没开始就手动请求一次
  if [[ "$i" == "3" && "$COMMIT" != "$SHA" ]]; then
    gh api -X POST "repos/$REPO/pages/builds" >/dev/null || true
  fi
  # 构建任务有时一直排队不开始（2026-10-05 v0.3.2、v0.3.5 都卡过）：3 分钟还没好就取消，重新请求一次
  if [[ "$i" == "18" && "$STATUS" != "built" ]]; then
    RUN="$(gh run list -R "$REPO" --limit 1 --json databaseId,status --jq '.[0] | select(.status == "queued" or .status == "waiting") | .databaseId')"
    if [[ -n "$RUN" ]]; then
      echo "Pages 构建排队 3 分钟没开始，取消后重新请求"
      gh run cancel "$RUN" -R "$REPO" >/dev/null || true
      sleep 8
      gh api -X POST "repos/$REPO/pages/builds" >/dev/null || true
    fi
  fi
  if [[ "$COMMIT" == "$SHA" && "$STATUS" == "errored" ]]; then
    echo "Pages 构建失败，去仓库的 Actions 页看看。" >&2
    exit 1
  fi
  sleep 10
done
if [[ "$COMMIT" != "$SHA" || "$STATUS" != "built" ]]; then
  echo "10 分钟内没等到这次提交的 Pages 构建（最新：$COMMIT $STATUS），去仓库的 Actions 页看看。" >&2
  exit 1
fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$SITE?nocache=$RANDOM")"
if [[ "$CODE" != "200" ]]; then
  echo "网站返回 HTTP $CODE，不是 200。" >&2
  exit 1
fi
for i in $(seq 1 30); do
  if curl -s "${SITE}src/version.js?nocache=$RANDOM" | grep -q "'$NEW'"; then
    echo "已发布 v$NEW：$SITE（页面底部应显示 网站版本 $NEW；看到旧版本就按 Ctrl+F5）"
    exit 0
  fi
  sleep 10
done
echo "首页是 200，但线上 src/version.js 还不是 $NEW（Pages 有约 10 分钟缓存），过几分钟再看页面底部的版本号。" >&2
exit 1
