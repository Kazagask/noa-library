import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { FsStore } from '../packages/library/fs-store.ts';
import { SqliteStore } from '../packages/server/sqlite-store.ts';
import { buildColdStart } from '../packages/library/coldstart.ts';
import * as ops from '../packages/library/operations.ts';
import { authenticate, handleRequest, TOOL_SCOPES } from '../packages/server/api.ts';
import { sha256 } from '../packages/core/util.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Fixture {
  dir: string; root: string; fs: FsStore; sql: SqliteStore;
  cleanup(): void;
}

function fresh(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'noa-accept-'));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, {
    recursive: true,
    filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src)
  });
  const fs = new FsStore(root);
  const sql = new SqliteStore(root, join(dir, 'db.sqlite'));
  sql.seedFromFiles('demo');
  return {
    dir, root, fs, sql,
    cleanup() {
      try { sql.close(); } catch { /* 已关闭 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁文件 */ }
    }
  };
}

async function withFresh(fn: (f: Fixture) => void | Promise<void>): Promise<void> {
  const f = fresh();
  try { await fn(f); } finally { f.cleanup(); }
}

const MAIN = { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', actor: 'person.player' };
const T1 = '2026-11-25T15:00:00.000Z';

test('1. 新会话冷启动恢复人格及状态', async () => {
  await withFresh(({ fs }) => {
    const result = buildColdStart(fs, { ...MAIN, maxChars: 6000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.data.text, /诺娅/);
    assert.match(result.data.text, /revision=7/);
    assert.match(result.data.text, /ep-004/);
    assert.match(result.data.text, /state\.commit/);
    assert.ok(result.data.charCount <= result.data.budget);
    assert.equal(result.data.text.includes('rel-003'), false, '秘密关系不得进入冷启动');
    assert.equal(result.data.text.includes('rel-004'), false, '主观认知不得进入冷启动');
    const tight = buildColdStart(fs, { ...MAIN, maxChars: 600 });
    assert.equal(tight.ok, true);
    if (tight.ok) {
      assert.equal(tight.data.truncated, true);
      assert.match(tight.data.text, /revision=7/);
    }
  });
});

test('2. 根据人物 ID 召回相关经历与关系', async () => {
  await withFresh(({ fs }) => {
    const result = ops.recall(fs, { ...MAIN, query: 'person.mira', limit: 50 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const ids = result.data.hits.map((h: any) => h.id);
    assert.ok(ids.includes('rel-002'), '应召回与米拉的关系');
    assert.ok(ids.includes('person.mira'), '应召回实体');
    assert.ok(ids.includes('ep-002'), '应召回相关经历');
  });
});

test('3. 多跳图谱检索', async () => {
  await withFresh(({ fs }) => {
    const result = ops.traverse(fs, { ...MAIN, start: 'person.player', hops: 2 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const depths = new Map(result.data.nodes.map((n: any) => [n.id, n.depth]));
    assert.equal(depths.get('person.shen'), 1);
    assert.equal(depths.get('place.council-hall'), 2);
    assert.ok(result.data.edges.some((e: any) => e.id === 'rel-007'));
    assert.equal(result.data.edges.some((e: any) => e.id === 'rel-003'), false);
  });
});

test('4. 历史关系修正与失效', async () => {
  await withFresh(({ fs }) => {
    const before = ops.recall(fs, { ...MAIN, query: '暂住', asOf: '2026-11-05T00:00:00.000Z' });
    assert.ok(before.ok && before.data.hits.some((h: any) => h.id === 'rel-006'));
    const after = ops.recall(fs, { ...MAIN, query: '暂住', asOf: T1 });
    assert.ok(after.ok && !after.data.hits.some((h: any) => h.id === 'rel-006'));

    const revised = ops.reviseMemory(fs, {
      ...MAIN, kind: 'relation', id: 'rel-001', expectedRevision: 1,
      patch: { description: '修正：林砚旁听沈砚秋的课程，尚未正式拜师。', confidence: 0.6 },
      idempotencyKey: 'revise-rel-001', at: T1
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    assert.match(revised.data.newId as string, /^rel-/);
    const snap = fs.read('demo', 'wl-main');
    const old = snap.relations.find(r => r.id === 'rel-001');
    const next = snap.relations.find(r => r.id === revised.data.newId);
    assert.equal(old?.status, 'superseded');
    assert.equal(old?.validUntil, T1);
    assert.equal(next?.supersedes, 'rel-001');
    assert.equal(next?.status, 'active');
    const recall = ops.recall(fs, { ...MAIN, query: '旁听', asOf: '2026-11-26T00:00:00.000Z' });
    assert.ok(recall.ok && recall.data.hits.some((h: any) => h.id === revised.data.newId));
  });
});

test('5. NPC 秘密情报隔离', async () => {
  await withFresh(({ fs }) => {
    const player = ops.recall(fs, { ...MAIN, query: '钥匙' });
    assert.equal(player.ok, true);
    if (player.ok) {
      const ids = player.data.hits.map((h: any) => h.id);
      assert.equal(ids.includes('rel-003'), false);
      assert.equal(ids.includes('ep-003'), false);
      assert.equal(ids.includes('secret.archive-key'), false);
    }
    const mira = ops.recall(fs, { ...MAIN, viewer: 'person.mira', query: '钥匙' });
    assert.ok(mira.ok && mira.data.hits.some((h: any) => h.id === 'rel-003'));
    assert.ok(mira.ok && mira.data.hits.some((h: any) => h.id === 'ep-003'));

    const shenBelief = ops.recall(fs, { ...MAIN, viewer: 'person.shen', query: '禁书', includeBeliefs: true });
    assert.ok(shenBelief.ok && shenBelief.data.hits.some((h: any) => h.id === 'rel-004'));
    const playerBelief = ops.recall(fs, { ...MAIN, query: '禁书', includeBeliefs: true });
    assert.ok(playerBelief.ok && !playerBelief.data.hits.some((h: any) => h.id === 'rel-004'));
    const shenFactOnly = ops.recall(fs, { ...MAIN, viewer: 'person.shen', query: '禁书' });
    assert.ok(shenFactOnly.ok && !shenFactOnly.data.hits.some((h: any) => h.id === 'rel-004'));

    const badBelief = ops.recordMemory(fs, {
      ...MAIN, kind: 'relation', idempotencyKey: 'bad-belief',
      data: { subject: 'person.shen', predicate: '认为', object: 'person.player', description: '无 holder', epistemic: 'belief' }, at: T1
    });
    assert.equal(badBelief.ok, false);
  });
});

test('6. 世界线分叉与回档', async () => {
  await withFresh(({ fs }) => {
    const cp = ops.checkpoint(fs, { ...MAIN, label: 'before-choice', id: 'cp-test-1', at: T1 });
    assert.equal(cp.ok, true);
    const fork = ops.forkWorldline(fs, { ...MAIN, to: 'wl-alt', idempotencyKey: 'fork-1', at: T1 });
    assert.equal(fork.ok, true);

    const newRel = ops.recordMemory(fs, {
      ...MAIN, worldlineId: 'wl-alt', kind: 'relation', idempotencyKey: 'alt-secret',
      data: { subject: 'person.player', predicate: '得知', object: 'secret.archive-key', description: '分叉线里秘密被揭开', knownBy: ['*'] }, at: T1
    });
    assert.equal(newRel.ok, true);
    const changed = ops.commitState(fs, {
      ...MAIN, worldlineId: 'wl-alt', expectedRevision: 7, changes: { flags: { tutorialDone: false } },
      idempotencyKey: 'alt-flag', at: T1
    });
    assert.equal(changed.ok, true);

    const mainState = fs.read('demo', 'wl-main').state;
    assert.equal(mainState.revision, 7);
    assert.equal(fs.read('demo', 'wl-alt').state.revision, 8);

    const restore = ops.restore(fs, { ...MAIN, checkpointId: 'cp-test-1', idempotencyKey: 'restore-1', at: T1 });
    assert.equal(restore.ok, true);
    const restored = fs.read('demo', 'wl-main');
    assert.equal(restored.state.revision, 7);
    assert.equal(restored.state.rng.cursor, 4);
    assert.equal(restored.relations.some(r => r.id === (newRel.ok ? newRel.data.id : '')), false);
    assert.equal(fs.read('demo', 'wl-alt').relations.some(r => r.id === (newRel.ok ? newRel.data.id : '')), true);
  });
});

test('7. 并发版本冲突检测', async () => {
  await withFresh(({ fs }) => {
    const first = ops.commitState(fs, {
      ...MAIN, expectedRevision: 7, changes: { flags: { tutorialDone: false } }, idempotencyKey: 'c1', at: T1
    });
    const second = ops.commitState(fs, {
      ...MAIN, expectedRevision: 7, changes: { flags: { tutorialDone: true } }, idempotencyKey: 'c2', at: T1
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, 'revision_conflict');
    assert.equal(fs.read('demo', 'wl-main').state.revision, 8);
  });
});

test('8. 重复请求幂等处理', async () => {
  await withFresh(({ fs }) => {
    const input = {
      ...MAIN, expectedRevision: 7, changes: { resources: { ink: 4 } },
      idempotencyKey: 'idem-commit', at: T1
    };
    const first = ops.commitState(fs, input);
    const again = ops.commitState(fs, input);
    assert.equal(first.ok, true);
    assert.equal(again.ok, true);
    assert.equal(fs.read('demo', 'wl-main').state.revision, 8);
    assert.equal(fs.events('demo', 'wl-main').filter((e: any) => e.idempotencyKey === 'idem-commit').length, 1);

    const recInput = {
      ...MAIN, kind: 'relation' as const, idempotencyKey: 'idem-record', at: T1,
      data: { subject: 'person.player', predicate: '借阅', object: 'item.note', description: '借到纸条' }
    };
    const r1 = ops.recordMemory(fs, recInput);
    const r2 = ops.recordMemory(fs, recInput);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal((r2 as any).data.id, (r1 as any).data.id, '同幂等键重复请求返回首次结果');
    assert.equal(fs.read('demo', 'wl-main').relations.filter(r => r.subject === 'person.player' && r.predicate === '借阅').length, 1);
  });
});

test('9. 确定性状态与语义记忆冲突处理', async () => {
  await withFresh(({ fs }) => {
    const changes = { inventory: [{ id: 'item.note', name: '折起的纸条', qty: 1, owner: 'person.player' }] };
    const noResolution = ops.commitState(fs, { ...MAIN, expectedRevision: 7, changes, idempotencyKey: 'conflict-1', at: T1 });
    assert.equal(noResolution.ok, false);
    if (!noResolution.ok) {
      assert.equal(noResolution.code, 'state_memory_conflict');
      assert.ok(Array.isArray((noResolution.details as any).conflicts));
    }
    const memoryWins = ops.commitState(fs, { ...MAIN, expectedRevision: 7, changes, idempotencyKey: 'conflict-2', resolution: 'memory-authoritative', at: T1 });
    assert.equal(memoryWins.ok, false);
    const stateWins = ops.commitState(fs, {
      ...MAIN, expectedRevision: 7, changes, idempotencyKey: 'conflict-3',
      resolution: 'state-authoritative', reason: '钥匙在剧情中已遗失', at: T1
    });
    assert.equal(stateWins.ok, true);
    if (stateWins.ok) assert.ok((stateWins.data.conflictsResolved as string[]).includes('rule.brass-key'));
    const rel = fs.read('demo', 'wl-main').relations.find(r => r.id === 'rel-005');
    assert.equal(rel?.status, 'superseded');
    const recall = ops.recall(fs, { ...MAIN, query: '黄铜钥匙', asOf: '2026-11-26T00:00:00.000Z' });
    assert.ok(recall.ok && !recall.data.hits.some((h: any) => h.id === 'rel-005'));
  });
});

test('10. 服务重启后数据完整恢复', async () => {
  const f = fresh();
  try {
    const commit = ops.commitState(f.sql, { ...MAIN, expectedRevision: 7, changes: { resources: { ink: 9 } }, idempotencyKey: 'restart-commit', at: T1 });
    assert.equal(commit.ok, true);
    const rec = ops.recordMemory(f.sql, {
      ...MAIN, kind: 'relation', idempotencyKey: 'restart-rel', at: T1,
      data: { subject: 'person.player', predicate: '重访', object: 'place.library', description: '重启后仍在的记忆' }
    });
    assert.equal(rec.ok, true);
    f.sql.close();
    const reopened = new SqliteStore(f.root, join(f.dir, 'db.sqlite'));
    try {
      const state = reopened.read('demo', 'wl-main').state;
      assert.equal(state.revision, 8);
      assert.equal(state.resources.ink, 9);
      assert.equal(reopened.read('demo', 'wl-main').relations.some(r => r.description === '重启后仍在的记忆'), true);
      assert.ok(reopened.searchFts('demo', 'wl-main', '灯禁').length > 0, 'FTS5 索引应可用');
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('11. 非法写入与越权访问拒绝', async () => {
  const f = fresh();
  try {
    const badField = ops.commitState(f.sql, { ...MAIN, expectedRevision: 7, changes: { bogus: 1 }, idempotencyKey: 'bad-field', at: T1 });
    assert.equal(badField.ok, false);
    if (!badField.ok) assert.equal(badField.code, 'invalid_change');
    const badSchema = ops.commitState(f.sql, { ...MAIN, expectedRevision: 7, changes: { clock: { turn: 'x', date: '2026-11-25', period: 'night' } }, idempotencyKey: 'bad-schema', at: T1 });
    assert.equal(badSchema.ok, false);
    if (!badSchema.ok) assert.equal(badSchema.code, 'schema_invalid');

    const injection = ops.recordMemory(f.sql, {
      ...MAIN, kind: 'relation', idempotencyKey: 'injection', at: T1,
      data: { subject: 'person.player', predicate: '测试', object: 'item.note', description: "'; DROP TABLE relations; --" }
    });
    assert.equal(injection.ok, true);
    assert.ok(f.sql.read('demo', 'wl-main').relations.some(r => r.description.includes('DROP TABLE')));
    assert.ok(f.sql.read('demo', 'wl-main').relations.length > 0, '注入字符串被当作数据处理，表未被删除');

    assert.equal(authenticate(undefined, { t: ['read'] }).ok, false);
    assert.equal(authenticate('Bearer wrong', { t: ['read'] }).ok, false);
    assert.equal(authenticate('Bearer t', { t: ['read'] }).ok, true);
    assert.equal(TOOL_SCOPES['state.commit'], 'write');

    const tokens = { reader: ['read'], writer: ['read', 'write'] };
    const server = createServer((req, res) => { void handleRequest(f.sql, req, res, tokens); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const noAuth = await fetch(`${base}/state.read`, { method: 'POST', body: '{}' });
      assert.equal(noAuth.status, 401);
      const forbidden = await fetch(`${base}/state.commit`, {
        method: 'POST', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 7, changes: { flags: {} }, idempotencyKey: 'forbidden-1' })
      });
      assert.equal(forbidden.status, 403);
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally { f.cleanup(); }
});

test('12. 存档导入、导出及恢复', async () => {
  await withFresh(({ fs }) => {
    const exported = ops.exportBundle(fs, { campaignId: 'demo' });
    assert.equal(exported.ok, true);
    if (!exported.ok) return;
    const bundle = structuredClone(exported.data);
    assert.equal(bundle.format, 'noa-bundle');
    assert.ok(bundle.snapshots['wl-main']);

    bundle.campaignId = 'demo2';
    bundle.manifest.id = 'demo2';
    const imported = ops.importBundle(fs, { bundle });
    assert.equal(imported.ok, true);
    const state = fs.read('demo2', 'wl-main').state;
    assert.equal(state.revision, 7);
    assert.equal(existsSync(join(fs.root, 'campaigns', 'demo2', 'manifest.yaml')), true);

    const cp = ops.checkpoint(fs, { campaignId: 'demo2', worldlineId: 'wl-main', label: 'imported', id: 'cp-imported', at: T1 });
    assert.equal(cp.ok, true);
    ops.commitState(fs, { campaignId: 'demo2', worldlineId: 'wl-main', expectedRevision: 7, changes: { resources: { ink: 0 } }, idempotencyKey: 'import-change', at: T1 });
    const restore = ops.restore(fs, { campaignId: 'demo2', worldlineId: 'wl-main', checkpointId: 'cp-imported', idempotencyKey: 'import-restore', at: T1 });
    assert.equal(restore.ok, true);
    assert.equal(sha256(fs.read('demo2', 'wl-main').state), sha256(state));
  });
});
