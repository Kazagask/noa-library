import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../packages/core/shared.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { dispatchTool } from '../packages/server/dispatch.ts';
import { TOOL_SCOPES, requiredScope, handleRequest } from '../packages/server/api.ts';
import { createServer } from 'node:http';
import { READ_BUDGETS } from '../packages/server/read-budget.ts';
import { recordMemory, checkpoint } from '../packages/library/operations.ts';
import { recoverySnapshot } from '../packages/library/recovery.ts';
import { buildMemoryLayerIndex, loadMemoryLayerIndex, refsForTiers, checkIndexFreshness } from '../packages/library/memory-tiers.ts';
import { createIncrementalCheckpoint, restoreIncrementalCheckpoint } from '../packages/library/checkpoint-governance.ts';
import { buildProjections, verifyProjectionCoverage } from '../packages/library/projections.ts';
import { submitChapterSummary, transitionLifecycle, lifecycleOf } from '../packages/library/lifecycle.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXED = '2026-11-27T01:40:00.000Z';
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'noa-v211-'));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  return { dir, root, store: new FsStore(root), cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lock */ } } };
}

test('只读 Token 对全部写工具默认拒绝，未知工具默认拒绝', () => {
  const writes = Object.entries(TOOL_SCOPES).filter(([, scope]) => scope !== 'read').map(([name]) => name);
  for (const tool of writes) assert.notEqual(requiredScope(tool), 'read', `${tool} 不得对只读可见`);
  assert.equal(requiredScope('no_such_tool'), null);
  assert.equal(requiredScope('memory.layers', { apply: true }), 'write');
  assert.equal(requiredScope('memory.layers', {}), 'read');
  assert.equal(requiredScope('memory.recall', { includeL3: true }), 'admin');
});

test('HTTP MCP：只读 Token 调用全部写工具返回 403', async () => {
  const f = fresh();
  const server = createServer((req, res) => { void handleRequest(f.store, req, res, { ro: ['read'] }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const writes = Object.keys(TOOL_SCOPES).filter(t => requiredScope(t) !== 'read');
    for (const tool of writes) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ro' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.replace(/\./g, '_'), arguments: {} } })
      });
      assert.equal(res.status, 403, `${tool} 未被只读 Token 拒绝`);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.cleanup();
  }
});

test('恶意扩大 maxBytes/limit 只能缩小预算，分页可遍历全部结果', async () => {
  const f = fresh();
  try {
    const snap = f.store.read('demo', 'wl-main');
    for (let i = 1; i <= 24; i++) snap.episodes.push({
      id: `ep-page-${String(i).padStart(2, '0')}`, at: FIXED, turn: i, title: `PAGE-TOKEN ${i}`,
      summary: `PAGE-TOKEN ${i} ${'填充'.repeat(120)}`, excerpt: '', worldlineId: 'wl-main',
      entities: ['person.player'], relationIds: [], knownBy: ['*'], sourceEventId: `page-${i}`,
      path: `page-${i}.md`, tags: ['page'], confidence: 1
    } as any);
    f.store.write('demo', 'wl-main', snap);
    let cursor: number | null = 0;
    const seen = new Set<string>();
    let guard = 0;
    while (cursor !== null && guard++ < 30) {
      const result = await dispatchTool(f.store, 'memory.recall', {
        query: 'PAGE-TOKEN', limit: 1000000, maxBytes: 100000000, cursor
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const data = result.data;
      assert.ok(data.budget.maxBytes <= READ_BUDGETS.business - 1024, '调用者不得扩大服务端上限');
      for (const hit of data.hits ?? []) seen.add(hit.id);
      cursor = data.nextCursor ?? null;
    }
    assert.ok(seen.size >= 20, `分页未覆盖全部结果: ${seen.size}`);
  } finally { f.cleanup(); }
});

test('叙述交付状态来自显式回执标记，不从摘要推断', () => {
  const f = fresh();
  try {
    f.store.appendEvent('demo', { id: 'narr-pending', op: 'state.commit', worldlineId: 'wl-main', narrativeRequired: true, idempotencyKey: 'np', seq: 100 });
    f.store.appendEvent('demo', { id: 'narr-delivered', op: 'state.commit', worldlineId: 'wl-main', narrativeRequired: true, narrativeDelivered: true, idempotencyKey: 'nd', seq: 101 });
    const recovery = recoverySnapshot(f.store, { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(recovery.ok, true);
    assert.ok((recovery as any).data.pendingNarratives.includes('narr-pending'));
    assert.equal((recovery as any).data.pendingNarratives.includes('narr-delivered'), false);
  } finally { f.cleanup(); }
});

test('生命周期状态机拒绝非法跃迁，摘要与归档原子落盘', () => {
  const f = fresh();
  try {
    const illegal = transitionLifecycle(f.store, { campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'illegal', to: 'archived', idempotencyKey: 'bad', actor: 'gm' });
    assert.equal(illegal.ok, false);
    assert.equal(illegal.code, 'illegal_transition');
    const summary = submitChapterSummary(f.store, {
      id: 'sum-v211', campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'instance-v211',
      keyCausality: ['结算完成'], characterChanges: [], resourceChanges: [], unresolved: [],
      decisions: ['叙事裁决'], sourceEventIds: ['ep-001'], sourceHash: '', stateRevision: 7,
      memoryRevision: 0, createdAt: FIXED, actor: 'gm', target: 'archived'
    });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    const state = lifecycleOf(f.store, 'demo', 'instance-v211');
    assert.equal((state as any).data.stage, 'archived');
    assert.equal((state as any).data.revision >= 1, true);
  } finally { f.cleanup(); }
});

test('checkpoint 真实增量恢复并校验状态/记忆哈希', () => {
  const f = fresh();
  try {
    const base = checkpoint(f.store, { campaignId: 'demo', worldlineId: 'wl-main', label: 'base', idempotencyKey: 'base-v211', actor: 'gm', at: FIXED, retention: 5 });
    assert.equal(base.ok, true);
    const baseId = (base as any).data.checkpointId;
    const after = recordMemory(f.store, {
      campaignId: 'demo', worldlineId: 'wl-main', kind: 'relation',
      data: { subject: 'person.player', predicate: '增量', object: 'checkpoint', description: 'delta', knownBy: ['*'], sourceEventId: 'delta-src' },
      idempotencyKey: 'delta-v211', actor: 'gm', at: FIXED
    });
    assert.equal(after.ok, true);
    const delta = createIncrementalCheckpoint(f.store, { campaignId: 'demo', worldlineId: 'wl-main', baseCheckpointId: baseId, id: 'delta-v211-cp', createdAt: FIXED });
    assert.equal(delta.ok, true);
    assert.equal(Object.keys((delta as any).data.changes).includes('state'), false, '未变化分片不应写入增量');
    const expectedHash = sha256(f.store.read('demo', 'wl-main').state);
    const snap = f.store.read('demo', 'wl-main');
    snap.state.resources = { gold: -1 };
    f.store.write('demo', 'wl-main', snap);
    const restored = restoreIncrementalCheckpoint(f.store, 'demo', 'delta-v211-cp');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(sha256((restored as any).data.snapshot.state), expectedHash);
    assert.equal((restored as any).data.applied.length, 1);
  } finally { f.cleanup(); }
});

test('memory.layers 按世界线隔离、权限过滤与陈旧检测', () => {
  const f = fresh();
  try {
    f.store.createWorldline('demo', 'wl-main', 'wl-other', f.store.read('demo', 'wl-main'));
    const built = buildMemoryLayerIndex(f.store, 'demo', 'wl-main', { apply: true, at: FIXED });
    assert.equal(built.ok, true);
    const main = loadMemoryLayerIndex(f.store, 'demo', 'wl-main');
    const other = loadMemoryLayerIndex(f.store, 'demo', 'wl-other');
    assert.equal(main.ok, true);
    assert.equal(other.ok, false, '世界线索引必须隔离');
    const gmRefs = refsForTiers((main as any).data, ['L0', 'L1', 'L2'], { viewer: 'gm', gm: true });
    const playerRefs = refsForTiers((main as any).data, ['L0', 'L1', 'L2'], { viewer: 'person.player' });
    assert.ok(gmRefs.length >= playerRefs.length);
    const snap = f.store.read('demo', 'wl-main');
    snap.state.revision += 1;
    f.store.write('demo', 'wl-main', snap);
    const freshness = checkIndexFreshness(f.store, (main as any).data);
    assert.equal((freshness as any).data.fresh, false);
  } finally { f.cleanup(); }
});

test('投影覆盖 Sites 业务分片与全部待办状态', () => {
  const f = fresh();
  try {
    const seed = JSON.parse(readFileSync(join(ROOT, 'apps/sites/src/seed.json'), 'utf8'));
    const snap: any = f.store.read('demo', 'wl-main');
    snap.state = seed.snapshot.state;
    snap.working = {
      ...seed.snapshot.working,
      pendingTasks: [
        { id: 't1', status: 'open' }, { id: 't2', status: 'completed' }, { id: 't3', status: 'sealed' }
      ],
      legacyPendingRecords: [{ id: 'legacy-1' }]
    };
    snap.state.extension = { business: { research: { projects: { p1: { id: 'p1' } } }, economy: { industries: { i1: { id: 'i1' } } }, settlementLedger: { b1: { id: 'b1' } } } };
    f.store.write('demo', 'wl-main', snap);
    const projections = buildProjections(f.store.read('demo', 'wl-main'), FIXED);
    assert.equal(projections.ok, true);
    const coverage = verifyProjectionCoverage(f.store.read('demo', 'wl-main'), (projections as any).data);
    assert.equal(coverage.ok, true, JSON.stringify(coverage));
    assert.equal((projections as any).data.pendingEvents.value.length, 3);
  } finally { f.cleanup(); }
});
