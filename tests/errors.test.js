// 云端错误分类（8.4 的表）：每一行一个用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, describeError } from '../src/store/errors.js';

const db = (status, code = '', extra = {}) => ({ source: 'db', status, code, ...extra });
const st = (statusCode, status = 400) => ({ source: 'storage', status, statusCode });

test('断网、超时、5xx、429（Storage 的也算）→ network', () => {
  assert.equal(classifyError({ source: 'db', network: true, status: 0 }), 'network');
  assert.equal(classifyError(db(0)), 'network');
  assert.equal(classifyError(db(503)), 'network');
  assert.equal(classifyError(db(429)), 'network');
  assert.equal(classifyError({ source: 'storage', network: true }), 'network');
  assert.equal(classifyError(st('', 502)), 'network');
  assert.equal(classifyError(st('500', 500)), 'network');
});

test('可能要重新登录：401、没会话时的 401 加 42501、PGRST301、PGRST303 → auth', () => {
  assert.equal(classifyError(db(401)), 'auth');
  assert.equal(classifyError(db(401, '42501')), 'auth');
  assert.equal(classifyError(db(401, 'PGRST301')), 'auth');
  assert.equal(classifyError(db(401, 'PGRST303')), 'auth');
  assert.equal(classifyError({ source: 'rpc', status: 401, code: '42501' }), 'auth');
});

test('缺授权：403 加 42501 → grant（不能当成登录问题）', () => {
  assert.equal(classifyError(db(403, '42501')), 'grant');
});

test('PT409 → conflict；23505 → duplicate', () => {
  assert.equal(classifyError(db(409, 'PT409')), 'conflict');
  assert.equal(classifyError(db(409, '23505')), 'duplicate');
});

test('22P05、22P02 → badText', () => {
  assert.equal(classifyError(db(400, '22P05')), 'badText');
  assert.equal(classifyError(db(400, '22P02')), 'badText');
});

test('402、25006 → quota', () => {
  assert.equal(classifyError(db(402)), 'quota');
  assert.equal(classifyError(db(500, '25006')), 'network', '5xx 先按网络问题重试');
  assert.equal(classifyError(db(400, '25006')), 'quota');
});

test('Storage 看返回体的 statusCode，不看 HTTP 状态', () => {
  assert.equal(classifyError(st('409')), 'exists');
  assert.equal(classifyError(st('403')), 'denied');
  assert.equal(classifyError(st('413')), 'tooBig');
  assert.equal(classifyError(st('415')), 'tooBig');
  assert.equal(classifyError(st('404')), 'notFound');
  assert.equal(classifyError(st('400')), 'other');
});

test('其他错误 → other；没有错误 → null', () => {
  assert.equal(classifyError(db(400, 'XX000')), 'other');
  assert.equal(classifyError(db(413)), 'other');
  assert.equal(classifyError(null), null);
});

test('describeError：列出 HTTP 状态、错误码和信息', () => {
  assert.equal(describeError(db(403, '42501', { message: 'permission denied' })), 'HTTP 403 · 错误码 42501 · permission denied');
  assert.match(describeError({ network: true }), /网络错误/);
});
