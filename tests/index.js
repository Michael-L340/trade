// 让 `node --test tests/` 在 Node 21 及以后也能用：
// 这些版本把 --test 后面的参数当成文件通配符，不会自动展开目录，
// 于是会把 tests/ 当成一个模块来运行，也就是运行这个文件。
// 这里把同目录下所有 *.test.js 依次导入，测试照常逐个登记和报告。
// 直接运行 `node --test`（不带参数）时这个文件不会被选中，不会重复跑。
import { readdirSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) await import(new URL(f, dir));
