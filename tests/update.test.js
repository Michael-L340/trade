import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVersion, isNewer } from '../src/update.js';

test('parseVersion：从 version.js 源码取版本号', () => {
  const src = readFileSync(new URL('../src/version.js', import.meta.url), 'utf8');
  assert.match(parseVersion(src), /^\d+\.\d+\.\d+$/);
  assert.equal(parseVersion('<html>404</html>'), null);
});

test('isNewer：逐段比数字，不按字符串比', () => {
  assert.equal(isNewer('0.3.10', '0.3.9'), true);
  assert.equal(isNewer('0.4.0', '0.3.9'), true);
  assert.equal(isNewer('0.3.3', '0.3.3'), false);
  assert.equal(isNewer('0.3.2', '0.3.3'), false);
});
