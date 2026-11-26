import { openVault, transact } from './vault.js';
import { runTool } from './tools.js';
import { sha256 } from './upstream/util.ts';

export async function verifyFormal(db,owner) {
  const scope={campaignId:'SAVE-481',worldlineId:'wl-main'};
  const loaded=await openVault(db,owner);
  const sources=loaded.document.sourceArchives?.[scope.campaignId];
  const checks={};
  if (!sources) return {pass:false,checks,reason:'正式档案尚未导入'};
  const fixture=owner+'/verify/'+crypto.randomUUID();
  const run=(name,args={},target=fixture)=>transact(db,target,doc=>runTool(doc,name,{...scope,...args},owner));
  async function rejected(code,name,args) {
    try {return (await run(name,args)).code===code}
    catch(error) {return error.code===code}
  }
  try {
    const read=await run('state_read',{},owner);
    const boot=await run('session_bootstrap',{},owner);
    checks.formalBaseline=read.ok && boot.ok && read.data.state.resources.gold===825921 &&
      read.data.state.actors.xiao_yan.realm.stars===7 && read.data.state.resources.researchVoucher===1 &&
      read.data.pendingEvents.length===9 && boot.data.persistenceProtocol.tool==='event_commit';
    const imported=await run('campaign_import',{sources,dryRun:false});
    const again=await run('campaign_import',{sources,dryRun:false});
    checks.importIdempotence=imported.ok && again.ok && again.data.receipt.duplicate===true &&
      imported.data.receipt.id===again.data.receipt.id;
    const before=await openVault(db,fixture);
    const first=before.document.campaigns['SAVE-481'].lines['wl-main'];
    checks.sourceAndCounts=first.episodes.length===16 && first.relations.length===15 && first.working.pendingEvents.length===9 &&
      sha256(before.document.sourceArchives['SAVE-481'])===sha256(sources);
    checks.demoIntact=sha256(before.document.campaigns.demo)===sha256(loaded.document.campaigns.demo);
    const expectedRevision=first.state.revision;
    const request={eventId:'NOA-VERIFY-PRIVATE',idempotencyKey:'NOA-VERIFY-PRIVATE',expectedRevision};
    const episode={id:'ep-NOA-VERIFY-PRIVATE',title:'NOA_VERIFY_PRIVATE_TOKEN',summary:'NOA_VERIFY_PRIVATE_TOKEN',at:new Date().toISOString(),
      turn:0,worldlineId:'wl-main',entities:[],relationIds:[],knownBy:['xiao_yan'],sourceEventId:request.eventId,
      path:'events/NOA-VERIFY-PRIVATE',tags:[],confidence:1};
    const wrong={...episode,worldlineId:'wl-test'};
    checks.rollback=await rejected('invalid_memory_row','event_commit',{...request,statePatch:{resources:{gold:1}},episodes:[episode,wrong]})
      && sha256((await openVault(db,fixture)).document)===sha256(before.document);
    const event={...request,episodes:[episode],statePatch:{resources:{gold:825920}}};
    const committed=await run('event_commit',event);
    const duplicate=await run('event_commit',event);
    const patched=await run('state_read');
    checks.partialStatePatch=patched.data.state.resources.gold===825920 && patched.data.state.resources.researchVoucher===1;
    const receipt=await run('event_receipt',{lookup:request.eventId});
    checks.atomicCommitAndReceipt=committed.ok && duplicate.data.receipt.duplicate===true && receipt.data.receipt.hash===committed.data.receipt.hash;
    checks.revisionConflict=await rejected('revision_conflict','event_commit',{...request,eventId:'NOA-VERIFY-STALE',idempotencyKey:'NOA-VERIFY-STALE',episodes:[episode]});
    const visible=await run('memory_recall',{query:episode.title,viewer:'xiao_yan'});
    const hidden=await run('memory_recall',{query:episode.title,viewer:'xiao_xuner'});
    checks.knowledgeIsolation=visible.data.hits.some(hit=>hit.id===episode.id) && !hidden.data.hits.some(hit=>hit.id===episode.id);
    checks.wrongWorldline=await rejected('worldline_not_found','state_read',{worldlineId:'wl-test'});
    checks.fakeRollRejected=await rejected('invalid_runtime_receipt','event_commit',{
      eventId:'NOA-VERIFY-FAKE',idempotencyKey:'NOA-VERIFY-FAKE',expectedRevision:committed.data.revision,
      statePatch:{resources:{gold:1}},runtimeReceipt:{id:'fake',hash:'fake'}});
    const roll=await run('runtime_execute',{skill:2,difficulty:1,idempotencyKey:'NOA-VERIFY-ROLL'});
    const applied=await run('event_commit',{eventId:'NOA-VERIFY-ROLL-EVENT',idempotencyKey:'NOA-VERIFY-ROLL-EVENT',
      expectedRevision:roll.data.revision,pendingEvents:[{id:'NOA-VERIFY-TASK',action:'验证',status:'pending'}],
      runtimeReceipt:{id:roll.data.receipt.id,hash:roll.data.receipt.hash}});
    checks.authenticRoll=applied.ok && applied.data.receipt.runtimeReceipt.id===roll.data.receipt.id;
    const historical=await run('event_receipt',{lookup:'EVOLUTION-P3-B-EXEC-01'},owner);
    checks.historicalReceiptMissing=historical.data.runtimeReceipt===null && historical.data.verified===false;
  } catch(error) {
    checks.interrupted=false;
    return {pass:false,checks,reason:error.code ?? error.name};
  } finally {
    await db.prepare('DELETE FROM noa_vault WHERE owner_id=?').bind(fixture).run();
  }
  return {pass:Object.values(checks).every(Boolean),checks};
}
