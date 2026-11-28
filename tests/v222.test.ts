import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { initialVault } from '../apps/sites/src/vault.js';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, promoteV3, stateReadV3 } from '../apps/sites/src/storage-v3.js';
import { stateFromComponents } from '../apps/sites/src/state-core.js';
import worker from '../apps/sites/src/worker.js';

const SITES = join(process.cwd(), 'apps', 'sites');

function richVault() {
  const document = structuredClone(initialVault());
  const main = document.campaigns.demo.lines['wl-main'];
  main.state.revision = 119;
  main.state.rng.cursor = 472;
  main.state.inventory = Array.from({ length: 12 }, (_, i) => ({ id: `item.${String(i).padStart(2, '0')}`, name: `物品${i}`, qty: i, owner: 'person.player' }));
  main.working.pendingEvents = [];
  document.campaigns.demo.lines['wl-other'] = structuredClone(main);
  document.campaigns.demo.lines['wl-other'].state.worldlineId = 'wl-other';
  document.campaigns.demo.lines['wl-other'].manifest.worldlineId = 'wl-other';
  document.campaignPersonas = { demo: { id: 'noa-demo', version: 7, name: '诺娅（demo）' } };
  document.receipts['demo:wl-main:roll-key'] = {
    fingerprint: 'fp-roll', receipt: {
      id: 'roll-legacy-1', op: 'runtime_execute', status: 'applied', actor: 'gm',
      campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: 'roll-key', appliedRevision: 118,
      hash: 'roll-hash'
    }, result: { roll: { value: 88, cursor: 4 } }
  };
  document.events.push({ campaignId: 'demo', id: 'legacy-roll-event', worldlineId: 'wl-main', runtimeReceiptId: 'roll-legacy-1' });
  const cpState = structuredClone(main.state);
  cpState.revision = 118;
  document.checkpoints['demo:legacy-cp'] = {
    id: 'legacy-cp', campaignId: 'demo', worldlineId: 'wl-main', label: 'legacy',
    createdAt: '2026-11-27T00:00:00.000Z', snapshot: { ...structuredClone(main), state: cpState },
    stateHash: 'legacy-state', memoryHash: 'legacy-memory'
  };
  return document;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v222-'));
  const db = new D1Sqlite(join(dir, 'v222.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'qa-owner';
  const document = richVault();
  await promoteVault(db, owner, { dryRun: false }, null, document);
  const migrated = await promoteV3AndActivate(db, owner, document);
  const env = { DB: db, NOA_REPAIR_OWNER: owner };
  let id = 0;
  const call = async (name: string, args: Record<string, any> = {}, method = 'tools/call') => {
    const req = new Request('https://sites.local/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: method === 'tools/call' ? { name, arguments: args } : {} })
    });
    const res = await worker.fetch(req, env, {});
    const json: any = await res.json();
    if (json.result?.content) return JSON.parse(json.result.content[0].text);
    return json;
  };
  return { dir, db, owner, document, migrated, call, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('V3 迁移覆盖全部世界线、人格、RNG、回执与 checkpoint', async () => {
  const s = await setup();
  try {
    assert.equal(s.migrated.ok, true, JSON.stringify(s.migrated));
    assert.equal(s.migrated.data.worldlines, 2);
    assert.equal(s.migrated.data.personas, 1);
    assert.equal(s.migrated.data.rng, 1);
    assert.equal(s.migrated.data.receipts >= 1, true);
    assert.equal(s.migrated.data.checkpoints >= 1, true);
    for (const worldlineId of ['wl-main', 'wl-other']) {
      const built = await stateFromComponents(s.db, s.owner, { campaignId: 'demo', worldlineId });
      const source = s.document.campaigns.demo.lines[worldlineId].state;
      assert.deepEqual(built, source, `${worldlineId} 状态迁移不一致`);
    }
    const persona = await s.db.prepare('SELECT body FROM noa_v3_doc WHERE owner_id=? AND family=?').bind(s.owner, 'persona:demo').first();
    assert.equal(JSON.parse(persona.body).version, 7);
    const rng = await s.db.prepare('SELECT consumed FROM noa_v3_rng WHERE owner_id=? AND receipt_id=?').bind(s.owner, 'roll-legacy-1').first();
    assert.equal(rng.consumed, 1);
  } finally { s.close(); }
});

test('迁移保持数组顺序与空集合', async () => {
  const s = await setup();
  try {
    const result = await stateReadV3(s.db, s.owner, { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(result.ok, true);
    const state = result.data.state;
    assert.equal(state.inventory.length, 12);
    assert.deepEqual(state.inventory.map((i: any) => i.id), Array.from({ length: 12 }, (_, i) => `item.${String(i).padStart(2, '0')}`));
    assert.deepEqual(result.data.working.pendingEvents, []);
  } finally { s.close(); }
});

test('checkpoint 恢复不倒退 revision，且幂等', async () => {
  const s = await setup();
  try {
    const restored = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'legacy-cp', idempotencyKey: 'RESTORE-V222' });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.data.stateRevision, 120);
    const replay = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'legacy-cp', idempotencyKey: 'RESTORE-V222' });
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.stateRevision, 120);
  } finally { s.close(); }
});

test('P1 协议：clock 分片、工具注册、冷启动与 GM 召回', async () => {
  const s = await setup();
  try {
    const clock = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main', section: 'clock' });
    assert.equal(clock.ok, true);
    assert.deepEqual(Object.keys(clock.data).filter(k => k !== 'release').sort(), ['campaignId', 'clock', 'revision', 'section', 'worldlineId']);
    const list = await s.call('tools/list', {}, 'tools/list');
    assert.ok(Array.isArray(list.result?.tools));
    const names = list.result.tools.map((t: any) => t.name);
    assert.ok(names.includes('session_recover'));
    assert.ok(names.includes('save_restore'));
    const boot = await s.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(boot.ok, true);
    assert.equal(boot.data.mode, 'sites-mcp');
    assert.ok(boot.data.state.clock);
    const gm = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: 'x', limit: 10 });
    assert.equal(gm.ok, true);
    assert.ok(['L3-audit'].includes(gm.data.layer));
  } finally { s.close(); }
});
