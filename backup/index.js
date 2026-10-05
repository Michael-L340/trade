// 只为了让网站仓库里 `node --test backup/` 能跑（同 tests/index.js 的说明：Node 21 起不展开目录，
// 会把 backup/ 当模块运行，也就是这个文件）。备份仓库里不需要这个文件，那边直接 `node --test`。
import './backup.test.mjs';
