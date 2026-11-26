import { commitEvent } from './events.js';
import { sha256, hashText, deterministicRoll, ok, fail } from '../../../packages/core/shared.ts';

/**
 * V2.2 增量存储内核。
 * 常规 event_commit 只读取 revision、state/working、约束关系、幂等/事件回执索引；
 * 写入只覆盖本轮变更分片并以 head.version CAS 原子提交。
 */
export const V3_SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS noa_v3_head (owner_id TEXT PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL, migration TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS noa_v3_doc (owner_id TEXT NOT NULL, family TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(owner_id,family,slot)) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS noa_v3_revision (owner_id TEXT NOT NULL, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, revision INTEGER NOT NULL, memory_revision INTEGER NOT NULL, rng_cursor INTEGER, state_hash TEXT NOT NULL, PRIMARY KEY(owner_id,campaign_id,worldline_id))',
  'CREATE TABLE IF NOT EXISTS noa_v3_tx (owner_id TEXT NOT NULL, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, receipt_id TEXT NOT NULL, worldline_id TEXT NOT NULL, seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner_id,idempotency_key))',
  'CREATE INDEX IF NOT EXISTS noa_v3_tx_event ON noa_v3_tx(owner_id,event_id)',
  'CREATE INDEX IF NOT EXISTS noa_v3_tx_receipt ON noa_v3_tx(owner_id,receipt_id)',
  'CREATE INDEX IF NOT EXISTS noa_v3_tx_seq ON noa_v3_tx(owner_id,seq DESC)',
  'CREATE INDEX IF NOT EXISTS noa_v3_doc_family ON noa_v3_doc(owner_id,family)',
  'CREATE INDEX IF NOT EXISTS noa_v3_revision_revision ON noa_v3_revision(owner_id,revision)',
  'CREATE TABLE IF NOT EXISTS noa_v3_rng (owner_id TEXT NOT NULL, receipt_id TEXT NOT NULL, event_id TEXT, consumed INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, PRIMARY KEY(owner_id,receipt_id))',
  'CREATE TABLE IF NOT EXISTS noa_v3_index (owner_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id,kind,key))',
  'CREATE INDEX IF NOT EXISTS noa_v3_index_kind ON noa_v3_index(owner_id,kind,value)',
  'CREATE TABLE IF NOT EXISTS noa_v3_checkpoint (owner_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, state_hash TEXT NOT NULL, memory_hash TEXT NOT NULL, rng_cursor INTEGER, delta TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner_id,id))',
  'CREATE TABLE IF NOT EXISTS noa_v3_cas_guard (success INTEGER CHECK(success=1))'
];

export async function applyV3Schema(db) {
  for (const sql of V3_SCHEMA_SQL) await db.prepare(sql).run();
}

const q = (db, sql, ...params) => db.prepare(sql).bind(...params);
const wfamily = (base, c, w) => `${base}:${c}:${w}`;
const encode = value => JSON.stringify(value);
const decode = text => JSON.parse(text);
const putDocStatement = (db, owner, family, slot, value, version) => q(db,
  'INSERT INTO noa_v3_doc VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,family,slot) DO UPDATE SET version=excluded.version,body=excluded.body,digest=excluded.digest',
  owner, family, slot, version, encode(value), hashText(encode(value)));

async function readDoc(db, owner, family, slot = '') {
  const row = await q(db, 'SELECT body,digest FROM noa_v3_doc WHERE owner_id=? AND family=? AND slot=?', owner, family, slot).first();
  if (!row) return null;
  if (hashText(row.body) !== row.digest) throw new Error('v3_shard_checksum');
  return decode(row.body);
}
async function readIndex(db, owner, kind, key) {
  const row = await q(db, 'SELECT value FROM noa_v3_index WHERE owner_id=? AND kind=? AND key=?', owner, kind, key).first();
  return row ? decode(row.value) : null;
}

export async function hasV3(db, owner) {
  return Boolean(await q(db, 'SELECT 1 AS ok FROM noa_v3_head WHERE owner_id=?', owner).first());
}

/** 一次性把 V2 完整文档迁移到 V3 局部文档与索引；常规提交禁止调用。 */
export async function promoteV3(db, owner, document, opts = {}) {
  const existing = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
  if (existing) return { alreadyActive: true, version: existing.version };
  const active = document.active ?? { campaignId: 'demo', worldlineId: 'wl-main' };
  const campaignId = active.campaignId;
  const worldlineId = active.worldlineId;
  const snapshot = document.campaigns?.[campaignId]?.lines?.[worldlineId];
  if (!snapshot) throw new Error('v3_migration_missing_snapshot');
  const statements = [
    q(db, 'INSERT INTO noa_v3_head VALUES (?,?,?,?)', owner, crypto.randomUUID(), 0, encode({ ...opts, migratedAt: new Date().toISOString() })),
    putDocStatement(db, owner, 'active', '', active, 0),
    putDocStatement(db, owner, wfamily('manifest', campaignId, worldlineId), '', snapshot.manifest, 0),
    putDocStatement(db, owner, 'persona', '', document.persona ?? null, 0),
    putDocStatement(db, owner, wfamily('state', campaignId, worldlineId), '', snapshot.state, 0),
    putDocStatement(db, owner, wfamily('working', campaignId, worldlineId), '', snapshot.working, 0)
  ];
  for (const entity of snapshot.entities ?? []) statements.push(putDocStatement(db, owner, wfamily('entity', campaignId, worldlineId), entity.id, entity, 0));
  for (const relation of snapshot.relations ?? []) statements.push(putDocStatement(db, owner, wfamily('relation', campaignId, worldlineId), relation.id, relation, 0));
  for (const episode of snapshot.episodes ?? []) statements.push(putDocStatement(db, owner, wfamily('episode', campaignId, worldlineId), episode.id, episode, 0));
  for (const [key, value] of Object.entries(document.receipts ?? {})) {
    const receipt = value.receipt ?? value;
    statements.push(q(db, 'INSERT OR IGNORE INTO noa_v3_tx VALUES (?,?,?,?,?,?,?,?)',
      owner, receipt.eventId ?? '', [receipt.worldlineId ?? worldlineId, receipt.idempotencyKey ?? key].join(':'), receipt.id ?? key,
      receipt.worldlineId ?? worldlineId, 0, value.fingerprint ?? '', encode(value)));
  }
  statements.push(q(db, `INSERT INTO noa_v3_revision VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,campaign_id,worldline_id) DO UPDATE SET revision=excluded.revision,memory_revision=excluded.memory_revision,rng_cursor=excluded.rng_cursor,state_hash=excluded.state_hash`,
    owner, campaignId, worldlineId, snapshot.state.revision, snapshot.working?.memoryRevision ?? 0,
    snapshot.state.rng?.cursor ?? null, hashText(encode(snapshot.state))));
  await db.batch(statements);
  return { version: 0, migratedEntities: snapshot.entities?.length ?? 0, migratedRelations: snapshot.relations?.length ?? 0, migratedEpisodes: snapshot.episodes?.length ?? 0 };
}

/**
 * 增量 event_commit：有界索引查询 + 局部文档构造 + CAS 原子提交。
 */
export async function commitEventV3(db, owner, input) {
  const { campaignId, worldlineId, eventId, idempotencyKey, expectedRevision, actor } = input;
  const eventKey = [campaignId, worldlineId, idempotencyKey].join(':');
  const txKey = [worldlineId, idempotencyKey].join(':');
  try {
    const head = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
    if (!head) return { ok: false, code: 'v3_not_initialized', message: 'V3 增量内核未初始化' };

    const prior = await q(db, 'SELECT fingerprint,body FROM noa_v3_tx WHERE owner_id=? AND idempotency_key=?', owner, txKey).first();
    if (prior) {
      const stored = decode(prior.body);
      const request = { ...input };
      delete request.actor;
      if (prior.fingerprint !== hashText(encode(sortDeep(request)))) return { ok: false, code: 'idempotency_conflict', message: '幂等键已绑定其他请求' };
      return { ok: true, data: { ...stored.result, receipt: { ...stored.receipt, duplicate: true } } };
    }
    const existingEvent = await q(db, 'SELECT 1 AS ok FROM noa_v3_tx WHERE owner_id=? AND event_id=? AND worldline_id=?', owner, eventId, worldlineId).first();
    if (existingEvent) return { ok: false, code: 'event_exists', message: '事件 ID 已存在' };

    const revisionRow = await q(db, 'SELECT revision,memory_revision,rng_cursor FROM noa_v3_revision WHERE owner_id=? AND campaign_id=? AND worldline_id=?', owner, campaignId, worldlineId).first();
    if (!revisionRow) return { ok: false, code: 'worldline_not_found', message: '世界线不存在' };
    if (revisionRow.revision !== expectedRevision) return { ok: false, code: 'revision_conflict', message: `revision 不匹配，当前 ${revisionRow.revision}` };

    const [state, working, manifest] = await Promise.all([
      readDoc(db, owner, wfamily('state', campaignId, worldlineId)),
      readDoc(db, owner, wfamily('working', campaignId, worldlineId)),
      readDoc(db, owner, wfamily('manifest', campaignId, worldlineId))
    ]);
    if (!state || !working || !manifest) return { ok: false, code: 'state_missing', message: '局部状态分片缺失' };
    const snapshot = { state, working, manifest, entities: [], relations: [], episodes: [] };

    // 只读取本次涉及的业务对象与一致性约束关系。
    const incoming = [...(input.entities ?? []), ...(input.relations ?? []), ...(input.episodes ?? [])];
    for (const id of new Set(incoming.map(r => r.id))) {
      for (const family of ['entity', 'relation', 'episode']) {
        const row = await readDoc(db, owner, wfamily(family, campaignId, worldlineId), id);
        if (row) snapshot[`${family}s`].push(row);
      }
    }
    for (const rule of manifest.consistencyRules ?? []) {
      let rel = await readDoc(db, owner, wfamily('relation', campaignId, worldlineId), rule.relationId);
      if (!rel) rel = await readIndex(db, owner, 'constraint', rule.relationId);
      if (rel && !snapshot.relations.some(r => r.id === rel.id)) snapshot.relations.push(rel);
    }

    const runtimeReceipt = input.runtimeReceipt;
    const receipts = {};
    if (runtimeReceipt?.id) {
      const roll = await q(db, 'SELECT body,consumed FROM noa_v3_rng WHERE owner_id=? AND receipt_id=?', owner, runtimeReceipt.id).first();
      if (roll?.consumed === 1) return { ok: false, code: 'runtime_receipt_consumed', message: '检定回执已被其他事件消费' };
      if (roll) receipts[runtimeReceipt.id] = { receipt: decode(roll.body).receipt };
    }
    const document = { receipts, events: { some: () => false } };
    let captured = null;
    const repo = {
      read: () => ({ ...snapshot, entities: [...snapshot.entities], relations: [...snapshot.relations], episodes: [...snapshot.episodes] }),
      write: (_c, _w, value) => { captured = value; },
      appendEvent: (_c, event) => { captured && (captured.event = event); }
    };
    const result = commitEvent(document, repo, { ...input, actor });
    if (!result?.value?.ok) return result?.value ?? { ok: false, code: 'commit_failed', message: '提交失败' };
    if (!captured) return { ok: false, code: 'commit_failed', message: '未捕获增量状态' };

    const nextVersion = head.version + 1;
    const receipt = result.value.data.receipt;
    const request = { ...input };
    delete request.actor;
    const fingerprint = hashText(encode(sortDeep(request)));
    const txBody = { receipt, result: result.value.data, fingerprint };
    const statements = [
      q(db, 'INSERT INTO noa_v3_cas_guard SELECT EXISTS(SELECT 1 FROM noa_v3_head WHERE owner_id=? AND version=?)', owner, head.version),
      q(db, 'UPDATE noa_v3_head SET version=? WHERE owner_id=? AND version=?', nextVersion, owner, head.version),
      q(db, 'DELETE FROM noa_v3_cas_guard'),
      putDocStatement(db, owner, wfamily('state', campaignId, worldlineId), '', captured.state, nextVersion),
      putDocStatement(db, owner, wfamily('working', campaignId, worldlineId), '', captured.working, nextVersion)
    ];
    for (const row of captured.entities ?? []) statements.push(putDocStatement(db, owner, wfamily('entity', campaignId, worldlineId), row.id, row, nextVersion));
    for (const row of captured.relations ?? []) statements.push(putDocStatement(db, owner, wfamily('relation', campaignId, worldlineId), row.id, row, nextVersion));
    for (const row of captured.episodes ?? []) statements.push(putDocStatement(db, owner, wfamily('episode', campaignId, worldlineId), row.id, row, nextVersion));
    statements.push(q(db, 'INSERT INTO noa_v3_tx VALUES (?,?,?,?,?,?,?,?)',
      owner, eventId, txKey, receipt.id, worldlineId, captured.event?.seq ?? 0, fingerprint, encode(txBody)));
    statements.push(q(db, `INSERT INTO noa_v3_revision VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,campaign_id,worldline_id) DO UPDATE SET revision=excluded.revision,memory_revision=excluded.memory_revision,rng_cursor=excluded.rng_cursor,state_hash=excluded.state_hash`,
      owner, campaignId, worldlineId, captured.state.revision, captured.working?.memoryRevision ?? 0,
      captured.state.rng?.cursor ?? null, hashText(encode(captured.state))));
    for (const index of (captured.event?.indexes ?? [])) {
      statements.push(q(db, 'INSERT OR REPLACE INTO noa_v3_index VALUES (?,?,?,?)', owner, index.kind, index.key, encode(index.value)));
    }
    if (runtimeReceipt?.id) {
      statements.push(q(db, 'UPDATE noa_v3_rng SET consumed=1 WHERE owner_id=? AND receipt_id=?', owner, runtimeReceipt.id));
    }
    await db.batch(statements);
    return result.value;
  } catch (error) {
    if (String(error?.message ?? '').includes('CHECK constraint failed: success=1')) {
      return { ok: false, code: 'concurrent_write', message: '并发写入冲突，请沿用原幂等键重试' };
    }
    return { ok: false, code: error?.code ?? 'v3_commit_failed', message: String(error?.message ?? error) };
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortDeep(value[k])]));
  return value;
}

/** 按 eventId / idempotencyKey / receiptId 走索引查询，不扫描全量回执。 */
export async function eventReceiptV3(db, owner, lookup, worldlineId) {
  const row = await q(db, `SELECT body FROM noa_v3_tx WHERE owner_id=? AND event_id=?
    UNION SELECT body FROM noa_v3_tx WHERE owner_id=? AND idempotency_key=?
    UNION SELECT body FROM noa_v3_tx WHERE owner_id=? AND receipt_id=? LIMIT 1`,
    owner, lookup, owner, worldlineId ? [worldlineId, lookup].join(':') : lookup, owner, lookup).first();
  return row ? ok(decode(row.body)) : fail('receipt_not_found', '未找到对应事务回执');
}

/** 有界恢复：只读 revision、最新若干 tx 和活跃待办，不加载全部历史。 */
export async function recoveryV3(db, owner, limit = 8) {
  const revision = await q(db, 'SELECT * FROM noa_v3_revision WHERE owner_id=? ORDER BY worldline_id LIMIT 1', owner).first();
  if (!revision) return fail('recovery_unavailable', '没有可恢复的世界线');
  const recent = await q(db, 'SELECT event_id,idempotency_key,receipt_id,seq,body FROM noa_v3_tx WHERE owner_id=? ORDER BY seq DESC LIMIT ?', owner, Math.min(20, limit)).all();
  const working = await readDoc(db, owner, wfamily('working', revision.campaign_id, revision.worldline_id));
  const active = await readDoc(db, owner, 'active');
  return ok({
    campaignId: revision.campaign_id, worldlineId: revision.worldline_id,
    stateRevision: revision.revision, memoryRevision: revision.memory_revision, rngCursor: revision.rng_cursor,
    scene: working?.scene ?? null,
    activeTodos: (working?.pendingEvents ?? []).filter(t => ['open', 'active'].includes(t.status)).slice(0, 12),
    recentReceipts: recent.results.map(r => ({ ...decode(r.body).receipt, seq: r.seq })),
    pendingNarratives: recent.results.filter(r => decode(r.body).receipt?.narrativeRequired && !decode(r.body).receipt?.narrativeDelivered).map(r => r.event_id)
  });
}

/** bootstrap 局部视图：只取状态摘要、人格与近期非 L3 情景路径。 */
export async function bootstrapV3(db, owner, limit = 3) {
  const active = await readDoc(db, owner, 'active');
  const campaignId = active?.campaignId ?? 'demo';
  const worldlineId = active?.worldlineId ?? 'wl-main';
  const [state, working, persona] = await Promise.all([
    readDoc(db, owner, wfamily('state', campaignId, worldlineId)),
    readDoc(db, owner, wfamily('working', campaignId, worldlineId)),
    readDoc(db, owner, 'persona')
  ]);
  if (!state || !working) return fail('bootstrap_unavailable', '局部状态缺失');
  const episodes = await q(db, `SELECT family,slot,body FROM noa_v3_doc
    WHERE owner_id=? AND family=? ORDER BY slot DESC LIMIT ?`, owner, wfamily('episode', campaignId, worldlineId), limit).all();
  return ok({
    campaignId: active?.campaignId, worldlineId: active?.worldlineId,
    revision: state.revision, memoryRevision: working.memoryRevision ?? 0, rngCursor: state.rng?.cursor ?? null,
    scene: working.scene, activeTodos: (working.pendingEvents ?? []).filter(t => ['open', 'active'].includes(t.status)).slice(0, 8),
    persona: persona ? { id: persona.id, name: persona.name } : null,
    refs: episodes.results.map(r => ({ id: r.slot, source: `episodes/${r.slot}` })),
    note: 'L3 冷归档正文不进入 bootstrap。'
  });
}

/** V3 checkpoint：首份为基准，后续只存变化的一级分片。 */
export async function checkpointV3(db, owner, opts = {}) {
  const revision = await q(db, 'SELECT campaign_id,worldline_id FROM noa_v3_revision WHERE owner_id=? ORDER BY worldline_id LIMIT 1', owner).first();
  const familyState = wfamily('state', revision?.campaign_id ?? 'demo', revision?.worldline_id ?? 'wl-main');
  const familyWorking = wfamily('working', revision?.campaign_id ?? 'demo', revision?.worldline_id ?? 'wl-main');
  const [state, working] = await Promise.all([readDoc(db, owner, familyState), readDoc(db, owner, familyWorking)]);
  if (!state || !working) return fail('checkpoint_unavailable', '状态分片缺失');
  const id = opts.id ?? `cp-${Date.now()}`;
  const parentId = opts.parentId ?? null;
  let delta = { state, working };
  if (parentId) {
    const parentRow = await q(db, 'SELECT delta FROM noa_v3_checkpoint WHERE owner_id=? AND id=?', owner, parentId).first();
    if (!parentRow) return fail('checkpoint_parent_missing', '父 checkpoint 不存在');
    const parent = decode(parentRow.delta);
    delta = {};
    if (hashText(encode(parent.state)) !== hashText(encode(state))) delta.state = state;
    if (hashText(encode(parent.working)) !== hashText(encode(working))) delta.working = working;
  }
  const body = encode(delta);
  await q(db, 'INSERT OR REPLACE INTO noa_v3_checkpoint VALUES (?,?,?,?,?,?,?,?,?)',
    owner, id, parentId, hashText(encode(state)), hashText(encode(working)),
    state.rng?.cursor ?? null, body, hashText(body), opts.createdAt ?? new Date().toISOString()).run();
  return ok({ id, parentId, stateHash: hashText(encode(state)), memoryHash: hashText(encode(working)), bytes: Buffer.byteLength(body, 'utf8') });
}

/** 回放 checkpoint 链并校验完整状态/记忆哈希，成功后原子写回。 */
export async function restoreCheckpointV3(db, owner, id) {
  const row = await q(db, 'SELECT * FROM noa_v3_checkpoint WHERE owner_id=? AND id=?', owner, id).first();
  if (!row) return fail('checkpoint_not_found', 'checkpoint 不存在');
  if (hashText(row.delta) !== row.digest) return fail('checkpoint_checksum', 'checkpoint 分片校验失败');
  const delta = decode(row.delta);
  let state = delta.state ?? null;
  let working = delta.working ?? null;
  const chain = [];
  let cursor = row.parent_id;
  const seen = new Set();
  while ((!state || !working) && cursor) {
    if (seen.has(cursor)) return fail('checkpoint_cycle', 'checkpoint 链成环');
    seen.add(cursor);
    const parent = await q(db, 'SELECT * FROM noa_v3_checkpoint WHERE owner_id=? AND id=?', owner, cursor).first();
    if (!parent) return fail('checkpoint_parent_missing', 'checkpoint 父节点不存在');
    const part = decode(parent.delta);
    state = state ?? part.state;
    working = working ?? part.working;
    chain.push(cursor);
    cursor = parent.parent_id;
  }
  if (!state || !working) return fail('checkpoint_incomplete', 'checkpoint 缺少状态或记忆');
  if (hashText(encode(state)) !== row.state_hash || hashText(encode(working)) !== row.memory_hash) {
    return fail('checkpoint_hash_mismatch', '状态或记忆哈希不一致');
  }
  const head = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
  if (!head) return fail('v3_not_initialized', 'V3 内核未初始化');
  const version = head.version + 1;
  const revision = await q(db, 'SELECT campaign_id,worldline_id FROM noa_v3_revision WHERE owner_id=? ORDER BY worldline_id LIMIT 1', owner).first();
  const statements = [
    q(db, 'UPDATE noa_v3_head SET version=? WHERE owner_id=?', version, owner),
    putDocStatement(db, owner, wfamily('state', revision?.campaign_id ?? 'demo', revision?.worldline_id ?? 'wl-main'), '', state, version),
    putDocStatement(db, owner, wfamily('working', revision?.campaign_id ?? 'demo', revision?.worldline_id ?? 'wl-main'), '', working, version)
  ];
  if (revision) statements.push(q(db, `UPDATE noa_v3_revision SET revision=?,memory_revision=?,rng_cursor=?,state_hash=? WHERE owner_id=? AND campaign_id=? AND worldline_id=?`,
    state.revision, working.memoryRevision ?? 0, state.rng?.cursor ?? null, hashText(encode(state)), owner, revision.campaign_id, revision.worldline_id));
  await db.batch(statements);
  return ok({ id, appliedChain: chain.reverse(), stateRevision: state.revision, memoryRevision: working.memoryRevision ?? 0, rngCursor: state.rng?.cursor ?? null });
}

/** 测试/迁移用：在同 owner 下复制世界线，验证 V3 分片隔离。 */
export async function createWorldlineV3(db, owner, opts) {
  const { campaignId, from, to } = opts;
  const [state, working, manifest] = await Promise.all([
    readDoc(db, owner, wfamily('state', campaignId, from)),
    readDoc(db, owner, wfamily('working', campaignId, from)),
    readDoc(db, owner, wfamily('manifest', campaignId, from))
  ]);
  if (!state || !working || !manifest) return fail('worldline_source_missing', '源世界线不存在');
  const head = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
  const version = head?.version ?? 0;
  const nextState = structuredClone(state);
  nextState.worldlineId = to;
  const nextWorking = structuredClone(working);
  nextWorking.worldlineId = to;
  const statements = [
    putDocStatement(db, owner, wfamily('state', campaignId, to), '', nextState, version),
    putDocStatement(db, owner, wfamily('working', campaignId, to), '', nextWorking, version),
    putDocStatement(db, owner, wfamily('manifest', campaignId, to), '', manifest, version),
    q(db, `INSERT INTO noa_v3_revision VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,campaign_id,worldline_id) DO UPDATE SET revision=excluded.revision,memory_revision=excluded.memory_revision,rng_cursor=excluded.rng_cursor,state_hash=excluded.state_hash`,
      owner, campaignId, to, nextState.revision, nextWorking.memoryRevision ?? 0, nextState.rng?.cursor ?? null, hashText(encode(nextState)))
  ];
  for (const family of ['entity', 'relation', 'episode']) {
    const rows = await q(db, 'SELECT slot,body FROM noa_v3_doc WHERE owner_id=? AND family=?', owner, wfamily(family, campaignId, from)).all();
    for (const row of rows.results) {
      const value = decode(row.body);
      const copy = { ...value, worldlineId: to };
      statements.push(putDocStatement(db, owner, wfamily(family, campaignId, to), row.slot, copy, version));
    }
  }
  await db.batch(statements);
  return ok({ campaignId, from, to, revision: nextState.revision });
}

/** V3 确定性检定：幂等、推进 RNG cursor，并生成可被 event_commit 消费的回执。 */
export async function runtimeExecuteV3(db, owner, input) {
  const { campaignId, worldlineId, skill, difficulty, idempotencyKey, actor } = input;
  const receiptId = `roll-${hashText([worldlineId, idempotencyKey].join(':')).slice(0, 12)}`;
  const prior = await q(db, 'SELECT body FROM noa_v3_rng WHERE owner_id=? AND receipt_id=?', owner, receiptId).first();
  if (prior) return ok({ ...decode(prior.body).result, duplicate: true });
  const head = await q(db, 'SELECT version FROM noa_v3_head WHERE owner_id=?', owner).first();
  if (!head) return fail('v3_not_initialized', 'V3 内核未初始化');
  const revision = await q(db, 'SELECT revision FROM noa_v3_revision WHERE owner_id=? AND campaign_id=? AND worldline_id=?', owner, campaignId, worldlineId).first();
  const expected = Number.isFinite(Number(input.expectedRevision)) ? Number(input.expectedRevision) : revision?.revision;
  if (revision?.revision !== expected) return fail('revision_conflict', 'revision 不匹配', { actual: revision?.revision });
  const state = await readDoc(db, owner, wfamily('state', campaignId, worldlineId));
  if (!state?.rng) return fail('rng_unavailable', 'RNG 流不可用');
  const roll = deterministicRoll({ skill: Number(skill), difficulty: Number(difficulty), seed: state.rng.seed, cursor: state.rng.cursor });
  const at = new Date().toISOString();
  const receipt = {
    id: receiptId, op: 'runtime_execute', status: 'applied', actor, at, campaignId, worldlineId,
    idempotencyKey, appliedRevision: expected + 1, value: roll.value, threshold: roll.threshold,
    success: roll.success, hash: hashText(encode({ roll, idempotencyKey }))
  };
  const nextState = structuredClone(state);
  nextState.rng.cursor = roll.cursor + 1;
  nextState.revision += 1;
  nextState.updatedAt = at;
  const version = head.version + 1;
  await db.batch([
    q(db, 'INSERT INTO noa_v3_cas_guard SELECT EXISTS(SELECT 1 FROM noa_v3_head WHERE owner_id=? AND version=?)', owner, head.version),
    q(db, 'UPDATE noa_v3_head SET version=? WHERE owner_id=? AND version=?', version, owner, head.version),
    q(db, 'DELETE FROM noa_v3_cas_guard'),
    putDocStatement(db, owner, wfamily('state', campaignId, worldlineId), '', nextState, version),
    q(db, 'INSERT INTO noa_v3_rng VALUES (?,?,?,?,?)', owner, receiptId, null, 0, encode({ receipt, result: { roll, receipt } })),
    q(db, `UPDATE noa_v3_revision SET revision=?,rng_cursor=?,state_hash=? WHERE owner_id=? AND campaign_id=? AND worldline_id=?`,
      nextState.revision, nextState.rng.cursor, hashText(encode(nextState)), owner, campaignId, worldlineId)
  ]);
  return ok({ roll, receipt, revision: nextState.revision });
}
