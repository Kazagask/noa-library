import { hashText } from '../../../packages/core/shared.ts';
import { transact, VaultError } from './vault.js';

export { hashText };
const encode = JSON.stringify;
const collections = new Set(['events','receipts','operations','checkpoints','sourceArchives','campaignPersonas','repairReceipts','entities','relations','episodes','pendingEvents','legacyPendingRecords','projects','settlementLedger']);
const branch = path => {
  const leaf=path.at(-1);
  return !path.length || ['campaigns','lines','state','working','extension','business','research'].includes(leaf)
    || path.at(-2)==='campaigns' || path.at(-2)==='lines';
};

function flatten(document) {
  const rows = new Map();
  const store = (path,ordinal,value) => {
    const family=encode(path.slice(0,-1)),slot=path.at(-1) ?? '';
    const body=encode(value);
    let part=0;
    // 60k UTF-16 code units fit within 180k UTF-8 bytes. Keep pairs intact.
    for(let start=0;start<body.length;) {
      let end=Math.min(start+60000,body.length);
      if (end<body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end--;
      const piece=body.slice(start,end);
      const key=encode([family,slot,part]);
      rows.set(key,[family,slot,ordinal,part++,piece,hashText(piece)]);
      start=end;
    }
  };
  const visit=(value,path,ordinal)=>{
    if (value && typeof value==='object' && (branch(path) || collections.has(path.at(-1)))) {
      store(path,ordinal,[Array.isArray(value)?'list':'map']);
      Object.entries(value).forEach(([key,child],offset)=>visit(child,[...path,key],offset));
    } else store(path,ordinal,['value',value]);
  };
  visit(document,[],0);
  return rows;
}

function inflate(rows) {
  const nodes=new Map();
  for (const {family,slot,ordinal,part,body,digest} of rows) {
    const path=JSON.parse(family);
    if (slot) path.push(slot);
    const key=encode(path);
    if (!nodes.has(key)) nodes.set(key,{path,ordinal,parts:[]});
    const node=nodes.get(key);
    if (part!==node.parts.length || hashText(body)!==digest) throw new VaultError('shard_checksum','分片校验失败',500);
    node.parts.push(body);
  }
  const ordered=[...nodes.values()].sort((a,b)=>a.path.length-b.path.length || a.ordinal-b.ordinal);
  let root;
  const decoded=new Map();
  for (const {path,parts} of ordered) {
    const [kind,content]=JSON.parse(parts.join(''));
    const value=kind==='list'?[]:kind==='map'?{}:content;
    decoded.set(encode(path),value);
    if (!path.length) root=value;
    else {
      const parent=decoded.get(encode(path.slice(0,-1)));
      if (!parent || Object.hasOwn(parent,path.at(-1))) throw new VaultError('shard_structure','分片层次无效',500);
      Object.defineProperty(parent,path.at(-1),{value,enumerable:true,configurable:true,writable:true});
    }
  }
  return root;
}

const query = (db,sql,...values) => db.prepare(sql).bind(...values);
const head = (db,owner) => query(db,'SELECT epoch,version,migration FROM noa_head WHERE owner_id=?',owner).first();
const put = (db,owner,epoch,row) => query(db,`INSERT INTO noa_shard VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(owner_id,epoch,family,slot,part) DO UPDATE SET ordinal=excluded.ordinal,body=excluded.body,digest=excluded.digest`,owner,epoch,...row);
const select = `SELECT h.epoch,h.version,h.migration,s.family,s.slot,s.ordinal,s.part,s.body,s.digest
  FROM noa_head h JOIN noa_shard s USING(owner_id,epoch) WHERE h.owner_id=?`;
const sorted = ' ORDER BY family,slot,part';

export async function openV2(db,owner,readMode) {
  const excludedRoot = ['events','receipts','operations','checkpoints','sourceArchives','repairReceipts'];
  // Reads use a single consistent SQL snapshot and skip unrelated archive rows.
  const selection=readMode
    ? " AND (s.family<>'[]' OR s.slot NOT IN ('events','receipts','operations','checkpoints','sourceArchives','repairReceipts'))"
      + " AND coalesce(json_extract(s.family,'$[0]'),'') NOT IN ("+excludedRoot.map(()=>'?').join(',')+")"
      + (readMode==='state'
        ? " AND coalesce(json_extract(s.family,'$[4]'),'') NOT IN ('episodes','entities','relations') AND NOT (json_array_length(s.family)=4 AND s.slot IN ('episodes','entities','relations'))"
        : "")
      + (readMode==='pendingHistory'?'':" AND (s.slot<>'legacyPendingRecords' OR coalesce(json_extract(s.family,'$[4]'),'')<>'working')"
      + " AND coalesce(json_extract(s.family,'$[5]'),'')<>'legacyPendingRecords'")
    : "";
  const {results}=await query(db,select+selection+sorted,owner,...(readMode?excludedRoot:[])).all();
  if (!results.length) return null;
  const {epoch,version,migration}=results[0];
  return {epoch,version,migration:JSON.parse(migration),document:inflate(results)};
}

export async function transactVault(db,owner,action,readMode) {
  for(let attempt=0;attempt<5;attempt++) {
    const view=await openV2(db,owner,readMode);
    if (!view) {
      try { return await transact(db,owner,action); }
      catch(error) { if (String(error.message).includes('noa_v2_active')) continue; throw error; }
    }
    const original=readMode?null:flatten(view.document);
    const result=await action(view.document,view.version,view);
    if (!result.write) return result.value;
    const pointer=await db.prepare('SELECT target FROM noa_authority_pointer WHERE owner_id=?').bind(owner).first();
    const v3=pointer?.target==='v2'?null:await db.prepare('SELECT 1 AS active FROM noa_v3_head WHERE owner_id=?').bind(owner).first();
    if (v3) throw new VaultError('authority_v3_active','V3 已激活或迁移中，V2 禁止业务写入',409);
    if (readMode) throw new VaultError('readonly_snapshot','只读分片视图无法提交',500);
    const updated=flatten(result.document ?? view.document);
    const statements=[
      query(db,`INSERT INTO noa_cas_guard SELECT EXISTS(SELECT 1 FROM noa_head
        WHERE owner_id=? AND epoch=? AND version=?)`,owner,view.epoch,view.version),
      query(db,'UPDATE noa_head SET version=version+1 WHERE owner_id=?',owner),
      db.prepare('DELETE FROM noa_cas_guard')
    ];
    for (const [key,row] of updated) {
      const prior=original.get(key);
      if (!prior || prior[5]!==row[5] || prior[2]!==row[2]) statements.push(put(db,owner,view.epoch,row));
    }
    for (const [key,[family,slot,,part]] of original) if (!updated.has(key)) {
      statements.push(query(db,'DELETE FROM noa_shard WHERE owner_id=? AND epoch=? AND family=? AND slot=? AND part=?',owner,view.epoch,family,slot,part));
    }
    try { await db.batch(statements); return result.value; }
    catch(error) {
      if (!String(error.message).includes('CHECK constraint failed: success=1')) throw error;
    }
  }
  throw new VaultError('concurrent_write','并发写入过多，请沿用原幂等键重试',409);
}

export async function storageStats(db,owner) {
  const current=await head(db,owner);
  if (!current) {
    const row=await query(db,'SELECT version,document FROM noa_vault WHERE owner_id=?',owner).first();
    return {schemaVersion:1,storage:'single-document',migrationStatus:'pending',manifest:null,
      legacyVersion:row?.version,legacyHash:row?hashText(row.document):null,
      physicalShardCount:row?1:0,shardBytes:row?new TextEncoder().encode(row.document).length:0};
  }
  const {results}=await query(db,`SELECT family,count(*) AS objects,
      sum(length(CAST(body AS BLOB))) AS bytes,max(length(CAST(body AS BLOB))) AS maxBytes
      FROM noa_shard WHERE owner_id=? AND epoch=? GROUP BY family ORDER BY family`,owner,current.epoch).all();
  return {schemaVersion:2,storage:'d1-transactional-shards',migrationStatus:'active',manifest:{
    generation:current.epoch,storageVersion:current.version,...JSON.parse(current.migration)
  },physicalShardCount:results.reduce((n,row)=>n+row.objects,0),
  shardBytes:results.reduce((n,row)=>n+row.bytes,0),families:results};
}

export async function promoteVault(db,owner,input,prepare,seed) {
  const current=await head(db,owner);
  if (current) return {alreadyActive:true,...await storageStats(db,owner)};
  const expected=input.expectedHash;
  const row=seed?null:await query(db,'SELECT version,document FROM noa_vault WHERE owner_id=?',owner).first();
  if (!seed && (!row || row.version!==input.expectedVersion || hashText(row.document)!==expected)) {
    throw new VaultError('migration_baseline_changed','备份哈希或旧库版本已变化',409);
  }
  const document=seed ?? JSON.parse(row.document);
  const projections=prepare?.(document) ?? null;
  const shards=flatten(document);
  const rows=[...shards.values()];
  const verification=inflate(rows.map(([family,slot,ordinal,part,body,digest])=>({family,slot,ordinal,part,body,digest}))
    .sort((a,b)=>a.part-b.part));
  if (encode(verification)!==encode(document)) throw new VaultError('migration_roundtrip','迁移重建结果不一致',500);
  const migration={schemaVersion:2,sourceHash:expected??null,sourceVersion:row?.version??null,
    migratedHash:hashText(encode(document)),projections};
  if (input.dryRun!==false) return {status:'dry-run',objects:rows.length,...migration};
  const epoch=crypto.randomUUID();
  for(let start=0;start<rows.length;start+=40) {
    await db.batch(rows.slice(start,start+40).map(value=>put(db,owner,epoch,value)));
  }
  const persisted=await query(db,'SELECT family,slot,ordinal,part,body,digest FROM noa_shard WHERE owner_id=? AND epoch=?'+sorted,owner,epoch).all();
  if (persisted.results.length!==rows.length || hashText(encode(inflate(persisted.results)))!==migration.migratedHash) {
    throw new VaultError('migration_roundtrip','持久化分片复核失败',500);
  }
  const insert=seed
    ? query(db,'INSERT OR IGNORE INTO noa_head VALUES (?,?,0,?)',owner,epoch,encode(migration))
    : query(db,`INSERT OR IGNORE INTO noa_head SELECT ?,?,?,? FROM noa_vault WHERE owner_id=? AND version=?`,
      owner,epoch,row.version,encode(migration),owner,row.version);
  const applied=await insert.run();
  if (!applied.meta.changes && !await head(db,owner)) throw new VaultError('migration_baseline_changed','迁移期间旧库已变化',409);
  return await storageStats(db,owner);
}

export async function compactVault(db,owner,dryRun=true) {
  // Concurrent staging epochs may still be in flight. Active and staging are separately accounted for.
  const staged=await query(db,`SELECT count(*) AS objects FROM noa_shard s WHERE owner_id=?
    AND NOT EXISTS(SELECT 1 FROM noa_head h WHERE h.owner_id=s.owner_id AND h.epoch=s.epoch)`,owner).first();
  return {dryRun,stagedObjects:staged.objects,removed:0,mode:'retain-staging',reason:'候选迁移仍可能在写入，保留未发布分片'};
}

/** 共享异步存储接口适配；Worker 不依赖同步全量 SnapshotRepo。 */
export function createD1StorageAdapter(db) {
  return {
    open: (owner, readMode) => openV2(db, owner, readMode),
    transact: (owner, action, readMode) => transactVault(db, owner, action, readMode),
    stats: owner => storageStats(db, owner),
    promote: (owner, input, prepare, seed) => promoteVault(db, owner, input, prepare, seed),
    compact: (owner, dryRun) => compactVault(db, owner, dryRun)
  };
}
