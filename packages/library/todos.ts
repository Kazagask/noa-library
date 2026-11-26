import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { SnapshotRepo } from './store.ts';

export const TODO_STATUSES = ['open', 'active', 'completed', 'cancelled', 'expired', 'superseded', 'sealed'] as const;
export type TodoStatus = typeof TODO_STATUSES[number];
const ACTIVE: TodoStatus[] = ['open', 'active'];

/** 活跃待办与历史待办记录拆分；大事件正文不进入活跃投影。 */
export function splitTodos(snap: any): { active: any[]; historical: any[] } {
  const rows = snap?.working?.pendingTasks ?? [];
  const active: any[] = [];
  const historical: any[] = [];
  for (const row of rows) (ACTIVE.includes(String(row.status ?? 'open') as TodoStatus) ? active : historical).push(row);
  return { active, historical };
}

export function projectTodo(todo: any): any {
  return {
    id: todo.id, title: todo.title ?? todo.hint ?? '',
    status: String(todo.status ?? 'open'),
    camera: todo.camera ?? todo.camp ?? null,
    sourceEventId: todo.sourceEventId ?? null,
    bytes: Buffer.byteLength(JSON.stringify(todo), 'utf8')
  };
}

/** 状态迁移幂等；禁止把整个事件历史或战斗记录写回待办。 */
export function setTodoStatus(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; id: string; status: TodoStatus;
  idempotencyKey: string; actor: string; at?: string;
}): Result {
  if (!TODO_STATUSES.includes(input.status)) return fail('invalid_todo_status', '未知待办状态');
  const key = `todo:${input.campaignId}:${input.worldlineId}:${input.idempotencyKey}`;
  if (repo.getOperation(key)) return ok({ deduplicated: true, id: input.id, status: input.status });
  const snap = repo.read(input.campaignId, input.worldlineId);
  const todo = (snap.working?.pendingTasks ?? []).find((t: any) => t.id === input.id);
  if (!todo) return fail('todo_not_found', `待办 ${input.id} 不存在`);
  todo.status = input.status;
  todo.updatedAt = input.at ?? new Date().toISOString();
  const revisions: Record<string, number> = { ...(snap.working?.todoRevisions ?? {}) };
  revisions[input.id] = (revisions[input.id] ?? 0) + 1;
  snap.working = { ...snap.working, todoRevisions: revisions, memoryRevision: (snap.working?.memoryRevision ?? 0) + 1 };
  const event = {
    id: `evt-${sha256(`${key}:${revisions[input.id]}`).slice(0, 12)}`, seq: repo.nextEventSeq?.(input.campaignId),
    worldlineId: input.worldlineId, at: todo.updatedAt, actor: input.actor,
    op: 'todo.status', idempotencyKey: input.idempotencyKey,
    patch: { todoId: input.id, status: input.status, revision: revisions[input.id] },
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision
  };
  if (repo.commit) repo.commit(input.campaignId, input.worldlineId, snap, event);
  else {
    repo.write(input.campaignId, input.worldlineId, snap);
    repo.appendEvent(input.campaignId, event);
    repo.putOperation(key, { id: input.id, status: input.status, appliedAt: todo.updatedAt });
  }
  return ok({ id: input.id, status: input.status, revision: revisions[input.id] });
}
