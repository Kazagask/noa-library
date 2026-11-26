import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeNodeHasher } from '../packages/core/node-hasher.ts';
import {
  normalizeToolName, isSharedTool, isProductionOnlyTool, PROTOCOL_VERSIONS
} from '../packages/core/tool-protocol.ts';
import {
  MemorySnapshotRepo, SqliteStorageAdapter, D1_SCHEMA, d1ShardKey, encodeD1Shard, decodeD1Shard, snapshotDigest
} from '../packages/server/storage-adapter.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { SqliteStore } from '../packages/server/sqlite-store.ts';
import { commitState, recordMemory } from '../packages/library/operations.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
initializeNodeHasher();

test('统一 MCP 协议兼容 main 点分名与 Sites snake_case', () => {
  assert.equal(normalizeToolName('state_commit'), 'state.commit');
  assert.equal(normalizeToolName('memory_recall'), 'memory.recall');
  assert.equal(normalizeToolName('state.commit'), 'state.commit');
  assert.equal(isSharedTool('event_receipt'), true);
  assert.equal(isProductionOnlyTool('event_receipt'), false);
  assert.equal(isProductionOnlyTool('event.commit'), false);
  assert.deepEqual([...PROTOCOL_VERSIONS], ['2024-11-05', '2026-07-28']);
});

test('D1 分片契约可编码/解码同一快照', () => {
  const fs = new FsStore(ROOT);
  const snap = fs.read('demo', 'wl-main');
  const key = d1ShardKey('demo', 'wl-main');
  assert.equal(key.family, 'snapshot');
  const encoded = encodeD1Shard(snap);
  assert.equal(encoded.digest.length, 64);
  assert.equal(encoded.body.length <= 240000, true);
  const decoded = decodeD1Shard(encoded.body);
  assert.equal(decoded.state.revision, snap.state.revision);
  assert.equal(D1_SCHEMA.shard.includes('noa_shard'), true);
  assert.equal(D1_SCHEMA.fence.includes('noa_v2_active'), true);
});

test('跨平台契约：FS / SQLite / Memory 三后端业务结果一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-contract-'));
  try {
    const root = join(dir, 'repo');
    cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
    const fsRepo = new FsStore(root);
    const sqlite = new SqliteStore(root, join(dir, 'contract.sqlite'));
    sqlite.seedFromFiles('demo');
    const memory = new MemorySnapshotRepo(root);
    const seed = fsRepo.read('demo', 'wl-main');
    memory.writeManifest('demo', seed.manifest);
    memory.write('demo', 'wl-main', seed);

    const backends: Array<{ name: string; repo: any }> = [
      { name: 'fs', repo: fsRepo },
      { name: 'sqlite', repo: new SqliteStorageAdapter(sqlite) },
      { name: 'memory', repo: memory }
    ];
    const digests: string[] = [];
    for (const backend of backends) {
      const s = commitState(backend.repo, {
        campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 7,
        changes: { resources: { ink: 100 } },
        idempotencyKey: 'contract-state', actor: 'gm', at: '2026-11-27T00:10:00.000Z'
      });
      assert.equal(s.ok, true, `${backend.name}: ${JSON.stringify(s)}`);
      const r = recordMemory(backend.repo, {
        campaignId: 'demo', worldlineId: 'wl-main', kind: 'relation',
        data: { subject: 'person.player', predicate: '契约', object: 'contract-shared', description: 'contract-test', knownBy: ['*'], sourceEventId: 'contract-source' },
        idempotencyKey: 'contract-rel', actor: 'gm', at: '2026-11-27T00:10:01.000Z'
      });
      assert.equal(r.ok, true, `${backend.name}: ${JSON.stringify(r)}`);
      const digest = snapshotDigest(backend.repo, 'demo', 'wl-main');
      assert.equal(digest.ok, true);
      // 每个后端有独立幂等键，但值相同；摘要中的业务字段应一致。
      digests.push(digest.data.hash);
    }
    assert.equal(new Set(digests).size, 1, `三后端业务结果摘要应一致: ${digests.join(',')}`);
    sqlite.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } }
});
