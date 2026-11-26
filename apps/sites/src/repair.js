import { openVault, transact, VaultError, VaultRepository } from './vault.js';
import { runTool } from './tools.js';
import { pendingForRead, relativeClock } from './authority.js';
import { sha256 } from './upstream/util.ts';

const scope={campaignId:'SAVE-481',worldlineId:'wl-main'};
const checkpointId='cp-49db518cd0c2';
const key='noa-authority-repair-v2';

export async function repairSave(db,owner) {
  const backup=owner+'/backup/'+key;
  await db.prepare('INSERT INTO noa_vault(owner_id,version,document) SELECT ?,version,document FROM noa_vault WHERE owner_id=? ON CONFLICT(owner_id) DO NOTHING')
    .bind(backup,owner).run();
  const saved=await db.prepare('SELECT version,document FROM noa_vault WHERE owner_id=?').bind(backup).first();
  if (!saved) throw new VaultError('backup_missing','全库备份未建立',409);
  const old=JSON.parse(saved.document);
  const source=old.sourceArchives?.[scope.campaignId];
  const checkpoints=old.checkpoints;
  if (!source || !checkpoints[scope.campaignId+':'+checkpointId]) throw new VaultError('backup_unverified','缺少正式源档或修复前快照',409);
  return await transact(db,owner,(doc,version)=>{
    if (doc.repairReceipts?.[key]) return {value:{...doc.repairReceipts[key],duplicate:true}};
    if (version!==saved.version) throw new VaultError('revision_conflict','备份后档案已变化，未执行修复',409);
    const repo=new VaultRepository(doc);
    const snapshot=repo.read(scope.campaignId,scope.worldlineId);
    if (snapshot.state.revision!==11 || snapshot.state.rng!==null) throw new VaultError('unexpected_baseline','预期 Revision 11 且未初始化随机流',409);
    const init=runTool(doc,'runtime_init',{...scope,expectedRevision:11,idempotencyKey:key},owner);
    if (!init.value.ok) throw new VaultError(init.value.code,init.value.message,409);
    const next=repo.read(scope.campaignId,scope.worldlineId);
    next.state.clock=relativeClock(next.state);
    next.working.pendingEvents=pendingForRead(next.working);
    next.working.memoryRevision+=1;
    repo.write(scope.campaignId,scope.worldlineId,next);
    const report={revision:next.state.revision,checkpointId,backupHash:sha256(old),sourceHash:sha256(source),
      clock:next.state.clock,rngCursor:next.state.rng.cursor,initializationReceipt:init.value.data.receipt.id,
      priorApplied:old.events.filter(e=>e.campaignId===scope.campaignId && e.op==='event_commit' && e.status==='applied').length};
    doc.repairReceipts={...doc.repairReceipts,[key]:report};
    repo.appendEvent(scope.campaignId,{...scope,id:key,op:'authority.repair',at:new Date().toISOString(),actor:owner,revision:next.state.revision});
    return {write:true,value:report};
  });
}

export async function verifyRepair(db,owner) {
  const {document:live}=await openVault(db,owner);
  const repair=live.repairReceipts?.[key];
  const repo=new VaultRepository(live);
  const current=repo.read(scope.campaignId,scope.worldlineId);
  const checked={};
  const direct=(name,args={},allowGM=true)=>runTool(live,name,{...scope,...args},owner,{allowGM}).value;
  const art=direct('state_read',{section:'cultivation'}).data.section.main_art;
  checked.authoritativeArt=art.completed_mutations===7 && art.mutations.at(-1).name==='万法归源' && art.proficiency===9768.93 && art.current_efficiency_multiplier===14.16;
  checked.originImmutable=sha256(live.sourceArchives[scope.campaignId])===repair?.sourceHash;
  checked.historicalReceipts=live.events.filter(e=>e.campaignId===scope.campaignId && e.op==='event_commit' && e.status==='applied' && e.appliedRevision<=11).length===10
    && direct('event_receipt',{lookup:'EVOLUTION-P3-B-EXEC-01'}).data.verified===false
    && direct('event_receipt',{lookup:'EVOLUTION-P2-V2-EXEC-01'}).data.playerRatified===true;
  checked.relativeClock=current.state.clock.elapsedMinutes===67620 && current.state.clock.date===null &&
    current.working.pendingEvents.some(row=>row.id==='PENDING-TRAVEL-TIME' && row.status==='unresolved') &&
    current.working.pendingEvents.some(row=>row.id==='PENDING-SITES-MIGRATION' && row.status==='resolved');
  checked.realRngInitialization=current.state.rng?.cursor===0 && Number.isSafeInteger(current.state.rng.seed);
  const boot=direct('session_bootstrap');
  checked.bootstrap=boot.data.viewer==='gm' && boot.data.memory.length>0 && boot.data.state.revision===current.state.revision;
  checked.GMPrivilege=direct('session_bootstrap',{viewer:'gm'},false).code==='gm_forbidden';
  checked.noise=direct('memory_recall',{viewer:'gm',query:'zzz_NOA_NO_MATCH_18377zzz'}).data.hits.length===0;
  const fixture=owner+'/verify/'+crypto.randomUUID();
  const run=(name,args={})=>transact(db,fixture,doc=>runTool(doc,name,{...scope,...args},owner,{allowGM:true}));
  try {
    const isolated={...live,sourceArchives:{},checkpoints:{},operations:{},receipts:{},events:[]};
    const seedless=structuredClone(current);
    seedless.state.rng=null;
    isolated.campaigns={...live.campaigns,[scope.campaignId]:{manifest:current.manifest,lines:{[scope.worldlineId]:seedless}}};
    await transact(db,fixture,()=>({write:true,document:isolated}));
    const before=await openVault(db,fixture);
    const base={eventId:'VERIFY-R12',idempotencyKey:'VERIFY-R12',expectedRevision:current.state.revision};
    try { await run('event_commit',{...base,statePatch:{unsupportedBusinessField:1}}); }
    catch(error) {checked.unknownFieldRollback=error.code==='unsupported_state_field' && sha256((await openVault(db,fixture)).document)===sha256(before.document);}
    const now=new Date().toISOString();
    const event={...base,statePatch:{research:{active_count:2},cultivation:{main_art:{proficiency:10000}},clock:{advanceMinutes:5}},
      episodes:[{id:'ep-verify-r12',at:now,turn:0,title:'NOA_VERIFY_PRIVATE_9913',summary:'NOA_VERIFY_PRIVATE_9913',worldlineId:'wl-main',entities:[],relationIds:[],knownBy:['xiao_yan'],sourceEventId:base.eventId,path:'wrong.json',tags:[],confidence:1}]};
    const receipt=await run('event_commit',event);
    const duplicate=await run('event_commit',event);
    checked.idempotent=receipt.ok && duplicate.data.receipt.duplicate===true && duplicate.data.receipt.id===receipt.data.receipt.id;
    checked.readWriteProjection=(await run('state_read',{section:'research'})).data.section.active_count===2 &&
      (await run('state_read',{section:'cultivation'})).data.section.main_art.proficiency===10000 &&
      (await run('state_read')).data.state.clock.elapsedMinutes===67625;
    const look={query:'NOA_VERIFY_PRIVATE_9913'};
    const gm=await run('memory_recall',{...look,viewer:'gm'});
    checked.roleIsolation=gm.data.hits.some(hit=>hit.id==='ep-verify-r12' && hit.source==='events/SAVE-481/wl-main/VERIFY-R12')
      && !(await run('memory_recall',{...look,viewer:'xiao_xuner'})).data.hits.length
      && !(await run('memory_recall',{...look,viewer:'xiao_yan',asOf:'2025-01-01T00:00:00Z'})).data.hits.length;
    const initArgs={expectedRevision:receipt.data.revision,idempotencyKey:'VERIFY-INIT-R12'};
    const init=await run('runtime_init',initArgs);
    const initAgain=await run('runtime_init',initArgs);
    const rollArgs={skill:2,difficulty:1,idempotencyKey:'VERIFY-ROLL-R12'};
    const roll=await run('runtime_execute',rollArgs);
    const again=await run('runtime_execute',rollArgs);
    const latest=await run('session_bootstrap');
    const rollReceipt=await run('event_receipt',{lookup:roll.data.receipt.id});
    checked.randomReceipt=init.data.rng.cursor===0 && initAgain.data.receipt.duplicate===true && roll.data.roll.seed===init.data.rng.seed &&
      again.data.receipt.duplicate===true && rollReceipt.data.receipt.hash===roll.data.receipt.hash &&
      latest.data.state.rng.cursor===1 && latest.data.state.rng.seed===init.data.rng.seed;
    checked.newSession=latest.data.memory.some(ep=>ep.id==='ep-verify-r12') && latest.data.state.clock.elapsedMinutes===67625;
  } catch(error) {
    return {pass:false,checks:checked,reason:error.code ?? error.name};
  } finally {
    await db.prepare('DELETE FROM noa_vault WHERE owner_id=?').bind(fixture).run();
  }
  return {pass:Object.values(checked).every(Boolean),checks:checked};
}
