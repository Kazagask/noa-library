import { join } from 'node:path';
import { writeJsonAtomic, readJson, stableStringify } from '../core/util.ts';
import { isObject, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';

export type MemoryTier = 'L0' | 'L1' | 'L2' | 'L3';
export interface MemoryRef {
  id: string; kind: string; tier: MemoryTier; title: string; source: string;
  at?: string; turn?: number; lifecycle?: string; bytes: number;
  campaignId: string; worldlineId: string;
  knownBy: string[]; epistemic?: string; holder?: string | null;
}
export interface MemoryLayerIndex {
  version: 1; campaignId: string; worldlineId: string;
  sourceStateRevision: number; sourceMemoryRevision: number;
  builtAt: string; refs: MemoryRef[];
  counts: Record<MemoryTier, number>; bytes: Record<MemoryTier, number>;
}
export interface VisibilityContext { viewer: string; gm?: boolean; includeBeliefs?: boolean; asOf?: string }

export function isL3Row(row: any, kind = 'entity'): boolean { return tierOf(row, kind) === 'L3'; }

function tierOf(row: any, kind: string): MemoryTier {
  const tags: string[] = Array.isArray(row.tags) ? row.tags.map(String) : [];
  if (row.lifecycle === 'archived' || tags.some(t => ['historical-backfill', 'raw-event', 'combat-log', 'receipt', 'checkpoint'].includes(t))) return 'L3';
  if (kind === 'state' || kind === 'todo') return 'L0';
  if (row.lifecycle === 'summarized' || row.lifecycle === 'settled' || tags.includes('current-chapter')) return 'L1';
  if (kind === 'episode') return 'L1';
  return 'L2';
}
function indexDir(repo: SnapshotRepo, campaignId: string): string {
  return join(repo.root, 'campaigns', campaignId, 'memory', 'governance');
}
export function layerIndexPath(repo: SnapshotRepo, campaignId: string, worldlineId: string): string {
  return join(indexDir(repo, campaignId), `layers.${worldlineId}.json`);
}

/** 索引按 campaign/worldline 隔离，引用带认知权限；L3 默认不进召回。 */
export function buildMemoryLayerIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string, opts: { apply?: boolean; at?: string } = {}): Result<MemoryLayerIndex> {
  try {
    const snap = repo.read(campaignId, worldlineId);
    const refs: MemoryRef[] = [];
    const add = (kind: string, row: any, fallbackId: string) => {
      refs.push({
        id: String(row.id ?? fallbackId), kind, tier: tierOf(row, kind),
        title: String(row.title ?? row.name ?? row.predicate ?? kind).slice(0, 160),
        source: kind === 'episode' ? `episodes/${row.path ?? row.id}` : kind,
        at: row.at, turn: row.turn, lifecycle: row.lifecycle,
        bytes: Buffer.byteLength(stableStringify(row), 'utf8'),
        campaignId, worldlineId,
        knownBy: Array.isArray(row.knownBy) ? row.knownBy.map(String) : ['*'],
        epistemic: row.epistemic, holder: row.holder ?? null
      });
    };
    add('state', { id: `state@${snap.state.revision}`, lifecycle: 'active', knownBy: ['*'] }, 'state');
    for (const [i, todo] of (snap.working?.pendingTasks ?? []).entries()) add('todo', todo, `todo-${i}`);
    for (const e of snap.episodes) add('episode', e, e.id);
    for (const r of snap.relations) add('relation', r, r.id);
    for (const e of snap.entities) add('entity', e, e.id);
    const counts: Record<MemoryTier, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
    const bytes: Record<MemoryTier, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const ref of refs) { counts[ref.tier]++; bytes[ref.tier] += ref.bytes; }
    const index: MemoryLayerIndex = {
      version: 1, campaignId, worldlineId,
      sourceStateRevision: snap.state.revision, sourceMemoryRevision: snap.working?.memoryRevision ?? 0,
      builtAt: opts.at ?? new Date().toISOString(), refs, counts, bytes
    };
    if (opts.apply) writeJsonAtomic(layerIndexPath(repo, campaignId, worldlineId), index);
    return ok(index);
  } catch (err: any) { return fail('layer_index_failed', String(err?.message ?? err)); }
}

export function loadMemoryLayerIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string): Result<MemoryLayerIndex> {
  try {
    const index = readJson(layerIndexPath(repo, campaignId, worldlineId)) as MemoryLayerIndex;
    if (index.campaignId !== campaignId || index.worldlineId !== worldlineId) return fail('layer_index_scope', '索引 campaign/worldline 不匹配');
    return ok(index);
  } catch { return fail('layer_index_missing', '尚未构建当前世界线的记忆分层索引'); }
}

/** 索引陈旧检测：revision 落后即不可信，必须重建。 */
export function checkIndexFreshness(repo: SnapshotRepo, index: MemoryLayerIndex): Result<{ fresh: boolean; reason?: string }> {
  try {
    const snap = repo.read(index.campaignId, index.worldlineId);
    const fresh = index.sourceStateRevision === snap.state.revision && index.sourceMemoryRevision === (snap.working?.memoryRevision ?? 0);
    return ok(fresh ? { fresh: true } : { fresh: false, reason: 'revision-advanced' });
  } catch { return ok({ fresh: false, reason: 'snapshot-unavailable' }); }
}

export function refsForTiers(index: MemoryLayerIndex, tiers: MemoryTier[] = ['L0', 'L1', 'L2'], ctx?: VisibilityContext): MemoryRef[] {
  return index.refs.filter(ref => {
    if (!tiers.includes(ref.tier)) return false;
    if (ref.campaignId !== index.campaignId || ref.worldlineId !== index.worldlineId) return false;
    if (!ctx) return true;
    if (ctx.gm) return true;
    if (ref.knownBy.includes('*') || ref.knownBy.includes(ctx.viewer)) return true;
    return ref.epistemic === 'belief' && Boolean(ctx.includeBeliefs) && ref.holder === ctx.viewer;
  });
}

export function isObjectRef(ref: unknown): ref is MemoryRef {
  return isObject(ref) && typeof ref.id === 'string' && typeof ref.tier === 'string';
}
