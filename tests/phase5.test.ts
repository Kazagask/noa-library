import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../packages/core/util.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { commitState, recordMemory, executeRoll } from '../packages/library/operations.ts';
import {
  exportFull, exportIncremental, importEnvelope, type BackupEnvelope
} from '../packages/backup/sync.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
function fresh(prefix: string): { dir: string; root: string; fs: FsStore; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, 'repo');
  cpSync(ROOT, root, { recursive: true, filter: src => !/node_modules|\.git|deploy[\\/]data|\.state/.test(src) });
  return { dir, root, fs: new FsStore(root), cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ } } };
}
function coreHash(store: FsStore): string {
  const snap = store.read('demo', 'wl-main');
  return sha256({ state: snap.state, entities: snap.entities, relations: snap.relations, episodes: snap.episodes, working: snap.working });
}

test('真实业务调用 → 导出 → 空库恢复：状态与记忆哈希一致', async () => {
  const source = fresh('noa-e2e-src-');
  const target = fresh('noa-e2e-dst-');
  try {
    const full = (exportFull(source.fs, 'demo') as any).data as BackupEnvelope;
    const stateResult = commitState(source.fs, {
      campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 7,
      changes: { resources: { ink: 42 }, flags: { e2eRecovered: true } },
      idempotencyKey: 'e2e-state-01', actor: 'gm', at: '2026-11-26T02:20:00.000Z'
    });
    assert.equal(stateResult.ok, true);
    const relResult = recordMemory(source.fs, {
      campaignId: 'demo', worldlineId: 'wl-main', kind: 'relation',
      data: {
        subject: 'person.player', predicate: '验证', object: 'item.note',
        description: '真实工具调用产生的关系', knownBy: ['*']
      },
      idempotencyKey: 'e2e-rel-01', actor: 'gm', at: '2026-11-26T02:20:01.000Z'
    });
    assert.equal(relResult.ok, true);
    const rollResult = executeRoll(source.fs, {
      campaignId: 'demo', worldlineId: 'wl-main', skill: 2, difficulty: 1,
      idempotencyKey: 'e2e-roll-01', actor: 'gm', at: '2026-11-26T02:20:02.000Z'
    });
    assert.equal(rollResult.ok, true);

    const events = source.fs.events('demo', 'wl-main');
    assert.ok(events.length >= 3);
    const seqs = events.map(e => Number(e.seq ?? 0));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(events.some(e => e.op === 'state.commit' && (e.patch as any)?.snapshot), '状态事件包含完整快照补丁');
    assert.ok(events.some(e => String(e.op).startsWith('memory.record') && (e.patch as any)?.snapshot), '记忆事件包含完整快照补丁');

    const inc = (exportIncremental(source.fs, 'demo', {
      stateRevision: full.stateRevision, memoryRevision: full.memoryRevision, seq: full.eventSeq
    }, { parent: full }) as any).data as BackupEnvelope;
    assert.equal(inc.parentHash, full.contentHash);
    assert.ok(inc.eventSeq > full.eventSeq);

    // 目标库只有代码与 manifest，没有状态、事件、记忆文件。
    for (const rel of ['state/latest.json', 'state/events.jsonl', 'memory/entities.jsonl', 'memory/relations.jsonl', 'memory/episodes/index.jsonl', 'working.json']) {
      rmSync(join(target.root, 'campaigns', 'demo', rel), { force: true });
    }
    assert.equal(existsSync(join(target.root, 'campaigns', 'demo', 'state', 'latest.json')), false);
    const importedFull = importEnvelope(target.fs, full);
    assert.equal((importedFull as any).data.imported, true);
    const importedInc = importEnvelope(target.fs, inc, { parent: full });
    assert.equal((importedInc as any).data.imported, true);

    const src = source.fs.read('demo', 'wl-main');
    const dst = target.fs.read('demo', 'wl-main');
    assert.equal(coreHash(source.fs), coreHash(target.fs), '状态与记忆内容哈希一致');
    assert.equal(dst.state.revision, src.state.revision);
    assert.equal(dst.working.memoryRevision, src.working.memoryRevision);
    assert.equal(dst.state.resources.ink, 42);
    assert.equal(dst.state.rng.cursor, src.state.rng.cursor);
    assert.ok(dst.relations.some(r => r.description === '真实工具调用产生的关系'));

    const duplicate = importEnvelope(target.fs, inc, { parent: full });
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
    assert.equal((duplicate as any).data.stateRevision, src.state.revision, '重复导入不产生版本回退');
    assert.equal(coreHash(target.fs), coreHash(source.fs));
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test('实时权威不可确认时 fail-closed，冷备份 Runtime 拒绝写入', async () => {
  const f = fresh('noa-e2e-auth-');
  try {
    mkdirSync(join(f.root, 'config'), { recursive: true });
    writeFileSync(join(f.root, 'config', 'campaign-map.yaml'), 'campaigns:\n  - sitesId: SAVE-481\n    vaultId: demo\n    worldlineId: wl-main\n');
    writeFileSync(join(f.root, 'config', 'runtime-mode.yaml'), 'runtimeMode: cold-backup\nwritable: false\n');
    const full = (exportFull(f.fs, 'demo') as any).data as BackupEnvelope;
    const blocked = importEnvelope(f.fs, full);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'authority_unavailable');

    const { executeRequest } = await import('../packages/runtime/github-native.ts');
    const req = {
      requestId: 'req-readonly-1', campaignId: 'demo', worldlineId: 'wl-main', expectedRevision: 7,
      idempotencyKey: 'readonly-1', actor: 'gm', createdAt: '2026-11-26T02:20:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      operations: [{ op: 'state.commit', changes: { resources: { ink: 1 } } }]
    };
    const rejected = executeRequest(f.root, req, { at: '2026-11-26T02:21:00.000Z' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'readonly_backup');
    assert.equal(f.fs.read('demo', 'wl-main').state.resources.ink, 3, '冷备份未写入');
  } finally { f.cleanup(); }
});
