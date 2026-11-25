import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readText, readJson, writeJsonAtomic, stableStringify, sha256 } from '../packages/core/util.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { SqliteStore } from '../packages/server/sqlite-store.ts';
import { migrateArchive, buildSitesBundle } from '../packages/library/archive-migration.ts';
import { AssetStore } from '../packages/assets/asset-store.ts';
import { traverse } from '../packages/library/operations.ts';
import { traverseGraph } from '../packages/library/domain.ts';
import { exportFull, exportIncremental, verify, diff, importEnvelope } from '../packages/backup/sync.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
interface Fixture { dir: string; root: string; fs: FsStore; cleanup(): void }
function fresh(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'noa-phase3-'));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  return { dir, root, fs: new FsStore(root), cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } } };
}
async function withFresh(fn: (f: Fixture) => void | Promise<void>): Promise<void> {
  const f = fresh();
  try { await fn(f); } finally { f.cleanup(); }
}

function syntheticArchive(): { campaign: any; persona: any } {
  const campaign: any = {
    meta: { save_id: 'SYN-001', revision: 4, world: 'synthetic', export_date: '2026-01-01T00:00:00.000Z', evidence: { source: 'synthetic' } },
    noa: { reward_flags: ['FLAG-1'], world_access: { default: 'campaign-only', active_authorization: { world: 'synthetic' } } },
    character: {
      id: 'person.hero', name: '合成角色', realm: { stage: 'test' },
      resources: { hp: { current: 10 }, mp: { current: 5 } },
      hexes: { infinite_evolution: { level: 2 }, skill_points: { available: 0, historical_transactions: [{ delta: 1 }, { delta: -1 }] } }
    },
    cultivation: { pending_realm_training_ledger: [{ id: 'LEDGER-1', booked: true }] },
    skills: [{ name: '测试技能' }], inventory: { current_confirmed: [] },
    research: { projects: [] }, economy: { cash_g: 1, industries: [] }, properties: [],
    relationships: [{ name: '合成伙伴', relationship: '同伴' }],
    contracts: [{ id: 'C-1', current_status: 'active' }],
    chat_group: {}, timeline: { events: [{ save_id: 'SYN-001', title: '合成事件', details: '中文检索测试', source: 'synthetic' }] },
    gm_rules: { mode: 'test' },
    unresolved: Array.from({ length: 18 }, (_, i) => ({ field: `field.${i}`, issue: '待核实' })),
    import_prompt: 'synthetic'
  };
  const persona = {
    id: 'noa', name: '诺娅', english_name: 'NOA', grade: 'test', identity: '叙事层管理者', layer: 'narrative', realm: 'test',
    authority: ['剧情裁决'], affinity: {}, persona: { description: '合成人格', speech_examples: {}, fairness: 'test' },
    appearance: 'synthetic', original_profile_asset: null,
    bonds: [
      { name: '跨越世界的重逢', grade: 'unique', status: 'unlocked' },
      { name: '秘密', grade: 'memorial', status: 'unlocked', description: '受限' }
    ],
    world_access: { default: '禁止', active_authorization: { world: 'synthetic' } },
    reward_flags: ['FLAG-1'], inventory: [], migrationSource: { sourcePolicy: 'synthetic' }
  };
  return { campaign, persona };
}

test('1. 正式档案迁移：validate/dry-run/apply/verify', async () => {
  await withFresh(({ root, fs }) => {
    const { campaign, persona } = syntheticArchive();
    const campaignPath = join(root, 'campaign-archive.json');
    const personaPath = join(root, 'persona-archive.json');
    writeJsonAtomic(campaignPath, campaign);
    writeJsonAtomic(personaPath, persona);
    const base = { campaignArchivePath: campaignPath, personaArchivePath: personaPath, campaignId: 'formal-import' };
    const validate = migrateArchive(fs, { ...base, mode: 'validate' });
    assert.equal(validate.ok, true);
    const dry = migrateArchive(fs, { ...base, mode: 'dry-run' });
    assert.equal((dry as any).data.dryRun, true);
    assert.equal(existsSync(join(root, 'campaigns', 'formal-import')), false);
    const applied = migrateArchive(fs, { ...base, mode: 'apply', at: '2026-01-02T00:00:00.000Z' });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.data.counts.unresolved, 18);
    assert.equal((applied.data as any).worldAuthorizationScope, 'campaign-only');
    const state = fs.read('formal-import', 'wl-main').state;
    assert.equal(state.extension.world.character.hexes.infinite_evolution.level, 2);
    assert.equal(state.extension.world.cultivation.pending_realm_training_ledger[0].id, 'LEDGER-1');
    assert.equal(state.rng.seed, 0);
    const worldAccess = readJson(join(root, 'campaigns', 'formal-import', 'migration', 'world-access.json'));
    assert.equal(worldAccess.default, '禁止');
    const personaRelations = readText(join(root, 'personas', 'noa', 'memory', 'relations.jsonl'));
    assert.equal(personaRelations.includes('active_authorization'), false);
    const verified = migrateArchive(fs, { ...base, mode: 'verify' });
    assert.equal((verified as any).data.verified, true);
    const bundle = buildSitesBundle(fs, 'formal-import');
    assert.equal((bundle as any).data.version, 2);
    assert.equal((bundle as any).data.format, 'noa-bundle');
    assert.ok((bundle as any).data.contentHash);
  });
});

test('2. 资产层：内容寻址、去重、授权解析与 GC dry-run', async () => {
  await withFresh(async ({ root }) => {
    const store = new AssetStore(root);
    const bytes = Buffer.from('synthetic-asset-bytes');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const first = await store.upload({ bytes, mediaType: 'text/plain', filename: 'a.txt', source: 'unit-test', declaredSha256: sha, tags: ['test'] });
    assert.equal((first as any).data.deduplicated, false);
    const second = await store.upload({ bytes, mediaType: 'text/plain', filename: 'a.txt', source: 'unit-test', declaredSha256: sha });
    assert.equal((second as any).data.deduplicated, true);
    assert.equal((second as any).data.assetId, (first as any).data.assetId);
    const bad = await store.upload({ bytes, mediaType: 'text/plain', filename: 'a.txt', source: 'unit-test', declaredSha256: 'bad' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'integrity_mismatch');
    const id = (first as any).data.assetId;
    store.link(id, 'person.noa', '身份画像', ['person.noa']);
    const denied = await store.resolve(id, 'other');
    assert.equal(denied.ok, false);
    const resolved = await store.resolve(id, 'person.noa');
    assert.equal((resolved as any).data.uri.startsWith('assets/objects/'), true);
    assert.equal(JSON.stringify(resolved).includes('synthetic-asset-bytes'), false);
    const found = store.search({ nodeId: 'person.noa' });
    assert.ok((found as any).data.total >= 1);
    const gc = await store.gc({ dryRun: true });
    assert.equal((gc as any).data.dryRun, true);
  });
});

test('3. 图谱性能：邻接查询不反序列化完整世界线', async () => {
  await withFresh(({ root }) => {
    const store = new SqliteStore(root, join(root, 'bench.sqlite'));
    store.seedFromFiles('demo');
    const snap = store.read('demo', 'wl-main');
    const relations: any[] = [];
    for (let i = 0; i < 6000; i++) {
      relations.push({
        id: `rel-bench-${i}`, subject: 'person.player', predicate: '关联', object: `node-${i % 60}`,
        description: `benchmark ${i}`, worldlineId: 'wl-main', validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: null, recordedAt: '2026-01-01T00:00:00.000Z', scope: 'world', knownBy: ['*'],
        confidence: 1, sourceEventId: 'bench', epistemic: 'fact', holder: null, status: 'active', revision: 1
      });
    }
    snap.episodes = snap.episodes.map((e: any, i: number) => ({ ...e, summary: i === 0 ? '中文检索命中测试' : e.summary }));
    snap.relations = [...snap.relations, ...relations];
    store.patch('demo', 'wl-main', snap);
    const full = store.read('demo', 'wl-main');
    const naiveStart = performance.now();
    const naive = traverseGraph('person.player', 2, { viewer: 'person.player', worldlineId: 'wl-main', asOf: '9999-12-31T23:59:59.999Z', includeBeliefs: false }, full.entities, full.relations);
    const naiveMs = performance.now() - naiveStart;
    const originalRead = store.read.bind(store);
    (store as any).read = () => { throw new Error('full snapshot deserialized'); };
    const dbStart = performance.now();
    const result = traverse(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', start: 'person.player', hops: 2 });
    const dbMs = performance.now() - dbStart;
    (store as any).read = originalRead;
    assert.equal(result.ok, true);
    assert.equal((result as any).data.engine, 'sqlite-adjacency');
    assert.ok((result as any).data.nodes.length > 5);
    assert.ok(naive.edges.length > 0);
    assert.ok(dbMs > 0 && naiveMs > 0);
    const chinese = store.searchText({ campaignId: 'demo', worldlineId: 'wl-main', query: '中文检索' });
    assert.ok(chinese.some(r => r.kind === 'episode'), '中文文本召回降级应命中');
    const reportPath = join(ROOT, 'reports', 'performance.json');
    mkdirSync(join(ROOT, 'reports'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      relations: full.relations.length, episodes: full.episodes.length,
      fullScanMs: Number(naiveMs.toFixed(2)), adjacencyMs: Number(dbMs.toFixed(2)),
      speedup: Number((naiveMs / Math.max(dbMs, 0.01)).toFixed(2)),
      returnedEdges: (result as any).data.edges.length,
      edgesTruncated: (result as any).data.edgesTruncated,
      note: '邻接查询在 store.read 被替换为抛错时仍成功，证明不反序列化完整世界线；原始耗时取决于图密度，返回边数受上限约束。'
    }, null, 2));
    store.close();
  });
});

test('4. 备份：全量/增量、校验、差异与 authorityEpoch', async () => {
  await withFresh(({ fs }) => {
    const full = exportFull(fs, 'demo', { authorityEpoch: 1 });
    assert.equal(full.ok, true);
    const verified = verify((full as any).data);
    assert.equal((verified as any).data.verified, true);
    const inc = exportIncremental(fs, 'demo', { stateRevision: 7, memoryRevision: 0 }, { authorityEpoch: 1 });
    assert.equal((inc as any).data.mode, 'incremental');
    const d = diff((full as any).data, (inc as any).data);
    assert.equal((d as any).data.authorityChanged, false);
    const rehash = (envelope: any, epoch: number) => {
      const next = { ...envelope, authorityEpoch: epoch, contentHash: '' };
      return { ...next, contentHash: sha256(stableStringify(next)) };
    };
    const imported = importEnvelope(fs, (full as any).data, { expectedAuthorityEpoch: 1 });
    assert.equal((imported as any).data.imported, true);
    const stale = importEnvelope(fs, rehash((full as any).data, 0));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'authority_epoch_stale');
    const bad = importEnvelope(fs, { ...(full as any).data, contentHash: 'bad' });
    assert.equal(bad.ok, false);
    assert.equal(fs.read('demo', 'wl-main').state.revision, 7);
  });
});
