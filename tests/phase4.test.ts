import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readText, readJson, writeJsonAtomic, sha256, stableStringify } from '../packages/core/util.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { SqliteStore } from '../packages/server/sqlite-store.ts';
import { loadAuthority, reconcileDeltas, assertNotStale } from '../packages/library/reconciliation.ts';
import {
  exportFull, exportIncremental, verify, importEnvelope, replayIncremental,
  type BackupEnvelope
} from '../packages/backup/sync.ts';
import { traverse } from '../packages/library/operations.ts';
import { traverseGraph } from '../packages/library/domain.ts';
import { AssetStore } from '../packages/assets/asset-store.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
interface Fixture { dir: string; root: string; fs: FsStore; cleanup(): void }
function fresh(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'noa-phase4-'));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  return { dir, root, fs: new FsStore(root), cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } } };
}
async function withFresh(fn: (f: Fixture) => void | Promise<void>): Promise<void> {
  const f = fresh();
  try { await fn(f); } finally { f.cleanup(); }
}
function envelopePatch(base: BackupEnvelope, patch: Partial<BackupEnvelope>): BackupEnvelope {
  const next = { ...base, ...patch, contentHash: '' } as BackupEnvelope;
  return { ...next, contentHash: sha256(stableStringify(next)) };
}

test('1. Campaign ID 映射与旧迁移包覆盖保护', async () => {
  await withFresh(({ root, fs }) => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeJsonAtomic(join(root, 'config', 'campaign-map.yaml'), {
      campaigns: [{ sitesId: 'SAVE-481', vaultId: 'demo', worldlineId: 'wl-main' }],
      authority: {
        source: 'sites-mcp', sitesCampaignId: 'SAVE-481', vaultCampaignId: 'demo',
        worldlineId: 'wl-main', stateRevision: 11, memoryRevision: 11,
        observedAt: '2026-11-26T01:49:23+08:00'
      }
    });
    const cfg = loadAuthority(fs);
    assert.equal((cfg as any).data.authority.stateRevision, 11);
    const stale = assertNotStale(fs, { campaignId: 'demo', stateRevision: 7, memoryRevision: 0 });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'authority_stale');
    const full = exportFull(fs, 'demo');
    const blocked = importEnvelope(fs, (full as any).data);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'authority_stale');
    assert.equal(fs.read('demo', 'wl-main').state.revision, 7, '未修改正式状态');
  });
});

test('2. 增量对账：父链、幂等、落后权威报告', async () => {
  await withFresh(({ root, fs }) => {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeJsonAtomic(join(root, 'config', 'campaign-map.yaml'), {
      campaigns: [{ sitesId: 'SAVE-481', vaultId: 'demo', worldlineId: 'wl-main' }],
      authority: { source: 'sites-mcp', sitesCampaignId: 'SAVE-481', vaultCampaignId: 'demo', worldlineId: 'wl-main', stateRevision: 11, memoryRevision: 11 }
    });
    const dir = join(root, 'deltas');
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, '01.json'), { id: 'D1', state_delta: { economy: { cash_g: 10 } }, episodes: [{ id: 'e1' }], knowledge_graph: { relations: [{ id: 'r1' }] } });
    writeJsonAtomic(join(dir, '02.json'), { id: 'D2', parent: { id: 'D1' }, event: { id: 'E2' }, state_delta: { economy: { cash_g: 12 } } });
    const report = reconcileDeltas(fs, { campaignId: 'demo', deltaDir: 'deltas', apply: true });
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.data.deltaCount, 2);
    assert.equal(report.data.applied.length, 2);
    assert.equal(report.data.behindAuthority, true);
    assert.equal(report.data.proposal.episodes, 1);
    assert.equal(fs.read('demo', 'wl-main').state.revision, 7, '对账只产出提案');
    writeJsonAtomic(join(dir, '03.json'), { id: 'D3', parent: { id: 'MISSING' }, state_delta: {} });
    const broken = reconcileDeltas(fs, { campaignId: 'demo', deltaDir: 'deltas' });
    assert.equal(broken.code, 'ambiguous_parent');
  });
});

test('3. 增量回放、parentHash 链、乱序/重复/记忆独立更新', async () => {
  await withFresh(({ fs }) => {
    const full = (exportFull(fs, 'demo') as any).data as BackupEnvelope;
    const imported = importEnvelope(fs, full);
    assert.equal((imported as any).data.imported, true);
    const inc = (exportIncremental(fs, 'demo', { stateRevision: 7, memoryRevision: 0 }, { parent: full }) as any).data as BackupEnvelope;
    assert.equal(inc.parentHash, full.contentHash);
    const events = [
      { id: 'EV-1', seq: 8, stateRevision: 8, memoryRevision: 0, patch: { resources: { ink: 11 } } },
      { id: 'EV-2', seq: 9, stateRevision: 8, memoryRevision: 2, episodes: [{ id: 'ep-memory-only' }] }
    ];
    const incEvents = envelopePatch(inc, { payload: { events }, stateRevision: 8, memoryRevision: 2 });
    const replay = replayIncremental(fs.read('demo', 'wl-main'), incEvents, full, fs, { markApplied: false });
    assert.equal((replay as any).data.snapshot.state.revision, 8);
    assert.equal((replay as any).data.snapshot.working.memoryRevision, 2);
    assert.equal((replay as any).data.applied.length, 2);
    const applied = importEnvelope(fs, incEvents, { parent: full });
    assert.equal((applied as any).data.stateRevision, 8);
    assert.equal((applied as any).data.memoryRevision, 2);
    const duplicate = importEnvelope(fs, incEvents, { parent: full });
    assert.equal((duplicate as any).data.stateRevision, 8);
    assert.equal(fs.read('demo', 'wl-main').state.resources.ink, 11);
    const broken = envelopePatch(incEvents, { parentHash: 'wrong' });
    assert.equal(importEnvelope(fs, broken, { parent: full }).code, 'broken_chain');
    const staleState = envelopePatch(incEvents, { stateRevision: 6, memoryRevision: 2 });
    assert.equal(importEnvelope(fs, staleState, { parent: full }).code, 'state_stale');
    const staleMemory = envelopePatch(incEvents, { stateRevision: 8, memoryRevision: 0 });
    assert.equal(importEnvelope(fs, staleMemory, { parent: full }).code, 'memory_stale');
  });
});

test('4. 图谱 BFS 等价性、预算与权限隔离', async () => {
  await withFresh(({ root }) => {
    const store = new SqliteStore(root, join(root, 'bfs.sqlite'));
    store.seedFromFiles('demo');
    const snap = store.read('demo', 'wl-main');
    const mk = (id: string, subject: string, object: string, knownBy = ['*'], epistemic: 'fact' | 'belief' = 'fact', holder: string | null = null): any => ({
      id, subject, predicate: '关联', object, description: id, worldlineId: 'wl-main',
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
      recordedAt: '2026-01-01T00:00:00.000Z', scope: 'world', knownBy, confidence: 1,
      sourceEventId: 'bfs', epistemic, holder, status: 'active', revision: 1
    });
    for (let i = 0; i < 40; i++) snap.relations.push(mk(`rel-bfs-${i}`, `n-${i % 4}`, `n-${(i + 1) % 4}`));
    snap.relations.push(mk('rel-secret', 'n-0', 'secret-node', ['gm']));
    snap.relations.push(mk('rel-belief', 'n-1', 'belief-node', ['*'], 'belief', 'person.mira'));
    store.patch('demo', 'wl-main', snap);

    const full = store.read('demo', 'wl-main');
    const ctx = { viewer: 'person.player', worldlineId: 'wl-main', asOf: '9999-12-31T23:59:59.999Z', includeBeliefs: false };
    const naiveStart = performance.now();
    let naive: any;
    for (let i = 0; i < 20; i++) naive = traverseGraph('n-0', 2, ctx, full.entities, full.relations);
    const naiveMs = (performance.now() - naiveStart) / 20;
    const dbStart = performance.now();
    let result: any;
    for (let i = 0; i < 20; i++) result = traverse(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', start: 'n-0', hops: 2 });
    const dbMs = (performance.now() - dbStart) / 20;
    assert.equal(result.ok, true);
    assert.equal((result as any).data.engine, 'sqlite-adjacency');
    const dbNodes = new Set((result as any).data.nodes.map((n: any) => n.id));
    const naiveNodes = new Set(naive.nodes.map((n: any) => n.id));
    const dbEdges = new Set((result as any).data.edges.map((e: any) => e.id));
    const naiveEdges = new Set(naive.edges.map((e: any) => e.id));
    assert.deepEqual([...dbNodes].sort(), [...naiveNodes].sort(), '等价结果节点集');
    assert.deepEqual([...dbEdges].sort(), [...naiveEdges].sort(), '等价结果边集');
    assert.equal(dbNodes.has('secret-node'), false, '权限隔离');
    assert.equal(dbNodes.has('belief-node'), false, '主观信念默认不可见');
    assert.ok((result as any).data.queries <= 24, '查询预算受控');
    const reportPath = join(ROOT, 'reports', 'performance.json');
    mkdirSync(join(ROOT, 'reports'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      scenario: '等价稀疏图：40 邻接边 + 1 受限边 + 1 信念边，2 跳',
      equivalent: true, nodes: dbNodes.size, edges: dbEdges.size,
      fullScanMs: Number(naiveMs.toFixed(3)), adjacencyMs: Number(dbMs.toFixed(3)),
      speedup: Number((naiveMs / Math.max(dbMs, 0.001)).toFixed(2)),
      queries: result.data.queries,
      note: '两侧节点/边集合先断言完全相等，再比较平均耗时；不再用不等价结果做性能结论。'
    }, null, 2));

    const dense = store.read('demo', 'wl-main');
    for (let i = 0; i < 900; i++) dense.relations.push(mk(`rel-dense-${i}`, 'hub', `leaf-${i % 300}`));
    store.patch('demo', 'wl-main', dense);
    const denseResult = traverse(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', start: 'hub', hops: 1, limit: 20 });
    assert.equal((denseResult as any).data.nodes.length <= 20, true);
    assert.equal((denseResult as any).data.edgesTruncated, true, '截断判定');
    assert.equal((denseResult as any).data.edges.every((e: any) => e.subject === 'hub' || e.object === 'hub'), true, '不超过请求跳数');
    store.close();
  });
});

test('5. 资产权限、原始证据保护与 GC 引用覆盖', async () => {
  await withFresh(async ({ root }) => {
    const store = new AssetStore(root);
    const bytes = Buffer.from('original-evidence');
    const original = (await store.upload({
      bytes, mediaType: 'image/jpeg', filename: 'original.jpeg', source: 'archive',
      declaredSha256: sha256(bytes).length === 64 ? undefined : undefined,
      personaId: 'noa', worldlineId: 'wl-noa-persistent', tags: ['原始']
    } as any) as any).data;
    const assetId = original.assetId;
    store.link(assetId, 'person.noa', '身份画像', ['person.noa']);
    const wrongLine = await store.resolve(assetId, 'person.noa', 'wl-other');
    assert.equal(wrongLine.ok, false);
    assert.equal(wrongLine.code, 'worldline_forbidden');
    const restricted = await store.resolve(assetId, 'npc');
    assert.equal(restricted.ok, false);
    assert.equal(store.revise(assetId, { kind: 'derivative', source: 'generated' }).code, 'immutable_original');
    mkdirSync(join(root, 'personas', 'noa', 'memory'), { recursive: true });
    writeFileSync(join(root, 'personas', 'noa', 'memory', 'episodes.jsonl'), JSON.stringify({ id: 'ep-reunion', assetRef: assetId }) + '\n');
    mkdirSync(join(root, 'campaigns', 'demo', 'checkpoints'), { recursive: true });
    writeFileSync(join(root, 'campaigns', 'demo', 'checkpoints', 'cp-1.json'), JSON.stringify({ snapshot: { assetRef: assetId } }));
    const gc = await store.gc({ dryRun: true });
    assert.equal((gc as any).data.orphaned.includes(assetId), false, '人格情景与检查点引用不得被 GC');
    const adapterSource = readText(join(ROOT, 'packages', 'assets', 'asset-store.ts'));
    assert.match(adapterSource, /sha:\s*meta\.sha/, 'GitHub DELETE 必须携带当前 blob sha');
    assert.equal(adapterSource.includes('github.com/${this.owner}/${this.repo}/blob'), false, '不得把普通 GitHub 页面 URL 当资源直链');
  });
});
