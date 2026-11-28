import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readJson, writeJsonAtomic } from '../core/util.ts';
import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';

export interface CheckpointPlan {
  campaignId: string; total: number; keepFull: number;
  duplicates: string[]; deltas: { id: string; parentId: string | null; bytes: number }[];
  fullBytes: number; deltaBytes: number; potentialSaving: number;
  note: string;
}

function coreHash(snap: any): string {
  return sha256({ state: snap.state, entities: snap.entities, relations: snap.relations, episodes: snap.episodes, working: snap.working });
}

/** 基准快照 + 增量日志方案评估；不修改现有 checkpoint，正式迁移需另行 dry-run。 */
export function planCheckpoints(repo: SnapshotRepo, campaignId: string, keepFull = 5): Result<CheckpointPlan> {
  const all = repo.listCheckpoints(campaignId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!all.length) return fail('no_checkpoints', '没有可评估的 checkpoint');
  const byHash = new Map<string, string>();
  const duplicates: string[] = [];
  const deltas: { id: string; parentId: string | null; bytes: number }[] = [];
  let fullBytes = 0, deltaBytes = 0;
  for (const [i, cp] of all.entries()) {
    const hash = coreHash(cp.snapshot);
    if (byHash.has(hash)) duplicates.push(cp.id);
    else byHash.set(hash, cp.id);
    const bytes = Buffer.byteLength(JSON.stringify(cp.snapshot), 'utf8');
    if (i < keepFull) fullBytes += bytes;
    else { deltaBytes += Math.round(bytes * 0.08); deltas.push({ id: cp.id, parentId: all[i - 1]?.id ?? null, bytes }); }
  }
  return ok({
    campaignId, total: all.length, keepFull, duplicates, deltas, fullBytes, deltaBytes,
    potentialSaving: Math.max(0, fullBytes + deltas.reduce((m, d) => m + d.bytes, 0) - deltaBytes) - fullBytes,
    note: '只生成方案与哈希链；不删除历史 checkpoint。内容寻址去重与增量链长度上限需在迁移 dry-run 后启用。'
  });
}

/** 恢复前校验：每个受支持 checkpoint 的完整哈希必须与元数据一致。 */
export function verifyCheckpoints(repo: SnapshotRepo, campaignId: string): Result<{ checked: number; valid: string[]; invalid: string[] }> {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const cp of repo.listCheckpoints(campaignId)) {
    const hash = coreHash(cp.snapshot);
    if (hash === cp.stateHash || hash === cp.memoryHash || cp.stateHash === sha256(cp.snapshot.state)) valid.push(cp.id);
    else invalid.push(cp.id);
  }
  return ok({ checked: valid.length + invalid.length, valid, invalid });
}

export interface DeltaCheckpoint {
  id: string; parentId: string; campaignId: string; worldlineId: string;
  stateHash: string; memoryHash: string; createdAt: string;
  keyHashes: Record<string, string>; changes: Partial<Snapshot>;
}
function deltaPath(repo: SnapshotRepo, campaignId: string, id: string): string {
  return join(repo.root, 'campaigns', campaignId, 'checkpoints', `delta-${id}.json`);
}
function partHash(part: unknown): string { return sha256(part); }

/** 真实增量 checkpoint：只存变化的一级分片，并记录每个分片哈希。 */
export function createIncrementalCheckpoint(repo: SnapshotRepo, opts: {
  campaignId: string; worldlineId: string; baseCheckpointId: string; id: string; createdAt?: string;
}): Result<DeltaCheckpoint> {
  const base = repo.loadCheckpoint(opts.campaignId, opts.baseCheckpointId);
  if (!base) return fail('base_checkpoint_missing', '基准 checkpoint 不存在');
  const current = repo.read(opts.campaignId, opts.worldlineId);
  const keys = ['state', 'entities', 'relations', 'episodes', 'working'] as const;
  const keyHashes: Record<string, string> = {};
  const changes: any = {};
  for (const key of keys) {
    keyHashes[key] = partHash((current as any)[key]);
    if (partHash((base.snapshot as any)[key]) !== keyHashes[key]) changes[key] = structuredClone((current as any)[key]);
  }
  const delta: DeltaCheckpoint = {
    id: opts.id, parentId: opts.baseCheckpointId,
    campaignId: opts.campaignId, worldlineId: opts.worldlineId,
    stateHash: partHash(current.state),
    memoryHash: partHash(current.working),
    createdAt: opts.createdAt ?? new Date().toISOString(), keyHashes, changes
  };
  writeJsonAtomic(deltaPath(repo, opts.campaignId, opts.id), delta);
  return ok(delta);
}

function readDelta(repo: SnapshotRepo, campaignId: string, id: string): DeltaCheckpoint | null {
  const path = deltaPath(repo, campaignId, id);
  return existsSync(path) ? readJson(path) as DeltaCheckpoint : null;
}

/** 从基准 checkpoint 顺序回放增量；每步校验分片哈希与完整状态/记忆哈希。 */
export function restoreIncrementalCheckpoint(repo: SnapshotRepo, campaignId: string, checkpointId: string): Result<{ snapshot: Snapshot; applied: string[] }> {
  const full = repo.loadCheckpoint(campaignId, checkpointId);
  let snapshot: Snapshot | null = full ? structuredClone(full.snapshot) : null;
  const applied: string[] = [];
  let cursor = checkpointId;
  const seen = new Set<string>();
  while (!snapshot) {
    if (seen.has(cursor)) return fail('delta_cycle', '增量链成环');
    seen.add(cursor);
    const delta = readDelta(repo, campaignId, cursor);
    if (!delta) return fail('checkpoint_not_found', `checkpoint ${cursor} 不存在`);
    const parent = repo.loadCheckpoint(campaignId, delta.parentId);
    if (parent) { snapshot = structuredClone(parent.snapshot); applied.push(cursor); break; }
    const parentDelta = readDelta(repo, campaignId, delta.parentId);
    if (!parentDelta) return fail('delta_parent_missing', '增量父节点不存在', { parentId: delta.parentId });
    cursor = delta.parentId;
    applied.push(cursor);
  }
  const chain = [...applied].reverse();
  for (const id of chain) {
    const delta = readDelta(repo, campaignId, id);
    if (!delta) return fail('delta_missing', '增量文件缺失', { id });
    const next = { ...snapshot!, ...structuredClone(delta.changes) } as Snapshot;
    for (const [key, hash] of Object.entries(delta.keyHashes)) {
      if (partHash((next as any)[key]) !== hash) return fail('delta_hash_mismatch', '增量分片哈希不一致', { id, key });
    }
    if (partHash(next.state) !== delta.stateHash || partHash(next.working) !== delta.memoryHash) {
      return fail('checkpoint_hash_mismatch', '完整状态/记忆哈希不一致', { id });
    }
    snapshot = next;
  }
  return ok({ snapshot: snapshot!, applied: chain });
}
