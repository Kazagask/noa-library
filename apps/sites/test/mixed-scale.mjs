import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { setSharedHasher } from '../../../packages/core/shared.ts';
import { D1Sqlite, applyMigrations } from './d1-sqlite.mjs';
import { initialVault } from '../src/vault.js';
import { promoteVault } from '../src/storage-v2.js';
import { promoteV3 } from '../src/storage-v3.js';
import worker from '../src/worker.js';

setSharedHasher(value => createHash('sha256').update(value).digest('hex'));
const SITES = process.cwd().endsWith('apps/sites') ? process.cwd() : join(process.cwd(), 'apps/sites');
const N = Number(process.env.NOA_MIXED_COMMITS ?? 1000);
const LABEL = process.env.NOA_MIXED_LABEL ?? String(N);
const dir = mkdtempSync(join(tmpdir(), 'noa-mixed-'));
const db = new D1Sqlite(join(dir, 'mixed.sqlite'));
applyMigrations(db, SITES);
const owner = 'mixed-owner';
await promoteVault(db, owner, { dryRun: false }, null, initialVault());
await promoteV3(db, owner, initialVault());
const env = { DB: db, NOA_REPAIR_OWNER: owner };
let requestId = 0, responseBytes = 0;
const call = async (name, args = {}) => {
  const request = new Request('https://sites.local/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } })
  });
  const started = performance.now();
  const res = await worker.fetch(request, env, {});
  const text = await res.text();
  const elapsed = performance.now() - started;
  responseBytes += Buffer.byteLength(text, 'utf8');
  const json = JSON.parse(text);
  return { result: JSON.parse(json.result?.content?.[0]?.text ?? text), elapsed };
};
const percentile = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

let current = await call('state_read', {});
let revision = Number(current.result.data?.state?.revision ?? current.result.data?.revision ?? 7);
const latencies = [], queryDeltas = [], rowDeltas = [], byteDeltas = [], commitBytes = [];
const startedAll = performance.now();
for (let i = 1; i <= N; i++) {
  const before = { ...db.metrics };
  let runtimeReceipt;
  if (i % 10 === 0) {
    const roll = await call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 5, difficulty: 3, idempotencyKey: `MIX-ROLL-${i}` });
    if (!roll.result.ok) throw new Error(`roll ${i}: ${JSON.stringify(roll.result)}`);
    revision = Number(roll.result.data.revision);
    runtimeReceipt = { id: roll.result.data.receipt.id, hash: roll.result.data.receipt.hash };
  }
  const input = {
    campaignId: 'demo', worldlineId: 'wl-main', eventId: `MIX-EVT-${i}`, expectedRevision: revision,
    idempotencyKey: `MIX-KEY-${i}`,
    statePatch: { flags: { mixed: i }, resources: { gold: 1000 + i } },
    episodes: i % 5 === 0 ? [{
      id: `ep-mix-${i}`, at: new Date(Date.UTC(2026, 10, 27, 0, 0, i)).toISOString(), turn: i,
      title: `混合情景 ${i}`, summary: `mixed episode ${i}`, excerpt: '', worldlineId: 'wl-main',
      entities: ['person.player'], relationIds: [], knownBy: ['*'], sourceEventId: `MIX-EVT-${i}`,
      path: `mix-${i}.md`, tags: ['mixed'], confidence: 1
    }] : [],
    entities: i % 25 === 0 ? [{ id: `entity-mix-${i}`, type: 'person', name: `角色${i}`, worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], attributes: {}, createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z' }] : [],
    relations: i % 25 === 0 ? [{ id: `rel-mix-${i}`, subject: 'person.player', predicate: '协作', object: `entity-mix-${i}`, worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], epistemic: 'fact', holder: null, description: 'mixed relation', confidence: 1, sourceEventId: `MIX-EVT-${i}`, recordedAt: '2026-11-27T00:00:00.000Z', status: 'active', revision: 1, supersedes: null, validFrom: '2026-11-27T00:00:00.000Z', validUntil: null }] : [],
    pendingEvents: i % 10 === 0 ? [{ id: `todo-mix-${i}`, status: 'active', action: `处理混合事项 ${i}`, worldlineId: 'wl-main' }] : [],
    runtimeReceipt
  };
  const commit = await call('event_commit', input);
  if (!commit.result.ok) throw new Error(`commit ${i}: ${JSON.stringify(commit.result)}`);
  revision = Number(commit.result.data.revision);
  latencies.push(commit.elapsed);
  queryDeltas.push(db.metrics.prepare - before.prepare);
  rowDeltas.push(db.metrics.rows - before.rows);
  byteDeltas.push(db.metrics.bytes - before.bytes);
  commitBytes.push(Buffer.byteLength(JSON.stringify(commit.result), 'utf8'));
  if (i % 1000 === 0) console.error(`mixed ${i}/${N}`);
}
const totalMs = performance.now() - startedAll;
const timings = {};
for (const name of ['session_bootstrap', 'memory_recall', 'session_recover', 'event_receipt']) {
  const t0 = performance.now();
  const r = await call(name, name === 'event_receipt'
    ? { campaignId: 'demo', worldlineId: 'wl-main', lookup: `MIX-EVT-${N}` }
    : { campaignId: 'demo', worldlineId: 'wl-main', query: 'mixed', limit: 8 });
  timings[name] = { ms: Number((performance.now() - t0).toFixed(2)), ok: r.result.ok };
}
const stats = await call('vault_stats', {});
const report = {
  label: LABEL, commits: N, totalMs: Number(totalMs.toFixed(1)),
  p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
  p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
  p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
  d1: {
    preparePerCommitAvg: queryDeltas.reduce((a, b) => a + b, 0) / N,
    batchTotal: db.metrics.batch,
    rowsPerCommitAvg: rowDeltas.reduce((a, b) => a + b, 0) / N,
    rowsMax: Math.max(...rowDeltas),
    scannedBytesPerCommitAvg: byteDeltas.reduce((a, b) => a + b, 0) / N,
    scannedBytesMax: Math.max(...byteDeltas)
  },
  response: {
    totalBytes: responseBytes,
    avgCommitBytes: commitBytes.reduce((a, b) => a + b, 0) / N
  },
  storage: { physicalShardCount: stats.result.data?.physicalShardCount ?? null, shardBytes: stats.result.data?.shardBytes ?? null },
  readTimings: timings,
  note: '真实 Worker + 隔离 D1；混合负载含状态/资源、关系、实体、情景、待办与检定回执。'
};
writeFileSync(join(SITES, '..', '..', 'reports', `v22-mixed-${LABEL}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
db.close();
rmSync(dir, { recursive: true, force: true });
