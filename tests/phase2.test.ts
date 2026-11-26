import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import {
  readText, readJson, parseYaml, writeJsonAtomic, sha256, type Result
} from '../packages/core/util.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { buildColdStart } from '../packages/library/coldstart.ts';
import { buildIndices, lookupEntity, indexFresh } from '../packages/library/indices.ts';
import { loadPersona, importPersona } from '../packages/library/persona.ts';
import { migrateHistory } from '../packages/library/migration.ts';
import {
  submitRequest, executeRequest, runtimeStatus, readReceipt, type RuntimeRequest
} from '../packages/runtime/github-native.ts';
import { handleRequest } from '../packages/server/api.ts';
import { parseTokens } from '../packages/server/auth.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIGRATION_FIXTURE = join(ROOT, 'tests', 'fixtures', 'migration');
const FIXED_AT = '2026-11-26T10:00:00.000Z';

interface Fixture { dir: string; root: string; store: FsStore; cleanup(): void }
function fresh(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'noa-phase2-'));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  const store = new FsStore(root);
  return { dir, root, store, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } } };
}
async function withFresh(fn: (f: Fixture) => void | Promise<void>): Promise<void> {
  const f = fresh();
  try { await fn(f); } finally { f.cleanup(); }
}
function request(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    requestId: 'req-e2e-001', campaignId: 'demo', worldlineId: 'wl-main',
    expectedRevision: 7, idempotencyKey: 'e2e-ink-001', actor: 'person.player',
    createdAt: FIXED_AT, expiresAt: '2027-01-01T00:00:00.000Z',
    operations: [{ op: 'state.commit', changes: { resources: { ink: 8 } } }],
    ...overrides
  };
}

test('1. 仅通过仓库入口恢复指定 campaign', async () => {
  await withFresh(({ store, root }) => {
    const bootstrap = readText(join(root, 'BOOTSTRAP.md'));
    assert.match(bootstrap, /项目标识/);
    assert.match(bootstrap, /最小启动流程/);
    assert.match(bootstrap, /写入与回执协议/);
    assert.match(bootstrap, /失败降级/);
    const result = buildColdStart(store, { stage: 1 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.campaignId, 'demo', '未指定 campaign 时自动取 active 存档');
    assert.equal(result.data.revision, 7);
    assert.match(result.data.text, /诺娅/);
    assert.equal(result.data.mode, 'github-native');
    const source = readText(join(root, 'packages', 'library', 'coldstart.ts'));
    assert.equal(source.includes("'demo'"), false, '冷启动代码不得硬编码 demo');
  });
});

test('2. 通过实体索引检索人物相关记忆', async () => {
  await withFresh(({ store, root }) => {
    const built = buildIndices(store, 'demo');
    assert.equal(built.ok, true);
    const relPath = join(root, 'campaigns', 'demo', 'memory', 'relations.jsonl');
    const epPath = join(root, 'campaigns', 'demo', 'memory', 'episodes', 'index.jsonl');
    renameSync(relPath, `${relPath}.bak`);
    renameSync(epPath, `${epPath}.bak`);
    const found = lookupEntity(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', id: 'person.player' });
    assert.equal(found.ok, true);
    if (!found.ok) return;
    assert.ok(found.data.relations.some((r: any) => r.id === 'rel-001'));
    assert.ok(found.data.episodes.some((e: any) => e.id === 'ep-001'));
    assert.equal(found.data.source, 'memory/by-entity/person.player.json');
    assert.equal(existsSync(relPath), false, '查询不应依赖完整关系文件');
  });
});

test('3. 模拟 1000 情景与 10000 关系后的按需读取', async () => {
  await withFresh(({ store, root }) => {
    const snap = store.read('demo', 'wl-main');
    snap.relations = [];
    for (let i = 0; i < 10000; i++) {
      snap.relations.push({
        id: `rel-gen-${i}`, subject: 'person.player', predicate: '关联', object: `test.entity-${i % 100}`,
        description: `生成关系 ${i}`, worldlineId: 'wl-main',
        validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
        recordedAt: '2026-01-01T00:00:00.000Z', scope: 'world', knownBy: ['*'],
        confidence: 1, sourceEventId: 'ep-gen', epistemic: 'fact', holder: null,
        status: 'active', revision: 1
      } as any);
    }
    snap.episodes = [];
    for (let i = 0; i < 1000; i++) {
      snap.episodes.push({
        id: `ep-gen-${i}`, at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        turn: i, title: `生成情景 ${i}`, summary: `第 ${i} 条`, worldlineId: 'wl-main',
        entities: ['person.player'], relationIds: [], knownBy: ['*'], path: `ep-gen-${i}.md`,
        tags: [], confidence: 1
      } as any);
    }
    store.write('demo', 'wl-main', snap);
    const built = buildIndices(store, 'demo', { pageThreshold: 50 });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.ok(built.data.relationCount >= 10000);
    assert.ok(built.data.episodeCount >= 1000);
    const viewPath = join(root, 'campaigns', 'demo', 'memory', 'by-entity', 'person.player.json');
    assert.ok(statSync(viewPath).size < 20000, '主视图不应包含全部关系');
    const found = lookupEntity(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', id: 'person.player', maxPages: 3 });
    assert.equal(found.ok, true);
    if (found.ok) {
      assert.equal(found.data.pagesRead, 3);
      assert.equal(found.data.truncated, true);
      assert.equal(found.data.relations.length, 150);
    }
    const freshness = indexFresh(store, 'demo');
    assert.equal((freshness.data as any).fresh, true);
  });
});

test('4. GitHub Native 变更请求与执行回执', async () => {
  await withFresh(({ store, root }) => {
    const req = request({ operations: [
      { op: 'state.commit', changes: { resources: { ink: 8 } } },
      { op: 'memory.record', kind: 'relation', data: { subject: 'person.player', predicate: '整理', object: 'item.note', description: '整理纸条' } }
    ] });
    const submitted = submitRequest(root, req, FIXED_AT);
    assert.equal(submitted.ok, true);
    assert.equal(existsSync(join(root, 'runtime', 'pending', 'req-e2e-001.json')), true);
    const executed = executeRequest(root, req, { at: FIXED_AT });
    assert.equal(executed.ok, true);
    if (executed.ok) {
      assert.equal(executed.data.status, 'applied');
      assert.equal(executed.data.appliedRevision, 8);
      assert.equal(executed.data.operations.length, 2);
      assert.ok(executed.data.hash);
    }
    assert.equal(store.read('demo', 'wl-main').state.resources.ink, 8);
    assert.equal(readReceipt(root, 'req-e2e-001')?.status, 'applied');
  });
});

test('5. 拒绝过期 revision', async () => {
  await withFresh(({ store, root }) => {
    const first = executeRequest(root, request({ requestId: 'req-first01', idempotencyKey: 'e2e-first', operations: [{ op: 'state.commit', changes: { resources: { ink: 6 } } }] }), { at: FIXED_AT });
    assert.equal(first.ok, true);
    const stale = executeRequest(root, request({ requestId: 'req-stale01', idempotencyKey: 'e2e-stale', expectedRevision: 7 }), { at: FIXED_AT });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'revision_conflict');
    assert.equal(existsSync(join(root, 'runtime', 'rejected', 'req-stale01.json')), true);
    assert.equal(store.read('demo', 'wl-main').state.revision, 8);
    assert.equal(store.read('demo', 'wl-main').state.resources.ink, 6);
  });
});

test('6. 并发请求不覆盖权威状态', async () => {
  await withFresh(({ store, root }) => {
    const a = executeRequest(root, request({ requestId: 'req-concur-a', idempotencyKey: 'e2e-concur-a', operations: [{ op: 'state.commit', changes: { resources: { ink: 1 } } }] }), { at: FIXED_AT });
    const b = executeRequest(root, request({ requestId: 'req-concur-b', idempotencyKey: 'e2e-concur-b', operations: [{ op: 'state.commit', changes: { resources: { ink: 2 } } }] }), { at: FIXED_AT });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(store.read('demo', 'wl-main').state.revision, 8);
    assert.equal(store.read('demo', 'wl-main').state.resources.ink, 1);
    writeFileSync(join(root, 'runtime', '.lock'), JSON.stringify({ pid: 99999, at: FIXED_AT }));
    const blocked = executeRequest(root, request({ requestId: 'req-concur-c', idempotencyKey: 'e2e-concur-c', expectedRevision: 8 }), { at: FIXED_AT });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'executor_busy');
    rmSync(join(root, 'runtime', '.lock'), { force: true });
  });
});

test('7. 重复请求不会重复结算', async () => {
  await withFresh(({ store, root }) => {
    const req = request({ operations: [{ op: 'state.commit', changes: { resources: { ink: 9 } } }] });
    const first = executeRequest(root, req, { at: FIXED_AT });
    const second = executeRequest(root, req, { at: FIXED_AT });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal((second as any).data.duplicate, true);
    assert.equal(store.read('demo', 'wl-main').state.revision, 8);
    assert.equal(store.events('demo', 'wl-main').filter((e: any) => e.idempotencyKey === 'e2e-ink-001').length, 1);
    const sameKeyDifferentId = executeRequest(root, request({ requestId: 'req-other01', operations: [{ op: 'state.commit', changes: { resources: { ink: 3 } } }] }), { at: FIXED_AT });
    assert.equal((sameKeyDifferentId as any).data.duplicate, true);
    assert.equal(store.read('demo', 'wl-main').state.resources.ink, 9);
  });
});

test('8. 历史存档 dry-run 导入与冲突报告', async () => {
  await withFresh(({ root, store }) => {
    const dry = migrateHistory(store, { inputPaths: [MIGRATION_FIXTURE], campaignId: 'migration-e2e' });
    assert.equal(dry.ok, true);
    if (!dry.ok) return;
    assert.equal(dry.data.dryRun, true);
    assert.ok(dry.data.conflicts.some((c: any) => c.id === 'person.hero'));
    assert.ok(dry.data.unmappedFields.includes('customMechanic'));
    assert.equal(existsSync(join(root, 'campaigns', 'migration-e2e')), false);
    const applied = migrateHistory(store, { inputPaths: [MIGRATION_FIXTURE], campaignId: 'migration-e2e', apply: true, at: FIXED_AT });
    assert.equal(applied.ok, true);
    assert.equal(store.read('migration-e2e', 'wl-main').state.revision, 3);
    assert.equal(store.read('migration-e2e', 'wl-main').state.extension.unmapped.customMechanic.level, 2);
    assert.equal(existsSync(join(root, 'campaigns', 'migration-e2e', 'migration', 'report.json')), true);
    const repeat = migrateHistory(store, { inputPaths: [MIGRATION_FIXTURE], campaignId: 'migration-e2e', apply: true });
    assert.equal((repeat as any).data.duplicate, true);
  });
});

test('9. 诺娅独立记忆不受游戏回档影响', async () => {
  await withFresh(async ({ root, store }) => {
    const before = loadPersona(store);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const cp = executeRequest(root, request({
      requestId: 'req-cp0001', idempotencyKey: 'e2e-cp',
      operations: [
        { op: 'session.close', label: 'before-persona-import', idempotencyKey: 'cp-op' },
        { op: 'state.commit', changes: { resources: { ink: 2 } } }
      ]
    }), { at: FIXED_AT });
    assert.equal(cp.ok, true);
    const receipt = readReceipt(root, 'req-cp0001');
    const checkpointId = (receipt?.operations?.[0]?.result as any)?.checkpointId;
    const imported = importPersona(store, {
      kind: 'examples', records: [{ id: 'ex-e2e-001', text: '样本' }],
      source: 'unit-test', idempotencyKey: 'persona-e2e-1', apply: true, at: FIXED_AT
    });
    assert.equal(imported.ok, true);
    const afterImport = loadPersona(store);
    assert.equal((afterImport as any).data.memory.examples.some((e: any) => e.id === 'ex-e2e-001'), true);
    const restored = executeRequest(root, request({
      requestId: 'req-restore1', idempotencyKey: 'e2e-restore', expectedRevision: 8,
      operations: [{ op: 'save.restore' as any, checkpointId, idempotencyKey: 'restore-op' }]
    }), { at: FIXED_AT });
    // 白名单不含 save.restore：验证人格隔离不依赖该操作，直接用 checkpoint 模块。
    assert.equal(restored.ok, false);
    const { restore } = await import('../packages/library/operations.ts');
    const r = restore(store, { campaignId: 'demo', worldlineId: 'wl-main', checkpointId, idempotencyKey: 'direct-restore', actor: 'gm', at: FIXED_AT });
    assert.equal(r.ok, true);
    assert.equal(store.read('demo', 'wl-main').state.resources.ink, 3);
    const afterRollback = loadPersona(store);
    assert.equal((afterRollback as any).data.hash, (afterImport as any).data.hash, '人格记忆不应被游戏回档改写');
  });
});

test('10. 世界线之间不泄露记忆', async () => {
  await withFresh(async ({ store, root }) => {
    const forbiddenFork = submitRequest(root, request({
      requestId: 'req-fork001', idempotencyKey: 'e2e-fork',
      operations: [{ op: 'worldline.fork' as any, to: 'wl-alt', idempotencyKey: 'fork-op' }]
    }));
    assert.equal(forbiddenFork.ok, false, '运行时白名单不含 fork，防止 Agent 私自分叉');
    const { forkWorldline, recordMemory, recall } = await import('../packages/library/operations.ts');
    assert.equal(forkWorldline(store, { campaignId: 'demo', to: 'wl-alt', idempotencyKey: 'direct-fork', actor: 'gm', at: FIXED_AT }).ok, true);
    const secret = recordMemory(store, {
      campaignId: 'demo', worldlineId: 'wl-alt', kind: 'relation', actor: 'gm',
      idempotencyKey: 'alt-only', at: FIXED_AT,
      data: { subject: 'person.player', predicate: '得知', object: 'secret.archive-key', description: '仅分叉线公开的情报', knownBy: ['*'] }
    });
    assert.equal(secret.ok, true);
    const main = recall(store, { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', query: '仅分叉线公开的情报' });
    assert.equal((main as any).data.hits.some((h: any) => h.id === (secret as any).data.id), false);
    const alt = recall(store, { campaignId: 'demo', worldlineId: 'wl-alt', viewer: 'person.player', query: '仅分叉线公开的情报' });
    assert.equal((alt as any).data.hits.some((h: any) => h.id === (secret as any).data.id), true);
  });
});

test('11. 恶意请求与记忆文本不能触发代码执行', async () => {
  await withFresh(async ({ store, root }) => {
    const evilChanges = JSON.parse('{"__proto__":{"polluted":true},"resources":{"ink":4}}');
    const badKey = request({ requestId: 'req-bad001', idempotencyKey: 'e2e-bad', operations: [{ op: 'state.commit', changes: evilChanges }] });
    const rejectedProto = executeRequest(root, badKey, { at: FIXED_AT });
    assert.equal(rejectedProto.ok, false);
    assert.equal(rejectedProto.code, 'invalid_request');
    const unsupported = request({ requestId: 'req-bad002', idempotencyKey: 'e2e-bad2', operations: [{ op: 'shell' }] });
    const rejectedShell = executeRequest(root, unsupported, { at: FIXED_AT });
    assert.equal(rejectedShell.ok, false);
    assert.equal(rejectedShell.code, 'invalid_request');
    const payload = "$(touch pwned)'; DROP TABLE relations; --";
    const recorded = await import('../packages/library/operations.ts');
    const r = recorded.recordMemory(store, {
      campaignId: 'demo', worldlineId: 'wl-main', kind: 'relation', actor: 'gm',
      idempotencyKey: 'malicious-text', at: FIXED_AT,
      data: { subject: 'person.player', predicate: '测试', object: 'item.note', description: payload }
    });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(root, 'pwned')), false);
    assert.ok(store.read('demo', 'wl-main').relations.some(rel => rel.description === payload));
    assert.equal(sha256(payload).length, 64);
  });
});

test('12. 公开仓与私有仓分离后仍可运行', async () => {
  await withFresh(({ dir, root, store }) => {
    const imported = migrateHistory(store, { inputPaths: [MIGRATION_FIXTURE], campaignId: 'private-campaign', apply: true, at: FIXED_AT });
    assert.equal(imported.ok, true);
    const publicColdStart = buildColdStart(store, { stage: 1 });
    assert.equal((publicColdStart as any).data.campaignId, 'demo');
    const vaultRoot = join(dir, 'vault-copy');
    cpSync(root, vaultRoot, {
      recursive: true,
      filter: src => !/node_modules|\.git|\.state/.test(src)
    });
    const campaignsDir = join(vaultRoot, 'campaigns');
    for (const name of ['demo']) rmSync(join(campaignsDir, name), { recursive: true, force: true });
    const manifest = parseYaml(readText(join(vaultRoot, 'manifest.yaml')));
    manifest.campaigns = [{
      id: 'private-campaign', path: 'campaigns/private-campaign/manifest.yaml',
      worldId: 'testworld', worldlineId: 'wl-main', status: 'active', title: '私有迁移存档'
    }];
    writeJsonAtomic(join(vaultRoot, 'manifest.yaml'), manifest);
    const vaultStore = new FsStore(vaultRoot);
    const vaultColdStart = buildColdStart(vaultStore, { stage: 1 });
    assert.equal(vaultColdStart.ok, true);
    if (vaultColdStart.ok) {
      assert.equal(vaultColdStart.data.campaignId, 'private-campaign');
      assert.equal(vaultColdStart.data.revision, 3);
    }
  });
});

test('13. HTTP Streamable MCP 与生产 token 行为', async () => {
  const f = fresh();
  try {
    const tokens = parseTokens({ NODE_ENV: 'production', NOA_API_TOKENS: '{"tok":["read"]}' });
    assert.deepEqual(tokens.tok, ['read']);
    assert.throws(() => parseTokens({ NODE_ENV: 'production' }), /必须设置/);
    const server = createServer((req, res) => { void handleRequest(f.store, req, res, tokens); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post = (body: unknown, auth = 'Bearer tok') => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body)
    });
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200);
    assert.equal((await init.json() as any).result.serverInfo.name, 'noa-library');
    const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any;
    assert.ok(list.result.tools.length >= 22);
    assert.ok(list.result.tools.some((t: any) => t.name === 'asset_search'));
    assert.ok(list.result.tools.some((t: any) => t.name === 'session_recover'));
    assert.ok(list.result.tools.some((t: any) => t.name === 'memory_layers'));
    const forbidden = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'state_commit', arguments: { changes: {}, expectedRevision: 7, idempotencyKey: 'http-mcp-bad' } } });
    assert.equal(forbidden.status, 403);
    const unauth = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'Bearer wrong');
    assert.equal(unauth.status, 401);
    await new Promise<void>(resolve => server.close(() => resolve()));
  } finally { f.cleanup(); }
});
