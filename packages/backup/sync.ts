import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readJson, writeJsonAtomic, sha256, stableStringify, isObject, ok, fail, type Result } from '../core/util.ts';
import type { SnapshotRepo, Snapshot } from '../library/store.ts';
import { assertNotStale } from '../library/reconciliation.ts';

export interface BackupEnvelope {
  format: 'noa-backup'; version: 1; mode: 'full' | 'incremental';
  campaignId: string; worldlineId: string; stateRevision: number; memoryRevision: number;
  eventSeq: number; schemaVersion: number; checkpointId: string | null; parentHash: string | null;
  contentHash: string; resultHash: string; assetRefs: { assetId: string; sha256: string; storage: string }[];
  authorityEpoch: number; createdAt: string;
  payload: { snapshot?: unknown; events?: unknown[] };
}
interface AuthorityRecord {
  epoch: number; stateRevision: number; memoryRevision: number; eventSeq: number;
  source: string; contentHash: string; importedAt: string;
}

function assetRefs(repo: SnapshotRepo): { assetId: string; sha256: string; storage: string }[] {
  const dir = join(repo.root, 'assets', 'index');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const r = readJson(join(dir, f));
    return { assetId: r.assetId, sha256: r.sha256, storage: `${r.storage.adapter}:${r.storage.key}` };
  });
}

function authorityPath(repo: SnapshotRepo, campaignId: string): string {
  return join(repo.root, 'campaigns', campaignId, 'backup', 'authority.json');
}
function readAuthority(repo: SnapshotRepo, campaignId: string, worldlineId = 'wl-main'): AuthorityRecord {
  const path = authorityPath(repo, campaignId);
  if (existsSync(path)) return readJson(path) as AuthorityRecord;
  try {
    const snap = repo.read(campaignId, worldlineId);
    return { epoch: 0, stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0, eventSeq: 0, source: 'local', contentHash: '', importedAt: '' };
  } catch {
    return { epoch: 0, stateRevision: -1, memoryRevision: -1, eventSeq: -1, source: 'unknown', contentHash: '', importedAt: '' };
  }
}
function writeAuthority(repo: SnapshotRepo, campaignId: string, record: AuthorityRecord): void {
  writeJsonAtomic(authorityPath(repo, campaignId), record);
}

function coreHash(snapshot: Snapshot): string {
  return sha256({ state: snapshot.state, entities: snapshot.entities, relations: snapshot.relations, episodes: snapshot.episodes, working: snapshot.working });
}
function finalize(envelope: Omit<BackupEnvelope, 'contentHash' | 'resultHash'> & { resultHash?: string }): BackupEnvelope {
  return { ...envelope, contentHash: sha256(stableStringify(envelope)) } as BackupEnvelope;
}

export function exportFull(repo: SnapshotRepo, campaignId: string, opts: { authorityEpoch?: number; checkpointId?: string | null; worldlineId?: string } = {}): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const authority = readAuthority(repo, campaignId, worldlineId);
  return ok(finalize({
    format: 'noa-backup', version: 1, mode: 'full', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    eventSeq: repo.events(campaignId, worldlineId).reduce((m, e) => Math.max(m, Number(e.seq ?? 0)), 0),
    schemaVersion: snap.state.schemaVersion, checkpointId: opts.checkpointId ?? null,
    parentHash: null, contentHash: '', resultHash: coreHash(snap), assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(), payload: { snapshot: snap }
  }));
}

/** parentHash 必须引用真实父备份的 contentHash。 */
export function exportIncremental(
  repo: SnapshotRepo, campaignId: string,
  since: { stateRevision: number; memoryRevision: number; seq?: number },
  opts: { authorityEpoch?: number; worldlineId?: string; parent?: BackupEnvelope } = {}
): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const authority = readAuthority(repo, campaignId, worldlineId);
  const sinceSeq = Number(since.seq ?? 0);
  const events = repo.events(campaignId, worldlineId).filter(e => Number((e as any).seq ?? 0) > sinceSeq);
  if (!opts.parent) return fail('parent_required', '增量导出必须提供真实父备份');
  const checkedParent = verify(opts.parent);
  if (!checkedParent.ok) return fail('invalid_parent', '父备份校验失败', checkedParent.details);
  if (opts.parent.campaignId !== campaignId || opts.parent.worldlineId !== worldlineId) {
    return fail('parent_mismatch', '父备份 campaign/世界线不一致');
  }
  if (opts.parent.eventSeq > sinceSeq) return fail('parent_seq_ahead', '父备份事件序号超过增量基线');
  const eventSeq = events.reduce((m, e) => Math.max(m, Number((e as any).seq ?? 0)), sinceSeq);
  return ok(finalize({
    format: 'noa-backup', version: 1, mode: 'incremental', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    eventSeq, schemaVersion: snap.state.schemaVersion, checkpointId: null,
    parentHash: opts.parent.contentHash, contentHash: '', resultHash: coreHash(snap), assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(), payload: { events }
  }));
}

export function verify(envelope: BackupEnvelope, parent?: BackupEnvelope): Result {
  if (envelope.format !== 'noa-backup' || envelope.version !== 1) return fail('invalid_envelope', '不是 noa-backup v1');
  if (!envelope.resultHash) return fail('result_hash_missing', '缺少回放结果哈希');
  const expected = sha256(stableStringify({ ...envelope, contentHash: '' }));
  if (expected !== envelope.contentHash) return fail('hash_mismatch', '内容哈希不一致', { expected, actual: envelope.contentHash });
  if (envelope.mode === 'incremental') {
    if (!envelope.parentHash) return fail('broken_chain', '增量备份缺少 parentHash');
    if (!parent) return fail('parent_required', '增量校验必须提供真实父备份');
    if (parent.contentHash !== envelope.parentHash) return fail('broken_chain', 'parentHash 与实际父备份不一致', { expected: parent.contentHash, actual: envelope.parentHash });
    if (parent.campaignId !== envelope.campaignId || parent.worldlineId !== envelope.worldlineId) return fail('parent_mismatch', '父备份 campaign/世界线不一致');
    if (envelope.eventSeq <= parent.eventSeq) return fail('seq_regression', '增量事件序号未超过父备份');
    if (envelope.stateRevision < parent.stateRevision || envelope.memoryRevision < parent.memoryRevision) return fail('version_regression', '增量版本低于父备份');
    if (envelope.schemaVersion !== parent.schemaVersion) return fail('schema_mismatch', '父子备份 schemaVersion 不一致');
  }
  return ok({ verified: true, mode: envelope.mode, stateRevision: envelope.stateRevision, memoryRevision: envelope.memoryRevision, eventSeq: envelope.eventSeq });
}

export function diff(a: BackupEnvelope, b: BackupEnvelope): Result {
  return ok({
    from: { stateRevision: a.stateRevision, memoryRevision: a.memoryRevision, authorityEpoch: a.authorityEpoch },
    to: { stateRevision: b.stateRevision, memoryRevision: b.memoryRevision, authorityEpoch: b.authorityEpoch },
    stateChanged: a.stateRevision !== b.stateRevision,
    memoryChanged: a.memoryRevision !== b.memoryRevision,
    assetChanges: a.assetRefs.filter(x => !b.assetRefs.some(y => y.assetId === x.assetId && y.sha256 === x.sha256)),
    authorityChanged: a.authorityEpoch !== b.authorityEpoch
  });
}

function mergePatch(target: any, patch: any): any {
  if (Array.isArray(patch)) return patch.slice();
  if (!isObject(patch)) return patch;
  const out: any = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) out[k] = Array.isArray(v) || isObject(v) ? mergePatch(out[k], v) : v;
  return out;
}

/** 真正的增量回放：事件按序应用，事件 ID 幂等，state/memory revision 独立追踪。 */
export function replayIncremental(
  base: Snapshot, envelope: BackupEnvelope, parent: BackupEnvelope | undefined, repo: SnapshotRepo,
  opts: { markApplied?: boolean } = {}
): Result<{ snapshot: Snapshot; applied: string[]; skipped: string[] }> {
  const checked = verify(envelope, parent);
  if (!checked.ok) return checked;
  if (envelope.mode !== 'incremental') return fail('not_incremental', '不是增量备份');
  let snapshot = structuredClone(base);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const event of (envelope.payload.events ?? []) as any[]) {
    const key = `backup:${envelope.campaignId}:${envelope.worldlineId}:${String(event.id ?? '')}`;
    if (repo.getOperation(key)) { skipped.push(String(event.id)); continue; }
    const patch = isObject(event.patch) ? event.patch : {};
    if (isObject(patch.snapshot)) {
      const restored = patch.snapshot as any;
      snapshot = structuredClone({
        manifest: restored.manifest ?? snapshot.manifest,
        state: restored.state ?? snapshot.state,
        entities: restored.entities ?? snapshot.entities,
        relations: restored.relations ?? snapshot.relations,
        episodes: restored.episodes ?? snapshot.episodes,
        working: restored.working ?? snapshot.working
      });
    } else {
      if (isObject(patch.state)) snapshot.state = mergePatch(snapshot.state, patch.state);
      if (Array.isArray(patch.entities)) snapshot.entities.push(...patch.entities);
      if (Array.isArray(patch.relations)) snapshot.relations.push(...patch.relations);
      if (Array.isArray(patch.episodes)) snapshot.episodes.push(...patch.episodes);
    }
    if (Array.isArray(event.entities)) snapshot.entities.push(...event.entities);
    if (Array.isArray(event.relations)) snapshot.relations.push(...event.relations);
    if (Array.isArray(event.episodes)) snapshot.episodes.push(...event.episodes);
    if (Number.isFinite(Number(event.stateRevision))) snapshot.state.revision = Number(event.stateRevision);
    if (Number.isFinite(Number(event.memoryRevision))) snapshot.working.memoryRevision = Number(event.memoryRevision);
    if (opts.markApplied !== false) repo.putOperation(key, { appliedAt: new Date().toISOString(), eventId: event.id });
    applied.push(String(event.id));
  }
  return ok({ snapshot, applied, skipped });
}

/** 显式导入；禁止同纪元旧状态覆盖新状态，禁止旧迁移包覆盖在线权威源。 */
export function importEnvelope(
  repo: SnapshotRepo, envelope: BackupEnvelope,
  opts: { expectedAuthorityEpoch?: number; parent?: BackupEnvelope; allowOlderState?: boolean } = {}
): Result {
  const checked = verify(envelope, opts.parent);
  if (!checked.ok) return checked;
  if (envelope.mode === 'incremental' && !opts.parent) return fail('parent_required', '增量导入必须提供真实父备份');
  const authority = readAuthority(repo, envelope.campaignId, envelope.worldlineId);
  if (opts.expectedAuthorityEpoch !== undefined && envelope.authorityEpoch !== opts.expectedAuthorityEpoch) {
    return fail('authority_epoch_conflict', 'authorityEpoch 与预期不一致', { expected: opts.expectedAuthorityEpoch, actual: envelope.authorityEpoch });
  }
  if (envelope.authorityEpoch < authority.epoch) return fail('authority_epoch_stale', '备份纪元早于当前权威源', { current: authority.epoch, incoming: envelope.authorityEpoch });
  const guard = assertNotStale(repo, { campaignId: envelope.campaignId, stateRevision: envelope.stateRevision, memoryRevision: envelope.memoryRevision });
  if (!guard.ok) return guard;
  if (!opts.allowOlderState) {
    if (envelope.stateRevision < authority.stateRevision) return fail('state_stale', '同一纪元内旧状态不得覆盖新状态', { incoming: envelope.stateRevision, current: authority.stateRevision });
    if (envelope.memoryRevision < authority.memoryRevision) return fail('memory_stale', '同一纪元内旧记忆不得覆盖新记忆', { incoming: envelope.memoryRevision, current: authority.memoryRevision });
  }

  let snapshot: Snapshot;
  if (envelope.mode === 'full') {
    const raw = envelope.payload.snapshot as any;
    if (!raw?.state || !raw?.manifest) return fail('invalid_payload', '全量备份缺少 snapshot');
    snapshot = raw;
  } else {
    const base = repo.read(envelope.campaignId, envelope.worldlineId);
    const replayed = replayIncremental(base, envelope, opts.parent, repo);
    if (!replayed.ok) return replayed;
    snapshot = replayed.data.snapshot;
  }
  if (snapshot.state.revision !== envelope.stateRevision || (snapshot.working.memoryRevision ?? 0) !== envelope.memoryRevision) {
    return fail('replay_version_mismatch', '回放版本与备份声明不一致', {
      actual: { stateRevision: snapshot.state.revision, memoryRevision: snapshot.working.memoryRevision },
      declared: { stateRevision: envelope.stateRevision, memoryRevision: envelope.memoryRevision }
    });
  }
  if (coreHash(snapshot) !== envelope.resultHash) return fail('replay_hash_mismatch', '回放内容与备份声明不一致');
  repo.writeManifest(envelope.campaignId, snapshot.manifest);
  repo.write(envelope.campaignId, envelope.worldlineId, snapshot);
  writeAuthority(repo, envelope.campaignId, {
    epoch: envelope.authorityEpoch, stateRevision: envelope.stateRevision,
    memoryRevision: envelope.memoryRevision, eventSeq: envelope.eventSeq, source: envelope.mode,
    contentHash: envelope.contentHash, importedAt: new Date().toISOString()
  });
  return ok({
    imported: true, campaignId: envelope.campaignId, worldlineId: envelope.worldlineId,
    stateRevision: snapshot.state.revision, memoryRevision: snapshot.working.memoryRevision ?? 0,
    authorityEpoch: envelope.authorityEpoch
  });
}
