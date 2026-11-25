import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readJson, writeJsonAtomic, sha256, stableStringify, isObject, ok, fail, type Result } from '../core/util.ts';
import type { SnapshotRepo, Snapshot } from '../library/store.ts';
import { assertNotStale } from '../library/reconciliation.ts';

export interface BackupEnvelope {
  format: 'noa-backup'; version: 1; mode: 'full' | 'incremental';
  campaignId: string; worldlineId: string; stateRevision: number; memoryRevision: number;
  schemaVersion: number; checkpointId: string | null; parentHash: string | null;
  contentHash: string; assetRefs: { assetId: string; sha256: string; storage: string }[];
  authorityEpoch: number; createdAt: string;
  payload: { snapshot?: unknown; events?: unknown[] };
}
interface AuthorityRecord {
  epoch: number; stateRevision: number; memoryRevision: number;
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
    return { epoch: 0, stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0, source: 'local', contentHash: '', importedAt: '' };
  } catch {
    return { epoch: 0, stateRevision: -1, memoryRevision: -1, source: 'unknown', contentHash: '', importedAt: '' };
  }
}
function writeAuthority(repo: SnapshotRepo, campaignId: string, record: AuthorityRecord): void {
  writeJsonAtomic(authorityPath(repo, campaignId), record);
}

function finalize(envelope: Omit<BackupEnvelope, 'contentHash'>): BackupEnvelope {
  return { ...envelope, contentHash: sha256(stableStringify(envelope)) };
}

export function exportFull(repo: SnapshotRepo, campaignId: string, opts: { authorityEpoch?: number; checkpointId?: string | null; worldlineId?: string } = {}): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const authority = readAuthority(repo, campaignId, worldlineId);
  return ok(finalize({
    format: 'noa-backup', version: 1, mode: 'full', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    schemaVersion: snap.state.schemaVersion, checkpointId: opts.checkpointId ?? null,
    parentHash: null, contentHash: '', assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(), payload: { snapshot: snap }
  }));
}

/** parentHash 必须引用真实父备份的 contentHash。 */
export function exportIncremental(
  repo: SnapshotRepo, campaignId: string,
  since: { stateRevision: number; memoryRevision: number },
  opts: { authorityEpoch?: number; worldlineId?: string; parent?: BackupEnvelope } = {}
): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const authority = readAuthority(repo, campaignId, worldlineId);
  const events = repo.events(campaignId, worldlineId).filter(e => {
    const seq = Number((e as any).seq ?? -1);
    const rev = Number((e as any).stateRevision ?? (e as any).revision ?? -1);
    const mem = Number((e as any).memoryRevision ?? -1);
    return seq > Math.max(since.stateRevision, since.memoryRevision) || rev > since.stateRevision || mem > since.memoryRevision;
  });
  let parentHash: string | null = null;
  if (opts.parent) {
    const checked = verify(opts.parent);
    if (!checked.ok) return fail('invalid_parent', '父备份校验失败', checked.details);
    parentHash = opts.parent.contentHash;
  } else {
    parentHash = sha256({ stateRevision: since.stateRevision, memoryRevision: since.memoryRevision });
  }
  return ok(finalize({
    format: 'noa-backup', version: 1, mode: 'incremental', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    schemaVersion: snap.state.schemaVersion, checkpointId: null,
    parentHash, contentHash: '', assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(), payload: { events }
  }));
}

export function verify(envelope: BackupEnvelope, parent?: BackupEnvelope): Result {
  if (envelope.format !== 'noa-backup' || envelope.version !== 1) return fail('invalid_envelope', '不是 noa-backup v1');
  const expected = sha256(stableStringify({ ...envelope, contentHash: '' }));
  if (expected !== envelope.contentHash) return fail('hash_mismatch', '内容哈希不一致', { expected, actual: envelope.contentHash });
  if (envelope.mode === 'incremental') {
    if (!envelope.parentHash) return fail('broken_chain', '增量备份缺少 parentHash');
    if (parent && parent.contentHash !== envelope.parentHash) return fail('broken_chain', 'parentHash 与实际父备份不一致', { expected: parent.contentHash, actual: envelope.parentHash });
  }
  return ok({ verified: true, mode: envelope.mode, stateRevision: envelope.stateRevision, memoryRevision: envelope.memoryRevision });
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
  const snapshot = structuredClone(base);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const event of (envelope.payload.events ?? []) as any[]) {
    const key = `backup:${envelope.campaignId}:${envelope.worldlineId}:${String(event.id ?? '')}`;
    if (repo.getOperation(key)) { skipped.push(String(event.id)); continue; }
    if (isObject(event.patch)) snapshot.state = mergePatch(snapshot.state, event.patch);
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
  repo.writeManifest(envelope.campaignId, snapshot.manifest);
  repo.write(envelope.campaignId, envelope.worldlineId, snapshot);
  writeAuthority(repo, envelope.campaignId, {
    epoch: envelope.authorityEpoch, stateRevision: envelope.stateRevision,
    memoryRevision: envelope.memoryRevision, source: envelope.mode,
    contentHash: envelope.contentHash, importedAt: new Date().toISOString()
  });
  return ok({
    imported: true, campaignId: envelope.campaignId, worldlineId: envelope.worldlineId,
    stateRevision: snapshot.state.revision, memoryRevision: snapshot.working.memoryRevision ?? 0,
    authorityEpoch: envelope.authorityEpoch
  });
}
