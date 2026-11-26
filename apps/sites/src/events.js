import { normalizePatch, episodeSource } from './authority.js';
import { applyChanges, checkConsistency } from './upstream/domain.ts';
import { isObject, sha256, newId, ok } from './upstream/util.ts';
import { VaultError, own, validateSnapshot } from './vault.js';

export const gmProtocol = {
  version:2,tool:'event_commit',
  categories:['人物境界变化','资源交易','科研结算','任务','契约','重要羁绊','个人愿望','重大剧情转折','未来事件'],
  rules:[
    '作为 ChatGPT GM，每次完成上述关键事件后，使用明确的 campaignId、worldlineId、当前 expectedRevision、稳定 eventId 和 idempotencyKey 调用 event_commit，再展示归档结果。',
    '普通闲聊无需逐句记录。只读面板不得写入或推进时间。',
    '对需要随机检定的事件先执行 runtime_execute，随后把返回的 receipt.id 和 receipt.hash 交给 event_commit。首次检定可先用 runtime_init 初始化新随机流。不得生成、重放或猜测历史骰值。',
    '只记录角色已知的内容，给每条记忆明确指定 knownBy，只有确证公开的信息才使用 *。禁止混合世界线。',
    '只有收到 status=applied 的回执才可显示已归档。遇到失败保留原待提交载荷，版本冲突须重新读取并显式解决，禁止自动覆盖。超时先用 event_receipt 检查，重传沿用原幂等键。',
    '历史未知、玩家追认和缺失回执保留原标记，禁止补骰、重复扣款或擅自推进时间。'
  ]
};

function requireData(condition,code,message,status=400) {
  if (!condition) throw new VaultError(code,message,status);
}
const rowId=/^[a-zA-Z0-9_.:-]{1,128}$/;

export function eventReceipt(document,input) {
  const receipt=Object.values(document.receipts).find(entry=>
    entry.receipt.campaignId===input.campaignId && entry.receipt.worldlineId===input.worldlineId &&
    (entry.receipt.eventId===input.lookup || entry.receipt.id===input.lookup || entry.receipt.idempotencyKey===input.lookup));
  const historical=document.events.find(event=>event.campaignId===input.campaignId && event.worldlineId===input.worldlineId &&
    event.id===input.lookup && event.op==='historical_import');
  if (receipt) return {value:ok({receipt:receipt.receipt})};
  if (historical) return {value:ok({id:historical.id,status:'historical_import',source:historical.source,
    ...(historical.id==='EVOLUTION-P2-V2-EXEC-01'?{playerRatified:true,runtimeReceipt:null}:{}),
    ...(historical.id==='EVOLUTION-P3-B-EXEC-01'?{runtimeReceipt:null,verified:false}:{})})};
  throw new VaultError('receipt_not_found','该世界线没有对应回执',404);
}

export function commitEvent(document,repo,input) {
  const {campaignId,worldlineId,eventId,idempotencyKey,expectedRevision,actor}=input;
  const eventKey=[campaignId,worldlineId,idempotencyKey].join(':');
  const {actor:authenticatedActor,...request}=input;
  const fingerprint=sha256(request);
  const previous=own(document.receipts,eventKey);
  if (previous) {
    requireData(previous.fingerprint===fingerprint,'idempotency_conflict','幂等键已绑定其他请求',409);
    return {value:ok({...previous.result,receipt:{...previous.receipt,duplicate:true}})};
  }
  requireData(!document.events.some(event=>event.campaignId===campaignId && event.worldlineId===worldlineId &&
    (event.eventId===eventId || event.id===eventId)),'event_exists','事件 ID 已存在',409);
  const snapshot=repo.read(campaignId,worldlineId);
  requireData(snapshot.state.revision===expectedRevision,'revision_conflict','状态 revision 不一致，当前 '+snapshot.state.revision,409);
  const {statePatch={},episodes=[],entities=[],relations=[],pendingEvents=[],runtimeReceipt}=input;
  requireData(Object.keys(statePatch).length+episodes.length+entities.length+relations.length+pendingEvents.length>0,
    'empty_event','事件至少包含一种变更');
  requireData(!Object.hasOwn(statePatch,'rngCursor'),'unsupported_state_field','rngCursor 由 runtime_execute 管理');
  let verifiedRoll;
  if (runtimeReceipt!==undefined && runtimeReceipt!==null) {
    requireData(isObject(runtimeReceipt) && Object.keys(runtimeReceipt).length===2,'invalid_runtime_receipt','只接受服务端回执 ID 与哈希');
    const prior=Object.values(document.receipts).find(({receipt})=>receipt.id===runtimeReceipt.id &&
      receipt.hash===runtimeReceipt.hash && receipt.op==='runtime_execute' && receipt.status==='applied' &&
      receipt.campaignId===campaignId && receipt.worldlineId===worldlineId && receipt.appliedRevision===expectedRevision);
    requireData(prior && !document.events.some(event=>event.runtimeReceiptId===runtimeReceipt.id),
      'invalid_runtime_receipt','检定回执不存在、版本不匹配或已用于其他事件',409);
    verifiedRoll={id:prior.receipt.id,hash:prior.receipt.hash};
  }
  const at=new Date().toISOString();
  let state;
  try {
    const changes=normalizePatch(snapshot.state,statePatch);
    state=applyChanges(snapshot.state,changes);
  }
  catch(error) { if (error instanceof VaultError) throw error; throw new VaultError('invalid_patch',error.message); }
  state.revision+=1;
  state.updatedAt=at;
  const conflicts=checkConsistency(state,snapshot.relations,snapshot.manifest.consistencyRules,
    {viewer:'system',worldlineId,asOf:at});
  requireData(conflicts.length===0,'state_memory_conflict','确定性状态和记忆约束冲突',409);
  for (const [rows,target,kind] of [[entities,snapshot.entities,'entity'],[relations,snapshot.relations,'relation'],[episodes,snapshot.episodes,'episode']]) {
    requireData(rows.length<=60,'too_many_rows','每类记忆每次最多 60 条');
    const ids=new Set(target.map(row=>row.id));
    for (const row of rows) {
      requireData(isObject(row) && rowId.test(row.id ?? '') && !ids.has(row.id) &&
        row.worldlineId===worldlineId && Array.isArray(row.knownBy) && row.knownBy.length>0 &&
        row.knownBy.every(viewer=>typeof viewer==='string' && viewer.length>0),
        'invalid_memory_row','记忆 ID 重复、世界线不一致或缺少认知范围');
      if (kind!=='entity') requireData(row.sourceEventId===eventId,'invalid_source','记忆来源必须匹配 eventId');
      if (kind==='relation' && row.epistemic==='belief') requireData(row.knownBy.length===1 && row.knownBy[0]===row.holder,
        'invalid_knowledge_scope','主观认知只能指定其持有人');
      ids.add(row.id);
      target.push(kind==='episode' && snapshot.manifest.worldId==='doupo' ? {...row,path:episodeSource(snapshot,{...row,path:''})} : row);
    }
  }
  requireData(pendingEvents.length<=60,'too_many_rows','每次最多更新 60 项待办');
  const pending=new Map((snapshot.working.pendingEvents ?? []).map(row=>[row.id,row]));
  const pendingIds=new Set();
  for (const row of pendingEvents) {
    requireData(isObject(row) && typeof row.id==='string' && rowId.test(row.id) && !pendingIds.has(row.id)
      && typeof row.status==='string' && typeof row.action==='string' &&
      (row.worldlineId===undefined || row.worldlineId===worldlineId),'invalid_pending','待办 ID、状态、行动或世界线无效');
    pendingIds.add(row.id);
    pending.set(row.id,{...row,worldlineId,sourceEventId:eventId});
  }
  snapshot.working.pendingEvents=[...pending.values()];
  snapshot.state=state;
  if (entities.length+relations.length+episodes.length+pendingEvents.length) {
    snapshot.working.memoryRevision=(snapshot.working.memoryRevision ?? 0)+1;
  }
  validateSnapshot(snapshot,campaignId,worldlineId);
  repo.write(campaignId,worldlineId,snapshot);
  const result={eventId,revision:state.revision,counts:{episodes:episodes.length,entities:entities.length,relations:relations.length,pendingEvents:pendingEvents.length}};
  const receipt={id:newId('req',eventKey),eventId,op:'event_commit',status:'applied',actor,at,campaignId,worldlineId,
    idempotencyKey,appliedRevision:state.revision,memoryRevision:snapshot.working.memoryRevision,hash:sha256({fingerprint,result,verifiedRoll}),
    runtimeReceipt:verifiedRoll??null};
  repo.appendEvent(campaignId,{...receipt,id:eventId,runtimeReceiptId:verifiedRoll?.id,statePatch,counts:result.counts});
  document.receipts[eventKey]={fingerprint,receipt,result};
  return {write:true,value:ok({...result,receipt})};
}
