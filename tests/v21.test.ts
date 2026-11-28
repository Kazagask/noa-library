import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { sha256, stableStringify } from '../packages/core/shared.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { buildMemoryLayerIndex, refsForTiers } from '../packages/library/memory-tiers.ts';
import { submitChapterSummary } from '../packages/library/lifecycle.ts';
import { buildProjections, detectStaleProjection } from '../packages/library/projections.ts';
import { splitTodos, setTodoStatus } from '../packages/library/todos.ts';
import { recoverySnapshot } from '../packages/library/recovery.ts';
import { planCheckpoints, verifyCheckpoints } from '../packages/library/checkpoint-governance.ts';
import { commitState, executeRoll, checkpoint } from '../packages/library/operations.ts';
import { dispatchTool } from '../packages/server/dispatch.ts';
import { verifyProductionBaseline, type ProductionBaseline } from '../packages/library/migration-baseline.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
function fresh(prefix = 'noa-v21-'): { dir: string; root: string; store: FsStore; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  return { dir, root, store: new FsStore(root), cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } } };
}
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function seedBattle(store: FsStore, rounds = 50): void {
  const snap = store.read('demo', 'wl-main');
  for (let i = 1; i <= rounds; i++) {
    snap.episodes.push({
      id: `battle-round-${i}`, at: `2026-11-26T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
      turn: 1000 + i, title: `净莲妖火副本战斗第 ${i} 轮`,
      summary: `ROUND-${i}-CRITICAL ${'战斗原文'.repeat(300)}`, excerpt: 'raw-combat-log',
      worldlineId: 'wl-main', entities: ['person.player'], relationIds: [], knownBy: ['*'],
      sourceEventId: `battle-evt-${i}`, path: `battle/${i}.md`, tags: ['combat-log', 'dungeon'], confidence: 1
    } as any);
  }
  store.write('demo', 'wl-main', snap);
}

test('1+2. 50 轮大型战斗结算、摘要、封存与重复 bootstrap 不重载', async () => {
  const f = fresh();
  try {
    seedBattle(f.store);
    const built = buildMemoryLayerIndex(f.store, 'demo', 'wl-main', { apply: true });
    assert.equal(built.ok, true);
    const index = built.data;
    assert.equal(index.counts.L3 >= 50, true);
    const summary = submitChapterSummary(f.store, {
      id: 'sum-battle-1', campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'net-lotus-dungeon',
      keyCausality: ['炼化成功'], characterChanges: ['萧炎七星斗尊'], resourceChanges: ['资金变化'],
      unresolved: ['第八蜕变待选'], decisions: ['玩家叙事裁决'],
      sourceEventIds: ['battle-round-1', 'battle-round-50'],
      sourceHash: '', stateRevision: 7, memoryRevision: 0, createdAt: FIXED, actor: 'gm',
      target: 'archived', idempotencyKey: 'battle-archive-1'
    });
    assert.equal(summary.ok, true);
    const repeated = submitChapterSummary(f.store, {
      id: 'sum-battle-1', campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'net-lotus-dungeon',
      keyCausality: ['炼化成功'], characterChanges: [], resourceChanges: [], unresolved: [], decisions: [],
      sourceEventIds: ['battle-round-1', 'battle-round-50'], sourceHash: '', stateRevision: 7,
      memoryRevision: 0, createdAt: FIXED, actor: 'gm', target: 'archived', idempotencyKey: 'battle-archive-1'
    });
    assert.equal((repeated as any).data.deduplicated, true);

    const bootBytes: number[] = [];
    for (let i = 0; i < 2; i++) {
      const boot = await dispatchTool(f.store, 'session.bootstrap', { maxBytes: 8192, maxChars: 6000 });
      assert.equal(boot.ok, true);
      const bytes = wireBytes(boot.data);
      bootBytes.push(bytes);
      assert.ok(bytes <= 8192, `bootstrap 超出 8KiB: ${bytes}`);
      assert.equal(JSON.stringify(boot.data).includes('ROUND-50-CRITICAL'), false, 'L3 战斗原文不得进入 bootstrap');
      assert.ok((boot as any).data.activeTodoCount >= 0);
    }
    writeFileSync(join(ROOT, 'reports', 'v21-performance.json'), JSON.stringify({
      scenario: '50 轮大型战斗，重复 bootstrap',
      l3BattleEpisodes: 50, bootstrapBytes: bootBytes, budgetBytes: 8192,
      note: 'L3 原文未进入上下文；体积受服务端硬预算约束。'
    }, null, 2));
  } finally { f.cleanup(); }
});

const FIXED = '2026-11-27T01:00:00.000Z';

test('3. 事务成功后连接断开：恢复不重复掷骰/扣费/奖励/推进时间', async () => {
  const f = fresh();
  try {
    const before = f.store.read('demo', 'wl-main');
    const r1 = await dispatchTool(f.store, 'runtime.execute', { skill: 2, difficulty: 1, idempotencyKey: 'sse-roll-1', actor: 'gm' });
    assert.equal(r1.ok, true);
    const afterFirst = f.store.read('demo', 'wl-main');
    const r2 = await dispatchTool(f.store, 'runtime.execute', { skill: 2, difficulty: 1, idempotencyKey: 'sse-roll-1', actor: 'gm' });
    assert.equal(r2.ok, true, '重复请求必须返回原幂等结果');
    const afterSecond = f.store.read('demo', 'wl-main');
    assert.equal(afterSecond.state.rng.cursor, afterFirst.state.rng.cursor);
    assert.equal(afterSecond.state.revision, afterFirst.state.revision);
    assert.equal(sha256(afterSecond.state.resources), sha256(afterFirst.state.resources));
    const recovery = recoverySnapshot(f.store, { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(recovery.ok, true);
    assert.ok((recovery as any).data.rngCursor >= before.state.rng.cursor);
    assert.ok((recovery as any).data.recentReceipts.length >= 1);
  } finally { f.cleanup(); }
});

test('4. 并发提交与 revision 冲突，投影带 revision 且可检测陈旧', () => {
  const f = fresh();
  try {
    const a = commitState(f.store, { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 7, changes: { resources: { ink: 11 } }, idempotencyKey: 'conc-1', actor: 'gm', at: FIXED });
    assert.equal(a.ok, true);
    const b = commitState(f.store, { campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 7, changes: { resources: { ink: 12 } }, idempotencyKey: 'conc-2', actor: 'gm', at: FIXED });
    assert.equal(b.ok, false);
    assert.equal(b.code, 'revision_conflict');
    const snap = f.store.read('demo', 'wl-main');
    const projections = buildProjections(snap, FIXED);
    assert.equal(projections.ok, true);
    assert.equal((projections as any).data.party.sourceRevision, snap.state.revision);
    const stale = detectStaleProjection((projections as any).data.party, { ...snap, state: { ...snap.state, revision: 999 } });
    assert.equal(stale, true);
  } finally { f.cleanup(); }
});

test('5. 所有常规读取接口具备服务端硬预算', async () => {
  const f = fresh();
  try {
    seedBattle(f.store, 20);
    const cases: Array<[string, Record<string, any>, number]> = [
      ['session.bootstrap', { maxBytes: 8192 }, 8192],
      ['persona.load', { maxBytes: 8192 }, 8192],
      ['state.read', { paths: ['revision'], maxBytes: 16384 }, 16384],
      ['memory.recall', { query: '战斗', maxBytes: 16384, limit: 200 }, 16384],
      ['memory.traverse', { start: 'person.player', hops: 2, maxBytes: 16384 }, 16384],
      ['event.receipt', { lookup: 'not-found', maxBytes: 8192 }, 8192]
    ];
    for (const [tool, args, cap] of cases) {
      const result = await dispatchTool(f.store, tool, args);
      assert.ok(wireBytes(result.ok ? result.data : result) <= cap, `${tool} 超出预算: ${wireBytes(result)}`);
    }
    const huge = await dispatchTool(f.store, 'state.read', { maxBytes: 64 });
    assert.equal(huge.ok, false);
    assert.equal(huge.code, 'state_budget_exceeded', '权威状态不得静默截断');
    const archive = await dispatchTool(f.store, 'archive.export', {});
    assert.equal(archive.code, 'backup_only', '备份导出不进入常规 GM 工作流');
  } finally { f.cleanup(); }
});

test('6. 封存事件仍可审计，原始骰值与回执完整', async () => {
  const f = fresh();
  try {
    const roll = await dispatchTool(f.store, 'runtime.execute', { skill: 3, difficulty: 2, idempotencyKey: 'audit-roll', actor: 'gm' });
    assert.equal(roll.ok, true);
    const receiptId = (roll as any).data.receipt?.id ?? 'audit-roll';
    const events = f.store.events('demo', 'wl-main');
    assert.ok(events.some(e => e.idempotencyKey === 'roll:audit-roll'));
    const found = await dispatchTool(f.store, 'event.receipt', { lookup: 'roll:audit-roll' });
    assert.equal(found.ok, true);
    assert.ok(receiptId);
    assert.equal(JSON.stringify(found.data).includes('audit-roll'), true);
  } finally { f.cleanup(); }
});

test('7. checkpoint 恢复与历史时序校验', () => {
  const f = fresh();
  try {
    const cp = checkpoint(f.store, { campaignId: 'demo', worldlineId: 'wl-main', label: 'v21', idempotencyKey: 'v21-cp', actor: 'gm', at: FIXED, retention: 2 });
    assert.equal(cp.ok, true);
    const plan = planCheckpoints(f.store, 'demo', 2);
    assert.equal(plan.ok, true);
    const verify = verifyCheckpoints(f.store, 'demo');
    assert.equal(verify.ok, true);
    assert.equal((verify as any).data.invalid.length, 0);
    assert.ok((plan as any).data.total >= 1);
  } finally { f.cleanup(); }
});

test('8. 1万/10万轮合成数据的读取趋势', () => {
  const sizes = [10_000, 100_000];
  const rows: any[] = [];
  const measures: any[] = [];
  for (const n of sizes) {
    const synthetic = Array.from({ length: n }, (_, i) => ({ id: `ref-${i}`, tier: i % 4 === 0 ? 'L3' : 'L2', bytes: 128 }));
    const t = performance.now();
    const visible = refsForTiers({ refs: synthetic } as any, ['L0', 'L1', 'L2']);
    const ms = performance.now() - t;
    rows.push({ n, visible: visible.length });
    measures.push({ n, ms: Number(ms.toFixed(2)), bytes: wireBytes(visible) });
  }
  const growth = measures[1].ms / Math.max(measures[0].ms, 0.01);
  const report = { scenario: '分层引用过滤，非原文加载', measures, growth: Number(growth.toFixed(2)), note: '10x 数据下应为近似线性增长；L3 默认不进入上下文。' };
  writeFileSync(join(ROOT, 'reports', 'v21-scale.json'), JSON.stringify(report, null, 2));
  assert.ok(growth < 30, `增长异常: ${growth}`);
  assert.equal(rows[1].visible < sizes[1], true);
});

test('9. 人格独立记忆不受世界线归档影响', () => {
  const f = fresh();
  try {
    const paths = ['personas/noa/identity.yaml', 'personas/noa/memory/entities.jsonl', 'personas/noa/memory/relations.jsonl', 'personas/noa/archive-profile.json'];
    const before = paths.map(p => existsSync(join(f.root, p)) ? sha256(readFileSync(join(f.root, p), 'utf8')) : null);
    submitChapterSummary(f.store, {
      id: 'sum-persona-guard', campaignId: 'demo', worldlineId: 'wl-main', instanceId: 'guard',
      keyCausality: [], characterChanges: [], resourceChanges: [], unresolved: [], decisions: [],
      sourceEventIds: ['ep-001'], sourceHash: '', stateRevision: 7, memoryRevision: 0, createdAt: FIXED, actor: 'gm'
    });
    setTodoStatus(f.store, { campaignId: 'demo', worldlineId: 'wl-main', id: (f.store.read('demo', 'wl-main').working.pendingTasks[0]?.id ?? 'none'), status: 'sealed', idempotencyKey: 'guard-todo', actor: 'gm' });
    const after = paths.map(p => existsSync(join(f.root, p)) ? sha256(readFileSync(join(f.root, p), 'utf8')) : null);
    assert.deepEqual(after, before);
  } finally { f.cleanup(); }
});

test('10. SAVE-481 迁移基准校验项不被改写', () => {
  const snapshot: any = {
    state: {
      revision: 7, rng: { cursor: 0 }, actors: { 'person.test': { realm: '斗师', exp: 100, maxExp: 1000 } },
      resources: { gold: 12345 },
      cultivation: { skills: { 'test-skill': { stage: '初阶' } } }
    },
    working: { memoryRevision: 0 }
  };
  const baseline: ProductionBaseline = {
    campaignId: 'SAVE-481', worldlineId: 'wl-main', eventId: 'fixture-event',
    stateRevision: 7, memoryRevision: 0, rngCursor: 0,
    gold: 12345, realm: '斗师', exp: 100, expMax: 1000,
    skill: 'test-skill', skillStage: '初阶', originalRolls: [1, 2],
    generatedAt: FIXED, source: 'isolated-fixture'
  };
  const checked = verifyProductionBaseline(snapshot, baseline);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const tampered = structuredClone(snapshot);
  tampered.state.revision = 1074;
  assert.equal(verifyProductionBaseline(tampered, baseline).code, 'baseline_mismatch');
});
