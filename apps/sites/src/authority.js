import { own, VaultError } from './vault.js';
import { isObject } from './upstream/util.ts';

export const businessSections = ['character','cultivation','research','economy','industries','skills','relationships','contracts','properties','chat_group','timeline','inventory','unresolved','quests'];
const businessObjects = new Set(['character','cultivation','research','economy','chat_group','timeline','inventory']);
const systemFields = new Set(['actors','resources','flags','clock','inventory','quests','extension']);
const archived = new Set(['sourceState','sourceRevision','provenance','historicalAudit','locationEvidence','plans']);
export function mergeFields(current,patch) {
  if (!isObject(current) || !isObject(patch)) return patch;
  return {...current,...Object.fromEntries(Object.entries(patch).map(([key,value])=>[
    key,mergeFields(own(current,key),value)
  ]))};
}

export function relativeClock(state) {
  const timeline = state.extension?.sourceState?.timeline;
  const elapsed = state.clock.elapsedMinutes ?? state.extension?.business?.timeline?.elapsed_minutes_since_save_464
    ?? state.extension?.timeline?.elapsed_minutes_since_save_464 ?? timeline?.elapsed_minutes_since_save_464 ?? null;
  return {...state.clock,elapsedMinutes:elapsed,anchor:state.clock.anchor ?? (timeline ? 'SAVE-464' : null)};
}

function indexRows(rows) {
  if (Array.isArray(rows)) return Object.fromEntries(rows.filter(row=>typeof row?.id==='string').map(row=>[row.id,row]));
  return isObject(rows)?rows:{};
}

function updateById(current,patch,path) {
  if (!isObject(patch)) invalid(path,'请用稳定 ID 对象提交业务更新');
  for (const [id,value] of Object.entries(patch)) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !isObject(value) || (value.id!==undefined && value.id!==id)) invalid(path+'.'+id);
  }
  return mergeFields(current,Object.fromEntries(Object.entries(patch).map(([id,value])=>[id,{...value,id}])));
}

function industryClock(row,clock) {
  if (!Number.isSafeInteger(row.next_due_elapsed_minutes) || !Number.isSafeInteger(clock.elapsedMinutes)) return row;
  if (row.clock_anchor!==undefined && row.clock_anchor!==clock.anchor) return row;
  const remaining=Math.max(0,row.next_due_elapsed_minutes-clock.elapsedMinutes);
  return {...row,remaining_minutes:remaining,next_settlement_days:remaining/1440,pending_settlement:remaining===0};
}

export function projectBusiness(state) {
  const ext = state.extension ?? {};
  const base = ext.sourceState ?? {};
  const projected = Object.fromEntries(businessSections.filter(key=>own(base,key)!==undefined).map(key=>[key,base[key]]));
  for (const key of businessSections) {
    if (own(ext,key)!==undefined) projected[key]=mergeFields(projected[key],ext[key]);
    if (own(ext.business ?? {},key)!==undefined) projected[key]=mergeFields(projected[key],ext.business[key]);
  }
  const character = own(state.actors,'xiao_yan');
  projected.character=mergeFields(projected.character ?? {},character ?? {});
  projected.cultivation={...projected.cultivation,...(character?.main_art ? {main_art:character.main_art} : {})};
  projected.economy={...projected.economy,cash_g:state.resources.gold ?? projected.economy?.cash_g};
  if (projected.industries!==undefined) projected.economy.industries=projected.industries;
  const clock=relativeClock(state);
  const industries=indexRows(projected.economy.industries ?? []);
  const industryIndex=mergeFields(industries,projected.economy.industriesById ?? {});
  const unkeyed=Array.isArray(projected.economy.industries)?projected.economy.industries.filter(row=>typeof row?.id!=='string'):[];
  projected.industries=[...Object.values(industryIndex),...unkeyed].map(row=>industryClock(row,clock));
  projected.economy.industries=projected.industries;
  delete projected.economy.industriesById;
  if (Array.isArray(projected.relationships) && state.actors.MEDUSA) {
    projected.relationships=projected.relationships.map(row=>row.stable_id==='MEDUSA' || row.contract_id==='MEDUSA'
      ? mergeFields(row,state.actors.MEDUSA) : row);
  }
  projected.inventory={...projected.inventory,current_confirmed:state.inventory};
  projected.timeline={...projected.timeline,current_game_date:clock.date,elapsed_minutes_since_save_464:clock.elapsedMinutes};
  projected.quests=state.quests;
  return projected;
}

function invalid(field,message='不支持的状态字段') {
  throw new VaultError('unsupported_state_field',message+'：'+field);
}
function assertShape(key,value) {
  if (businessObjects.has(key) ? !isObject(value) : !Array.isArray(value)) invalid(key,'无效的业务分片结构');
}

export function normalizePatch(state,patch) {
  if (state.worldId!=='doupo') {
    for (const key of Object.keys(patch)) if (!systemFields.has(key)) invalid(key);
    return Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,mergeFields(own(state,key),value)]));
  }
  const core={}, business={};
  const record=(key,value)=>{
    if (!businessSections.includes(key)) invalid('business.'+key);
    assertShape(key,value);
    business[key]=mergeFields(own(business,key),value);
  };
  for (const [key,value] of Object.entries(patch)) {
    if (key==='business' || key==='extension') {
      if (!isObject(value)) invalid(key,'业务分片必须为对象');
      for (const [section,update] of Object.entries(value)) {
        if (archived.has(section)) invalid(key+'.'+section,'原始导入档案不可变');
        if (key==='extension' && section==='business') {
          if (!isObject(update)) invalid('extension.business');
          for (const [name,data] of Object.entries(update)) record(name,data);
        } else record(section,update);
      }
    } else if (systemFields.has(key)) {
      core[key]=value;
    } else record(key,value);
  }
  const setCore=(key,value)=>{ core[key]=mergeFields(core[key] ?? {},value); };
  if (business.character && Object.keys(business.character).length) setCore('actors',{xiao_yan:business.character});
  if (business.cultivation && Object.hasOwn(business.cultivation,'main_art')) {
    if (!isObject(business.cultivation.main_art)) invalid('cultivation.main_art','功法必须为对象');
    setCore('actors',{xiao_yan:{main_art:business.cultivation.main_art}});
  }
  if (business.economy && Object.hasOwn(business.economy,'cash_g')) setCore('resources',{gold:business.economy.cash_g});
  if (business.inventory && Object.hasOwn(business.inventory,'current_confirmed')) core.inventory=business.inventory.current_confirmed;
  if (business.quests) core.quests=business.quests;
  if (business.relationships) {
    const medusa=business.relationships.find(row=>isObject(row) && (row.stable_id==='MEDUSA' || row.contract_id==='MEDUSA'));
    if (medusa) setCore('actors',{MEDUSA:medusa});
  }
  if (business.research && Object.hasOwn(business.research,'projects')) {
    const projects=business.research.projects;
    if (!isObject(projects) && !Array.isArray(projects)) invalid('research.projects');
    if (Array.isArray(projects) && (projects.some(row=>!isObject(row) || typeof row.id!=='string')
      || new Set(projects.map(row=>row.id)).size!==projects.length)) invalid('research.projects','项目必须具有唯一稳定 ID');
    business.research.projects=updateById(indexRows(projectBusiness(state).research?.projects),indexRows(projects),'research.projects');
  }
  if (business.economy && Object.hasOwn(business.economy,'industriesById')) {
    if (business.industries || Object.hasOwn(business.economy,'industries')) invalid('economy.industriesById','同一事务不能混用产业列表与按 ID 更新');
    const previous=projectBusiness(state).industries;
    const updated=updateById(indexRows(previous),business.economy.industriesById,'economy.industriesById');
    for (const [id,row] of Object.entries(business.economy.industriesById)) {
      if (Object.hasOwn(row,'next_due_elapsed_minutes') && (!Number.isSafeInteger(row.next_due_elapsed_minutes)
        || row.next_due_elapsed_minutes<0)) invalid('economy.industriesById.'+id+'.next_due_elapsed_minutes');
      if (Object.hasOwn(row,'clock_anchor') && (typeof row.clock_anchor!=='string' || !row.clock_anchor.trim())) invalid('economy.industriesById.'+id+'.clock_anchor');
    }
    business.industries=[...Object.values(updated),...previous.filter(row=>typeof row?.id!=='string')];
    business.economy.industries=business.industries;
    delete business.economy.industriesById;
  }
  if (business.economy && Object.hasOwn(business.economy,'settlementLedger')) {
    const previous=projectBusiness(state).economy.settlementLedger ?? {};
    const next=business.economy.settlementLedger;
    if (!isObject(next)) invalid('economy.settlementLedger');
    for (const id of Object.keys(next)) if (Object.hasOwn(previous,id)) {
      throw new VaultError('settlement_already_booked','批次已经入账：'+id,409);
    }
    business.economy.settlementLedger=updateById(previous,next,'economy.settlementLedger');
  }
  if (business.economy && Object.hasOwn(business.economy,'industries')) {
    if (!Array.isArray(business.economy.industries)) invalid('economy.industries','产业必须为数组');
    business.industries=business.economy.industries;
  }
  if (business.timeline && ['elapsed_minutes_since_save_464','current_game_date'].some(key=>Object.hasOwn(business.timeline,key))) {
    invalid('timeline','通过 clock 更新游戏时钟');
  }
  if (core.clock!==undefined) {
    if (!isObject(core.clock)) invalid('clock');
    const previous=relativeClock(state);
    const {advanceMinutes,...clockPatch}=core.clock;
    for (const field of Object.keys(clockPatch)) if (!['turn','date','period','elapsedMinutes','anchor'].includes(field)) invalid('clock.'+field);
    if (Object.hasOwn(clockPatch,'elapsedMinutes') && (!Number.isSafeInteger(clockPatch.elapsedMinutes) || clockPatch.elapsedMinutes<0)) invalid('clock.elapsedMinutes');
    if (Object.hasOwn(clockPatch,'anchor') && (typeof clockPatch.anchor!=='string' || !clockPatch.anchor.trim())) invalid('clock.anchor');
    if (Object.hasOwn(clockPatch,'date') && clockPatch.date!==null && typeof clockPatch.date!=='string') invalid('clock.date');
    const reanchored=clockPatch.anchor!==undefined && clockPatch.anchor!==previous.anchor;
    if (reanchored && !Object.hasOwn(clockPatch,'elapsedMinutes')) invalid('clock.anchor','更换基准必须明确指定 elapsedMinutes');
    if (!reanchored && Number.isSafeInteger(previous.elapsedMinutes) && clockPatch.elapsedMinutes<previous.elapsedMinutes) invalid('clock.elapsedMinutes','同一基准上的时钟不可回退');
    if (advanceMinutes!==undefined) {
      if (Object.hasOwn(clockPatch,'elapsedMinutes')) invalid('clock.advanceMinutes','不能同时指定增量和绝对相对分钟');
      if (!Number.isSafeInteger(advanceMinutes) || advanceMinutes<0 || !Number.isSafeInteger(previous.elapsedMinutes)
        || !Number.isSafeInteger(previous.elapsedMinutes+advanceMinutes)) {
        throw new VaultError('invalid_clock_advance','耗时必须为已确认的非负整数分钟，且相对基线已知');
      }
      clockPatch.elapsedMinutes=previous.elapsedMinutes+advanceMinutes;
    }
    core.clock={...previous,...clockPatch};
  }
  if (Object.keys(business).length) {
    core.extension={business:mergeFields(state.extension?.business ?? {},business)};
  }
  return Object.fromEntries(Object.entries(core).map(([key,value])=>[key,mergeFields(own(state,key),value)]));
}

export function pendingForRead(working) {
  return (working.pendingEvents ?? []).map(row=>row.id==='PENDING-SITES-MIGRATION' && row.status==='blocked'
    ? {...row,status:'resolved',resolution:'SAVE-481 已正式迁移，事件归档可用'} : row);
}

export function episodeSource(snapshot,episode) {
  if (episode.path?.startsWith('#')) return snapshot.manifest.paths.episodesIndex+episode.path;
  if (snapshot.manifest.worldId==='doupo' && episode.sourceEventId) {
    return 'events/'+encodeURIComponent(snapshot.manifest.id)+'/'+encodeURIComponent(snapshot.state.worldlineId)+'/'+encodeURIComponent(episode.sourceEventId);
  }
  return snapshot.manifest.paths.episodesDir+'/'+episode.path;
}
