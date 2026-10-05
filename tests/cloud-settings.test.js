// 设置页云端几块的说法（7.10）：截图空间、每日备份、同步问题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageView, backupLines, problemText, fmtMB, conflictEntryText } from '../src/ui/cloud-settings.js';

const u = (project) => ({ tj_shots_bytes: project, tj_shots_files: 12, project_bytes: project, warn_bytes: 800000000, limit_bytes: 900000000 });

test('截图空间：按 1 MB = 100 万字节；800 MB 变黄，900 MB 已满', () => {
  assert.equal(fmtMB(12345678), '12.3 MB');
  assert.equal(usageView(u(1000)).level, '');
  assert.match(usageView(u(1000)).text, /共 12 个文件（含没被引用的）；本项目 Storage 合计 0\.0 MB。到 800 MB 提醒，到 900 MB 服务端不再接收新截图。（1 MB = 100 万字节）/);
  assert.equal(usageView(u(800000000)).level, 'warn');
  assert.equal(usageView(u(900000000)).full, true);
});

test('每日备份：读不到、没备份过、正常、超过 48 小时、有缺图，各是各的说法', () => {
  assert.equal(backupLines({ ok: false, message: '读不到备份状态' })[0].text, '读不到备份状态');
  assert.equal(backupLines({ ok: true, backup: null })[0].text, '还没有过自动备份');
  const now = Date.parse('2026-10-08T00:00:00Z');
  const fresh = backupLines({ ok: true, backup: { at: '2026-10-07T18:17:00Z', trades: 230, shots: 410, missing: 0 } }, now);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].text, /230 笔、410 张截图/);
  const stale = backupLines({ ok: true, backup: { at: '2026-10-04T18:17:00Z', trades: 1, shots: 0, missing: 2 } }, now);
  assert.equal(stale[1].level, 'warn');
  assert.match(stale[1].text, /已 3 天没有自动备份/);
  assert.match(stale[2].text, /日志已备份，2 张截图没备份/);
});

test('同步问题的说明：缺授权让再跑一遍 SQL；坏字符指到第几笔哪一格', () => {
  assert.match(problemText({ status: 'grant' }), /tj_0001_init\.sql/);
  assert.equal(problemText({ status: 'badText', badText: { tradeNo: 7, label: '开仓理由' } }), '第 7 笔的"开仓理由"里有存不进去的字符，改掉后会自动重试。');
  assert.match(problemText({ status: 'missingRemote' }), /云端没有你的日志，本机数据还在/);
  assert.equal(problemText({ status: 'synced' }), '');
  assert.match(conflictEntryText({ at: '2026-10-05T06:30:00Z', source: 'remote', doc: { rows: [{ type: 'trade' }, { type: 'system' }] } }), /云端 · 1 笔$/);
});
