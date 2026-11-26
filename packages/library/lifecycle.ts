import { writeJsonAtomic } from '../core/util.ts';
import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';
import { readSummaries, summariesPath } from './lifecycle-internal.ts';

export const LIFECYCLE = ['open', 'active', 'settled', 'summarized', 'archived'] as const;
export type LifecycleStage = typeof LIFECYCLE[number];

export interface ChapterSummary {
  id: string; campaignId: string; worldlineId: string; instanceId: string;
  keyCausality: string[]; characterChanges: string[]; resourceChanges: string[];
  unresolved: string[]; decisions: string[]; sourceEventIds: string[];
  sourceHash: string; stateRevision: number; memoryRevision: number;
  createdAt: string; actor: string;
}

export function validateSummary(input: any): Result<ChapterSummary> {
  const required = ['keyCausality', 'characterChanges', 'resourceChanges', 'unresolved', 'decisions', 'sourceEventIds'];
  for (const key of required) if (!Array.isArray(input?.[key])) return fail('invalid_summary', `${key} 必须是数组`);
  if (!input.instanceId || !input.campaignId || !input.worldlineId) return fail('invalid_summary', '缺少实例或世界线标识');
  return ok(input as ChapterSummary);
}

/** 服务端校验结构、引用与幂等，并把已结束副本推进到 summarized/archived。 */
export function submitChapterSummary(repo: SnapshotRepo, input: ChapterSummary & { target?: LifecycleStage; idempotencyKey?: string }): Result {
  const checked = validateSummary(input);
  if (!checked.ok) return checked;
  const key = `lifecycle:${input.campaignId}:${input.worldlineId}:${input.idempotencyKey ?? input.id}`;
  if (repo.getOperation(key)) return ok({ deduplicated: true, summaryId: input.id });
  const snap = repo.read(input.campaignId, input.worldlineId);
  const known = new Set([...snap.episodes.map(e => e.id), ...snap.relations.map(r => r.id), ...snap.events?.map?.(e => e.id) ?? []]);
  const missing = input.sourceEventIds.filter(id => !known.has(id));
  if (missing.length) return fail('summary_ref_missing', '摘要引用了不存在的来源', { missing });
  const all = readSummaries(repo, input.campaignId);
  const summary: ChapterSummary = {
    ...input,
    id: input.id ?? `sum-${sha256(`${input.instanceId}:${input.sourceEventIds.join(',')}`).slice(0, 12)}`,
    sourceHash: sha256({ sourceEventIds: input.sourceEventIds, keyCausality: input.keyCausality }),
    stateRevision: snap.state.revision, memoryRevision: snap.working?.memoryRevision ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(), actor: input.actor ?? 'gm'
  };
  all[summary.id] = summary;
  writeJsonAtomic(summariesPath(repo, input.campaignId), all);
  const event = {
    id: `evt-${sha256(`${key}:${summary.sourceHash}`).slice(0, 12)}`,
    seq: repo.nextEventSeq?.(input.campaignId),
    worldlineId: input.worldlineId, at: summary.createdAt, actor: summary.actor,
    op: 'memory.summarize', idempotencyKey: input.idempotencyKey ?? summary.id,
    stateRevision: summary.stateRevision, memoryRevision: summary.memoryRevision,
    patch: { summary, instanceId: input.instanceId, target: input.target ?? 'summarized' }
  };
  repo.appendEvent(input.campaignId, event);
  repo.putOperation(key, { summaryId: summary.id, applied: true });
  return ok({ summaryId: summary.id, target: input.target ?? 'summarized', refs: input.sourceEventIds.length });
}

/** 给定实例的生命周期；已归档实例不进入活跃待办/工作记忆。 */
export function lifecycleOf(repo: SnapshotRepo, campaignId: string, instanceId: string): Result<{ stage: LifecycleStage; summaryId?: string }> {
  const all = readSummaries(repo, campaignId);
  const match = Object.values(all).find(s => s.instanceId === instanceId);
  return ok(match ? { stage: (match as any).target ?? 'summarized', summaryId: match.id } : { stage: 'open' });
}
