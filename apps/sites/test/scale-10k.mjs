import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { D1Sqlite, applyMigrations } from './d1-sqlite.mjs';
import { initialVault } from '../src/vault.js';
import { promoteVault } from '../src/storage-v2.js';
import worker from '../src/worker.js';
import { createHash } from 'node:crypto';
import { setSharedHasher } from '../../../packages/core/shared.ts';

setSharedHasher(value => createHash('sha256').update(value).digest('hex'));

const SITES = process.cwd().endsWith('apps/sites') ? process.cwd() : join(process.cwd(), 'apps/sites');
const N = Number(process.env.NOA_SCALE_COMMITS ?? 10000);
const dir = mkdtempSync(join(tmpdir(), 'noa-scale-'));
const dbPath = join(dir, 'scale.sqlite');
const db = new D1Sqlite(dbPath);
applyMigrations(db, SITES);
const owner = 'scale-owner';
await promoteVault(db, owner, { dryRun: false }, null, initialVault());
const env = { DB: db, NOA_REPAIR_OWNER: owner };
let id = 0, responseBytes = 0;
const call = async (name, args = {}) => {
  const req = new Request('https://sites.local/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
  });
  const res = await worker.fetch(req, env, {});
  const text = await res.text();
  responseBytes += Buffer.byteLength(text, 'utf8');
  const json = JSON.parse(text);
  return JSON.parse(json.result?.content?.[0]?.text ?? text);
};

let current = await call('state_read', {});
let revision = Number(current.data?.state?.revision ?? current.data?.revision ?? 0);
const started = performance.now();
for (let i = 1; i <= N; i++) {
  const result = await call('event_commit', {
    campaignId: 'demo', worldlineId: 'wl-main', eventId: `SCALE-${i}`, expectedRevision: revision,
    idempotencyKey: `SCALE-KEY-${i}`, statePatch: { flags: { scaleRound: i } }
  });
  if (!result.ok) throw new Error(`commit ${i} failed: ${JSON.stringify(result)}`);
  revision = Number(result.data?.revision ?? result.data?.receipt?.appliedRevision ?? revision + 1);
  if (i % 1000 === 0) console.error(`scale ${i}/${N}`);
}
const commitsMs = performance.now() - started;
const bootStart = performance.now();
const boot = await call('session_bootstrap', {});
const bootMs = performance.now() - bootStart;
const recallStart = performance.now();
const recall = await call('memory_recall', { query: 'scale', limit: 8 });
const recallMs = performance.now() - recallStart;
const stats = await call('vault_stats', {});
const metrics = { ...db.metrics, responseBytes };
const report = {
  commits: N, commitMs: Number(commitsMs.toFixed(1)), commitsPerSecond: Number((N / commitsMs * 1000).toFixed(1)),
  bootstrapMs: Number(bootMs.toFixed(1)), recallMs: Number(recallMs.toFixed(1)),
  bootstrapOk: boot.ok, recallOk: recall.ok,
  physicalShardCount: stats.data?.physicalShardCount ?? null,
  shardBytes: stats.data?.shardBytes ?? null,
  d1: metrics,
  note: '真实 Worker + 隔离 D1；100,000 次为后续规模验收，不用数组过滤替代。'
};
writeFileSync(join(SITES, '..', '..', 'reports', 'v211-scale.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
db.close();
rmSync(dir, { recursive: true, force: true });
