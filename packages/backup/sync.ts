import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readJson, writeJsonAtomic, sha256, stableStringify, ok, fail, type Result } from '../core/util.ts';
import type { SnapshotRepo } from '../library/store.ts';

export interface BackupEnvelope {
  format: 'noa-backup'; version: 1; mode: 'full' | 'incremental';
  campaignId: string; worldlineId: string; stateRevision: number; memoryRevision: number;
  schemaVersion: number; checkpointId: string | null; parentHash: string | null;
  contentHash: string; assetRefs: { assetId: string; sha256: string; storage: string }[];
  authorityEpoch: number; createdAt: string;
  payload: { snapshot?: unknown; events?: unknown[] };
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
function readAuthority(repo: SnapshotRepo, campaignId: string): { epoch: number; source: string } {
  const path = authorityPath(repo, campaignId);
  return existsSync(path) ? readJson(path) : { epoch: 0, source: 'unknown' };
}

function finalize(envelope: Omit<BackupEnvelope, 'contentHash'>): BackupEnvelope {
  const contentHash = sha256(stableStringify(envelope));
  return { ...envelope, contentHash };
}

export function exportFull(repo: SnapshotRepo, campaignId: string, opts: { authorityEpoch?: number; checkpointId?: string | null; worldlineId?: string } = {}): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const authority = readAuthority(repo, campaignId);
  const envelope = finalize({
    format: 'noa-backup', version: 1, mode: 'full', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    schemaVersion: snap.state.schemaVersion, checkpointId: opts.checkpointId ?? null,
    parentHash: null, contentHash: '', assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(),
    payload: { snapshot: snap }
  });
  return ok(envelope);
}

export function exportIncremental(repo: SnapshotRepo, campaignId: string, since: { stateRevision: number; memoryRevision: number }, opts: { authorityEpoch?: number; worldlineId?: string } = {}): Result {
  const worldlineId = opts.worldlineId ?? 'wl-main';
  const snap = repo.read(campaignId, worldlineId);
  const events = repo.events(campaignId, worldlineId).filter(e => {
    const rev = Number((e as any).revision ?? -1);
    return rev > since.stateRevision;
  });
  const authority = readAuthority(repo, campaignId);
  const envelope = finalize({
    format: 'noa-backup', version: 1, mode: 'incremental', campaignId, worldlineId,
    stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
    schemaVersion: snap.state.schemaVersion, checkpointId: null,
    parentHash: sha256({ stateRevision: since.stateRevision, memoryRevision: since.memoryRevision }),
    contentHash: '', assetRefs: assetRefs(repo),
    authorityEpoch: opts.authorityEpoch ?? authority.epoch,
    createdAt: new Date().toISOString(), payload: { events }
  });
  return ok(envelope);
}

export function verify(envelope: BackupEnvelope): Result {
  if (envelope.format !== 'noa-backup' || envelope.version !== 1) return fail('invalid_envelope', '不是 noa-backup v1');
  const expected = sha256(stableStringify({ ...envelope, contentHash: '' }));
  if (expected !== envelope.contentHash) return fail('hash_mismatch', '内容哈希不一致', { expected, actual: envelope.contentHash });
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

/** 显式导入；authorityEpoch 必须单调递增，禁止静默双主覆盖。 */
export function importEnvelope(repo: SnapshotRepo, envelope: BackupEnvelope, opts: { expectedAuthorityEpoch?: number; allowOlderState?: boolean } = {}): Result {
  const checked = verify(envelope);
  if (!checked.ok) return checked;
  const authority = readAuthority(repo, envelope.campaignId);
  if (opts.expectedAuthorityEpoch !== undefined && envelope.authorityEpoch !== opts.expectedAuthorityEpoch) {
    return fail('authority_epoch_conflict', 'authorityEpoch 与预期不一致', { expected: opts.expectedAuthorityEpoch, actual: envelope.authorityEpoch });
  }
  if (envelope.authorityEpoch < authority.epoch) return fail('authority_epoch_stale', '备份纪元早于当前权威源', { current: authority.epoch, incoming: envelope.authorityEpoch });
  if (envelope.mode === 'incremental') return ok({ imported: false, reason: 'incremental-needs-base', events: (envelope.payload.events ?? []).length });
  const snapshot = envelope.payload.snapshot as any;
  if (!snapshot?.state || !snapshot?.manifest) return fail('invalid_payload', '全量备份缺少 snapshot');
  if (!opts.allowOlderState && snapshot.state.revision < authority.epoch) {
    return fail('state_stale', '备份状态修订号过旧', { incoming: snapshot.state.revision });
  }
  repo.writeManifest(envelope.campaignId, snapshot.manifest);
  repo.write(envelope.campaignId, envelope.worldlineId, snapshot);
  writeJsonAtomic(authorityPath(repo, envelope.campaignId), {
    epoch: envelope.authorityEpoch, source: envelope.mode, importedAt: new Date().toISOString(), contentHash: envelope.contentHash
  });
  return ok({ imported: true, campaignId: envelope.campaignId, worldlineId: envelope.worldlineId, revision: snapshot.state.revision, authorityEpoch: envelope.authorityEpoch });
}
