import { sha256, ok, fail, type Result } from '../core/shared.ts';
import type { Snapshot } from './store.ts';

export interface Projection<T = any> {
  name: string; sourceRevision: number; sourceMemoryRevision: number;
  sourceHash: string; rebuiltAt: string; stale: boolean; value: T;
}

function envelope<T>(name: string, snap: Snapshot, value: T, at: string): Projection<T> {
  const sourceHash = sha256({ state: snap.state, working: snap.working });
  return {
    name, sourceRevision: snap.state.revision, sourceMemoryRevision: snap.working?.memoryRevision ?? 0,
    sourceHash, rebuiltAt: at, stale: false, value
  };
}

function actors(state: any): any[] {
  return Object.entries(state?.actors ?? {}).map(([id, a]: [string, any]) => ({
    id, name: a.name ?? id, realm: a.realm ?? a.stage ?? null,
    location: a.location ?? null, hp: a.hp ?? null, maxHp: a.maxHp ?? null
  }));
}
function pending(working: any): any[] {
  return (working?.pendingTasks ?? []).filter((t: any) => ['open', 'active', 'pending'].includes(String(t.status ?? 'open')));
}

/** 所有投影都从权威 state/working 现场重建，并带 revision/hash 与陈旧检测。 */
export function buildProjections(snap: Snapshot, at = new Date().toISOString()): Result<Record<string, Projection>> {
  if (!snap?.state) return fail('invalid_snapshot', '缺少权威 state');
  const state: any = snap.state;
  const work: any = snap.working ?? {};
  const party = envelope('party', snap, actors(state).filter(a => work.partyIds?.includes(a.id) || a.location === state.clock?.location || a.id === 'person.player'), at);
  const research = envelope('research', snap, {
    projects: Object.values(state.research?.projectsById ?? state.research?.projects ?? {}),
    vouchers: state.research?.voucherQuantity ?? state.research?.vouchers ?? 0
  }, at);
  const economy = envelope('economy', snap, {
    gold: state.resources?.gold ?? state.economy?.cash_g ?? null,
    industries: Object.values(state.economy?.industriesById ?? state.economy?.industries ?? {})
  }, at);
  const todos = envelope('pendingEvents', snap, pending(work), at);
  return ok({ party, research, economy, pendingEvents: todos });
}

export function detectStaleProjection(projection: Projection, snap: Snapshot): boolean {
  return projection.sourceRevision !== snap.state.revision ||
    projection.sourceMemoryRevision !== (snap.working?.memoryRevision ?? 0) ||
    projection.sourceHash !== sha256({ state: snap.state, working: snap.working });
}
