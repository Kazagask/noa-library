import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { sha256, hashText } from '../packages/core/shared.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { initialVault } from '../apps/sites/src/vault.js';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { transactVault, openV2 } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, promoteV3, verifyV3, activateV3, rollbackToV2, hasV3, authorityFrozen, unfreezeAuthority, documentV3, archiveExportV3, archiveImportV3, createWorldlineV3, applyV3Schema, checkpointV3 } from '../apps/sites/src/storage-v3.js';
import { tools } from '../apps/sites/src/tools.js';
import { AUTHORITY_MATRIX } from '../apps/sites/src/authority-matrix.js';
import worker from '../apps/sites/src/worker.js';

const SITES = join(process.cwd(), 'apps', 'sites');

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v223-'));
  const db = new D1Sqlite(join(dir, 'v223.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'authority-owner';
  const doc = initialVault();
  await promoteVault(db, owner, { dryRun: false }, null, doc);
  await promoteV3AndActivate(db, owner, doc);
  const env = { DB: db, NOA_REPAIR_OWNER: owner, NOA_REPAIR_SECRET: 'v223-secret' };
  let id = 0;
  const call = async (name: string, args: Record<string, any> = {}, method = 'tools/call') => {
    const req = new Request('https://sites.local/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: method === 'tools/call' ? { name, arguments: args } : {} })
    });
    const res = await worker.fetch(req, env, {});
    const json: any = await res.json();
    return json.result?.content ? JSON.parse(json.result.content[0].text) : json;
  };
  return { dir, db, owner, doc, env, call, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('权威矩阵覆盖全部 MCP 工具且注解与读写属性一致', async () => {
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(Object.keys(AUTHORITY_MATRIX).sort(), names);
  for (const tool of tools) {
    const entry = AUTHORITY_MATRIX[tool.name];
    assert.equal(tool.annotations.readOnlyHint, entry.access === 'read', `${tool.name} annotations 不一致`);
    assert.ok(entry.backend && entry.status && entry.scope, `${tool.name} 矩阵字段缺失`);
  }
});

test('V3 激活后 V2 业务写入被存储层拒绝，V2 哈希不变', async () => {
  const s = await setup();
  try {
    const before = sha256((await import('../apps/sites/src/storage-v2.js')).openV2 ? (await (await import('../apps/sites/src/storage-v2.js')).openV2(s.db, s.owner)).document : {});
    await assert.rejects(
      () => transactVault(s.db, s.owner, doc => ({ write: true, value: { ok: true }, document: { ...doc, active: { campaignId: 'demo', worldlineId: 'wl-main' } } }), undefined),
      (error: any) => error.code === 'authority_v3_active'
    );
    const after = sha256((await (await import('../apps/sites/src/storage-v2.js')).openV2(s.db, s.owner)).document);
    assert.equal(before, after);
    const adapted = await s.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data: { id: 'entity.x', type: 'generic', name: 'x' }, idempotencyKey: 'REC-1' });
    assert.equal(adapted.ok, true, JSON.stringify(adapted));
    const hashAfterTool = sha256((await (await import('../apps/sites/src/storage-v2.js')).openV2(s.db, s.owner)).document);
    assert.equal(before, hashAfterTool);
  } finally { s.close(); }
});

test('已适配写入 V3 后所有 V3 读取立即可见', async () => {
  const s = await setup();
  try {
    const commit = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'V223-1', expectedRevision: 7, idempotencyKey: 'V223-K1', statePatch: { flags: { v223: true } } });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const read = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(read.data.state.flags.v223, true);
    const boot = await s.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(boot.data.state.revision, 8);
    const recover = await s.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(recover.data.stateRevision, 8);
    const stateCommit = await s.call('state_commit', { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 8, idempotencyKey: 'V223-S1', changes: { flags: { v223State: true } } });
    assert.equal(stateCommit.ok, true, JSON.stringify(stateCommit));
    const read2 = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(read2.data.state.flags.v223State, true);
  } finally { s.close(); }
});

test('Checkpoint 元数据完整且恢复 revision 不倒退', async () => {
  const s = await setup();
  try {
    const before = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    const business = value => { const out = { ...value }; delete out.revision; delete out.updatedAt; delete out.memoryRevision; return out; };
    const cp = await s.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', label: 'v223-cp', idempotencyKey: 'V223-CP' });
    assert.equal(cp.ok, true);
    const changed = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'V224-BEFORE-RESTORE', expectedRevision: 7, idempotencyKey: 'V224-BEFORE-RESTORE', statePatch: { flags: { beforeRestore: true } } });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(cp.data.receipt.checkpointId, 'V223-CP');
    assert.ok(cp.data.receipt.id);
    const meta = await s.db.prepare('SELECT * FROM noa_v3_checkpoint_meta WHERE owner_id=? AND id=?').bind(s.owner, 'V223-CP').first();
    assert.equal(meta.label, 'v223-cp');
    assert.equal(meta.campaign_id, 'demo');
    assert.equal(meta.worldline_id, 'wl-main');
    const archived = await documentV3(s.db, s.owner);
    const exported = archived.checkpoints['demo:V223-CP'];
    assert.equal(exported.campaignId, 'demo');
    assert.equal(exported.worldlineId, 'wl-main');
    assert.equal(exported.label, 'v223-cp');
    assert.equal(exported.source, 'v3');
    const restore = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'V223-CP', idempotencyKey: 'V223-RESTORE' });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    assert.ok(restore.data.stateRevision >= 8);
    const after = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(sha256(business(after.data.state)), sha256(business(before.data.state)), '恢复后业务状态必须与 R1550 备份一致');
    assert.equal(sha256(business(after.data.working)), sha256(business(before.data.working)), '恢复后业务工作记忆必须一致');
    const replay = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'V223-CP', idempotencyKey: 'V223-RESTORE' });
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.stateRevision, restore.data.stateRevision);
  } finally { s.close(); }
});

test('Bootstrap 显式 scope 优先且不存在时拒绝', async () => {
  const s = await setup();
  try {
    await createWorldlineV3(s.db, s.owner, { campaignId: 'demo', from: 'wl-main', to: 'wl-other' });
    const other = await s.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-other' });
    assert.equal(other.ok, true);
    assert.equal(other.data.worldlineId, 'wl-other');
    const missing = await s.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-missing' });
    assert.equal(missing.code, 'scope_not_found');
    const missingRecall = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-missing', query: 'x' });
    assert.equal(missingRecall.code, 'scope_not_found');
  } finally { s.close(); }
});

test('归档完整分页、哈希、结束标记与往返导入', async () => {
  const s = await setup();
  try {
    const header = await archiveExportV3(s.db, s.owner, { pageBytes: 1024 });
    assert.equal(header.ok, true);
    const cursor0 = await archiveExportV3(s.db, s.owner, { pageBytes: 1024, cursor: 0 });
    assert.equal(cursor0.ok, true);
    assert.equal(cursor0.data.page, 0);
    assert.ok(cursor0.data.base64 && cursor0.data.pageHash, 'cursor=0 必须返回正文');
    const cursor1 = await archiveExportV3(s.db, s.owner, { pageBytes: 1024, cursor: 1 });
    assert.equal(cursor1.data.page, 1);
    const largePage = await archiveExportV3(s.db, s.owner, { pageBytes: 64000, page: 0 });
    assert.equal(Buffer.from(largePage.data.base64, 'base64').length, Math.min(64000, header.data.bytes), '64000 页必须返回足额字节');
    assert.ok(cursor1.data.base64 && cursor1.data.pageHash, 'cursor=1 必须返回正文');
    const pages = [];
    for (let page = 0; page < header.data.pages; page++) {
      const part = await archiveExportV3(s.db, s.owner, { pageBytes: 1024, page });
      assert.equal(part.ok, true, JSON.stringify(part));
      const chunk = Buffer.from(part.data.base64, 'base64');
      assert.equal(part.data.pageHash, createHash('sha256').update(chunk).digest('hex'), '页哈希必须是原始字节哈希');
      pages.push(chunk);
      if (part.data.done) assert.equal(part.data.nextCursor, null);
    }
    const bytes = Buffer.concat(pages);
    assert.equal(bytes.length, header.data.bytes);
    const archive = JSON.parse(bytes.toString('utf8'));
    assert.equal(sha256(archive), header.data.sha256);
    const rdir = mkdtempSync(join(tmpdir(), 'noa-v223-roundtrip-'));
    const rdb = new D1Sqlite(join(rdir, 'roundtrip.sqlite'));
    applyMigrations(rdb, SITES);
    const imported = await archiveImportV3(rdb, 'roundtrip-owner', { ...archive, format: 'noa-archive-v3', sha256: header.data.sha256 });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const a = await documentV3(s.db, s.owner);
    const b = await documentV3(rdb, 'roundtrip-owner');
    assert.equal(sha256(a), sha256(b));
    rdb.close(); rmSync(rdir, { recursive: true, force: true });
  } finally { s.close(); }
});

test('迁移中途故障后可恢复且不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v223-resume-'));
  const db = new D1Sqlite(join(dir, 'resume.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'resume-owner';
  const document = initialVault();
  await promoteVault(db, owner, { dryRun: false }, null, document);
  const originalBatch = db.batch.bind(db);
  let calls = 0, injected = false;
  db.batch = async (statements: any[]) => {
    calls++;
    if (calls === 2 && !injected) { injected = true; throw new Error('injected-migration-component-failure'); }
    return originalBatch(statements);
  };
  await assert.rejects(() => promoteV3(db, owner, document));
  const head = await db.prepare('SELECT migration FROM noa_v3_head WHERE owner_id=?').bind(owner).first();
  assert.ok(head && JSON.parse(head.migration).status === 'building');
  const progress = await db.prepare('SELECT cursor FROM noa_v3_migration_progress WHERE owner_id=? AND stage=?').bind(owner, 'documents').first();
  assert.ok(Number(progress?.cursor ?? 0) > 0, '故障后应持久化批次游标');
  db.batch = originalBatch;
  const resumed = await promoteV3AndActivate(db, owner, document);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const done = await db.prepare('SELECT migration FROM noa_v3_head WHERE owner_id=?').bind(owner).first();
  assert.equal(JSON.parse(done.migration).status, 'complete');
  const state = await (await import('../apps/sites/src/state-core.js')).stateFromComponents(db, owner, { campaignId: 'demo', worldlineId: 'wl-main' });
  assert.equal(sha256(state), sha256(document.campaigns.demo.lines['wl-main'].state));
  const rebuilt = await documentV3(db, owner);
  assert.equal(rebuilt.campaigns.demo.lines['wl-main'].entities.length, document.campaigns.demo.lines['wl-main'].entities.length);
  db.close(); rmSync(dir, { recursive: true, force: true });
});


test('全部 MCP 写入入口：适配成功或明确拒绝，V2 哈希不变', async () => {
  const s = await setup();
  try {
    const before = sha256((await openV2(s.db, s.owner)).document);
    const rejected = [
      ['vault_migrate', { expectedHash: '0'.repeat(64), expectedVersion: 0, dryRun: true }],
      ['qa_create', { campaignId: 'demo', worldlineId: 'wl-main' }],
      ['vault_compact', { dryRun: true }],
      ['campaign_import', { campaignId: 'demo', worldlineId: 'wl-main', sources: {}, dryRun: true }]
    ];
    for (const [name, args] of rejected) {
      const result = await s.call(name as string, args as any);
      assert.equal(result.code, 'v3_governance_not_adapted', `${name} 未明确拒绝: ${JSON.stringify(result)}`);
    }
    const layers = await s.call('memory_layers', { campaignId: 'demo', worldlineId: 'wl-main', apply: true });
    assert.equal(layers.code, 'v3_governance_not_adapted');

    const memBefore = (await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' })).data.workingSummary.memoryRevision;
    const record = await s.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data: { id: 'entity.probe', type: 'generic', name: '探针' }, idempotencyKey: 'PROBE-MR' });
    assert.equal(record.ok, true, JSON.stringify(record));
    const memAfter = (await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' })).data.workingSummary.memoryRevision;
    assert.ok(memAfter > memBefore, `memoryRevision 必须单调: ${memBefore} -> ${memAfter}`);
    const recallEntity = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '探针', limit: 10 });
    assert.equal(recallEntity.data.hits.some((h: any) => h.id === 'entity.probe'), true);
    const revise = await s.call('memory_revise', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', id: 'entity.probe', patch: { name: '探针修订' }, expectedRevision: 0, idempotencyKey: 'PROBE-MREV' });
    assert.equal(revise.ok, true, JSON.stringify(revise));
    const summarize = await s.call('memory_summarize', { campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'chapter-1', keyCausality: ['因果'], characterChanges: ['角色'], resourceChanges: [], unresolved: [], decisions: ['决定'], sourceEventIds: ['ep-001'], idempotencyKey: 'PROBE-SUM' });
    assert.equal(summarize.ok, true, JSON.stringify(summarize));
    const summaryRecall = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '因果', limit: 10 });
    assert.equal(summaryRecall.data.hits.some((h: any) => h.id === summarize.data.id), true, JSON.stringify(summaryRecall.data));
    const todoSeed = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'PROBE-TODO-SEED', expectedRevision: 7, idempotencyKey: 'PROBE-TODO-SEED', pendingEvents: [{ id: 'todo.probe', status: 'open', action: 'probe' }] });
    assert.equal(todoSeed.ok, true, JSON.stringify(todoSeed));
    const todo = await s.call('todo_status', { campaignId: 'demo', worldlineId: 'wl-main', id: 'todo.probe', status: 'closed', idempotencyKey: 'PROBE-TODO' });
    assert.equal(todo.ok, true, JSON.stringify(todo));
    const pending = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main', section: 'pendingEvents' });
    assert.equal(pending.data.pendingEvents.find((t: any) => t.id === 'todo.probe')?.status, 'closed');
    const recovered = await s.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    const states = await import('../apps/sites/src/state-core.js');
    await states.applyEffects(s.db, s.owner, { scope: { campaignId: 'demo', worldlineId: 'wl-main' }, expectedVersion: (await s.db.prepare('SELECT version FROM noa_v3_head WHERE owner_id=?').bind(s.owner).first()).version, idempotencyKey: 'PROBE-RNG-NULL', effects: [{ op: 'upsertComponent', entityId: 'wl-main', componentType: 'state', key: 'rng', value: null }] });
    const rng = await s.call('runtime_init', { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 8, idempotencyKey: 'PROBE-INIT' });
    assert.equal(rng.ok, true, JSON.stringify(rng));

    let revision = (await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' })).data.revision;
    const commit = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'PROBE-EVT', expectedRevision: revision, idempotencyKey: 'PROBE-EVT-K', statePatch: { flags: { probe: 1 } } });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    revision = commit.data.revision;
    const stateCommit = await s.call('state_commit', { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: revision, idempotencyKey: 'PROBE-STATE', changes: { flags: { probeState: 1 } } });
    assert.equal(stateCommit.ok, true, JSON.stringify(stateCommit));
    revision = stateCommit.data.revision;
    const roll = await s.call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 5, difficulty: 3, expectedRevision: revision, idempotencyKey: 'PROBE-ROLL' });
    assert.equal(roll.ok, true, JSON.stringify(roll));
    revision = roll.data.revision;
    const cp = await s.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', label: 'probe', idempotencyKey: 'PROBE-CP' });
    assert.equal(cp.ok, true, JSON.stringify(cp));
    const restore = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'PROBE-CP', idempotencyKey: 'PROBE-RESTORE' });
    assert.equal(restore.ok, true, JSON.stringify(restore));
    assert.ok(restore.data.stateRevision > revision);
    const after = sha256((await openV2(s.db, s.owner)).document);
    assert.equal(before, after, 'V2 业务数据不得被 V3 写入改变');
  } finally { s.close(); }
});


test('Recall 按稳定身份去重，不误删不同来源', async () => {
  const s = await setup();
  try {
    const row = await s.db.prepare('SELECT body FROM noa_v3_doc WHERE owner_id=? AND family=? AND slot=?').bind(s.owner, 'episode:demo:wl-main', 'ep-001').first();
    const value = JSON.parse(row.body);
    for (const tier of ['L1', 'L2']) {
      await s.db.prepare('INSERT OR REPLACE INTO noa_v3_component_index VALUES (?,?,?,?,?,?,?,?)')
        .bind(s.owner, 'demo', 'wl-main', 'memory.tier', `${tier}:episode:ep-001`, 'ep-001', 'episode', 'ep-001').run();
    }
    const recall = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '入学', limit: 50 });
    assert.equal(recall.ok, true);
    assert.equal(recall.data.hits.filter((h: any) => h.id === 'ep-001').length, 1, '同一稳定身份重复索引应去重');
    assert.equal(value.sourceEventId, 'ep-001');
  } finally { s.close(); }
});


test('state_read fields/limit 生效且 traverse 返回多跳边', async () => {
  const s = await setup();
  try {
    const projected = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main', fields: ['clock'] });
    assert.equal(projected.ok, true);
    assert.deepEqual(Object.keys(projected.data.state), ['clock']);
    const bounded = await s.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main', fields: ['clock'], maxBytes: 400 });
    assert.equal(bounded.ok, true, JSON.stringify(bounded));
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.data), 'utf8') <= 400);
    const oneHop = await s.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 1 });
    assert.deepEqual(oneHop.data.nodes.map((n: any) => n.id).sort(), ['item.brass-key', 'person.mira', 'person.player', 'person.shen', 'place.library']);
    const traverse = await s.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 3 });
    assert.equal(traverse.ok, true);
    assert.ok(Array.isArray(traverse.data.edges));
    assert.ok(traverse.data.nodes.some((n: any) => n.id === 'person.shen'), JSON.stringify(traverse.data));
    assert.ok(traverse.data.nodes.every((n: any) => !String(n.id).startsWith('rel-')), '关系 ID 不应进入实体节点');
    assert.ok(traverse.data.edges.some((e: any) => e.from === 'person.player' && e.to === 'person.shen'));
  } finally { s.close(); }
});


test('旧库无邻接表时仍返回全部同向关系', async () => {
  const s = await setup();
  try {
    await s.db.prepare('DELETE FROM noa_v3_adjacency WHERE owner_id=? AND campaign_id=? AND worldline_id=?').bind(s.owner, 'demo', 'wl-main').run();
    const traverse = await s.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 1 });
    assert.deepEqual(traverse.data.nodes.map((n: any) => n.id).sort(), ['item.brass-key', 'person.mira', 'person.player', 'person.shen', 'place.library']);
    assert.ok(traverse.data.edges.length >= 4);
    assert.equal(new Set(traverse.data.edges.map((e: any) => e.relationId)).size, traverse.data.edges.length, '同一关系不得重复');
  } finally { s.close(); }
});


test('旧库邻接回填从 family 解析 scope 且部分邻接不漏边', async () => {
  const s = await setup();
  try {
    await s.db.prepare('DELETE FROM noa_v3_adjacency WHERE owner_id=?').bind(s.owner).run();
    await applyV3Schema(s.db);
    const rows = await s.db.prepare('SELECT campaign_id,worldline_id,from_id,to_id FROM noa_v3_adjacency WHERE owner_id=?').bind(s.owner).all();
    assert.ok(rows.results.length >= 4);
    assert.ok(rows.results.every((r: any) => r.campaign_id === 'demo' && r.worldline_id === 'wl-main'));
    // 仅保留一条邻接，模拟旧库部分回填。
    await s.db.prepare('DELETE FROM noa_v3_adjacency WHERE owner_id=? AND from_id=? AND relation_id<>?').bind(s.owner, 'person.player', 'rel-001').run();
    const partial = await s.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 1 });
    assert.deepEqual(partial.data.nodes.map((n: any) => n.id).sort(), ['item.brass-key', 'person.mira', 'person.player', 'person.shen', 'place.library']);
  } finally { s.close(); }
});


test('大型 checkpoint 自动分片且可恢复', async () => {
  const s = await setup();
  try {
    const working = await s.db.prepare('SELECT body FROM noa_v3_doc WHERE owner_id=? AND family=?').bind(s.owner, 'working:demo:wl-main').first();
    const parsed = JSON.parse(working.body);
    parsed.large = 'x'.repeat(3_100_000);
    const bodyText = JSON.stringify(parsed);
    await s.db.prepare('UPDATE noa_v3_doc SET body=?,digest=? WHERE owner_id=? AND family=?').bind(bodyText, hashText(bodyText), s.owner, 'working:demo:wl-main').run();
    const cp = await checkpointV3(s.db, s.owner, { id: 'V224-LARGE', label: 'large', campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(cp.ok, true, JSON.stringify(cp));
    const row = await s.db.prepare('SELECT delta FROM noa_v3_checkpoint WHERE owner_id=? AND id=?').bind(s.owner, 'V224-LARGE').first();
    assert.equal(row.delta, '');
    const chunks = await s.db.prepare('SELECT ordinal,body FROM noa_v3_checkpoint_chunk WHERE owner_id=? AND checkpoint_id=? ORDER BY ordinal').bind(s.owner, 'V224-LARGE').all();
    assert.ok(chunks.results.length > 1);
    assert.ok(chunks.results.every((c: any) => c.body.length < 100000));
    const restore = await s.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: 'V224-LARGE', idempotencyKey: 'V224-LARGE-RESTORE' });
    assert.equal(restore.ok, true, JSON.stringify(restore));
  } finally { s.close(); }
});


test('事件历史与回执同步增长，归档缓存随权威写入失效', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await s.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: `HIST-${i}`, expectedRevision: 7 + i, idempotencyKey: `HIST-K-${i}`, statePatch: { flags: { [`h${i}`]: true } } });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const events = await s.db.prepare('SELECT count(*) n FROM noa_v3_event WHERE owner_id=? AND campaign_id=?').bind(s.owner, 'demo').first();
    const receipts = await s.db.prepare('SELECT count(*) n FROM noa_v3_tx WHERE owner_id=? AND worldline_id=?').bind(s.owner, 'wl-main').first();
    assert.ok(events.n >= receipts.n, `events ${events.n} < receipts ${receipts.n}`);
    const before = await s.call('archive_export', { pageBytes: 1024 });
    const memory = await s.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data: { id: 'entity.archive-stale', type: 'generic', name: 'cache-buster' }, idempotencyKey: 'ARCHIVE-STALE' });
    assert.equal(memory.ok, true, JSON.stringify(memory));
    const after = await s.call('archive_export', { pageBytes: 1024 });
    assert.notEqual(after.data.archiveId, before.data.archiveId);
    assert.notEqual(after.data.sha256, before.data.sha256);
  } finally { s.close(); }
});

test('归档分片缺失或损坏必须拒绝分页', async () => {
  const s = await setup();
  try {
    const header = await s.call('archive_export', { pageBytes: 1024 });
    const page = await s.call('archive_export', { pageBytes: 1024, page: 0, archiveId: header.data.archiveId });
    assert.equal(page.ok, true, JSON.stringify(page));
    await s.db.prepare('DELETE FROM noa_v3_archive_chunk WHERE owner_id=? AND archive_id=? AND ordinal=0').bind(s.owner, header.data.archiveId).run();
    const missing = await s.call('archive_export', { pageBytes: 1024, page: 0, archiveId: header.data.archiveId });
    assert.equal(missing.code, 'archive_chunk_missing');
    await s.db.prepare('INSERT INTO noa_v3_archive_chunk VALUES (?,?,?,?,?)').bind(s.owner, header.data.archiveId, 0, 'AAAA', 'bad').run();
    const corrupt = await s.call('archive_export', { pageBytes: 1024, page: 0, archiveId: header.data.archiveId });
    assert.equal(corrupt.code, 'archive_chunk_corrupt');
  } finally { s.close(); }
});


test('发布状态机 build→verify→activate 与 V2 指针回切', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v224-state-'));
  const db = new D1Sqlite(join(dir, 'state.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'state-owner';
  const document = initialVault();
  await promoteVault(db, owner, { dryRun: false }, null, document);
  const built = await promoteV3(db, owner, document, { sourceVersion: 'R1550' });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.data.status, 'building');
  assert.equal(await hasV3(db, owner), false);
  const verified = await verifyV3(db, owner, document);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const activated = await activateV3(db, owner, { verificationId: verified.data.verificationId, frozen: true });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(await hasV3(db, owner), true);
  assert.equal(await authorityFrozen(db, owner), true);
  const env = { DB: db, NOA_REPAIR_OWNER: owner };
  let id = 0;
  const call = async (name: string, args: any) => {
    const req = new Request('https://sites.local/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const res = await worker.fetch(req, env, {}); const json: any = await res.json(); return JSON.parse(json.result.content[0].text);
  };
  const frozenWrite = await call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-FROZEN', expectedRevision: 7, idempotencyKey: 'SMOKE-FROZEN', statePatch: { flags: { smoke: false } } });
  assert.equal(frozenWrite.code, 'authority_frozen');
  const thaw = await unfreezeAuthority(db, owner);
  assert.equal(thaw.ok, true, JSON.stringify(thaw));
  const smokeWrite = await call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-WRITE', expectedRevision: 7, idempotencyKey: 'SMOKE-WRITE', statePatch: { flags: { smoke: true } } });
  assert.equal(smokeWrite.ok, true, JSON.stringify(smokeWrite));
  const replay = await activateV3(db, owner, { verificationId: verified.data.verificationId });
  assert.equal(replay.code, 'activation_invalid');
  const rolled = await rollbackToV2(db, owner);
  assert.equal(rolled.code, 'authority_after_smoke');
  assert.equal(await hasV3(db, owner), true);
  db.close(); rmSync(dir, { recursive: true, force: true });
});


test('checkpoint 缺片时归档必须 fail-closed', async () => {
  const s = await setup();
  try {
    const working = await s.db.prepare('SELECT body FROM noa_v3_doc WHERE owner_id=? AND family=?').bind(s.owner, 'working:demo:wl-main').first();
    const parsed = JSON.parse(working.body); parsed.large = 'z'.repeat(700 * 1024);
    const bodyText = JSON.stringify(parsed);
    await s.db.prepare('UPDATE noa_v3_doc SET body=?,digest=? WHERE owner_id=? AND family=?').bind(bodyText, hashText(bodyText), s.owner, 'working:demo:wl-main').run();
    const cp = await checkpointV3(s.db, s.owner, { id: 'ARCHIVE-CP', campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(cp.ok, true);
    await s.db.prepare('DELETE FROM noa_v3_checkpoint_chunk WHERE owner_id=? AND checkpoint_id=? AND ordinal=0').bind(s.owner, 'ARCHIVE-CP').run();
    const archive = await archiveExportV3(s.db, s.owner, { pageBytes: 10000 });
    assert.equal(archive.code, 'archive_incomplete');
  } finally { s.close(); }
});


test('冻结阶段回切 V2，原库保留且可写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v224-rollback-'));
  const db = new D1Sqlite(join(dir, 'rollback.sqlite'));
  applyMigrations(db, SITES);
  const owner = 'rollback-owner';
  const document = initialVault();
  await promoteVault(db, owner, { dryRun: false }, null, document);
  const built = await promoteV3(db, owner, document, { sourceVersion: 'R1550' });
  assert.equal(built.ok, true);
  const verified = await verifyV3(db, owner, document);
  await activateV3(db, owner, { verificationId: verified.data.verificationId, frozen: true });
  const before = sha256((await openV2(db, owner)).document);
  const rolled = await rollbackToV2(db, owner);
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(await hasV3(db, owner), false);
  const write = await transactVault(db, owner, doc => ({ write: true, document: { ...doc, active: { campaignId: 'demo', worldlineId: 'wl-main' } }, value: { ok: true } }), undefined);
  assert.equal(write.ok, true);
  assert.equal(sha256((await openV2(db, owner)).document) === before, true, 'V2 原文档内容不应被回切改写');
  db.close(); rmSync(dir, { recursive: true, force: true });
});


test('Recall 全量扫描可命中后部实体与属性文本', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 12; i++) {
      const r = await s.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data: { id: `entity.fill-${i}`, type: 'generic', name: `填充-${i}` }, idempotencyKey: `FILL-${i}` });
      assert.equal(r.ok, true);
    }
    const target = await s.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data: { id: 'entity.xiaoyan', type: 'person', name: '萧炎', attributes: { title: '九星斗圣' } }, idempotencyKey: 'RECALL-XIAOYAN' });
    assert.equal(target.ok, true, JSON.stringify(target));
    const hit = await s.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '九星斗圣', limit: 5 });
    assert.equal(hit.ok, true);
    assert.equal(hit.data.hits.some((h: any) => h.id === 'entity.xiaoyan'), true, JSON.stringify(hit.data));
  } finally { s.close(); }
});
