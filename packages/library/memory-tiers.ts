import { join } from 'node:path';
import { writeJsonAtomic, readJson, stableStringify } from '../core/util.ts';
import { isObject, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';

export type MemoryTier = 'L0' | 'L1' | 'L2' | 'L3';
export interface MemoryRef {
  id: string; kind: string; tier: MemoryTier; title: string; source: string;
  at?: string; turn?: number; lifecycle?: string; bytes: number;
}
export interface MemoryLayerIndex {
  version: 1; campaignId: string; worldlineId: string;
  sourceStateRevision: number; sourceMemoryRevision: number;
  builtAt: string; refs: MemoryRef[];
  counts: Record<MemoryTier, number>; bytes: Record<MemoryTier, number>;
}

function tierOf(row: any, kind: string): MemoryTier {
  const tags: string[] = Array.isArray(row.tags) ? row.tags.map(String) : [];
  if (row.lifecycle === 'archived' || tags.some(t => ['historical-backfill', 'raw-event', 'combat-log', 'receipt', 'checkpoint'].includes(t))) return 'L3';
  if (kind === 'state' || kind === 'todo') return 'L0';
  if (row.lifecycle === 'summarized' || row.lifecycle === 'settled' || tags.includes('current-chapter')) return 'L1';
  if (kind === 'episode') return 'L1';
  return 'L2';
}

/** 只落引用与体积，不复制历史正文；L3 默认不进召回。 */
export function buildMemoryLayerIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string, opts: { apply?: boolean; at?: string } = {}): Result<MemoryLayerIndex> {
  try {
    const snap = repo.read(campaignId, worldlineId);
    const refs: MemoryRef[] = [];
    const add = (kind: string, row: any, fallbackId: string) => {
      const tier = tierOf(row, kind);
      refs.push({
        id: String(row.id ?? fallbackId), kind, tier,
        title: String(row.title ?? row.name ?? row.predicate ?? kind).slice(0, 160),
        source: kind === 'episode' ? `episodes/${row.path ?? row.id}` : kind,
        at: row.at, turn: row.turn, lifecycle: row.lifecycle,
        bytes: Buffer.byteLength(stableStringify(row), 'utf8')
      });
    };
    add('state', { id: `state@${snap.state.revision}`, lifecycle: 'active' }, 'state');
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
    if (opts.apply) writeJsonAtomic(join(repo.root, 'campaigns', campaignId, 'memory', 'governance', 'layers.json'), index);
    return ok(index);
  } catch (err: any) { return fail('layer_index_failed', String(err?.message ?? err)); }
}

export function loadMemoryLayerIndex(repo: SnapshotRepo, campaignId: string): Result<MemoryLayerIndex> {
  const path = join(repo.root, 'campaigns', campaignId, 'memory', 'governance', 'layers.json');
  try { return ok(readJson(path) as MemoryLayerIndex); }
  catch { return fail('layer_index_missing', '尚未构建记忆分层索引'); }
}

export function refsForTiers(index: MemoryLayerIndex, tiers: MemoryTier[] = ['L0', 'L1', 'L2']): MemoryRef[] {
  return index.refs.filter(r => tiers.includes(r.tier));
}

export function isObjectRef(ref: unknown): ref is MemoryRef {
  return isObject(ref) && typeof ref.id === 'string' && typeof ref.tier === 'string';
}
