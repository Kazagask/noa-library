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
