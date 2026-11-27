import { hashText, ok, fail } from '../../../packages/core/shared.ts';

/**
 * PROJECT AKASHA 通用状态内核。
 * Entity/Component/Collection/Schema/Index 均为通用原语，不包含任何世界业务类型。
 */
export const COMPONENT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS noa_v3_schema (
    owner_id TEXT NOT NULL, component_type TEXT NOT NULL, version INTEGER NOT NULL,
    schema_json TEXT NOT NULL, digest TEXT NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,component_type,version)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS noa_v3_entity (
    owner_id TEXT NOT NULL, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL,
    entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, meta TEXT NOT NULL, digest TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,campaign_id,worldline_id,entity_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS noa_v3_component (
    owner_id TEXT NOT NULL, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL,
    entity_id TEXT NOT NULL, component_type TEXT NOT NULL, component_key TEXT NOT NULL,
    body TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,campaign_id,worldline_id,entity_id,component_type,component_key)) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS noa_v3_component_type ON noa_v3_component(owner_id,campaign_id,worldline_id,component_type)',
  'CREATE INDEX IF NOT EXISTS noa_v3_component_digest ON noa_v3_component(owner_id,digest)',
  `CREATE TABLE IF NOT EXISTS noa_v3_collection_item (
    owner_id TEXT NOT NULL, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL,
    collection_id TEXT NOT NULL, item_key TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,campaign_id,worldline_id,collection_id,item_key)) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS noa_v3_collection_id ON noa_v3_collection_item(owner_id,campaign_id,worldline_id,collection_id)',
  `CREATE TABLE IF NOT EXISTS noa_v3_component_index (
    owner_id TEXT NOT NULL, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL,
    index_name TEXT NOT NULL, index_key TEXT NOT NULL, entity_id TEXT NOT NULL,
    component_type TEXT NOT NULL, component_key TEXT NOT NULL,
    PRIMARY KEY(owner_id,campaign_id,worldline_id,index_name,index_key)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS noa_v3_component_checkpoint (
    owner_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, delta TEXT NOT NULL,
    digest TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(owner_id,id)) WITHOUT ROWID`
];

const q = (db, sql, ...params) => db.prepare(sql).bind(...params);
const encode = value => JSON.stringify(value);
const decode = text => JSON.parse(text);
const now = () => new Date().toISOString();
const putComponent = (db, o, c, w, e, t, k, value, revision, at = now()) => q(db,
  `INSERT INTO noa_v3_component VALUES (?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(owner_id,campaign_id,worldline_id,entity_id,component_type,component_key)
   DO UPDATE SET body=excluded.body,digest=excluded.digest,revision=excluded.revision,updated_at=excluded.updated_at`,
  o, c, w, e, t, k, encode(value), hashText(encode(value)), revision, at);
const putItem = (db, o, c, w, id, key, value, revision, at = now()) => q(db,
  `INSERT INTO noa_v3_collection_item VALUES (?,?,?,?,?,?,?,?,?)
   ON CONFLICT(owner_id,campaign_id,worldline_id,collection_id,item_key)
   DO UPDATE SET body=excluded.body,digest=excluded.digest,revision=excluded.revision,updated_at=excluded.updated_at`,
  o, c, w, id, key, encode(value), hashText(encode(value)), revision, at);

export async function registerSchema(db, owner, input) {
  if (!input.componentType || !Number.isInteger(input.version) || !input.schema) return fail('invalid_schema', '缺少组件类型、版本或 Schema');
  const body = encode(input.schema);
  await q(db, `INSERT INTO noa_v3_schema VALUES (?,?,?,?,?,?)
    ON CONFLICT(owner_id,component_type,version) DO NOTHING`,
    owner, input.componentType, input.version, body, hashText(body), input.at ?? now()).run();
  return ok({ componentType: input.componentType, version: input.version, digest: hashText(body) });
}

export async function readComponent(db, owner, scope, entityId, componentType, key = '') {
  const row = await q(db, `SELECT body,digest,revision,updated_at FROM noa_v3_component
    WHERE owner_id=? AND campaign_id=? AND worldline_id=? AND entity_id=? AND component_type=? AND component_key=?`,
    owner, scope.campaignId, scope.worldlineId, entityId, componentType, key).first();
  if (!row) return null;
  if (hashText(row.body) !== row.digest) throw new Error('component_checksum');
  return { value: decode(row.body), digest: row.digest, revision: row.revision, updatedAt: row.updated_at };
}

export async function readComponents(db, owner, scope, selector = {}) {
  const where = ['owner_id=?', 'campaign_id=?', 'worldline_id=?'];
  const params = [owner, scope.campaignId, scope.worldlineId];
  for (const [column, value] of [['entity_id', selector.entityId], ['component_type', selector.componentType], ['component_key', selector.key]]) {
    if (value !== undefined) { where.push(`${column}=?`); params.push(value); }
  }
  const rows = await q(db, `SELECT entity_id,component_type,component_key,body,digest,revision FROM noa_v3_component WHERE ${where.join(' AND ')} LIMIT ?`, ...params, selector.limit ?? 500).all();
  return rows.results.map(row => ({ entityId: row.entity_id, componentType: row.component_type, key: row.component_key, value: decode(row.body), digest: row.digest, revision: row.revision }));
}

/** 通用组件/集合原子事务：调用方提供 Effect 列表，统一 CAS 提交。 */
export async function applyEffects(db, owner, input) {
  const { scope, expectedVersion, effects = [], idempotencyKey } = input;
  if (!scope?.campaignId || !scope?.worldlineId || !idempotencyKey) return fail('invalid_effect_input', '缺少 scope 或幂等键');
  const head = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
  if (!head) return fail('v3_not_initialized', 'V3 内核未初始化');
  if (head.version !== expectedVersion) return fail('revision_conflict', '组件事务版本冲突', { actual: head.version });
  const at = input.at ?? now();
  const next = head.version + 1;
  const statements = [
    q(db, 'INSERT INTO noa_v3_cas_guard SELECT EXISTS(SELECT 1 FROM noa_v3_head WHERE owner_id=? AND version=?)', owner, head.version),
    q(db, 'UPDATE noa_v3_head SET version=? WHERE owner_id=? AND version=?', next, owner, head.version),
    q(db, 'DELETE FROM noa_v3_cas_guard')
  ];
  for (const effect of effects) {
    if (effect.op === 'upsertComponent') {
      statements.push(putComponent(db, owner, scope.campaignId, scope.worldlineId, effect.entityId, effect.componentType, effect.key ?? '', effect.value, next, at));
      statements.push(q(db, `INSERT INTO noa_v3_entity VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,campaign_id,worldline_id,entity_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`,
        owner, scope.campaignId, scope.worldlineId, effect.entityId, effect.entityType ?? 'generic', encode(effect.meta ?? {}), hashText(encode(effect.meta ?? {})), next, at));
    } else if (effect.op === 'deleteComponent') {
      statements.push(q(db, `DELETE FROM noa_v3_component WHERE owner_id=? AND campaign_id=? AND worldline_id=? AND entity_id=? AND component_type=? AND component_key=?`,
        owner, scope.campaignId, scope.worldlineId, effect.entityId, effect.componentType, effect.key ?? ''));
    } else if (effect.op === 'upsertCollectionItem') {
      statements.push(putItem(db, owner, scope.campaignId, scope.worldlineId, effect.collectionId, effect.itemKey, effect.value, next, at));
    } else if (effect.op === 'deleteCollectionItem') {
      statements.push(q(db, `DELETE FROM noa_v3_collection_item WHERE owner_id=? AND campaign_id=? AND worldline_id=? AND collection_id=? AND item_key=?`,
        owner, scope.campaignId, scope.worldlineId, effect.collectionId, effect.itemKey));
    } else if (effect.op === 'index') {
      statements.push(q(db, `INSERT INTO noa_v3_component_index VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,campaign_id,worldline_id,index_name,index_key) DO UPDATE SET entity_id=excluded.entity_id,component_type=excluded.component_type,component_key=excluded.component_key`,
        owner, scope.campaignId, scope.worldlineId, effect.indexName, effect.indexKey, effect.entityId, effect.componentType ?? '', effect.key ?? ''));
    } else return fail('invalid_effect', `未知 Effect: ${effect.op}`);
  }
  try { await db.batch(statements); }
  catch (error) {
    if (String(error?.message ?? '').includes('CHECK constraint failed: success=1')) return fail('concurrent_write', '组件事务并发冲突');
    return fail('component_commit_failed', String(error?.message ?? error));
  }
  return ok({ version: next, effects: effects.length, idempotencyKey });
}

export async function readCollection(db, owner, scope, collectionId, limit = 1000, cursor = 0) {
  const rows = await q(db, `SELECT item_key,body,digest,revision FROM noa_v3_collection_item
    WHERE owner_id=? AND campaign_id=? AND worldline_id=? AND collection_id=? AND item_key>=?
    ORDER BY item_key LIMIT ?`, owner, scope.campaignId, scope.worldlineId, collectionId, String(cursor), limit).all();
  return rows.results.map(row => ({ key: row.item_key, value: decode(row.body), digest: row.digest, revision: row.revision }));
}

const COLLECTION_FIELDS = new Set(['actors', 'inventory', 'quests', 'flags', 'resources']);
const collectionId = (worldline, field) => `${worldline}:state:${field}`;

/** 从组件与集合重建权威 state；只读取实际存在的分片。 */
export async function stateFromComponents(db, owner, scope) {
  const rows = await readComponents(db, owner, scope, { entityId: scope.worldlineId, componentType: 'state', limit: 100 });
  const state = {};
  for (const row of rows) state[row.key] = row.value;
  for (const field of COLLECTION_FIELDS) {
    const shape = state[`${field}@shape`];
    delete state[`${field}@shape`];
    const items = await readCollection(db, owner, scope, collectionId(scope.worldlineId, field), 100000);
    if (!items.length) continue;
    const isArray = shape === 'array';
    if (isArray) state[field] = items.map(i => i.value);
    else {
      state[field] = {};
      for (const item of items) state[field][item.key] = item.value;
    }
  }
  return state;
}

/** 按字段/集合条目做差异写入，避免 state 单文档随历史增长。 */
export async function writeStateDiffToComponents(db, owner, scope, previous, next, version, at = now()) {
  const statements = [];
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    if (COLLECTION_FIELDS.has(key)) {
      const shape = Array.isArray(next[key]) ? 'array' : 'map';
      statements.push(putComponent(db, owner, scope.campaignId, scope.worldlineId, scope.worldlineId, 'state', `${key}@shape`, shape, version, at));
      const before = previous?.[key] ?? (Array.isArray(next[key]) ? [] : {});
      const after = next[key] ?? (Array.isArray(before) ? [] : {});
      const beforeItems = Array.isArray(before) ? before.map((v, i) => [String(i), v]) : Object.entries(before);
      const afterItems = Array.isArray(after) ? after.map((v, i) => [String(i), v]) : Object.entries(after);
      const beforeMap = new Map(beforeItems);
      const afterMap = new Map(afterItems);
      for (const [itemKey, value] of afterMap) {
        if (JSON.stringify(beforeMap.get(itemKey)) !== JSON.stringify(value)) {
          statements.push(putItem(db, owner, scope.campaignId, scope.worldlineId, collectionId(scope.worldlineId, key), itemKey, value, version, at));
        }
      }
      for (const itemKey of beforeMap.keys()) if (!afterMap.has(itemKey)) {
        statements.push(q(db, `DELETE FROM noa_v3_collection_item WHERE owner_id=? AND campaign_id=? AND worldline_id=? AND collection_id=? AND item_key=?`,
          owner, scope.campaignId, scope.worldlineId, collectionId(scope.worldlineId, key), itemKey));
      }
    } else if (JSON.stringify(previous?.[key]) !== JSON.stringify(next[key])) {
      statements.push(putComponent(db, owner, scope.campaignId, scope.worldlineId, scope.worldlineId, 'state', key, next[key], version, at));
    }
  }
  if (statements.length) await db.batch(statements);
  return statements.length;
}

/** 组件级 checkpoint：只记录发生变化的组件/集合条目哈希。 */
export async function componentCheckpoint(db, owner, id, parentId = null) {
  const rows = await q(db, `SELECT entity_id,component_type,component_key,digest FROM noa_v3_component WHERE owner_id=?`, owner).all();
  const items = await q(db, `SELECT collection_id,item_key,digest FROM noa_v3_collection_item WHERE owner_id=?`, owner).all();
  const delta = { components: rows.results, items: items.results };
  const body = encode(delta);
  await q(db, `INSERT OR REPLACE INTO noa_v3_component_checkpoint VALUES (?,?,?,?,?,?)`, owner, id, parentId, body, hashText(body), now()).run();
  return ok({ id, parentId, components: delta.components.length, items: delta.items.length, bytes: Buffer.byteLength(body, 'utf8') });
}

export async function componentStats(db, owner) {
  const tables = ['noa_v3_schema', 'noa_v3_entity', 'noa_v3_component', 'noa_v3_collection_item', 'noa_v3_component_index', 'noa_v3_component_checkpoint'];
  const byteColumn = { noa_v3_schema: 'schema_json', noa_v3_entity: 'meta', noa_v3_component: 'body', noa_v3_collection_item: 'body', noa_v3_component_checkpoint: 'delta', noa_v3_doc: 'body', noa_v3_tx: 'body', noa_v3_rng: 'body', noa_v3_index: 'value', noa_v3_checkpoint: 'delta' };
  const columnFor = table => byteColumn[table] ? `length(${byteColumn[table]})` : '0';
  const result = {};
  for (const table of tables) {
    const row = await q(db, `SELECT count(*) AS records, coalesce(sum(${columnFor(table)}),0) AS bytes FROM ${table} WHERE owner_id=?`, owner).first();
    result[table] = { records: row?.records ?? 0, logicalBytes: row?.bytes ?? 0 };
  }
  return result;
}
