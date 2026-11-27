import state from './schemas/state.schema.json' with { type: 'json' };
import entity from './schemas/entity.schema.json' with { type: 'json' };
import relation from './schemas/relation.schema.json' with { type: 'json' };
import episode from './schemas/episode.schema.json' with { type: 'json' };
import manifest from './schemas/manifest.schema.json' with { type: 'json' };
import {
  validateSchema, sha256, newId, isObject, ok, fail,
  deterministicRoll, type Result, type Json
} from './util.ts';
import {
  checkConsistency, entityVisible, episodeVisible, applyChanges, relationVisible,
  relevanceScore, traverseGraph, type Entity, type Episode, type Relation,
  type RecallHit, type ViewContext
} from './domain.ts';
import type { Checkpoint, Snapshot, SnapshotRepo } from './store.ts';


function schemasOf(_repo: SnapshotRepo) { return { state, entity, relation, episode, manifest }; }

function opKey(campaignId: string, worldlineId: string, key: string): string {
  return `${campaignId}:${worldlineId}:${key}`;
}

function nowOf(input: Record<string, any>): string {
  return typeof input.at === 'string' ? input.at : new Date().toISOString();
}

/** 记忆层每次变更递增，物化索引用它做同版本一致性校验。 */
function bumpMemoryRevision(snap: Snapshot): void {
  snap.working = { ...snap.working, memoryRevision: (Number(snap.working.memoryRevision) || 0) + 1 };
}

function view(snapshot: Snapshot, input: Record<string, any>, worldlineId: string): ViewContext {
  return {
    viewer: input.viewer ?? 'person.player',
    worldlineId,
    asOf: input.asOf ?? '9999-12-31T23:59:59.999Z',
    includeBeliefs: input.includeBeliefs === true,
    gm: input.gm === true
  };
}

export function readState(repo: SnapshotRepo, input: { campaignId: string; worldlineId: string }): Result {
  const snap = repo.read(input.campaignId, input.worldlineId);
  return ok({ state: snap.state, revision: snap.state.revision, worldlineId: input.worldlineId });
}

export function commitState(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; expectedRevision: number;
  changes: Record<string, unknown>; idempotencyKey: string; actor: string;
  resolution?: 'state-authoritative' | 'memory-authoritative'; reason?: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const snap = repo.read(input.campaignId, input.worldlineId);
  if (snap.state.revision !== input.expectedRevision) {
    return fail('revision_conflict', `revision 不匹配：期望 ${input.expectedRevision}，实际 ${snap.state.revision}`, { actual: snap.state.revision });
  }
  if (!isObject(input.changes)) return fail('invalid_change', 'changes 必须是对象');
  let next: Record<string, any>;
  try { next = applyChanges(snap.state, input.changes); }
  catch (err: any) { return fail('invalid_change', err.message); }
  const at = nowOf(input);
  next.updatedAt = at;
  next.revision = snap.state.revision + 1;

  const validationState = snap.manifest.worldId === 'doupo' ? {
    ...next, clock: { turn: next.clock?.turn ?? 0, date: next.clock?.date ?? '', period: next.clock?.period ?? 'day' },
    rng: next.rng ?? { algorithm: 'mulberry32', seed: 0, cursor: 0 }
  } : next;
  const errors = validateSchema(validationState, schemasOf(repo).state);
  if (errors.length) return fail('schema_invalid', '状态未通过 Schema 校验', { errors });

  const ctx: ViewContext = { viewer: 'system', worldlineId: input.worldlineId, asOf: at, includeBeliefs: false };
  const conflicts = checkConsistency(next, snap.relations, snap.manifest.consistencyRules, ctx);
  if (conflicts.length) {
    if (input.resolution === 'memory-authoritative') return fail('state_memory_conflict', '按记忆权威拒绝状态变更', { conflicts });
    if (input.resolution !== 'state-authoritative') return fail('state_memory_conflict', '检测到确定性状态与语义记忆冲突，需明确 resolution', { conflicts });
    if (!input.reason?.trim()) return fail('missing_reason', 'state-authoritative 决议必须给出理由');
    for (const conflict of conflicts) {
      const rel = snap.relations.find(r => r.id === conflict.relationId);
      if (!rel) continue;
      rel.validUntil = at;
      rel.status = 'superseded';
      rel.revision += 1;
    }
  }
  if (conflicts.length) bumpMemoryRevision(snap);
  repo.write(input.campaignId, input.worldlineId, { ...snap, state: next });
  repo.appendEvent(input.campaignId, {
    id: newId('evt'), worldlineId: input.worldlineId, revision: next.revision, at,
    actor: input.actor, idempotencyKey: input.idempotencyKey, op: 'state.commit',
    changes: input.changes, conflictsResolved: conflicts.map(c => c.ruleId)
  });
  const data = { state: next, revision: next.revision, conflictsResolved: conflicts.map(c => c.ruleId) };
  repo.putOperation(key, data);
  return ok(data);
}

export function recall(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; viewer: string; query: string;
  asOf?: string; limit?: number; includeBeliefs?: boolean; gm?: boolean;
  kinds?: ('entity' | 'relation' | 'episode')[];
  includeL3?: boolean;
}): Result {
  const snap = repo.read(input.campaignId, input.worldlineId);
  const ctx = view(snap, input, input.worldlineId);
  const kinds = input.kinds ?? ['entity', 'relation', 'episode'];
  const hits: RecallHit[] = [];
  const isL3 = (row: any) => !input.includeL3 && (row?.lifecycle === 'archived' || (Array.isArray(row?.tags) && row.tags.some((t: any) => ['combat-log', 'raw-event', 'receipt', 'checkpoint', 'historical-backfill'].includes(String(t)))));
  const paths = snap.manifest.paths;

  if (kinds.includes('entity')) for (const e of snap.entities) {
    if (isL3(e)) continue;
    if (!entityVisible(e, ctx)) continue;
    const text = [e.name, e.id, ...(e.aliases ?? []), JSON.stringify(e.attributes ?? {})].join(' ');
    let score = relevanceScore(text, input.query);
    if (score > 0 && e.id === input.viewer) score += 4;
    if (score > 0) hits.push({ kind: 'entity', id: e.id, title: e.name, text, score, source: paths.entities, meta: { type: e.type } });
  }

  if (kinds.includes('relation')) for (const r of snap.relations) {
    if (isL3(r)) continue;
    if (!relationVisible(r, ctx)) continue;
    const text = [r.subject, r.predicate, r.object, r.description].join(' ');
    let score = relevanceScore(text, input.query);
    if (score > 0 && (r.subject === input.viewer || r.object === input.viewer)) score += 5;
    if (score > 0) hits.push({
      kind: 'relation', id: r.id, title: `${r.subject} ${r.predicate} ${r.object}`, text: r.description,
      score, source: paths.relations,
      meta: { epistemic: r.epistemic, holder: r.holder, confidence: r.confidence, knownBy: r.knownBy }
    });
  }

  if (kinds.includes('episode')) for (const ep of snap.episodes) {
    if (isL3(ep)) continue;
    if (!episodeVisible(ep, ctx)) continue;
    const text = [ep.title, ep.summary, ep.excerpt ?? '', ...ep.entities, ...ep.tags].join(' ');
    let score = relevanceScore(text, input.query);
    if (score > 0 && ep.entities.includes(input.viewer)) score += 3;
    if (score > 0) hits.push({
      kind: 'episode', id: ep.id, title: ep.title, text: ep.summary, score,
      source: `${paths.episodesDir}/${ep.path}`,
      meta: {
        at: ep.at, turn: ep.turn,
        relationIds: ep.relationIds.filter(id => {
          const rel = snap.relations.find(r => r.id === id);
          return rel ? relationVisible(rel, ctx) : false;
        }),
        knownBy: ep.knownBy
      }
    });
  }

  const ftsRepo = repo as SnapshotRepo & { searchFts?: (campaignId: string, worldlineId: string, query: string, limit?: number) => { id: string; snippet: string }[] };
  if (typeof ftsRepo.searchFts === 'function' && input.query.trim() && kinds.includes('episode')) {
    for (const row of ftsRepo.searchFts(input.campaignId, input.worldlineId, input.query, input.limit ?? 20)) {
      const ep = snap.episodes.find(e => e.id === row.id);
      if (!ep || !episodeVisible(ep, ctx) || hits.some(h => h.kind === 'episode' && h.id === ep.id)) continue;
      hits.push({
        kind: 'episode', id: ep.id, title: ep.title,
        text: `[FTS5] ${row.snippet} ${ep.summary}`, score: 8, source: 'episode_fts',
        meta: { at: ep.at, turn: ep.turn, knownBy: ep.knownBy, engine: 'fts5' }
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ok({ hits: hits.slice(0, input.limit ?? 20), viewer: ctx.viewer, worldlineId: ctx.worldlineId, asOf: ctx.asOf });
}

export function traverse(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; viewer: string; start: string;
  hops?: number; asOf?: string; includeBeliefs?: boolean; gm?: boolean;
}): Result {
  const snap = repo.read(input.campaignId, input.worldlineId);
  const ctx = view(snap, input, input.worldlineId);
  const hops = Math.max(1, Math.min(4, input.hops ?? 2));
  return ok(traverseGraph(input.start, hops, ctx, snap.entities, snap.relations));
}

export function recordMemory(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; kind: 'entity' | 'relation' | 'episode';
  data: Record<string, any>; idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const snap = repo.read(input.campaignId, input.worldlineId);
  const at = nowOf(input);
  const schemas = schemasOf(repo);
  const data = { ...input.data };

  if (input.kind === 'relation') {
    if (data.epistemic === 'belief' && !data.holder) return fail('belief_requires_holder', '主观认知必须标明 holder');
    const id = data.id ?? newId('rel', `${input.worldlineId}:${data.subject}:${data.predicate}:${data.object}:${data.epistemic ?? 'fact'}`);
    const duplicate = snap.relations.find(r => r.id === id || (
      r.subject === data.subject && r.predicate === data.predicate && r.object === data.object &&
      r.holder === (data.epistemic === 'belief' ? data.holder : null) &&
      r.epistemic === (data.epistemic ?? 'fact') && r.status === 'active' && r.worldlineId === input.worldlineId
    ));
    if (duplicate) {
      const result = { kind: 'relation', id: duplicate.id, deduplicated: true, relation: duplicate };
      repo.putOperation(key, result);
      return ok(result);
    }
    const row: Relation = {
      id, subject: data.subject, predicate: data.predicate, object: data.object,
      description: data.description ?? '', worldlineId: input.worldlineId,
      validFrom: data.validFrom ?? at, validUntil: data.validUntil ?? null, recordedAt: at,
      scope: data.scope ?? 'world', knownBy: data.knownBy ?? ['*'], confidence: data.confidence ?? 1,
      sourceEventId: data.sourceEventId ?? newId('ep'), epistemic: data.epistemic ?? 'fact',
      holder: data.epistemic === 'belief' ? (data.holder ?? null) : null,
      status: 'active', revision: 1, supersedes: null, idempotencyKey: input.idempotencyKey
    } as Relation;
    if (row.epistemic === 'belief') row.knownBy = [row.holder as string];
    const errors = validateSchema(row, schemas.relation);
    if (errors.length) return fail('schema_invalid', '关系未通过 Schema 校验', { errors });
    snap.relations.push(row);
    const result = { kind: 'relation', id: row.id, deduplicated: false, relation: row };
    bumpMemoryRevision(snap);
    repo.write(input.campaignId, input.worldlineId, snap);
    repo.appendEvent(input.campaignId, { id: newId('evt'), worldlineId: input.worldlineId, at, actor: input.actor, op: 'memory.record', idempotencyKey: input.idempotencyKey, refId: row.id });
    repo.putOperation(key, result);
    return ok(result);
  }

  if (input.kind === 'entity') {
    const id = data.id ?? newId(data.type ?? 'concept', `${input.worldlineId}:${data.name}`);
    const row: Entity = {
      id, type: data.type ?? 'concept', name: data.name ?? id, aliases: data.aliases ?? [],
      worldlineId: input.worldlineId, scope: data.scope ?? 'world', knownBy: data.knownBy ?? ['*'],
      attributes: data.attributes ?? {}, createdAt: at, updatedAt: at
    } as Entity;
    const errors = validateSchema(row, schemas.entity);
    if (errors.length) return fail('schema_invalid', '实体未通过 Schema 校验', { errors });
    if (snap.entities.some(e => e.id === row.id)) {
      const result = { kind: 'entity', id: row.id, deduplicated: true, entity: snap.entities.find(e => e.id === row.id) };
      repo.putOperation(key, result);
      return ok(result);
    }
    snap.entities.push(row);
    const result = { kind: 'entity', id: row.id, deduplicated: false, entity: row };
    bumpMemoryRevision(snap);
    repo.write(input.campaignId, input.worldlineId, snap);
    repo.putOperation(key, result);
    return ok(result);
  }

  const id = data.id ?? newId('ep', `${input.worldlineId}:${data.title}:${at}`);
  const row: Episode = {
    id, at, turn: data.turn ?? snap.state.clock.turn ?? 0, title: data.title ?? '未命名情景',
    summary: data.summary ?? '', excerpt: data.excerpt ?? '', worldlineId: input.worldlineId,
    entities: data.entities ?? [], relationIds: data.relationIds ?? [], knownBy: data.knownBy ?? ['*'],
    sourceEventId: data.sourceEventId ?? id, path: data.path ?? `${id}.md`, tags: data.tags ?? [],
    confidence: data.confidence ?? 1
  } as Episode;
  const errors = validateSchema(row, schemas.episode);
  if (errors.length) return fail('schema_invalid', '情景未通过 Schema 校验', { errors });
  if (snap.episodes.some(e => e.id === row.id)) {
    const result = { kind: 'episode', id: row.id, deduplicated: true };
    repo.putOperation(key, result);
    return ok(result);
  }
  snap.episodes.push(row);
  const result = { kind: 'episode', id: row.id, deduplicated: false, episode: row };
  bumpMemoryRevision(snap);
  repo.write(input.campaignId, input.worldlineId, snap);
  repo.appendEvent(input.campaignId, { id: newId('evt'), worldlineId: input.worldlineId, at, actor: input.actor, op: 'memory.record', idempotencyKey: input.idempotencyKey, refId: row.id });
  repo.putOperation(key, result);
  return ok(result);
}

export function reviseMemory(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; kind: 'relation' | 'entity' | 'episode';
  id: string; expectedRevision: number; patch: Record<string, any>;
  idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const snap = repo.read(input.campaignId, input.worldlineId);
  const at = nowOf(input);
  if (input.kind === 'relation') {
    const old = snap.relations.find(r => r.id === input.id);
    if (!old) return fail('not_found', `关系 ${input.id} 不存在`);
    if (old.revision !== input.expectedRevision) return fail('revision_conflict', `关系 revision 期望 ${input.expectedRevision}，实际 ${old.revision}`);
    old.validUntil = at;
    old.status = 'superseded';
    old.revision += 1;
    const next: Relation = {
      ...old, ...input.patch,
      id: input.patch.id ?? newId('rel', `${old.id}:r${old.revision + 1}:${at}`),
      validFrom: at, validUntil: null, recordedAt: at, status: 'active', revision: 1,
      supersedes: old.id, worldlineId: input.worldlineId, idempotencyKey: input.idempotencyKey
    } as Relation;
    if (snap.relations.some(r => r.id === next.id)) return fail('duplicate_id', '关系 ID 已存在');
    if (next.epistemic === 'belief') {
      if (!next.holder) return fail('belief_requires_holder', '主观认知必须标明 holder');
      next.knownBy = [next.holder];
    } else next.holder = null;
    const errors = validateSchema(next, schemasOf(repo).relation);
    if (errors.length) return fail('schema_invalid', '修正后的关系未通过 Schema 校验', { errors });
    snap.relations.push(next);
    bumpMemoryRevision(snap);
    repo.write(input.campaignId, input.worldlineId, snap);
    const result = { oldId: old.id, newId: next.id, relation: next };
    repo.appendEvent(input.campaignId, { id: newId('evt'), worldlineId: input.worldlineId, at, actor: input.actor, op: 'memory.revise', idempotencyKey: input.idempotencyKey, oldId: old.id, newId: next.id });
    repo.putOperation(key, result);
    return ok(result);
  }
  const keyOfKind = input.kind === 'entity' ? 'entities' : 'episodes';
  const list = snap[keyOfKind] as (Entity | Episode)[];
  const item = list.find(r => r.id === input.id);
  if (!item) return fail('not_found', `${input.kind} ${input.id} 不存在`);
  if (snap.working.memoryRevision !== input.expectedRevision) {
    return fail('revision_conflict', 'memoryRevision 不匹配', { actual: snap.working.memoryRevision });
  }
  const next = { ...item, ...input.patch, id: item.id, worldlineId: input.worldlineId };
  if (input.kind === 'entity') next.updatedAt = at;
  const errors = validateSchema(next, schemasOf(repo)[input.kind]);
  if (errors.length) return fail('schema_invalid', '修正后的记忆未通过 Schema 校验', { errors });
  list[list.indexOf(item)] = next;
  bumpMemoryRevision(snap);
  repo.write(input.campaignId, input.worldlineId, snap);
  const result = { id: item.id, item: next, memoryRevision: snap.working.memoryRevision };
  repo.putOperation(key, result);
  return ok(result);
}

export function consolidate(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const snap = repo.read(input.campaignId, input.worldlineId);
  const at = nowOf(input);
  const groups = new Map<string, Relation[]>();
  for (const r of snap.relations) {
    if (r.status !== 'active' || r.worldlineId !== input.worldlineId) continue;
    const k = [r.subject, r.predicate, r.object, r.epistemic, r.holder ?? ''].join('|');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      dup.status = 'superseded';
      dup.validUntil = at;
      dup.revision += 1;
      merged++;
    }
  }
  snap.working = { ...snap.working, lastConsolidatedAt: at };
  bumpMemoryRevision(snap);
  repo.write(input.campaignId, input.worldlineId, snap);
  const result = { mergedRelations: merged, groups: groups.size };
  repo.putOperation(key, result);
  return ok(result);
}

export function checkpoint(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; label: string; id?: string; at?: string;
}): Result {
  const snap = repo.read(input.campaignId, input.worldlineId);
  const at = nowOf(input);
  const cp: Checkpoint = {
    id: input.id ?? newId('cp', `${input.campaignId}:${input.worldlineId}:${at}`),
    campaignId: input.campaignId, worldlineId: input.worldlineId, label: input.label,
    createdAt: at, snapshot: structuredClone(snap),
    stateHash: sha256(snap.state),
    memoryHash: sha256({ entities: snap.entities, relations: snap.relations, episodes: snap.episodes, working: snap.working })
  };
  repo.saveCheckpoint(input.campaignId, cp);
  return ok({ checkpointId: cp.id, stateHash: cp.stateHash, memoryHash: cp.memoryHash, worldlineId: cp.worldlineId });
}

export function restore(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; checkpointId: string;
  idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const cp = repo.loadCheckpoint(input.campaignId, input.checkpointId);
  if (!cp) return fail('checkpoint_not_found', `快照 ${input.checkpointId} 不存在`);
  if (cp.worldlineId !== input.worldlineId) return fail('worldline_mismatch', '快照属于另一条世界线');
  repo.write(input.campaignId, input.worldlineId, structuredClone(cp.snapshot));
  repo.appendEvent(input.campaignId, {
    id: newId('evt'), worldlineId: input.worldlineId, at: nowOf(input), actor: input.actor,
    op: 'save.restore', idempotencyKey: input.idempotencyKey, checkpointId: cp.id,
    revision: cp.snapshot.state.revision, rngCursor: cp.snapshot.state.rng?.cursor ?? null
  });
  const data = { checkpointId: cp.id, worldlineId: cp.worldlineId, revision: cp.snapshot.state.revision, stateHash: cp.stateHash, memoryHash: cp.memoryHash };
  repo.putOperation(key, data);
  return ok(data);
}

export function forkWorldline(repo: SnapshotRepo, input: {
  campaignId: string; from?: string; to: string; idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.to, input.idempotencyKey);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  if (!/^wl-[a-zA-Z0-9_-]+$/.test(input.to)) return fail('invalid_worldline', 'worldlineId 必须匹配 ^wl-[a-zA-Z0-9_-]+$');
  if (repo.listWorldlines(input.campaignId).includes(input.to)) return fail('worldline_exists', `世界线 ${input.to} 已存在`);
  const from = input.from ?? repo.listCampaigns().find(c => c.id === input.campaignId)?.worldlineId ?? 'wl-main';
  const snap = structuredClone(repo.read(input.campaignId, from));
  snap.state.worldlineId = input.to;
  snap.state.docId = `${snap.state.docId}-${input.to}`;
  for (const row of [...snap.entities, ...snap.relations, ...snap.episodes]) row.worldlineId = input.to;
  snap.working = { ...snap.working, worldlineId: input.to, forkedFrom: from, durable: false };
  repo.createWorldline(input.campaignId, from, input.to, snap);
  repo.appendEvent(input.campaignId, {
    id: newId('evt'), worldlineId: input.to, at: nowOf(input), actor: input.actor,
    op: 'worldline.fork', idempotencyKey: input.idempotencyKey, forkedFrom: from
  });
  const data = { worldlineId: input.to, forkedFrom: from, revision: snap.state.revision };
  repo.putOperation(key, data);
  return ok(data);
}

export function executeRoll(repo: SnapshotRepo, input: {
  campaignId: string; worldlineId: string; skill: number; difficulty: number;
  idempotencyKey: string; actor: string; at?: string;
}): Result {
  const key = opKey(input.campaignId, input.worldlineId, `roll:${input.idempotencyKey}`);
  const cached = repo.getOperation(key);
  if (cached) return ok(cached);
  const snap = repo.read(input.campaignId, input.worldlineId);
  const at = nowOf(input);
  const roll = deterministicRoll({
    skill: Number(input.skill), difficulty: Number(input.difficulty),
    seed: snap.state.rng.seed, cursor: snap.state.rng.cursor
  });
  if (!Number.isFinite(roll.threshold)) return fail('invalid_roll', '检定参数必须是有限数字');
  const commit = commitState(repo, {
    campaignId: input.campaignId, worldlineId: input.worldlineId,
    expectedRevision: snap.state.revision, changes: { rngCursor: roll.cursor + 1 },
    idempotencyKey: `roll:${input.idempotencyKey}`, actor: input.actor, at
  });
  if (!commit.ok) return commit;
  const data = { roll, revision: commit.data.revision };
  repo.putOperation(key, data);
  return ok(data);
}

export function exportBundle(repo: SnapshotRepo, input: { campaignId: string; at?: string }): Result {
  const worldlines = repo.listWorldlines(input.campaignId);
  if (!worldlines.length) return fail('campaign_not_found', `campaign ${input.campaignId} 不存在`);
  const base = repo.read(input.campaignId, worldlines[0]);
  const snapshots: Record<string, Snapshot> = {};
  for (const wl of worldlines) snapshots[wl] = repo.read(input.campaignId, wl);
  const bundle = {
    format: 'noa-bundle', version: 1, exportedAt: nowOf(input), campaignId: input.campaignId,
    manifest: base.manifest, snapshots, checkpoints: repo.listCheckpoints(input.campaignId)
  };
  return ok(bundle);
}

export function importBundle(repo: SnapshotRepo, input: { bundle: any }): Result {
  const bundle = input.bundle;
  if (!isObject(bundle) || bundle.format !== 'noa-bundle' || bundle.version !== 1) return fail('invalid_bundle', '不是有效的 noa-bundle v1');
  const campaignId = bundle.campaignId as string;
  if (typeof campaignId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(campaignId)) return fail('invalid_bundle', 'campaignId 非法');
  const errors = validateSchema(bundle.manifest, schemasOf(repo).manifest);
  if (errors.length) return fail('schema_invalid', 'bundle manifest 校验失败', { errors });
  repo.writeManifest(campaignId, bundle.manifest as any);
  for (const [wl, snapshot] of Object.entries(bundle.snapshots as Record<string, Snapshot>)) {
    repo.write(campaignId, wl, snapshot);
  }
  for (const cp of (bundle.checkpoints as Checkpoint[]) ?? []) repo.saveCheckpoint(campaignId, cp);
  return ok({ campaignId, worldlines: Object.keys(bundle.snapshots as object) });
}

