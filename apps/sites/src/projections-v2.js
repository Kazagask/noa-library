import { projectBusiness } from './authority.js';
import { VaultError } from './vault.js';

export function migrateProjections(document) {
  const snapshot=document.campaigns['SAVE-481']?.lines['wl-main'];
  if (!snapshot) return null;
  const {state,working}=snapshot;
  const pending=working.pendingEvents ?? [];
  const byId=new Map(pending.map(row=>[row.id,row]));
  const applied=new Set(document.events.filter(e=>e.campaignId==='SAVE-481' && e.worldlineId==='wl-main' && e.status==='applied').map(e=>e.eventId ?? e.id));
  const evidence=id=>{
    const row=byId.get(id);
    if (!row || !applied.has(row.sourceEventId)) throw new VaultError('migration_evidence','缺少已提交的业务投影来源：'+id,409);
    return row;
  };
  const ledger=evidence('PENDING-DOUZUN-CLOCK-LEDGER');
  const promise=evidence('THREE-YEAR-PROMISE-PROJECTION');
  const elapsed=ledger.effectiveMinutes;
  if (!Number.isSafeInteger(elapsed) || elapsed!==promise.projection.elapsedMinutes || elapsed<state.clock.elapsedMinutes) {
    throw new VaultError('migration_evidence','相对时钟来源不一致',409);
  }
  state.clock.elapsedMinutes=elapsed;
  const {timeline,economy,relationships,research}=projectBusiness(state);
  const settlement=evidence('INDUSTRY-SETTLEMENT-LEDGER-V1');
  const revival=evidence('YAOCHEN-GENESIS-CURRENT-PROJECTION');
  const party=evidence('CENTRAL-EXPEDITION-PARTY');
  const projects=Object.fromEntries(Array.isArray(research.projects)
    ? research.projects.filter(p=>p.id).map(p=>[p.id,p])
    : Object.entries(research.projects ?? {}));
  for (const row of pending.filter(r=>r.id.startsWith('PLAN-') && r.plan?.id)) {
    evidence(row.id);
    projects[row.plan.id]={...projects[row.plan.id],...row.plan,status:row.status,sourceEventId:row.sourceEventId,
      ...(row.review===undefined?{}:{review:row.review})};
  }
  const industries=economy.industries.map(industry=>{
    const booked=settlement.ledger.batches.filter(batch=>batch.booked===true && batch.id.startsWith(industry.id+'-'));
    const last=booked.at(-1);
    if (!last) return industry;
    const {pending_settlement,pending_batch,next_batch,overdue_days_approximate,overdue_hours_approximate,
      additional_cycles,next_settlement_days,next_settlement_days_approximate,next_settlement_days_basis,...rest}=industry;
    return {...rest,pending_settlement:false,pending_batch:null,booked:true,last_settled_batch:last.id,
      last_settlement:last,sourceEventId:settlement.sourceEventId};
  });
  state.extension.business={
    ...state.extension.business,
    timeline:{...timeline,elapsed_minutes_since_save_464:elapsed,
      three_year_promise_remaining_days:promise.projection.remainingDaysEstimate,
      promiseProjection:{...promise.projection,sourceEventId:promise.sourceEventId}},
    economy:{...economy,industries,settlementSourceEventId:settlement.sourceEventId},
    industries,
    relationships:relationships.map(row=>row.name==='药尘'
      ? {...row,realm:revival.projection.currentRealm,realmSourceEventId:revival.sourceEventId}:row),
    research:{...research,projects}
  };
  working.scene=party.party.location;
  working.party=party.party;
  working.legacyPendingRecords=pending;
  const active=new Set(['not-started','unresolved','partially-reconciled','partially-settled','candidate-only',
    'authorized-execution','planned','running','awaiting-review','approved-scheduled',
    'partially-completed-paused-oculus','accepted-trip-contract-pending','reviewed-conditional-consent']);
  working.pendingEvents=pending.filter(row=>active.has(row.status)).map(({id,status,action,sourceEventId,worldlineId,plan})=>({
    id,status,action:action.slice(0,160),sourceEventId,worldlineId,...(plan?.id?{projectId:plan.id}:{})
  }));
  return {campaignId:'SAVE-481',worldlineId:'wl-main',revision:state.revision,previousPending:pending.length,
    activePending:working.pendingEvents.length,projects:Object.keys(projects).length,
    preserved:{events:document.events.length,receipts:Object.keys(document.receipts).length,
      episodes:snapshot.episodes.length,entities:snapshot.entities.length,relations:snapshot.relations.length},
    sources:[ledger,promise,settlement,revival,party].map(row=>row.sourceEventId)};
}
