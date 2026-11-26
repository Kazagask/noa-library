import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import '../apps/sites/src/shared-hash.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import worker from '../apps/sites/src/worker.js';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { initialVault } from '../apps/sites/src/vault.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITES = join(ROOT, 'apps', 'sites');
const seed = JSON.parse(readFileSync(join(SITES, 'src', 'seed.json'), 'utf8'));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'noa-sites-d1-'));
  const dbPath = join(dir, 'isolated.sqlite');
  const db = new D1Sqlite(dbPath);
  applyMigrations(db, SITES);
  const owner = 'isolated-owner';
  await promoteVault(db, owner, { dryRun: false }, null, initialVault());
  const env = { DB: db, NOA_REPAIR_OWNER: owner, NOA_MIGRATION_OWNER: owner, NOA_MIGRATION_SECRET: 's', NOA_REPAIR_SECRET: 's' };
  let id = 0;
  const call = async (name: string, args: Record<string, any> = {}, user = owner) => {
    const req = new Request('https://sites.local/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const res = await worker.fetch(req, env, {});
    const json: any = await res.json();
    return JSON.parse(json.result?.content?.[0]?.text ?? JSON.stringify(json));
  };
  return { dir, db, dbPath, owner, env, call, reopen: () => new D1Sqlite(dbPath) };
}

test('真实 Sites Worker + 隔离 D1：工具链可调用', async () => {
  const s = await setup();
  try {
    const read = await s.call('state_read', {});
    assert.equal(read.ok, true);
    const revision = read.data?.state?.revision ?? read.data?.revision;
    assert.ok(Number.isFinite(revision));
    const stats = await s.call('vault_stats', {});
    assert.equal(stats.ok, true);
    assert.equal(stats.data.storage, 'd1-transactional-shards');
    const boot = await s.call('session_bootstrap', {});
    assert.equal(boot.ok, true);
    assert.ok(JSON.stringify(boot.data).length > 50);
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('真实 D1 event_commit：幂等、CAS 冲突与重启后回执', async () => {
  const s = await setup();
  try {
    const read = await s.call('state_read', {});
    const revision = Number(read.data?.state?.revision ?? read.data?.revision);
    const args = {
      campaignId: 'demo', worldlineId: 'wl-main', eventId: 'E2E-D1-1', expectedRevision: revision,
      idempotencyKey: 'E2E-D1-KEY-1', statePatch: { flags: { d1Round: 1 } }
    };
    const first = await s.call('event_commit', args);
    assert.equal(first.ok, true, JSON.stringify(first));
    const dup = await s.call('event_commit', args);
    assert.equal(dup.ok, true);
    assert.equal(dup.data?.receipt?.duplicate ?? dup.data?.duplicate, true);
    const stale = await s.call('event_commit', { ...args, eventId: 'E2E-D1-2', idempotencyKey: 'E2E-D1-KEY-2' });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'revision_conflict');
    const receipt = await s.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'E2E-D1-1' });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const reopened = await s.reopen();
    const stats = await reopened.prepare('SELECT count(*) AS n FROM noa_head').bind().first();
    assert.ok(stats.n >= 1);
    reopened.close();
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('真实 D1：并发 CAS 冲突只有一个成功', async () => {
  const s = await setup();
  try {
    const read = await s.call('state_read', {});
    const revision = Number(read.data?.state?.revision ?? read.data?.revision);
    const base = { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: revision, statePatch: { flags: { cas: true } } };
    const [a, b] = await Promise.all([
      s.call('event_commit', { ...base, eventId: 'CAS-1', idempotencyKey: 'CAS-KEY-1' }),
      s.call('event_commit', { ...base, eventId: 'CAS-2', idempotencyKey: 'CAS-KEY-2' })
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, `并发结果异常: ${JSON.stringify([a, b])}`);
    assert.ok([a, b].some(r => r.code === 'revision_conflict' || r.code === 'concurrent_write'));
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('真实 D1：50 轮事件提交后普通召回不返回 L3 原文', async () => {
  const s = await setup();
  try {
    let read = await s.call('state_read', {});
    let revision = Number(read.data?.state?.revision ?? read.data?.revision);
    for (let i = 1; i <= 50; i++) {
      const res = await s.call('event_commit', {
        campaignId: 'demo', worldlineId: 'wl-main', eventId: `ROUND-${i}`, expectedRevision: revision,
        idempotencyKey: `ROUND-KEY-${i}`,
        statePatch: { flags: { d1Round: i } },
        episodes: [{
          id: `ep-round-${i}`, at: new Date(Date.UTC(2026, 10, 27, 0, i)).toISOString(), turn: 1000 + i,
          title: `战斗第 ${i} 轮`, summary: `L3-CRITICAL-MARKER-${i}`, excerpt: 'raw combat log',
          worldlineId: 'wl-main', entities: ['person.player'], relationIds: [], knownBy: ['*'],
          sourceEventId: `ROUND-${i}`, path: `round-${i}.md`, tags: ['combat-log'], confidence: 1
        }]
      });
      assert.equal(res.ok, true, `round ${i}: ${JSON.stringify(res)}`);
      revision = Number(res.data?.revision ?? res.data?.receipt?.appliedRevision ?? revision + 1);
    }
    const recall = await s.call('memory_recall', { query: 'L3-CRITICAL-MARKER', limit: 100 });
    assert.equal(recall.ok, true);
    assert.equal(JSON.stringify(recall).includes('L3-CRITICAL-MARKER'), false, '普通召回不得返回 L3 原文');
    const t = performance.now();
    const boot = await s.call('session_bootstrap', {});
    assert.equal(boot.ok, true);
    assert.ok(performance.now() - t < 5000);
    const archive = await s.call('archive_export', {});
    assert.equal(archive.ok, true, '所有者审计导出仍可读取 L3');
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); }
});
