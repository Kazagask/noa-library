import seed from './seed.json' with { type: 'json' };
import { sha256, validateSchema, isObject } from './upstream/util.ts';
import manifestSchema from './schemas/manifest.schema.json' with { type: 'json' };
import stateSchema from './schemas/state.schema.json' with { type: 'json' };
import entitySchema from './schemas/entity.schema.json' with { type: 'json' };
import relationSchema from './schemas/relation.schema.json' with { type: 'json' };
import episodeSchema from './schemas/episode.schema.json' with { type: 'json' };

export class VaultError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
export const copied = structuredClone;
export const campaignIdValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export const worldlineIdValid = id => typeof id === 'string' && /^wl-[a-zA-Z0-9_-]{1,64}$/.test(id);

export function initialVault() {
  return copied({
    format: 'noa-sites-v1',
    active: { campaignId:'demo', worldlineId:'wl-main' },
    persona: seed.persona,
    campaigns: { demo: { manifest: seed.snapshot.manifest, lines: { 'wl-main': seed.snapshot } } },
    checkpoints: {}, operations: {}, receipts: {}, events: seed.events.map(event => ({ campaignId:'demo', ...event }))
  });
}

export class VaultRepository {
  constructor(document) { this.document = document; }
  read(campaign, worldline) {
    const entry = own(this.document.campaigns, campaign);
    const snapshot = entry && own(entry.lines, worldline);
    if (!snapshot) throw new VaultError('worldline_not_found','Campaign 或世界线不存在',404);
    return copied({ ...snapshot, manifest:entry.manifest });
  }
  write(campaign, worldline, snapshot) {
    this.document.campaigns[campaign].lines[worldline] = copied(snapshot);
  }
  appendEvent(campaign, event) { this.document.events.push({ campaignId:campaign, ...event }); }
  getOperation(key) { return own(this.document.operations, key) ?? null; }
  putOperation(key,value) { this.document.operations[key] = copied(value); }
  saveCheckpoint(campaign, value) {
    const key = campaign + ':' + value.id;
    if (own(this.document.checkpoints,key)) throw new VaultError('checkpoint_exists','快照已存在',409);
    this.document.checkpoints[key] = copied(value);
  }
  loadCheckpoint(campaign,id) { return own(this.document.checkpoints,campaign + ':' + id) ?? null; }
  listCheckpoints(campaign) { return Object.values(this.document.checkpoints).filter(cp => cp.campaignId === campaign); }
  listWorldlines(campaign) { return Object.keys(own(this.document.campaigns,campaign)?.lines ?? {}); }
  createWorldline(campaign,_from,to,snapshot) { this.write(campaign,to,snapshot); }
  listCampaigns() { return Object.values(this.document.campaigns).map(({manifest}) => manifest); }
}

export async function openVault(db, owner) {
  let row = await db.prepare('SELECT version,document FROM noa_vault WHERE owner_id=?').bind(owner).first();
  if (!row) {
    await db.prepare('INSERT INTO noa_vault(owner_id,version,document) VALUES(?,0,?) ON CONFLICT(owner_id) DO NOTHING').bind(owner,JSON.stringify(initialVault())).run();
    row = await db.prepare('SELECT version,document FROM noa_vault WHERE owner_id=?').bind(owner).first();
  }
  return { version:row.version, document:JSON.parse(row.document) };
}

export async function transact(db,owner,action) {
  const pointer=await db.prepare('SELECT target FROM noa_authority_pointer WHERE owner_id=?').bind(owner).first();
  const v3=pointer?.target==='v2'?null:await db.prepare('SELECT 1 AS active FROM noa_v3_head WHERE owner_id=?').bind(owner).first();
  if (v3) throw new VaultError('authority_v3_active','V3 已激活或迁移中，V2 禁止业务写入',409);
  for (let attempt = 0; attempt < 5; attempt++) {
    const {version,document} = await openVault(db,owner);
    const outcome = await action(document,version);
    if (!outcome.write) return outcome.value;
    const serialized = JSON.stringify(outcome.document ?? document);
    if (new TextEncoder().encode(serialized).length > 1_500_000) {
      throw new VaultError('vault_capacity','已达到单档案 1.5 MB 上限，请先导出备份',413);
    }
    // State, receipts, checkpoints, and audit events share one atomic SQL write.
    const result = await db.prepare('UPDATE noa_vault SET version=version+1,document=? WHERE owner_id=? AND version=?')
      .bind(serialized,owner,version).run();
    if (result.meta.changes === 1) return outcome.value;
  }
  throw new VaultError('concurrent_write','并发写入过多，请使用原幂等键重试',409);
}

function check(value,schema) {
  const errors = validateSchema(value,schema);
  if (errors.length) throw new VaultError('schema_invalid',errors.slice(0,6).join('；'));
}
function requireData(condition,message) {
  if (!condition) throw new VaultError('invalid_import',message);
}
export function validateSnapshot(snapshot,campaign,worldline) {
  requireData(isObject(snapshot) && isObject(snapshot.working),'快照缺少 working 数据');
  check(snapshot.manifest,manifestSchema);
  if (snapshot.manifest.worldId==='doupo') {
    const {clock,rng}=snapshot.state;
    requireData(isObject(clock) && ['turn','date','period'].every(key=>Object.hasOwn(clock,key)) && Object.keys(clock).every(key=>['turn','date','period','elapsedMinutes','anchor'].includes(key)) && (clock.elapsedMinutes==null || (Number.isSafeInteger(clock.elapsedMinutes) && clock.elapsedMinutes>=0)) && (clock.anchor==null || (typeof clock.anchor==='string' && clock.anchor.trim().length>0)), '时钟字段缺失');
    check({...snapshot.state,clock:{turn:clock.turn ?? 0,date:clock.date ?? '',period:clock.period ?? 'day'},
      rng:rng===null?{algorithm:'mulberry32',seed:0,cursor:0}:rng},stateSchema);
  } else check(snapshot.state,stateSchema);
  requireData(campaignIdValid(campaign) && worldlineIdValid(worldline)
    && snapshot.manifest.id === campaign && snapshot.state.worldlineId === worldline
    && snapshot.state.worldId === snapshot.manifest.worldId
    && (!snapshot.working.worldlineId || snapshot.working.worldlineId === worldline),'存档或世界线标识不一致');
  requireData(Number.isSafeInteger(snapshot.state.revision) && (snapshot.state.rng===null || Number.isSafeInteger(snapshot.state.rng.cursor)),'状态 revision 或 RNG cursor 无效');
  for (const [list,schema] of [[snapshot.entities,entitySchema],[snapshot.relations,relationSchema],[snapshot.episodes,episodeSchema]]) {
    requireData(Array.isArray(list),'快照缺少图谱数组');
    const ids = new Set();
    for (const row of list) {
      check(row,schema);
      requireData(row.worldlineId === worldline && !ids.has(row.id),'图谱存在重复 ID 或跨世界线记录');
      requireData(row.epistemic !== 'belief' || (typeof row.holder === 'string' && row.holder),'主观认知缺少 holder');
      ids.add(row.id);
    }
  }
}
export function validatePersona(persona) {
  requireData(isObject(persona) && persona.id === seed.persona.id
    && persona.namespace === 'noa/persona-relationship'
    && isObject(persona.parts) && isObject(persona.memory)
    && (typeof persona.version === 'string' || Number.isInteger(persona.version)),'人格档案格式或命名空间无效');
}
export function validateCheckpoint(cp,campaign) {
  requireData(isObject(cp) && cp.campaignId === campaign && /^cp-[a-zA-Z0-9_-]+$/.test(cp.id),'快照标识无效');
  validateSnapshot(cp.snapshot,campaign,cp.worldlineId);
  const {state,entities,relations,episodes,working} = cp.snapshot;
  requireData(cp.stateHash === sha256(state) && cp.memoryHash === sha256({entities,relations,episodes,working}),'快照哈希不匹配');
}
export function validateVault(vault) {
  requireData(isObject(vault) && vault.format === 'noa-sites-v1' && isObject(vault.campaigns)
    && isObject(vault.active) && isObject(vault.checkpoints) && isObject(vault.operations)
    && isObject(vault.receipts) && Array.isArray(vault.events),'备份格式无效');
  validatePersona(vault.persona);
  for (const [campaign,{manifest,lines}] of Object.entries(vault.campaigns)) {
    check(manifest,manifestSchema);
    requireData(isObject(lines) && own(lines,manifest.worldlineId),'缺少默认世界线');
    for (const [worldline,snapshot] of Object.entries(lines)) {
      validateSnapshot(snapshot,campaign,worldline);
      requireData(sha256(manifest) === sha256(snapshot.manifest),'Campaign manifest 不一致');
    }
  }
  new VaultRepository(vault).read(vault.active.campaignId,vault.active.worldlineId);
  for (const [key,cp] of Object.entries(vault.checkpoints)) {
    validateCheckpoint(cp,cp?.campaignId);
    requireData(key === cp.campaignId + ':' + cp.id
      && own(vault.campaigns,cp.campaignId) && own(vault.campaigns[cp.campaignId].lines,cp.worldlineId),'快照归属无效');
  }
}
