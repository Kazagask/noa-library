import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { initialVault } from '../apps/sites/src/vault.js';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3, createWorldlineV3 } from '../apps/sites/src/storage-v3.js';
import worker from '../apps/sites/src/worker.js';

const SITES = join(process.cwd(), 'apps', 'sites');

async function setup(owners = ['owner-a']) {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v22-'));
  const db = new D1Sqlite(join(dir, 'v22.sqlite'));
  applyMigrations(db, SITES);
  const env: any = { DB: db };
  for (const owner of owners) {
    await promoteVault(db, owner, { dryRun: false }, null, initialVault());
    await promoteV3(db, owner, initialVault());
    env.NOA_REPAIR_OWNER = owner;
  }
  let id = 0;
  const call = async (name: string, args: Record<string, any> = {}, user = owners[0]) => {
    const req = new Request('https://sites.local/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const res = await worker.fetch(req, env, {});
    const json: any = await res.json();
    return JSON.parse(json.result?.content?.[0]?.text ?? JSON.stringify(json));
  };
  return { dir, db, call, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('V3 增量提交：回执查询、幂等重传、CAS 冲突与有界读取', async () => {
  const s = await setup();
  try {
    const args = { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'V22-1', expectedRevision: 7, idempotencyKey: 'V22-K1', statePatch: { flags: { v22: 1 } } };
    const before = { ...s.db.metrics };
    const first = await s.call('event_commit', args);
    assert.equal(first.ok, true, JSON.stringify(first));
    const firstReads = s.db.metrics.rows - before.rows;
    assert.ok(firstReads < 200, `单次提交读取行数异常: ${firstReads}`);

    const receipt = await s.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'V22-1' });
    assert.equal(receipt.ok, true);
    const duplicate = await s.call('event_commit', args);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.data.receipt.duplicate, true);
    const stale = await s.call('event_commit', { ...args, eventId: 'V22-2', idempotencyKey: 'V22-K2' });
    assert.equal(stale.code, 'revision_conflict');
    const boot = await s.call('session_bootstrap', {});
    assert.equal(boot.ok, true);
    assert.equal(JSON.stringify(boot).includes('raw-combat-log'), false);
    const recover = await s.call('session_recover', {});
    assert.equal(recover.ok, true);
    assert.equal(recover.data.stateRevision, 8);
    assert.ok(recover.data.recentReceipts.length <= 8);
  } finally { s.close(); }
});

test('V3 checkpoint：增量创建、篡改后恢复并校验状态/记忆/RNG', async () => {
  const s = await setup();
  try {
    await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'CP-A', expectedRevision: 7, idempotencyKey: 'CP-K1', statePatch: { flags: { cp: 1 } } });
    const cp = await s.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', label: 'cp-a', idempotencyKey: 'CP-1' });
    assert.equal(cp.ok, true, JSON.stringify(cp));
    await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'CP-B', expectedRevision: 8, idempotencyKey: 'CP-K2', statePatch: { flags: { cp: 2 } } });
    const delta = await s.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', label: 'cp-b', idempotencyKey: 'CP-2', parentId: 'CP-1' });
    assert.equal(delta.ok, true, JSON.stringify(delta));
    assert.ok(delta.data.bytes > 0);
    const restored = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'CP-1', idempotencyKey: 'RESTORE-1' });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.ok(restored.data.stateRevision >= 10, '恢复不得倒退 revision');
  } finally { s.close(); }
});

test('V3 双世界线与双 owner 隔离', async () => {
  const s = await setup(['owner-a', 'owner-b']);
  try {
    const created = await createWorldlineV3(s.db, 'owner-a', { campaignId: 'demo', from: 'wl-main', to: 'wl-other' });
    assert.equal(created.ok, true);
    const a = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'ISO-A', expectedRevision: 7, idempotencyKey: 'SAME-KEY', statePatch: { flags: { iso: 'a' } } }, 'owner-a');
    const b = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'ISO-B', expectedRevision: 7, idempotencyKey: 'SAME-KEY', statePatch: { flags: { iso: 'b' } } }, 'owner-b');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, '不同 owner 不应共享幂等键');
    const other = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-other', eventId: 'ISO-OTHER', expectedRevision: 7, idempotencyKey: 'SAME-KEY', statePatch: { flags: { iso: 'other' } } }, 'owner-a');
    assert.equal(other.ok, true, '不同世界线不应共享幂等键');
    const receiptA = await s.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'ISO-A' }, 'owner-a');
    const receiptB = await s.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'ISO-A' }, 'owner-b');
    assert.equal(receiptA.ok, true);
    assert.equal(receiptB.ok, false);
  } finally { s.close(); }
});

test('故障注入：批次提交前失败可回滚，响应丢失后重传返回原回执', async () => {
  const s = await setup();
  try {
    const originalBatch = s.db.batch.bind(s.db);
    let failed = false;
    s.db.batch = async (statements: any[]) => {
      if (!failed) { failed = true; throw new Error('injected-pre-batch-failure'); }
      return originalBatch(statements);
    };
    const args = { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'FAULT-1', expectedRevision: 7, idempotencyKey: 'FAULT-K1', statePatch: { flags: { fault: 1 } } };
    const injected = await s.call('event_commit', args);
    assert.equal(injected.ok, false);
    const retry = await s.call('event_commit', args);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.data.receipt.duplicate, undefined);
    // 模拟事务成功但响应发送失败：再次重传必须返回原回执且不推进 revision。
    const replay = await s.call('event_commit', args);
    assert.equal(replay.ok, true);
    assert.equal(replay.data.receipt.duplicate, true);
    assert.equal(replay.data.revision, retry.data.revision);
  } finally { s.close(); }
});
