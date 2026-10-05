// 源码守卫（9.2）：不许违反的规矩用读源码的方式守住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, cloudConfigured } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? dir + '/' + name : name;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const srcFiles = walk('src').filter((f) => f.endsWith('.js'));
/** 去掉注释（注释里提到规矩本身不算违反）；行注释只认行首或空白后的 //，免得吃掉字符串里的 https:// */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const htmlCode = () => read('index.html').replace(/<!--[\s\S]*?-->/g, '');

test('只有 src/store/remote.js 碰 globalThis.supabase', () => {
  for (const f of srcFiles) {
    const has = /globalThis\)?\.supabase|window\.supabase/.test(code(f));
    assert.equal(has, f === 'src/store/remote.js', f);
  }
});

test('没有 localStorage.clear(、serviceWorker.register、caches.open、updateUser(、innerHTML', () => {
  for (const f of srcFiles) {
    const s = code(f);
    for (const bad of ['localStorage.clear(', 'serviceWorker.register', 'caches.open', 'updateUser(', 'innerHTML']) {
      assert.ok(!s.includes(bad), `${f} 里出现了 ${bad}`);
    }
  }
});

test("signOut( 必须带 scope: 'local'", () => {
  for (const f of srcFiles) {
    const s = read(f);
    for (const m of s.matchAll(/auth\.signOut\(([^)]*)\)/g)) assert.match(m[1], /scope:\s*'local'/, f);
  }
});

test('src/ 里不出现访问记账五张表的写法', () => {
  const tables = ['accounts', 'categories', 'transactions', 'facade_adjusts', 'meter_readings'];
  for (const f of srcFiles) {
    const s = read(f);
    for (const t of tables) {
      assert.ok(!new RegExp(`from\\(\\s*['"]${t}['"]\\s*\\)`).test(s), `${f}: from('${t}')`);
      assert.ok(!s.includes('/rest/v1/' + t), `${f}: /rest/v1/${t}`);
    }
  }
});

test('除了 tests/，仓库里没有长得像密钥的字符串（sb_secret_、sbp_、eyJ 开头的 JWT）', () => {
  const files = walk('').filter((f) => !f.startsWith('tests/') && !f.startsWith('vendor/') && !/\.(png|jpg|webp|ico)$/.test(f));
  for (const f of files) {
    const s = read(f);
    assert.ok(!/sb_secret_[A-Za-z0-9]/.test(s), f + ' 里像有 secret key');
    assert.ok(!/\bsbp_[A-Za-z0-9]{8,}/.test(s), f + ' 里像有管理令牌');
    assert.ok(!/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(s), f + ' 里像有 JWT（旧的 anon / service_role 密钥）');
  }
});

test('index.html 的 CSP 地址和 src/config.js 一致（没配置时是 https://*.supabase.co）', () => {
  const html = read('index.html');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].trim().split(/\s+/);
  if (cloudConfigured()) assert.deepEqual(connect, ["'self'", SUPABASE_URL]);
  else {
    assert.equal(SUPABASE_URL === '' || !cloudConfigured(), true);
    assert.deepEqual(connect, ["'self'", 'https://*.supabase.co']);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(typeof SUPABASE_PUBLISHABLE_KEY === 'string');
  if (SUPABASE_PUBLISHABLE_KEY) assert.match(SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/, '只放 publishable key');
});

test('index.html 先用普通 script 加载 vendor/supabase.js，再加载 module；没有内联脚本和 style=""', () => {
  const html = htmlCode();
  const vendor = html.indexOf('<script src="vendor/supabase.js"></script>');
  const main = html.indexOf('<script type="module" src="src/main.js"></script>');
  assert.ok(vendor > 0 && main > vendor);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), '没有内联脚本');
  assert.ok(!/\sstyle="/.test(html));
});

test('vendor/supabase.js 原样未改（sha256 和 vendor/README.md 一致）', () => {
  const sum = createHash('sha256').update(readFileSync(join(root, 'vendor/supabase.js'))).digest('hex');
  assert.equal(sum, '59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd');
  assert.ok(read('vendor/README.md').includes(sum));
});

test('supabase/tj_0001_init.sql 在，内容是 5.4 的建表 SQL', () => {
  const sql = read('supabase/tj_0001_init.sql');
  assert.ok(sql.startsWith('-- tj_0001_init.sql\n'));
  for (const s of ['create table if not exists public.tj_journal', 'tj_journal_history', "values ('tj-shots', 'tj-shots', false, 307200", 'tj_storage_usage', '900000000']) {
    assert.ok(sql.includes(s), s);
  }
});

test("createClient 设了 storageKey 'tj-auth'", () => {
  const s = read('src/store/remote.js');
  assert.ok(s.includes("AUTH_STORAGE_KEY = 'tj-auth'"));
  assert.ok(/storageKey: AUTH_STORAGE_KEY/.test(s));
});
