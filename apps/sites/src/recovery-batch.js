import { sha256, hashText, stableStringify, ok, fail, isObject } from '../../../packages/core/shared.ts';
import { documentV3 } from './storage-v3.js';
import { stateFromComponents } from './state-core.js';

/**
 * NOA-INFRA-003: minimum structured batch recovery.
 * No arbitrary SQL is accepted: only fixed tables/fields are translated into
 * parameterized INSERT OR REPLACE statements executed via D1 batch().
 */

export const RECOVERY_BATCH_FORMAT = 'noa-v3-recovery-batch';
export const RECOVERY_MANIFEST_FORMAT = 'noa-v3-recovery-manifest';
export const RECOVERY_LIMITS = Object.freeze({
  maxRequestBytes: 1_950_000,
  maxPayloadBytes: 900_000,
  maxStatementsPerBatch: 44,
  maxRowsPerBatch: 40,
  maxColumnsPerStatement: 16,
  maxValueBytes: 1_000_000
});

const OWNER_TABLE = 'owner_id';
export const RECOVERY_TABLES = Object.freeze({
  noa_head: ['owner_id', 'epoch', 'version', 'migration'],
  noa_shard: ['owner_id', 'epoch', 'family', 'slot', 'ordinal', 'part', 'body', 'digest'],
  noa_v3_activation: ['owner_id', 'id', 'source_version', 'generation', 'summary', 'digest', 'created_at', 'consumed_at'],
  noa_v3_adjacency: ['owner_id', 'campaign_id', 'worldline_id', 'from_id', 'to_id', 'relation_id', 'direction'],
  noa_v3_archive: ['owner_id', 'id', 'revision', 'sha256', 'bytes', 'chunk_bytes', 'created_at'],
  noa_v3_archive_chunk: ['owner_id', 'archive_id', 'ordinal', 'body', 'digest'],
  noa_v3_archive_integrity: ['owner_id', 'archive_id', 'manifest', 'digest'],
  noa_v3_checkpoint: ['owner_id', 'id', 'parent_id', 'state_hash', 'memory_hash', 'rng_cursor', 'delta', 'digest', 'created_at'],
  noa_v3_checkpoint_chunk: ['owner_id', 'checkpoint_id', 'ordinal', 'body', 'digest'],
  noa_v3_checkpoint_meta: ['owner_id', 'id', 'campaign_id', 'worldline_id', 'label', 'created_at', 'source', 'source_version', 'format', 'revision', 'parent_id'],
  noa_v3_collection_item: ['owner_id', 'campaign_id', 'worldline_id', 'collection_id', 'item_key', 'body', 'digest', 'revision', 'updated_at'],
  noa_v3_component: ['owner_id', 'campaign_id', 'worldline_id', 'entity_id', 'component_type', 'component_key', 'body', 'digest', 'revision', 'updated_at'],
  noa_v3_component_checkpoint: ['owner_id', 'id', 'parent_id', 'delta', 'digest', 'created_at'],
  noa_v3_component_index: ['owner_id', 'campaign_id', 'worldline_id', 'index_name', 'index_key', 'entity_id', 'component_type', 'component_key'],
  noa_v3_doc: ['owner_id', 'family', 'slot', 'version', 'body', 'digest'],
  noa_v3_doc_chunk: ['owner_id', 'family', 'slot', 'ordinal', 'body', 'digest'],
  noa_v3_entity: ['owner_id', 'campaign_id', 'worldline_id', 'entity_id', 'entity_type', 'meta', 'digest', 'revision', 'updated_at'],
  noa_v3_event: ['owner_id', 'campaign_id', 'worldline_id', 'event_id', 'seq', 'body', 'digest'],
  noa_v3_head: ['owner_id', 'generation', 'version', 'migration'],
  noa_v3_index: ['owner_id', 'kind', 'key', 'value'],
  noa_v3_memory_order: ['owner_id', 'campaign_id', 'worldline_id', 'kind', 'memory_id', 'seq'],
  noa_v3_migration_progress: ['owner_id', 'stage', 'cursor', 'batches', 'bytes', 'updated_at'],
  noa_v3_revision: ['owner_id', 'campaign_id', 'worldline_id', 'revision', 'memory_revision', 'rng_cursor', 'state_hash'],
  noa_v3_rng: ['owner_id', 'receipt_id', 'event_id', 'consumed', 'body'],
  noa_v3_schema: ['owner_id', 'component_type', 'version', 'schema_json', 'digest', 'registered_at'],
  noa_v3_todo: ['owner_id', 'campaign_id', 'worldline_id', 'todo_id', 'status', 'updated_at'],
  noa_v3_tx: ['owner_id', 'event_id', 'idempotency_key', 'receipt_id', 'worldline_id', 'seq', 'fingerprint', 'body'],
  noa_vault: ['owner_id', 'version', 'document']
});

// Authority tables are never pushed: the pointer is published only by finalize,
// and the smoke marker is owned by the separate unfreeze boundary.
const SKIP_TABLES = new Set(['noa_authority_pointer', 'noa_authority_smoke', 'noa_cas_guard', 'noa_v3_cas_guard']);
const utf8 = value => new TextEncoder().encode(value).length;

export const RECOVERY_SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS noa_recovery_session (owner_id TEXT NOT NULL, session_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, manifest TEXT NOT NULL, state TEXT NOT NULL, expected_batches INTEGER NOT NULL, applied_batches INTEGER NOT NULL DEFAULT 0, expected_rows INTEGER NOT NULL, applied_rows INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finalized_at TEXT, PRIMARY KEY(owner_id,session_id))',
  'CREATE TABLE IF NOT EXISTS noa_recovery_batch (owner_id TEXT NOT NULL, session_id TEXT NOT NULL, batch_id TEXT NOT NULL, ordinal INTEGER NOT NULL, sha256 TEXT NOT NULL, rows INTEGER NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL, applied_at TEXT, PRIMARY KEY(owner_id,session_id,batch_id))'
];

const statementMeta = new WeakMap();
const q = (db, sql, ...params) => {
  const statement = db.prepare(sql).bind(...params);
  statementMeta.set(statement, { bytes: sql.length + JSON.stringify(params).length });
  return statement;
};
const bytesOf = statement => statementMeta.get(statement)?.bytes ?? 0;

export async function ensureRecoverySchema(db) {
  for (const sql of RECOVERY_SCHEMA_SQL) await db.prepare(sql).run();
}

function statementBytes(records) {
  let bytes = 0;
  for (const record of records) {
    const columns = record.columns.map(name => `"${name}"`).join(',');
    const sql = `INSERT OR REPLACE INTO "${record.table}" (${columns}) VALUES (${record.columns.map(() => '?').join(',')})`;
    for (const row of record.rows) bytes += sql.length + JSON.stringify(row).length;
  }
  return bytes;
}

function normalizeValue(value, table, column) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && utf8(value) <= RECOVERY_LIMITS.maxValueBytes) return value;
  return fail('recovery_invalid_value', `非法字段值 ${table}.${column}`);
}

/** Canonicalize a batch before hashing or binding. Shared by Worker and CLI. */
export function normalizeBatch(batch) {
  if (!isObject(batch) || batch.format !== RECOVERY_BATCH_FORMAT || batch.version !== 1) return fail('recovery_invalid_batch', '批量格式不支持');
  if (typeof batch.batchId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(batch.batchId)) return fail('recovery_invalid_batch', 'batchId 非法');
  if (!Number.isInteger(batch.ordinal) || batch.ordinal < 0) return fail('recovery_invalid_batch', 'ordinal 非法');
  if (!Array.isArray(batch.records) || batch.records.length === 0 || batch.records.length > 16) return fail('recovery_invalid_batch', 'records 非法');
  let rows = 0, bytes = 0;
  const records = [];
  for (const record of batch.records) {
    if (!isObject(record) || typeof record.table !== 'string') return fail('recovery_invalid_batch', '记录缺少表名');
    const allowed = RECOVERY_TABLES[record.table];
    if (!allowed) return fail('recovery_table_not_allowed', `表 ${record.table} 不在白名单`);
    if (!Array.isArray(record.columns) || record.columns.length === 0 || record.columns.length > RECOVERY_LIMITS.maxColumnsPerStatement) return fail('recovery_invalid_batch', `${record.table} 字段数量非法`);
    if (new Set(record.columns).size !== record.columns.length || record.columns.some(c => typeof c !== 'string' || !allowed.includes(c))) return fail('recovery_field_not_allowed', `${record.table} 字段不在白名单`);
    if (!Array.isArray(record.rows) || record.rows.length === 0) return fail('recovery_invalid_batch', `${record.table} 行集合为空`);
    rows += record.rows.length;
    const values = [];
    for (const row of record.rows) {
      if (!Array.isArray(row) || row.length !== record.columns.length) return fail('recovery_invalid_batch', `${record.table} 行列数不一致`);
      const normalized = [];
      for (let i = 0; i < row.length; i++) {
        const value = normalizeValue(row[i], record.table, record.columns[i]);
        if (value && typeof value === 'object' && value.ok === false) return value;
        normalized.push(value);
      }
      values.push(normalized);
    }
    records.push({ table: record.table, columns: [...record.columns], rows: values });
  }
  if (rows > RECOVERY_LIMITS.maxRowsPerBatch) return fail('recovery_too_many_rows', `单批最多 ${RECOVERY_LIMITS.maxRowsPerBatch} 行`);
  const canonical = { format: RECOVERY_BATCH_FORMAT, version: 1, batchId: batch.batchId, ordinal: batch.ordinal, records };
  bytes = statementBytes(records);
  if (bytes > RECOVERY_LIMITS.maxPayloadBytes) return fail('recovery_batch_too_large', `单批 ${bytes} bytes 超出 ${RECOVERY_LIMITS.maxPayloadBytes}`);
  return ok({ ...canonical, bytes, rows });
}

export function recoveryBatchSha256(batch) {
  const normalized = normalizeBatch(batch);
  if (!normalized.ok) return null;
  return sha256({ format: RECOVERY_BATCH_FORMAT, version: 1, batchId: normalized.data.batchId, ordinal: normalized.data.ordinal, records: normalized.data.records });
}

/** Byte estimate used by both CLI sharding and Worker request checks. */
export function recoveryStatementBytes(batch) {
  if (!isObject(batch) || !Array.isArray(batch.records)) return -1;
  const records = batch.records.map(record => ({
    table: record.table, columns: record.columns, rows: record.rows
  }));
  return statementBytes(records);
}

function validateManifest(manifest, dataOwner) {
  if (!isObject(manifest) || manifest.format !== RECOVERY_MANIFEST_FORMAT || manifest.version !== 1) return fail('recovery_invalid_manifest', '恢复清单格式不支持');
  if (manifest.ownerMapping?.target !== dataOwner) return fail('recovery_owner_mismatch', `清单 owner 必须为 ${dataOwner}`);
  if (!(manifest.maxRequestBytes > 0 && manifest.maxRequestBytes <= RECOVERY_LIMITS.maxRequestBytes)) return fail('recovery_invalid_manifest', '请求体上限非法');
  if (!Array.isArray(manifest.batches) || manifest.batches.length === 0) return fail('recovery_invalid_manifest', '清单缺少批次');
  const seen = new Set();
  for (const [index, batch] of manifest.batches.entries()) {
    if (!isObject(batch) || typeof batch.batchId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(batch.batchId)) return fail('recovery_invalid_manifest', `批次 ${index} id 非法`);
    if (seen.has(batch.batchId)) return fail('recovery_invalid_manifest', `批次 ${batch.batchId} 重复`);
    seen.add(batch.batchId);
    if (batch.ordinal !== index) return fail('recovery_invalid_manifest', `批次 ${batch.batchId} ordinal 不连续`);
    if (!/^[a-f0-9]{64}$/.test(batch.sha256 ?? '')) return fail('recovery_invalid_manifest', `批次 ${batch.batchId} sha256 非法`);
    if (!(batch.rows > 0) || !(batch.bytes > 0)) return fail('recovery_invalid_manifest', `批次 ${batch.batchId} 计数非法`);
  }
  if (!isObject(manifest.evidence) || manifest.evidence.revision !== 1550 || manifest.evidence.rngCursor !== 657) return fail('recovery_invalid_manifest', '业务证据基线不匹配');
  return ok(manifest);
}

async function loadSession(db, dataOwner, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return fail('recovery_session_required', '缺少 sessionId');
  const row = await q(db, 'SELECT * FROM noa_recovery_session WHERE owner_id=? AND session_id=?', dataOwner, sessionId).first();
  if (!row) return fail('recovery_session_not_found', '恢复会话不存在');
  return ok({ row, manifest: JSON.parse(row.manifest) });
}

async function assertTargetEmpty(db, dataOwner) {
  const tables = [...Object.keys(RECOVERY_TABLES), 'noa_authority_pointer', 'noa_authority_smoke'];
  for (const table of tables) {
    const exists = await q(db, `SELECT 1 AS ok FROM "${table}" WHERE owner_id=? LIMIT 1`, dataOwner).first();
    if (exists) return fail('recovery_target_conflict', `目标库已存在 ${table} 数据，拒绝覆盖`);
  }
  return ok({});
}

export async function recoveryBegin(db, dataOwner, args = {}) {
  await ensureRecoverySchema(db);
  const checked = validateManifest(args.manifest, dataOwner);
  if (!checked.ok) return checked;
  const manifest = checked.data;
  const manifestSha256 = sha256(manifest);
  if (args.manifestSha256 !== manifestSha256) return fail('recovery_manifest_hash', '清单 SHA-256 不匹配');
  const sessionId = args.sessionId ?? `rec-${manifestSha256.slice(0, 16)}`;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.:-]{4,128}$/.test(sessionId)) return fail('recovery_invalid_session', 'sessionId 非法');

  const existing = await q(db, 'SELECT * FROM noa_recovery_session WHERE owner_id=? AND session_id=?', dataOwner, sessionId).first();
  if (existing) {
    if (existing.manifest_sha256 !== manifestSha256) return fail('recovery_session_conflict', '会话已绑定其他清单');
    return ok({ sessionId, state: existing.state, appliedBatches: existing.applied_batches, expectedBatches: existing.expected_batches, appliedRows: existing.applied_rows, expectedRows: existing.expected_rows, manifestSha256, duplicate: true });
  }
  const conflict = await assertTargetEmpty(db, dataOwner);
  if (!conflict.ok) return conflict;

  const expectedBatches = manifest.batches.length;
  const expectedRows = manifest.batches.reduce((n, batch) => n + batch.rows, 0);
  await q(db, 'INSERT INTO noa_recovery_session VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
    dataOwner, sessionId, manifestSha256, stableStringify(manifest), 'applying', expectedBatches, 0, expectedRows, 0, new Date().toISOString()).run();
  return ok({ sessionId, state: 'applying', appliedBatches: 0, expectedBatches, appliedRows: 0, expectedRows, manifestSha256, duplicate: false });
}

export async function recoveryPush(db, dataOwner, args = {}) {
  const session = await loadSession(db, dataOwner, args.sessionId);
  if (!session.ok) return session;
  if (session.data.row.state === 'finalized') return fail('recovery_session_finalized', '会话已 finalize，禁止继续推送');
  if (session.data.row.state === 'aborted') return fail('recovery_session_aborted', '会话已 abort');
  const normalized = normalizeBatch(args.batch);
  if (!normalized.ok) return normalized;
  const batch = normalized.data;
  const expected = session.data.manifest.batches.find(row => row.batchId === batch.batchId);
  if (!expected) return fail('recovery_batch_unknown', `批次 ${batch.batchId} 不在清单`);
  if (expected.ordinal !== batch.ordinal) return fail('recovery_ordinal_conflict', `批次 ${batch.batchId} ordinal 不匹配`);
  if (expected.rows !== batch.rows) return fail('recovery_row_count', `批次 ${batch.batchId} 行数不匹配`);
  const digest = recoveryBatchSha256(batch);
  if (digest !== expected.sha256) return fail('recovery_sha256_mismatch', `批次 ${batch.batchId} SHA-256 与清单不一致`);
  if (args.sha256 !== digest) return fail('recovery_sha256_mismatch', `批次 ${batch.batchId} 提交 SHA-256 不一致`);

  const prior = await q(db, 'SELECT * FROM noa_recovery_batch WHERE owner_id=? AND session_id=? AND batch_id=?', dataOwner, args.sessionId, batch.batchId).first();
  if (prior) {
    if (prior.sha256 !== digest || prior.rows !== batch.rows) return fail('recovery_batch_conflict', `批次 ${batch.batchId} 已以不同内容提交`);
    return ok({ batchId: batch.batchId, rows: batch.rows, duplicate: true, appliedBatches: session.data.row.applied_batches, expectedBatches: session.data.row.expected_batches });
  }

  const statements = [];
  for (const record of batch.records) {
    const columns = record.columns.map(name => `"${name}"`).join(',');
    const placeholders = record.columns.map(() => '?').join(',');
    const sql = `INSERT OR REPLACE INTO "${record.table}" (${columns}) VALUES (${placeholders})`;
    for (const row of record.rows) statements.push(q(db, sql, ...row));
  }
  if (statements.length > RECOVERY_LIMITS.maxStatementsPerBatch - 2) return fail('recovery_too_many_statements', `单批语句数超出 ${RECOVERY_LIMITS.maxStatementsPerBatch - 2}`);
  const bytes = statements.reduce((n, statement) => n + bytesOf(statement), 0);
  if (bytes > RECOVERY_LIMITS.maxPayloadBytes) return fail('recovery_batch_too_large', `单批语句 ${bytes} bytes 超出上限`);
  const at = new Date().toISOString();
  statements.push(
    q(db, 'INSERT INTO noa_recovery_batch VALUES (?,?,?,?,?,?,?,?,?)', dataOwner, args.sessionId, batch.batchId, batch.ordinal, digest, batch.rows, batch.bytes, 'applied', at),
    q(db, 'UPDATE noa_recovery_session SET applied_batches=applied_batches+1, applied_rows=applied_rows+? WHERE owner_id=? AND session_id=?', batch.rows, dataOwner, args.sessionId)
  );
  await db.batch(statements);
  return ok({ batchId: batch.batchId, rows: batch.rows, sha256: digest, duplicate: false, appliedBatches: session.data.row.applied_batches + 1, expectedBatches: session.data.row.expected_batches });
}

export async function recoveryStatus(db, dataOwner, args = {}) {
  const session = await loadSession(db, dataOwner, args.sessionId);
  if (!session.ok) return session;
  const batches = await q(db, 'SELECT batch_id,ordinal,sha256,rows,state FROM noa_recovery_batch WHERE owner_id=? AND session_id=? ORDER BY ordinal', dataOwner, args.sessionId).all();
  const pointer = await q(db, 'SELECT target,frozen,v3_generation FROM noa_authority_pointer WHERE owner_id=?', dataOwner).first();
  return ok({
    sessionId: args.sessionId, state: session.data.row.state,
    appliedBatches: session.data.row.applied_batches, expectedBatches: session.data.row.expected_batches,
    appliedRows: session.data.row.applied_rows, expectedRows: session.data.row.expected_rows,
    manifestSha256: session.data.row.manifest_sha256, applied: batches.results.map(row => row.batch_id),
    authority: pointer ? { target: pointer.target, frozen: Number(pointer.frozen), generation: pointer.v3_generation } : null
  });
}

async function tableHashes(db, dataOwner) {
  const result = {};
  for (const table of Object.keys(RECOVERY_TABLES)) {
    let rows;
    try { rows = (await q(db, `SELECT * FROM "${table}" WHERE owner_id=? ORDER BY rowid`, dataOwner).all()).results; }
    catch { rows = (await q(db, `SELECT * FROM "${table}" WHERE owner_id=?`, dataOwner).all()).results.slice().sort((a, b) => sha256(a).localeCompare(sha256(b))); }
    result[table] = { rows: rows.length, sha256: sha256(rows) };
  }
  return result;
}

async function verifyEvidence(db, dataOwner, evidence) {
  const checks = [];
  const check = (name, okValue, detail = {}) => checks.push({ name, ok: Boolean(okValue), ...detail });
  const count = async (sql, ...params) => Number((await q(db, sql, ...params).first())?.n ?? 0);
  const expectedCounts = evidence.counts ?? {};
  const actualCounts = {
    events: await count('SELECT count(*) n FROM noa_v3_event WHERE owner_id=?', dataOwner),
    receipts: await count('SELECT count(*) n FROM noa_v3_tx WHERE owner_id=?', dataOwner),
    checkpoints: await count('SELECT count(*) n FROM noa_v3_checkpoint WHERE owner_id=?', dataOwner),
    entities: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'entity:%'", dataOwner),
    relations: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'relation:%'", dataOwner),
    episodes: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'episode:%'", dataOwner),
    rng: await count('SELECT count(*) n FROM noa_v3_rng WHERE owner_id=?', dataOwner)
  };
  for (const key of Object.keys(actualCounts)) check(`count:${key}`, actualCounts[key] === expectedCounts[key], { actual: actualCounts[key], expected: expectedCounts[key] });

  const document = await documentV3(db, dataOwner);
  const line = document.campaigns?.['SAVE-481']?.lines?.['wl-main'];
  check('domain:persona', sha256(document.persona) === evidence.personaSha256);
  check('domain:campaigns', sha256(document.campaigns) === evidence.businessSha256);
  const sortById = rows => rows.slice().sort((a, b) => String(a.id ?? a.eventId ?? a.receipt?.id ?? '').localeCompare(String(b.id ?? b.eventId ?? b.receipt?.id ?? '')));
  check('history:events', sha256(sortById(document.events ?? [])) === evidence.eventSha256);
  check('history:receipts', sha256(sortById(Object.values(document.receipts ?? {}))) === evidence.receiptSha256);
  const cpView = value => sortById(Object.values(value).map(cp => ({ id: cp.id, snapshot: cp.snapshot })));
  check('history:checkpoints', sha256(cpView(document.checkpoints ?? {})) === evidence.checkpointSha256);
  if (line) {
    check('business:working', sha256(line.working) === evidence.workingSha256);
    const built = await stateFromComponents(db, dataOwner, { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    check('business:state', sha256(built) === evidence.stateSha256, { revision: built?.revision });
    check('business:rng-cursor', built?.rng?.cursor === evidence.rngCursor);
    check('business:rng-seed', built?.rng?.seed === evidence.rngSeed);
  } else check('business:line', false);
  const graph = await q(db, 'SELECT count(*) n FROM noa_v3_adjacency WHERE owner_id=?', dataOwner).first();
  check('graph:adjacency', sha256([graph?.n ?? 0]) === evidence.graphSha256, { edges: graph?.n });
  const head = await q(db, 'SELECT migration FROM noa_v3_head WHERE owner_id=?', dataOwner).first();
  let migration = {}; try { migration = JSON.parse(head?.migration ?? '{}'); } catch {}
  check('head:complete', migration.status === 'complete', { status: migration.status });

  const hashes = await tableHashes(db, dataOwner);
  const skip = new Set(['noa_authority_pointer', 'noa_authority_smoke', 'noa_cas_guard', 'noa_v3_cas_guard']);
  for (const [table, meta] of Object.entries(evidence.tableHashes ?? {})) {
    if (skip.has(table)) continue;
    const actual = hashes[table];
    check(`table:${table}`, actual?.rows === meta.rows && actual?.sha256 === meta.sha256, { actualRows: actual?.rows, expectedRows: meta.rows, actualSha256: actual?.sha256, expectedSha256: meta.sha256 });
  }
  return checks;
}

export async function recoveryFinalize(db, dataOwner, args = {}) {
  const session = await loadSession(db, dataOwner, args.sessionId);
  if (!session.ok) return session;
  if (session.data.row.state === 'finalized') return ok({ sessionId: args.sessionId, state: 'finalized', duplicate: true, checks: [] });
  if (session.data.row.state !== 'applying') return fail('recovery_session_invalid', `会话状态 ${session.data.row.state} 不可 finalize`);
  if (session.data.row.applied_batches !== session.data.row.expected_batches || session.data.row.applied_rows !== session.data.row.expected_rows) {
    return fail('recovery_incomplete', `尚有 ${session.data.row.expected_batches - session.data.row.applied_batches} 批未导入`);
  }
  const checks = await verifyEvidence(db, dataOwner, session.data.manifest.evidence);
  const failed = checks.filter(row => !row.ok);
  if (failed.length) return fail('recovery_evidence_failed', '业务证据校验失败', { failed });
  const head = await q(db, 'SELECT migration FROM noa_v3_head WHERE owner_id=?', dataOwner).first();
  let migration = {}; try { migration = JSON.parse(head?.migration ?? '{}'); } catch {}
  if (!migration.generation) return fail('recovery_generation_missing', 'V3 generation 缺失');
  const at = new Date().toISOString();
  await db.batch([
    q(db, 'INSERT OR REPLACE INTO noa_authority_pointer VALUES (?,?,?,?,?)', dataOwner, 'v3', migration.generation, 1, at),
    q(db, 'UPDATE noa_recovery_session SET state=?,finalized_at=? WHERE owner_id=? AND session_id=?', 'finalized', at, dataOwner, args.sessionId)
  ]);
  return ok({ sessionId: args.sessionId, state: 'finalized', authority: { target: 'v3', frozen: 1, generation: migration.generation }, checks: checks.length, failed: 0 });
}

export async function recoveryAbort(db, dataOwner, args = {}) {
  const session = await loadSession(db, dataOwner, args.sessionId);
  if (!session.ok) return session;
  if (session.data.row.state === 'finalized') return fail('recovery_session_finalized', '已发布权威指针，禁止 abort');
  const statements = [];
  for (const table of [...Object.keys(RECOVERY_TABLES), 'noa_authority_pointer', 'noa_authority_smoke']) {
    statements.push(q(db, `DELETE FROM "${table}" WHERE owner_id=?`, dataOwner));
  }
  statements.push(q(db, 'DELETE FROM noa_recovery_batch WHERE owner_id=? AND session_id=?', dataOwner, args.sessionId));
  statements.push(q(db, 'DELETE FROM noa_recovery_session WHERE owner_id=? AND session_id=?', dataOwner, args.sessionId));
  if (statements.length > RECOVERY_LIMITS.maxStatementsPerBatch) return fail('recovery_abort_too_large', 'abort 语句数超限');
  await db.batch(statements);
  return ok({ sessionId: args.sessionId, state: 'aborted', removedTables: statements.length - 2 });
}

export async function recoveryTool(db, dataOwner, name, args) {
  switch (name) {
    case 'recovery_begin': return recoveryBegin(db, dataOwner, args);
    case 'recovery_push': return recoveryPush(db, dataOwner, args);
    case 'recovery_status': return recoveryStatus(db, dataOwner, args);
    case 'recovery_finalize': return recoveryFinalize(db, dataOwner, args);
    case 'recovery_abort': return recoveryAbort(db, dataOwner, args);
    default: return fail('unknown_recovery_tool', `未知恢复工具 ${name}`);
  }
}

export { hashText };
