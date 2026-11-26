import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { Snapshot } from './store.ts';

export interface Projection<T = any> {
  name: string; sourceRevision: number; sourceMemoryRevision: number;
  sourceHash: string; rebuiltAt: string; stale: boolean; value: T;
}

function envelope<T>(name: string, snap: Snapshot, value: T, at: string): Projection<T> {
  return {
    name, sourceRevision: snap.state.revision, sourceMemoryRevision: snap.working?.memoryRevision ?? 0,
    sourceHash: sha256({ state: snap.state, working: snap.working }), rebuiltAt: at, stale: false, value
  };
}
const objectValues = (value: any): any[] => Array.isArray(value) ? value : Object.values(value ?? {});
const business = (state: any): any => state?.extension?.business ?? state?.business ?? {};

/** 兼容 Sites 生产数据：state.actors、extension.business、working.pendingTasks/legacyPendingRecords。 */
export function buildProjections(snap: Snapshot, at = new Date().toISOString()): Result<Record<string, Projection>> {
  if (!snap?.state) return fail('invalid_snapshot', '缺少权威 state');
  const state: any = snap.state;
  const work: any = snap.working ?? {};
  const biz = business(state);
  const party = envelope('party', snap, Object.entries(state.actors ?? {}).map(([id, a]: [string, any]) => ({
    id, name: a.name ?? id, realm: a.realm ?? a.stage ?? a.cultivation?.realm ?? null,
    location: a.location ?? null, hp: a.hp ?? null, maxHp: a.maxHp ?? null, skills: a.skills ?? {}
  })), at);
  const research = envelope('research', snap, {
    projects: objectValues(biz.research?.projects ?? state.research?.projects ?? state.research?.projectsById ?? {}),
    vouchers: biz.research?.voucherQuantity ?? state.research?.voucherQuantity ?? 0
  }, at);
  const economy = envelope('economy', snap, {
    gold: state.resources?.gold ?? state.economy?.cash_g ?? null,
    industries: objectValues(biz.economy?.industries ?? state.economy?.industriesById ?? state.economy?.industries ?? {}),
    settlementLedger: objectValues(biz.settlementLedger ?? state.economy?.settlementLedger ?? {})
  }, at);
  const todos = envelope('pendingEvents', snap, work.pendingTasks ?? [], at);
  const historical = envelope('pendingHistory', snap, work.legacyPendingRecords ?? [], at);
  return ok({ party, research, economy, pendingEvents: todos, pendingHistory: historical });
}

export function detectStaleProjection(projection: Projection, snap: Snapshot): boolean {
  return projection.sourceRevision !== snap.state.revision ||
    projection.sourceMemoryRevision !== (snap.working?.memoryRevision ?? 0) ||
    projection.sourceHash !== sha256({ state: snap.state, working: snap.working });
}

/** 覆盖校验：所有业务项目、账本条目、待办状态都必须在投影中保留。 */
export function verifyProjectionCoverage(snap: Snapshot, projections: Record<string, Projection>): Result<{ checked: number }> {
  const state: any = snap.state ?? {};
  const work: any = snap.working ?? {};
  const biz = business(state);
  const checks: Array<[boolean, string]> = [
    [projections.party?.value.length === Object.keys(state.actors ?? {}).length, 'party'],
    [projections.research?.value.projects.length === objectValues(biz.research?.projects ?? state.research?.projects ?? {}).length, 'research.projects'],
    [projections.economy?.value.industries.length === objectValues(biz.economy?.industries ?? state.economy?.industriesById ?? {}).length, 'economy.industries'],
    [projections.economy?.value.settlementLedger.length === objectValues(biz.settlementLedger ?? state.economy?.settlementLedger ?? {}).length, 'settlementLedger'],
    [projections.pendingEvents?.value.length === (work.pendingTasks ?? []).length, 'pendingEvents'],
    [projections.pendingHistory?.value.length === (work.legacyPendingRecords ?? []).length, 'pendingHistory']
  ];
  const failed = checks.filter(([pass]) => !pass).map(([, name]) => name);
  return failed.length ? fail('projection_loss', '投影丢失业务数据', { failed }) : ok({ checked: checks.length });
}
