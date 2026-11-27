import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { setSharedHasher } from '../../../packages/core/shared.ts';
import { D1Sqlite, applyMigrations } from './d1-sqlite.mjs';
import { initialVault } from '../src/vault.js';
import { promoteVault } from '../src/storage-v2.js';
import { promoteV3, recoveryV3, stateReadV3, statsV3 } from '../src/storage-v3.js';
import { applyEffects, componentStats } from '../src/state-core.js';
import worker from '../src/worker.js';

setSharedHasher(value => createHash('sha256').update(value).digest('hex'));
const SITES = process.cwd().endsWith('apps/sites') ? process.cwd() : join(process.cwd(), 'apps/sites');
const N = Number(process.env.NOA_AKASHA_N ?? 1000);
const SCENARIO = process.env.NOA_AKASHA_SCENARIO ?? 'history';
const LABEL = process.env.NOA_AKASHA_LABEL ?? `${SCENARIO}-${N}`;
const dir = mkdtempSync(join(tmpdir(), 'noa-akasha-'));
const db = new D1Sqlite(join(dir, 'scale.sqlite'));
applyMigrations(db, SITES);
const owner = 'scale-owner';
await promoteVault(db, owner, { dryRun: false }, null, initialVault());
await promoteV3(db, owner, initialVault());
const env = { DB: db, NOA_REPAIR_OWNER: owner };
let requestId = 0, responseBytes = 0;
const call = async (name, args = {}) => {
  const req = new Request('https://sites.local/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } })
  });
  const t0 = performance.now();
  const text = await (await worker.fetch(req, env, {})).text();
  responseBytes += Buffer.byteLength(text, 'utf8');
  const json = JSON.parse(text);
  return { data: JSON.parse(json.result?.content?.[0]?.text ?? text), ms: performance.now() - t0 };
};
const head = async () => (await db.prepare('SELECT version FROM noa_v3_head WHERE owner_id=?').bind(owner).first()).version;
const percentile = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
const scope = { campaignId: 'demo', worldlineId: 'wl-main' };
const latencies = [], rows = [], scanned = [], written = [];
let revision = 7;
const started = performance.now();

for (let i = 1; i <= N; i++) {
  const before = { ...db.metrics };
  const t0 = performance.now();
  let bytesWritten = 0;
  if (SCENARIO === 'history') {
    // 固定实体与固定状态条目，持续增长历史/回执。
    const result = await call('event_commit', {
      ...scope, eventId: `HIST-${i}`, expectedRevision: revision, idempotencyKey: `HIST-K-${i}`,
      statePatch: { flags: { scenario: 'history' } }
    });
    if (!result.data.ok) throw new Error(`history ${i}: ${JSON.stringify(result.data)}`);
    revision = result.data.data.revision;
    bytesWritten += 300;
  } else if (SCENARIO === 'entities') {
    const version = await head();
    const effects = [
      { op: 'upsertComponent', entityId: 'entity.fixed-a', componentType: 'bench.counter', key: 'main', value: { n: i }, entityType: 'generic' },
      { op: 'upsertComponent', entityId: 'entity.fixed-b', componentType: 'bench.counter', key: 'main', value: { n: i }, entityType: 'generic' },
      { op: 'upsertComponent', entityId: `entity.grown-${i}`, componentType: 'bench.profile', key: 'main', value: { n: i }, entityType: 'generic' }
    ];
    const result = await applyEffects(db, owner, { scope, expectedVersion: version, idempotencyKey: `ENT-K-${i}`, effects });
    if (!result.ok) throw new Error(`entities ${i}: ${JSON.stringify(result)}`);
    bytesWritten += effects.reduce((n, e) => n + JSON.stringify(e.value).length, 0);
  } else if (SCENARIO === 'collection') {
    const version = await head();
    const effects = [{ op: 'upsertCollectionItem', collectionId: 'entity.single:bench.items', itemKey: `item-${i}`, value: { n: i } }];
    const result = await applyEffects(db, owner, { scope, expectedVersion: version, idempotencyKey: `COL-K-${i}`, effects });
    if (!result.ok) throw new Error(`collection ${i}: ${JSON.stringify(result)}`);
    bytesWritten += JSON.stringify(effects[0].value).length;
  } else if (SCENARIO === 'multi') {
    const version = await head();
    const effects = [];
    for (let e = 0; e < 5; e++) for (let c = 0; c < 3; c++) effects.push({ op: 'upsertComponent', entityId: `entity.multi-${e}`, componentType: `bench.c${c}`, key: 'main', value: { n: i, e, c }, entityType: 'generic' });
    const result = await applyEffects(db, owner, { scope, expectedVersion: version, idempotencyKey: `MUL-K-${i}`, effects });
    if (!result.ok) throw new Error(`multi ${i}: ${JSON.stringify(result)}`);
    bytesWritten += effects.reduce((n, e) => n + JSON.stringify(e.value).length, 0);
  } else if (SCENARIO === 'memory') {
    const result = await call('event_commit', {
      ...scope, eventId: `MEM-${i}`, expectedRevision: revision, idempotencyKey: `MEM-K-${i}`,
      statePatch: { flags: { scenario: 'memory' } },
      episodes: [{ id: `ep-mem-${i}`, at: '2026-11-27T00:00:00.000Z', turn: i, title: `记忆${i}`, summary: `memory ${i}`, worldlineId: 'wl-main', entities: ['person.player'], relationIds: [], knownBy: ['*'], sourceEventId: `MEM-${i}`, path: `mem-${i}.md`, tags: [], confidence: 1 }]
    });
    if (!result.data.ok) throw new Error(`memory ${i}: ${JSON.stringify(result.data)}`);
    revision = result.data.data.revision;
    bytesWritten += 320;
  } else throw new Error(`unknown scenario ${SCENARIO}`);
  latencies.push(performance.now() - t0);
  rows.push(db.metrics.rows - before.rows);
  scanned.push(db.metrics.bytes - before.bytes);
  written.push(bytesWritten);
  if (i % 1000 === 0) console.error(`${SCENARIO} ${i}/${N}`);
}
const totalMs = performance.now() - started;
const timings = {};
for (const [name, fn] of [
  ['bootstrap', () => call('session_bootstrap', scope)],
  ['recall', () => call('memory_recall', { ...scope, query: 'memory', viewer: 'person.player', limit: 8 })],
  ['recover', () => recoveryV3(db, owner, 8)],
  ['event_receipt', () => call('event_receipt', { ...scope, lookup: SCENARIO === 'history' ? `HIST-${N}` : SCENARIO === 'memory' ? `MEM-${N}` : 'unknown' })]
]) {
  const t0 = performance.now();
  await fn();
  timings[name] = Number((performance.now() - t0).toFixed(2));
}
const v3Stats = await db.prepare('SELECT count(*) AS n, coalesce(sum(length(body)),0) AS bytes FROM noa_v3_doc WHERE owner_id=?').bind(owner).first();
const report = {
  scenario: SCENARIO, commits: N, totalMs: Number(totalMs.toFixed(1)),
  p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
  p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
  p99Ms: Number(percentile(latencies, 0.99).toFixed(3)),
  reads: { rowsAvg: rows.reduce((a, b) => a + b, 0) / N, rowsMax: Math.max(...rows), bytesAvg: scanned.reduce((a, b) => a + b, 0) / N, bytesMax: Math.max(...scanned) },
  writes: { bytesAvg: written.reduce((a, b) => a + b, 0) / N, bytesTotal: written.reduce((a, b) => a + b, 0) },
  storage: { v3DocRecords: v3Stats.n, v3DocBytes: v3Stats.bytes, responseBytes,
    v3: await statsV3(db, owner), components: await componentStats(db, owner) },
  readTimingsMs: timings,
  note: '真实 Worker + 隔离 SQLite/D1 兼容层；存储统计使用 V3 表，不使用旧版分片数。'
};
writeFileSync(join(SITES, '..', '..', 'reports', `v221-${LABEL}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
db.close();
rmSync(dir, { recursive: true, force: true });
