import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { initialVault } from '../apps/sites/src/vault.js';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, promoteV3, statsV3 } from '../apps/sites/src/storage-v3.js';
import { registerSchema, readComponent, readComponents, applyEffects, readCollection, componentStats, componentCheckpoint } from '../apps/sites/src/state-core.js';
import worker from '../apps/sites/src/worker.js';
import { AKASHA_CONTRACT_VERSION } from '../packages/akasha/contracts.ts';

const SITES = join(process.cwd(), 'apps', 'sites');

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v221-'));
  const db = new D1Sqlite(join(dir, 'v221.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'akasha-owner';
  await promoteVault(db, owner, { dryRun: false }, null, initialVault());
  await promoteV3AndActivate(db, owner, initialVault());
  const env = { DB: db, NOA_REPAIR_OWNER: owner };
  let id = 0;
  const call = async (name: string, args: Record<string, any> = {}) => {
    const req = new Request('https://sites.local/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const res = await worker.fetch(req, env, {});
    const json: any = await res.json();
    return JSON.parse(json.result?.content?.[0]?.text ?? JSON.stringify(json));
  };
  const head = async () => (await db.prepare('SELECT version FROM noa_v3_head WHERE owner_id=?').bind(owner).first()).version;
  return { dir, db, owner, call, head, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('通用组件 Schema、精确读取、CAS 与集合独立增长', async () => {
  const s = await setup();
  try {
    const registered = await registerSchema(s.db, s.owner, {
      componentType: 'runtime.custom', version: 1, schema: { type: 'object', properties: { value: { type: 'integer' } } }
    });
    assert.equal(registered.ok, true);
    const scope = { campaignId: 'demo', worldlineId: 'wl-main' };
    const version = await s.head();
    const applied = await applyEffects(s.db, s.owner, {
      scope, expectedVersion: version, idempotencyKey: 'component-1',
      effects: [
        { op: 'upsertComponent', entityId: 'entity.a', componentType: 'runtime.custom', key: 'main', value: { value: 1 }, entityType: 'generic' },
        { op: 'upsertComponent', entityId: 'entity.b', componentType: 'runtime.custom', key: 'main', value: { value: 2 }, entityType: 'generic' },
        { op: 'upsertCollectionItem', collectionId: 'collection.a', itemKey: 'item-1', value: { n: 1 } },
        { op: 'upsertCollectionItem', collectionId: 'collection.a', itemKey: 'item-2', value: { n: 2 } }
      ]
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const one = await readComponent(s.db, s.owner, scope, 'entity.a', 'runtime.custom', 'main');
    assert.equal(one.value.value, 1);
    const many = await readComponents(s.db, s.owner, scope, { componentType: 'runtime.custom' });
    assert.equal(many.length, 2);
    const items = await readCollection(s.db, s.owner, scope, 'collection.a');
    assert.equal(items.length, 2);
    const conflict = await applyEffects(s.db, s.owner, { scope, expectedVersion: version, idempotencyKey: 'component-2', effects: [] });
    assert.equal(conflict.code, 'revision_conflict');
    const stats = await componentStats(s.db, s.owner);
    assert.equal(stats.noa_v3_component.records >= 2, true);
    assert.equal(stats.noa_v3_collection_item.records >= 2, true);
    const cp = await componentCheckpoint(s.db, s.owner, 'component-cp-1');
    assert.equal(cp.ok, true);
  } finally { s.close(); }
});

test('V3 写入对所有 V3 读取接口立即可见', async () => {
  const s = await setup();
  try {
    const commit = await s.call('event_commit', {
      campaignId: 'demo', worldlineId: 'wl-main', eventId: 'VIS-1', expectedRevision: 7,
      idempotencyKey: 'VIS-K1', statePatch: { flags: { visible: true }, resources: { gold: 4242 } },
      episodes: [{
        id: 'ep-visible', at: '2026-11-27T00:00:00.000Z', turn: 100, title: '可见性验证',
        summary: 'VISIBLE-EPISODE-MARKER', worldlineId: 'wl-main', entities: ['person.player'],
        relationIds: [], knownBy: ['*'], sourceEventId: 'VIS-1', path: 'visible.md', tags: [], confidence: 1
      }]
    });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const read = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(read.ok, true);
    assert.equal(read.data.state.flags.visible, true, JSON.stringify(read.data.state.flags));
    assert.equal(read.data.state.resources.gold, 4242);
    const recall = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', query: 'VISIBLE', viewer: 'person.player', limit: 20 });
    assert.equal(recall.ok, true);
    assert.equal(JSON.stringify(recall.data).includes('VISIBLE-EPISODE-MARKER'), true);
    const traverse = await s.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 2 });
    assert.equal(traverse.ok, true);
    const recover = await s.call('session_recover', {});
    assert.equal(recover.data.stateRevision, 8);
  } finally { s.close(); }
});

test('统计分别报告 V2 与 V3 数据', async () => {
  const s = await setup();
  try {
    const stats = await s.call('vault_stats', {});
    assert.equal(stats.ok, true);
    assert.equal(stats.data.storage, 'd1-transactional-shards', 'V2 统计仍保留');
    assert.equal(stats.data.v3.storage, 'v3-component-core');
    assert.ok(stats.data.v3.tables.noa_v3_component.records >= 0);
    assert.ok(stats.data.v3.tables.noa_v3_tx !== undefined);
    const direct = await statsV3(s.db, s.owner);
    assert.equal(direct.head.version >= 0, true);
  } finally { s.close(); }
});

test('契约版本存在且不暴露执行器', async () => {
  const contracts = await import('../packages/akasha/contracts.ts');
  assert.equal(contracts.AKASHA_CONTRACT_VERSION, 1);
  assert.equal('executeRule' in contracts, false);
  assert.equal('eval' in contracts, false);
});
