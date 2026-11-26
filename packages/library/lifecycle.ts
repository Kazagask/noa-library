import { readFileSync, unlinkSync } from 'node:fs';
import { writeJsonAtomic } from '../core/util.ts';
import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';
import { readSummaries, summariesPath, readLifecycles, lifecyclesPath } from './lifecycle-internal.ts';

export const LIFECYCLE = ['open', 'active', 'settled', 'summarized', 'archived'] as const;
export type LifecycleStage = typeof LIFECYCLE[number];
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStage, LifecycleStage[]> = {
  open: ['active'], active: ['settled'], settled: ['summarized'],
  summarized: ['archived'], archived: []
};

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
  if (input.keyCausality.length + input.decisions.length === 0) return fail('invalid_summary', '摘要必须包含关键因果或裁决');
  if (!input.instanceId || !input.campaignId || !input.worldlineId) return fail('invalid_summary', '缺少实例或世界线标识');
  return ok(input as ChapterSummary);
}

function persistBatch(repo: SnapshotRepo, campaignId: string, writes: Array<[string, any]>, commit: () => void): Result {
  const backups = writes.map(([path]) => {
    try { return [path, readFileSync(path, 'utf8')]; } catch { return [path, null]; }
  }) as Array<[string, string | null]>;
  try {
    for (const [path, value] of writes) writeJsonAtomic(path, value);
    commit();
    return ok({ atomic: true });
  } catch (err) {
    for (const [path, value] of backups) {
      if (value !== null) writeJsonAtomic(path, JSON.parse(value));
      else { try { unlinkSync(path); } catch { /* ignore */ } }
    }
    return { ok: false, code: 'commit_failed', message: String((err as any)?.message ?? err) };
  }
}

/** 真实状态机：非法跃迁拒绝；每次跃迁写事件与幂等记录。 */
export function transitionLifecycle(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; instanceId: string; to: LifecycleStage;
  idempotencyKey: string; actor: string; at?: string; summaryId?: string;
}): Result {
  if (!LIFECYCLE.includes(input.to)) return fail('invalid_lifecycle_stage', '未知生命周期状态');
  const key = `lifecycle:${input.campaignId}:${input.worldlineId}:${input.idempotencyKey}`;
  const cached = repo.getOperation(key);
  if (cached) return ok({ ...cached, deduplicated: true });
  const states = readLifecycles(repo, input.campaignId);
  const current: LifecycleStage = states[input.instanceId]?.stage ?? 'open';
  if (current === input.to) return ok({ instanceId: input.instanceId, stage: current, deduplicated: true });
  if (!LIFECYCLE_TRANSITIONS[current].includes(input.to)) return fail('illegal_transition', `不允许 ${current} → ${input.to}`, { current, to: input.to });
  states[input.instanceId] = {
    stage: input.to, summaryId: input.summaryId ?? null,
    revision: (states[input.instanceId]?.revision ?? 0) + 1,
    updatedAt: input.at ?? new Date().toISOString(), actor: input.actor
  };
  const event = {
    id: `evt-${sha256(`${key}:${input.to}`).slice(0, 12)}`, seq: repo.nextEventSeq?.(input.campaignId),
    worldlineId: input.worldlineId, at: states[input.instanceId].updatedAt, actor: input.actor,
    op: 'lifecycle.transition', idempotencyKey: input.idempotencyKey,
    patch: { instanceId: input.instanceId, from: current, to: input.to },
    stateRevision: 0, memoryRevision: 0
  };
  const persisted = persistBatch(repo, input.campaignId, [[lifecyclesPath(repo, input.campaignId), states]], () => {
    repo.appendEvent(input.campaignId, event);
    repo.putOperation(key, { instanceId: input.instanceId, stage: input.to, revision: states[input.instanceId].revision });
  });
  if (!persisted.ok) return persisted;
  return ok({ instanceId: input.instanceId, stage: input.to, revision: states[input.instanceId].revision });
}

/** 摘要与归档原子提交：摘要写入、状态跃迁、事件与幂等记录同批完成。 */
export function submitChapterSummary(repo: SnapshotRepo, input: ChapterSummary & { target?: LifecycleStage; idempotencyKey?: string }): Result {
  const checked = validateSummary(input);
  if (!checked.ok) return checked;
  const key = `summary:${input.campaignId}:${input.worldlineId}:${input.idempotencyKey ?? input.id}`;
  if (repo.getOperation(key)) return ok({ deduplicated: true, summaryId: input.id });
  const snap = repo.read(input.campaignId, input.worldlineId);
  const eventIds = new Set([...snap.episodes.map(e => e.id), ...repo.events(input.campaignId, input.worldlineId).map(e => String(e.id))]);
  const missing = input.sourceEventIds.filter(id => !eventIds.has(id));
  if (missing.length) return fail('summary_ref_missing', '摘要引用了不存在的来源', { missing });
  const states = readLifecycles(repo, input.campaignId);
  const current: LifecycleStage = states[input.instanceId]?.stage ?? 'open';
  // 旧副本补归档允许从 open 直接进入 settled；新副本仍需按状态机逐步推进。
  const path: LifecycleStage[] = current === 'open' ? ['active', 'settled'] : [];
  const target: LifecycleStage = input.target ?? 'summarized';
  if (![...path, current].includes('settled') && target !== 'summarized') return fail('illegal_transition', '必须先结算再归档', { current, target });

  const all = readSummaries(repo, input.campaignId);
  const summary: ChapterSummary = {
    ...input,
    id: input.id ?? `sum-${sha256(`${input.instanceId}:${input.sourceEventIds.join(',')}`).slice(0, 12)}`,
    sourceHash: sha256({ sourceEventIds: input.sourceEventIds, keyCausality: input.keyCausality }),
    stateRevision: snap.state.revision, memoryRevision: snap.working?.memoryRevision ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(), actor: input.actor ?? 'gm'
  };
  all[summary.id] = summary;
  states[input.instanceId] = {
    stage: target, summaryId: summary.id,
    revision: (states[input.instanceId]?.revision ?? 0) + 1,
    updatedAt: summary.createdAt, actor: summary.actor
  };
  const event = {
    id: `evt-${sha256(`${key}:${summary.sourceHash}`).slice(0, 12)}`, seq: repo.nextEventSeq?.(input.campaignId),
    worldlineId: input.worldlineId, at: summary.createdAt, actor: summary.actor,
    op: 'memory.summarize', idempotencyKey: input.idempotencyKey ?? summary.id,
    stateRevision: summary.stateRevision, memoryRevision: summary.memoryRevision,
    patch: { summary, instanceId: input.instanceId, target }
  };
  const persisted = persistBatch(repo, input.campaignId, [
    [summariesPath(repo, input.campaignId), all],
    [lifecyclesPath(repo, input.campaignId), states]
  ], () => {
    repo.appendEvent(input.campaignId, event);
    repo.putOperation(key, { summaryId: summary.id, stage: target, revision: states[input.instanceId].revision });
  });
  if (!persisted.ok) return persisted;
  return ok({ summaryId: summary.id, stage: target, refs: input.sourceEventIds.length });
}

export function lifecycleOf(repo: SnapshotRepo, campaignId: string, instanceId: string): Result<{ stage: LifecycleStage; summaryId?: string; revision: number }> {
  const state = readLifecycles(repo, campaignId)[instanceId];
  return ok(state ? { stage: state.stage, summaryId: state.summaryId, revision: state.revision } : { stage: 'open', revision: 0 });
}
