import { registryFor, validateRegistryArgs } from '../../../packages/core/mcp-registry.ts';
import { exportPage } from './export.js';
import { normalizePatch, projectBusiness, relativeClock, pendingForRead, episodeSource } from './authority.js';
import { importCampaign } from './formal.js';
import { commitEvent, eventReceipt, gmProtocol } from './events.js';
import * as ops from './upstream/operations.ts';
import { entityVisible, relationVisible, episodeVisible } from './upstream/domain.ts';
import { fail, ok, sha256, validateSchema, isObject, newId } from './upstream/util.ts';
import { own, VaultError, VaultRepository, validateSnapshot } from './vault.js';

const str = { type:'string' };
const int = { type:'integer', minimum:0 };
const obj = { type:'object' };
const bool = { type:'boolean' };
const view = {viewer:str, asOf:str, includeBeliefs:bool};
const key = {type:'string',pattern:'^[a-zA-Z0-9_.:-]{4,128}$'};
const version = { ...int, maximum:Number.MAX_SAFE_INTEGER-1 };
const kind = {type:'string',enum:['entity','relation','episode']};
const revision = {expectedRevision:version};
const idem = {idempotencyKey:key};
const common = {
  campaignId:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,64}$'},
  worldlineId:{type:'string',pattern:'^wl-[a-zA-Z0-9_-]{1,64}$'}
};

const scope = ['campaignId','worldlineId'];
const rows = {type:'array',items:obj};
function initializeRng(repo,input) {
  const snapshot=repo.read(input.campaignId,input.worldlineId);
  if (snapshot.state.rng!==null) return fail('rng_already_initialized','随机流已经初始化');
  if (snapshot.state.revision!==input.expectedRevision) return fail('revision_conflict','状态 revision 不一致，当前 '+snapshot.state.revision);
  const [seed]=crypto.getRandomValues(new Uint32Array(1));
  snapshot.state.rng={algorithm:'mulberry32',seed,cursor:0};
  snapshot.state.revision+=1;
  snapshot.state.updatedAt=input.at;
  repo.write(input.campaignId,input.worldlineId,snapshot);
  return ok({rng:snapshot.state.rng,revision:snapshot.state.revision});
}

const definitions = {
  vault_stats:['读取部署版本、物理分片及迁移状态。',{},[]],
  vault_compact:['检查可安全回收的分片。',{dryRun:bool},[]],
  vault_migrate:['校验旧库哈希并迁移到 V2。',{expectedHash:str,expectedVersion:int,dryRun:bool},['expectedHash','expectedVersion'],true],
  qa_create:['创建隔离合成 QA Campaign。',{},scope,true],
  archive_export:['所有者全库备份，省略 cursor 返回清单，从 0 开始分页获取 base64 和 SHA-256。',{cursor:int},[]],
  runtime_init: ['显式创建新随机流，持久化种子和 cursor=0。没有检定。',{...revision,...idem},[...scope,'expectedRevision','idempotencyKey'],initializeRng],
  campaign_list: ['列出正式及 DEMO Campaign 与当前世界线。', {}, []],
  campaign_import: ['导入四份 SAVE-481 GitHub 原始 blob。默认只检查；dryRun=false 正式迁移。', {sources:obj,dryRun:bool}, [...scope,'sources'], importCampaign],
  event_commit: ['原子归档关键事件。明确指定 Campaign、世界线、revision、事件 ID 和幂等键。',
    {...revision,...idem,eventId:key,statePatch:obj,episodes:rows,entities:rows,relations:rows,pendingEvents:rows,runtimeReceipt:{type:['object','null']}},
    [...scope,'eventId','expectedRevision','idempotencyKey'],commitEvent],
  event_receipt: ['按事件 ID、幂等键或回执 ID 查询世界线归档回执。', {lookup:key}, [...scope,'lookup']],
  session_bootstrap: ['恢复当前存档、诺娅人格和视角记忆。', { ...view,maxChars:{type:'integer',minimum:1000,maximum:20000} }, []],
  persona_load: ['读取诺娅的人格档案及独立人格记忆。', {}, []],
  state_read: ['读取权威状态和 revision。指定 section 读取由当前状态投影的业务分片。', {section:str,entityId:str,fields:{type:'array',items:str},cursor:int,limit:{...int,minimum:1,maximum:100}}, []],
  state_commit: ['用 expectedRevision 原子提交状态，必须读取回执。', {...revision,...idem,changes:obj,resolution:{type:'string',enum:['state-authoritative','memory-authoritative']},reason:str}, ['expectedRevision','changes','idempotencyKey'], ops.commitState],
  memory_recall: ['按世界线、角色认知及时间检索记忆，返回来源。',{...view,query:str,cursor:int,limit:{type:'integer',minimum:1,maximum:100}},['query']],
  memory_traverse: ['检索当前视角可见的 1–4 跳关系子图。',{...view,start:str,hops:{type:'integer',minimum:1,maximum:4}},['start']],
  memory_record: ['记录实体、关系或情景。请提供来源事件 ID。',{...idem,kind,data:obj},['kind','data','idempotencyKey'],ops.recordMemory],
  memory_revise: ['修正记忆。关系使用自身 revision，实体与情景使用 memoryRevision。',{...revision,...idem,kind,id:str,patch:obj},['kind','id','patch','expectedRevision','idempotencyKey'],ops.reviseMemory],
  runtime_execute: ['执行一项 Mulberry32 检定，原子推进 RNG cursor。',{...idem,skill:{type:'number',minimum:-1000,maximum:1000},difficulty:{type:'number',minimum:-1000,maximum:1000}},['skill','difficulty','idempotencyKey'],ops.executeRoll],
  save_checkpoint: ['持久化权威状态、图谱、工作记忆及 RNG 快照。',{...idem,label:str},['label','idempotencyKey'],ops.checkpoint]
};

export const tools = Object.entries(definitions).map(([name,[description,properties,required,execute]]) => ({
  name,description,inputSchema:{type:'object',properties:{...common,...properties},required,additionalProperties:false},
  annotations:{readOnlyHint:!execute,idempotentHint:true,destructiveHint:Boolean(execute && ['campaign_import','event_commit','state_commit','memory_revise'].includes(name)),openWorldHint:false}
}));
// 用统一声明式注册表覆盖共享工具的 Schema；平台专属工具仍可独立定义。
for (const reg of registryFor('sites')) {
  for (const name of reg.aliases) {
    const entry=definitions[name];
    if (entry) { entry[1]=reg.schema; if (reg.required?.length) entry[2]=reg.required; }
    else definitions[name]=[reg.description,reg.schema,reg.required ?? [],null];
  }
}

const toolByName = new Map(tools.map(tool => [tool.name,tool]));

export function verifyToolArguments(name,raw) {
  if (registryFor('sites').some(reg => reg.aliases.includes(name) || reg.canonical === name)) {
    const checked=validateRegistryArgs(name,raw);
    return checked.ok ? null : {ok:false,code:checked.code,message:checked.message,details:checked.details};
  }
  const schema=toolByName.get(name)?.inputSchema;
  if (!schema) return fail('unknown_tool','未知工具');
  if (!isObject(raw)) return fail('invalid_arguments','参数必须为对象');
  const errors=validateSchema(raw,schema);
  if (errors.length || Object.values(raw).some(v=>typeof v==='string' && v.length>4000)) {
    return fail('invalid_arguments','参数校验失败',errors);
  }
  return null;
}

function compactRealm(realm) {
  if (!isObject(realm)) return realm;
  const {stage,stars,exp,exp_required}=realm;
  return {stage,stars,exp,exp_required};
}

function perspective(repo,input) {
  const result = new VaultRepository({campaigns:{[input.campaignId]:{manifest:repo.document.campaigns[input.campaignId].manifest,lines:{}}}});
  const snapshot = repo.read(input.campaignId,input.worldlineId);
  const ctx = {...input, asOf:input.asOf ?? (input.gm ? '9999-12-31T23:59:59.999Z' : new Date().toISOString())};
  const hidden = new Set(snapshot.entities.filter(row => !entityVisible(row,ctx)).map(row => row.id));
  snapshot.entities = snapshot.entities.filter(row => !hidden.has(row.id));
  snapshot.relations = snapshot.relations.filter(row => relationVisible(row,ctx) && !hidden.has(row.subject) && !hidden.has(row.object));
  const visibleRelations = new Set(snapshot.relations.map(row => row.id));
  snapshot.episodes = snapshot.episodes.filter(row => episodeVisible(row,ctx) && (!input.asOf || row.at <= input.asOf))
    .map(row => ({...row,entities:row.entities.filter(id=>!hidden.has(id)),relationIds:row.relationIds.filter(id=>visibleRelations.has(id))}));
  result.write(input.campaignId,input.worldlineId,snapshot);
  return { repo:result, snapshot, hidden };
}

export function runTool(document,name,raw,actor,{allowGM=false,archiveManifest=null}={}) {
  const invalid=verifyToolArguments(name,raw);
  if (invalid) return {value:invalid};
  if (name==='archive_export' || (name==='state_read' && /^archive_export\.(manifest|[0-9]+)$/.test(raw.section ?? ''))) {
    if (!allowGM) return {value:fail('forbidden','导出需要所有者权限')};
    const page=name==='archive_export'?raw.cursor:raw.section.split('.')[1];
    return exportPage(archiveManifest ? {format:'noa-sites-v2',manifest:archiveManifest,document} : document,page==='manifest'||page===undefined?undefined:Number(page));
  }
  const writes = Boolean(definitions[name][3]);
  if (writes && (!raw.campaignId || !raw.worldlineId)) return {value:fail('explicit_scope_required','写入必须明确指定 Campaign 和世界线')};
  if (name === 'campaign_list') return {value:ok({active:document.active,campaigns:Object.values(document.campaigns).map(entry=>({
    id:entry.manifest.id,title:entry.manifest.title,status:entry.manifest.status,worldlines:Object.keys(entry.lines)
  }))})};
  if (name === 'campaign_import') return importCampaign(document,raw,actor);
  if (name === 'event_receipt') return eventReceipt(document,raw);
  const requestedCampaign = raw.campaignId ?? document.active.campaignId;
  const entry = own(document.campaigns,requestedCampaign);
  const input = {campaignId:requestedCampaign,
    worldlineId: requestedCampaign===document.active.campaignId ? document.active.worldlineId : entry?.manifest.worldlineId,
    ...raw,actor};
  const personaProfile = own(document.campaignPersonas ?? {},requestedCampaign) ?? document.persona;
  const repo = new VaultRepository(document);
  if (name === 'persona_load') return {value:ok(personaProfile)};
  const state = repo.read(input.campaignId,input.worldlineId);
  const playerViewer=state.working.playerViewer ?? 'person.player';
  if (raw.viewer==='gm' && !allowGM) return {value:fail('gm_forbidden','该身份没有 GM 召回权限')};
  const gm=allowGM && (raw.viewer==='gm' || (name==='session_bootstrap' && raw.viewer===undefined && state.manifest.worldId==='doupo'));
  input.viewer=gm ? 'gm' : raw.viewer ?? playerViewer;
  if (gm) { input.gm=true; input.includeBeliefs=raw.includeBeliefs ?? true; }
  if (raw.asOf && !Number.isFinite(Date.parse(raw.asOf))) return {value:fail('invalid_as_of','asOf 必须为有效时间')};
  if (raw.asOf) input.asOf=new Date(raw.asOf).toISOString();
  if (name==='event_commit') return commitEvent(document,repo,input);
  if (state.manifest.worldId==='doupo' && name==='memory_record') {
    return {value:fail('event_commit_required','正式存档关键事件请使用 event_commit 一次提交')};
  }
  if (name === 'state_read') {
    const {extension,...core}=state.state;
    const formal=state.manifest.worldId==='doupo';
    core.clock=formal?relativeClock(state.state):core.clock;
    const business=formal?projectBusiness(state.state):extension ?? {};
    const sectionNames=['clock','manifest','pendingEvents','pendingHistory','settlementLedger','scene','party',...Object.keys(business)];
    const meta={campaignId:input.campaignId,worldlineId:input.worldlineId,revision:core.revision,
      memoryRevision:state.working.memoryRevision ?? 0,source:state.manifest.paths.state};
    if (!input.section) return {value:ok({...meta,state:formal?{...core,actors:{xiao_yan:{realm:compactRealm(core.actors.xiao_yan?.realm)}},inventory:undefined}:state.state,
      sections:sectionNames,pendingCount:state.working.pendingEvents?.length ?? 0})};
    const [sectionName,pathId,...rest]=input.section.split('/');
    if (rest.length || (input.entityId && pathId && input.entityId!==pathId)) return {value:fail('invalid_section','业务对象路径不一致')};
    const entityId=input.entityId ?? pathId;
    const special={settlementLedger:business.economy?.settlementLedger ?? {},clock:core.clock,manifest:{campaign:state.manifest,storage:archiveManifest},
      pendingEvents:pendingForRead(state.working),pendingHistory:state.working.legacyPendingRecords ?? [],scene:state.working.scene,party:state.working.party};
    let data=own(special,sectionName) ?? own(business,sectionName);
    if (entityId) {
      const rows=sectionName==='research'?data?.projects:data;
      data=Array.isArray(rows)?rows.find(row=>[row.id,row.name,row.stable_id].includes(entityId))
        : rows && typeof rows==='object'?own(rows,entityId):undefined;
    } else if (sectionName==='research' && data?.projects) {
      data={...data,projects:Object.entries(data.projects).map(([key,row])=>({
        id:row.id ?? key,name:row.name,status:row.status,sourceEventId:row.sourceEventId
      }))};
    }
    if (data===undefined) return {value:fail('section_not_found','业务分片或对象不存在')};
    if (input.fields?.length) {
      const select=row=>isObject(row)?Object.fromEntries(input.fields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])):row;
      data=Array.isArray(data)?data.map(select):select(data);
    }
    let nextCursor=null;
    const offset=input.cursor??0, limit=input.limit??25;
    const rows=Array.isArray(data)?data:sectionName==='research'&&!entityId?data.projects:null;
    if (rows) {
      nextCursor=offset+limit<rows.length?offset+limit:null;
      const page=rows.slice(offset,offset+limit);
      data=Array.isArray(data)?page:{...data,projects:page};
    }
    return {value:ok({...meta,section:data,nextCursor})};
  }
  if (name === 'memory_recall' || name === 'memory_traverse' || name === 'session_bootstrap') {
    const visible = perspective(repo,input);
    if (name === 'memory_recall') {
      const offset=input.cursor??0, limit=input.limit??12;
      const result=ops.recall(visible.repo,{...input,limit:offset+limit+1});
      const total=result.data.hits.length;
      result.data.hits=result.data.hits.slice(offset,offset+limit);
      result.data.nextCursor=offset+limit<total?offset+limit:null;
      const episodes=new Map(visible.snapshot.episodes.map(ep=>[ep.id,ep]));
      for (const hit of result.data.hits) {
        const ep=episodes.get(hit.id);
        if (ep) { hit.source=episodeSource(state,ep); hit.meta.sourceEventId=ep.sourceEventId; }
        const relation=hit.kind==='relation' && visible.snapshot.relations.find(row=>row.id===hit.id);
        if (relation) hit.meta.sourceEventId=relation.sourceEventId;
      }
      return {value:result};
    }
    if (name === 'memory_traverse') {
      if (visible.hidden.has(input.start)) return {value:fail('not_found','该视角无法访问此实体')};
      const result = ops.traverse(visible.repo,input);
      const uniqueEdges = [...new Map(result.data.edges.map(edge=>[edge.id,edge])).values()];
      return {value:ok({...result.data,edges:uniqueEdges,source:state.manifest.paths.relations,worldlineId:input.worldlineId,viewer:input.viewer})};
    }
    const recent = visible.snapshot.episodes.slice().sort((a,b)=>b.at.localeCompare(a.at) || b.turn-a.turn);
    const privileged=gm || input.viewer===playerViewer;
    const clock=state.manifest.worldId==='doupo'?relativeClock(state.state):state.state.clock;
    const summary={revision:state.state.revision,clock,
      ...(privileged?{rng:state.state.rng,scene:state.working.scene,resources:state.state.resources,
        playerRealm:compactRealm(state.state.actors.xiao_yan?.realm)}: {})};
    const data={mode:'sites-mcp',campaignId:input.campaignId,worldlineId:input.worldlineId,viewer:input.viewer,state:summary,
      persona:privileged?{id:personaProfile.id,version:personaProfile.version,tool:'persona_load'}:undefined,
      persistenceProtocol:privileged?{version:gmProtocol.version,tool:gmProtocol.tool}:undefined,memory:[]};
    const budget=input.maxChars ?? 6000;
    const size=()=>new TextEncoder().encode(JSON.stringify(ok(data))).length;
    const add=(key,value)=>{ data[key]=value; if(size()>budget) delete data[key]; };
    if (size()>budget) {
      delete summary.playerRealm;
      delete summary.resources;
    }
    if (size()>budget && typeof summary.scene==='string') summary.scene=summary.scene.slice(0,80);
    const appendMemory=episodes=>{
      for(const episode of episodes) {
        const item={id:episode.id,title:episode.title,summary:episode.summary.slice(0,budget<=1500?36:280),sourceEventId:episode.sourceEventId};
        data.memory.push(item);
        if(size()>budget) data.memory.pop();
      }
    };
    appendMemory(recent.slice(0,2));
    if (privileged) {
      add('party',state.working.party?.members?.map(({name,role,realm})=>({name,role,realm})));
      add('activeTasks',state.working.pendingEvents?.slice(0,8).map(({id,status})=>({id,status})));
      add('queries',{memory:'memory_recall',world:'state_read',sections:['clock','scene','party','research','economy','pendingEvents']});
      add('gmRules',gmProtocol.rules);
    }
    appendMemory(recent.slice(2,8));
    if (size()>budget) return {value:ok({campaignId:input.campaignId,worldlineId:input.worldlineId,revision:state.state.revision,truncated:true})};
    return {value:ok(data)};
  }

  const receiptKey = [input.campaignId,input.worldlineId,input.idempotencyKey].join(':');
  const fingerprint = sha256({name, ...input});
  const prior = own(document.receipts,receiptKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return {value:fail('idempotency_conflict','这个幂等键已用于不同请求')};
    return {value:ok({...prior.result,receipt:{...prior.receipt,duplicate:true}})};
  }
  if (name === 'state_commit' && Object.hasOwn(input.changes,'rngCursor')) {
    return {value:fail('invalid_change','RNG cursor 仅能由 runtime_execute 推进')};
  }
  const at = new Date().toISOString();
  const id = newId('req',receiptKey);
  // The upstream repository cache uses an internal key to avoid collisions with user keys or roll prefixes.
  if (name==='runtime_execute' && state.state.rng===null) {
    const [seed] = crypto.getRandomValues(new Uint32Array(1));
    state.state.rng={algorithm:'mulberry32',seed,cursor:0};
    repo.write(input.campaignId,input.worldlineId,state);
  }
  const normalized=name==='state_commit'?{changes:normalizePatch(state.state,input.changes)}:{};
  const result = definitions[name][3](repo,{...input,...normalized,at,idempotencyKey:id,id:newId('cp',receiptKey),...(name === 'memory_revise' ? {id:input.id} : {})});
  if (!result.ok) return {value:result};
  const current = repo.read(input.campaignId,input.worldlineId);
  validateSnapshot(current,input.campaignId,input.worldlineId);
  const receipt = {
    id,op:name,status:'applied',at,actor,idempotencyKey:input.idempotencyKey,
    campaignId:input.campaignId,worldlineId:input.worldlineId,appliedRevision:current.state.revision,
    memoryRevision:current.working.memoryRevision ?? 0,hash:sha256(result.data)
  };
  repo.appendEvent(input.campaignId,{...receipt,id:newId('evt',id),requestId:id});
  document.receipts[receiptKey] = {fingerprint,receipt,result:result.data};
  return {write:true,value:ok({...result.data,receipt})};
}
