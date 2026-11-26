import { ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';
import { buildProjections } from './projections.ts';
import { splitTodos, projectTodo } from './todos.ts';
import { readSummaries } from './lifecycle-internal.ts';

export interface RecoveryBundle {
  version: 1; campaignId: string; worldlineId: string;
  stateRevision: number; memoryRevision: number; rngCursor: number | null;
  scene: string | null; activeTodos: any[]; recentReceipts: any[];
  pendingNarratives: string[]; projections: Record<string, any>;
  note: string;
}

/** 轻量会话恢复：只返回当前 revision、近期事务、场景与未完成流程，不重放历史正文。 */
export function recoverySnapshot(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; viewer?: string; limit?: number;
}): Result<RecoveryBundle> {
  try {
    const snap = repo.read(input.campaignId, input.worldlineId);
    const projections = buildProjections(snap);
    if (!projections.ok) return projections;
    const todos = splitTodos(snap);
    const events = repo.events(input.campaignId, input.worldlineId).slice(-Math.max(1, Math.min(input.limit ?? 8, 20)));
    const summaries = readSummaries(repo, input.campaignId);
    const summarized = new Set(Object.values(summaries).flatMap(s => s.sourceEventIds ?? []));
    const pendingNarratives = events
      .filter(e => ['state.commit', 'runtime.execute', 'memory.record', 'memory.revise'].includes(String(e.op)) && !summarized.has(String(e.id)))
      .slice(0, 8)
      .map(e => String(e.id));
    return ok({
      version: 1, campaignId: input.campaignId, worldlineId: input.worldlineId,
      stateRevision: snap.state.revision, memoryRevision: snap.working?.memoryRevision ?? 0,
      rngCursor: snap.state.rng?.cursor ?? null,
      scene: snap.working?.scene ?? null,
      activeTodos: todos.active.slice(0, 12).map(projectTodo),
      recentReceipts: events.map(e => ({
        eventId: e.id, op: e.op, idempotencyKey: e.idempotencyKey,
        stateRevision: e.stateRevision, actor: e.actor, at: e.at, seq: e.seq
      })),
      pendingNarratives,
      projections: Object.fromEntries(Object.entries(projections.data).map(([k, v]) => [k, {
        sourceRevision: v.sourceRevision, sourceMemoryRevision: v.sourceMemoryRevision, stale: v.stale, value: v.value
      }])),
      note: '仅用于恢复当前上下文；事务结果以服务端回执为准，断线不触发重复掷骰/扣费/奖励/时间推进。'
    });
  } catch (err: any) { return fail('recovery_failed', String(err?.message ?? err)); }
}
