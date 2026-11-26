import { sha256 as digest } from '@noble/hashes/sha2.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isObject, sha256, newId, ok } from './upstream/util.ts';
import { VaultError, VaultRepository, own, validateSnapshot, validatePersona } from './vault.js';

const campaignId = 'SAVE-481';
const worldlineId = 'wl-main';
const paths = [
  'imports/persona/SAVE-481-persona.json',
  'imports/doupo/SAVE-481-campaign-staged.json',
  'imports/doupo/SAVE-481_structured.json',
  'imports/doupo/deltas/SAVE-481-MEDUSA-01.json'
];
const encoder = new TextEncoder();

function check(condition,code,message,status=400) {
  if (!condition) throw new VaultError(code,message,status);
}

export function importCampaign(document,input,actor) {
  check(input.campaignId === campaignId && input.worldlineId === worldlineId,'invalid_target','需明确指定 SAVE-481 / wl-main');
  check(isObject(input.sources) && Object.keys(input.sources).length===paths.length,'invalid_sources','需要四份指定 GitHub 源档');
  const files = paths.map(path=>{
    const blob=own(input.sources,path);
    check(typeof blob?.text==='string' && /^[a-f0-9]{40}$/.test(blob.sha),'invalid_blob','缺少原始 blob 或 SHA');
    const bytes=encoder.encode(blob.text);
    const hash=sha1.create().update(encoder.encode('blob '+bytes.length+'\0')).update(bytes);
    check(bytesToHex(hash.digest())===blob.sha,'blob_sha_mismatch','Git blob SHA 不匹配 '+path);
    try { return JSON.parse(blob.text); }
    catch { throw new VaultError('invalid_json','源档无效 '+path); }
  });
  const [profile,staged,original,delta]=files;
  const [personaPath,stagedPath,originalPath,deltaPath]=paths;
  const blobSha=path=>input.sources[path].sha;
  const base=delta.base;
  const d=delta.state_delta;
  check(delta.id==='SAVE-481-MEDUSA-01' && delta.campaign_id===campaignId && (delta.worldline_id===null || delta.worldline_id===worldlineId)
    && base?.branch==='main' && base.save_id===campaignId
    && base.campaign_path===stagedPath && base.campaign_blob_sha===blobSha(stagedPath)
    && base.original_path===originalPath && base.original_blob_sha===blobSha(originalPath)
    && base.persona_path===personaPath && base.persona_blob_sha===blobSha(personaPath)
    && base.revision===staged.meta?.revision && base.revision===original.meta?.revision
    && staged.meta?.save_id===campaignId && original.meta?.save_id===campaignId
    && staged.migration?.sourcePath===originalPath && staged.migration?.sourceBlobSha===blobSha(originalPath)
    && staged.noa_ref===personaPath,'baseline_mismatch','增量引用、原档或阶段档基线不一致');
  const {noa,...originalState}=original;
  const {noa_ref,migration,...state}=staged;
  const {migrationSource,...identity}=profile;
  const {original_profile_asset:{data:assetBytes,...assetMetadata},...originalPersona}=noa;
  const {original_profile_asset:{sourcePath,jsonPointer,...importedAssetMetadata},...importedPersona}=identity;
  check(sha256(state)===sha256(originalState) && sha256(importedPersona)===sha256(originalPersona)
    && sha256(assetMetadata)===sha256(importedAssetMetadata) && sourcePath===originalPath
    && jsonPointer==='/noa/original_profile_asset/data' && typeof assetBytes==='string'
    && bytesToHex(digest(Uint8Array.from(atob(assetBytes),char=>char.charCodeAt(0))))===assetMetadata.sha256,
    'baseline_mismatch','阶段档、人格分片或原始画像校验失败');
  const evolution = d.research.project_delta;
  const p2=evolution.stages.find(s=>s.id==='P2');
  const p3=evolution.stages.find(s=>s.id==='P3');
  const voucher=state.inventory.current_confirmed.find(i=>i.id==='REUNION_RESEARCH_VOUCHER');
  const invite=delta.knowledge_graph.relations.find(edge=>edge.predicate==='accepts_invitation_to');
  const elapsed=d.timeline.elapsed_minutes_since_save_464;
  const cash=d.economy.cash_g;
  check(delta.episodes.length===16 && delta.knowledge_graph.relations.length===15 && delta.pending.length===9
    && state.character.realm.stage==='斗宗' && state.character.realm.stars===7
    && state.character.id===d.character.id && state.character.location===d.character.location.base && d.character.realm_unchanged
    && state.economy.cash_g===cash.before && cash.before+cash.delta===cash.after && cash.after===825921
    && state.timeline.elapsed_minutes_since_save_464===elapsed.before && elapsed.before+elapsed.delta===elapsed.after
    && state.research.frozen_g===d.economy.frozen_g.before && d.research.frozen_g===d.economy.frozen_g.after
    && voucher?.quantity===1 && d.inventory.reunion_research_voucher.before===1 && d.inventory.reunion_research_voucher.after===1
    && evolution.id==='EVOLUTION' && evolution.session_status==='4/4完成' && p2?.player_ratified===true
    && p2.verified_python_receipt===false && p3?.verified_python_receipt===false
    && d.relationships.realm_after==='一星斗宗' && d.relationships.bloodline_after==='七彩吞天蟒·完美血脉'
    && d.quests.some(q=>q.id==='HOMELAND' && q.status==='已接受') && invite?.status==='未出发'
    && delta.pending.some(row=>row.id==='PENDING-XIAO-VISIT' && row.status==='accepted-not-departed')
    && delta.audit.ledger.every(row=>row.actual_tool_receipt==null)
    && delta.audit.ledger.reduce((sum,row)=>sum+row.cash_delta,0)===cash.delta
    && delta.audit.ledger.reduce((sum,row)=>sum+row.minutes,0)===elapsed.delta,
    'acceptance_mismatch','正式迁移验收基线或结算对账不一致');
  for (const rows of [delta.episodes,delta.pending,delta.knowledge_graph.entities,delta.audit.ledger]) {
    check(rows.every(row=>/^[a-zA-Z0-9_-]+$/.test(row.id)) && new Set(rows.map(row=>row.id)).size===rows.length,
      'duplicate_event','事件、待办或实体 ID 无效或重复');
  }
  const eventIds=new Set(delta.episodes.map(row=>row.id));
  check(delta.audit.ledger.every(row=>eventIds.has(row.id)) && delta.knowledge_graph.relations.every(edge=>edge.source===campaignId || eventIds.has(edge.source)),
    'missing_reference','语义关系或结算账缺少来源事件');
  const key=[campaignId,worldlineId,delta.id].join(':');
  const provenance=Object.fromEntries(paths.map(path=>[path,blobSha(path)]));
  const fingerprint=sha256(provenance);
  const previous=own(document.receipts,key);
  const report={campaignId,worldlineId,deltaId:delta.id,provenance,episodes:16,relations:15,pending:9,
    baseline:{realm:'七星斗宗',cash:cash.after,voucher:1,evolution:evolution.session_status,medusaRealm:d.relationships.realm_after,
      medusaBloodline:d.relationships.bloodline_after,p2PlayerRatified:true,p3ReceiptVerified:false,homeland:'已接受',visit:'accepted-not-departed'}};
  if (previous) {
    check(previous.fingerprint===fingerprint,'import_conflict','已应用增量的 blob SHA 不同',409);
    return {value:ok({...previous.result,receipt:{...previous.receipt,duplicate:true}})};
  }
  check(!own(document.campaigns,campaignId),'campaign_exists','正式 Campaign 已存在，禁止覆盖',409);
  const at=new Date().toISOString();
  const manifest={manifestVersion:1,id:campaignId,title:'斗破苍穹 · SAVE-481',worldId:'doupo',worldlineId,status:'active',
    paths:{state:stagedPath,events:deltaPath,entities:deltaPath,relations:deltaPath,episodesIndex:deltaPath,episodesDir:deltaPath,journals:deltaPath,checkpoints:'sites/checkpoints',working:deltaPath}};
  const entityTypes={character:'person',place:'place',faction:'faction'};
  const entities=delta.knowledge_graph.entities.map(row=>({
    id:row.id,name:row.id==='MEDUSA'?'美杜莎':row.name,type:entityTypes[row.type]??'concept',
    worldlineId,scope:'campaign',knownBy:row.id==='NOA'?['xiao_yan']:['*'],createdAt:at,updatedAt:at,attributes:{source:deltaPath}
  }));
  const relations=delta.knowledge_graph.relations.map((edge,index)=>{
    const id='rel-'+delta.id+'-'+(index+1);
    const knownBy=edge.visibility==='公开'?['*']:edge.visibility==='家庭'?['xiao_yan','xiao_xuner','ziyan']:
      edge.visibility==='叙事层'?['xiao_yan']:['xiao_yan','MEDUSA'];
    return {id,subject:edge.from,predicate:edge.predicate,object:edge.to??'literal:'+id,
      description:JSON.stringify(edge),worldlineId,validFrom:at,validUntil:null,recordedAt:at,scope:'campaign',
      knownBy,confidence:1,sourceEventId:edge.source,epistemic:'fact',holder:null,status:'active',revision:1,
      idempotencyKey:delta.id+':'+id};
  });
  const episodes=delta.episodes.map(row=>({
    id:'ep-'+row.id,sourceEventId:row.id,at,turn:row.order,title:row.title,summary:row.summary,worldlineId,
    entities:[],relationIds:relations.filter(edge=>edge.sourceEventId===row.id).map(edge=>edge.id),knownBy:['xiao_yan'],
    path:'#episodes/'+row.id,tags:['historical-import'],confidence:1
  }));
  state.character.location=d.character.location.session;
  state.economy.cash_g=cash.after;
  state.economy.cash_includes_frozen_g=d.economy.cash_includes_frozen_g;
  state.economy.industries=state.economy.industries.map(row=>({...row,...d.economy.industries.find(industry=>industry.id===row.id && !industry.unchanged)}));
  Object.assign(state.timeline,{current_game_date:d.timeline.current_game_date,three_year_promise_remaining_days:d.timeline.three_year_promise_remaining_days,
    elapsed_minutes_since_save_464:elapsed.after,pending_elapsed:d.timeline.pending_elapsed});
  Object.assign(state.research,{active_count:d.research.active_count,paused_count:d.research.paused_count,frozen_g:d.research.frozen_g,
    total_spent_g:d.research.total_spent_g,evolution_exp_ledger:d.research.evolution_exp_ledger});
  state.research.projects=state.research.projects.map(row=>row.id===evolution.id?{...row,...evolution,status:evolution.session_status}:row);
  state.relationships=state.relationships.map(row=>row.name===d.relationships.target?{...row,...d.relationships}:row);
  state.contracts=state.contracts.map(row=>row.id===d.contracts.id?{...row,...d.contracts}:row);
  const snapshot={manifest,state:{schemaVersion:1,docId:campaignId,worldId:'doupo',worldlineId,revision:1,updatedAt:at,
    rng:null,clock:{turn:null,date:null,period:null},actors:{xiao_yan:state.character,MEDUSA:d.relationships},inventory:state.inventory.current_confirmed,
    resources:{gold:cash.after,researchVoucher:voucher.quantity},quests:d.quests,
    flags:{p2PlayerRatified:true,p3ReceiptVerified:false,visit:'accepted-not-departed'},
    extension:{sourceRevision:base.revision,provenance,sourceState:state,locationEvidence:d.character.location,plans:delta.plans,historicalAudit:delta.audit}},
    entities,relations,episodes,working:{memoryRevision:1,scene:delta.resume,pendingEvents:delta.pending,playerViewer:'xiao_yan'}};
  // Validate the complete candidate even during dry-run.
  validateSnapshot(snapshot,campaignId,worldlineId);
  const persona={...document.persona,version:2,status:'SAVE-481 正式人格',source:personaPath,parts:{...document.persona.parts,importedProfile:profile}};
  const {hash:oldHash,...unhashed}=persona;
  persona.hash=sha256(unhashed);
  validatePersona(persona);
  if (input.dryRun!==false) return {value:ok({...report,dryRun:true,valid:true})};
  document.sourceArchives ??= {};
  document.sourceArchives[campaignId]=input.sources;
  document.campaigns[campaignId]={manifest,lines:{[worldlineId]:snapshot}};
  // Keep the DEMO persona and snapshots intact.
  document.campaignPersonas ??= {};
  document.campaignPersonas[campaignId]=persona;
  document.active={campaignId,worldlineId};
  const receipt={id:newId('req',key),op:'campaign_import',status:'applied',actor,at,campaignId,worldlineId,eventId:delta.id,appliedRevision:1,hash:fingerprint};
  document.receipts[key]={fingerprint,receipt,result:report};
  document.events.push(...delta.episodes.map(row=>({id:row.id,campaignId,worldlineId,at,op:'historical_import',source:deltaPath})),receipt);
  return {write:true,value:ok({...report,receipt})};
}
