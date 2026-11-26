import { createHash } from 'node:crypto';
import type { Checkpoint, Snapshot, SnapshotRepo } from '../library/store.ts';
import { sha256, stableStringify, type Result } from '../core/shared.ts';

/** 平台无关的存储契约标识；具体实现分别落在 Node/Worker 侧。 */
export type StorageBackend = 'fs' | 'sqlite' | 'd1' | 'memory';
export interface StorageAdapter extends SnapshotRepo { readonly backend: StorageBackend }

/** 内存适配器：用于跨平台契约测试，语义与 FsStore/SQLite 一致。 */
export class MemorySnapshotRepo implements StorageAdapter {
  readonly backend: StorageBackend = 'memory';
  readonly root: string;
  constructor(root = ':memory:') { this.root = root; }
  private manifests = new Map<string, any>();
  private snapshots = new Map<string, Snapshot>();
  private events = new Map<string, Record<string, unknown>[]>();
  private ops = new Map<string, Record<string, unknown>>();
  private checkpoints = new Map<string, Checkpoint>();

  private key(campaignId: string, worldlineId: string): string { return `${campaignId}::${worldlineId}`; }
  private clone<T>(value: T): T { return structuredClone(value); }
  read(campaignId: string, worldlineId: string): Snapshot {
    const snap = this.snapshots.get(this.key(campaignId, worldlineId));
    if (!snap) throw new Error(`世界线 ${worldlineId} 不存在`);
    return this.clone(snap);
  }
  write(campaignId: string, worldlineId: string, snapshot: Snapshot): void {
    this.snapshots.set(this.key(campaignId, worldlineId), this.clone(snapshot));
  }
  patch(campaignId: string, worldlineId: string, snapshot: Snapshot): void { this.write(campaignId, worldlineId, snapshot); }
  writeManifest(campaignId: string, manifest: any): void { this.manifests.set(campaignId, this.clone(manifest)); }
  nextEventSeq(campaignId: string): number {
    return [...this.events.entries()]
      .filter(([k]) => k.startsWith(`${campaignId}::`))
      .flatMap(([, rows]) => rows)
      .reduce((m, e) => Math.max(m, Number(e.seq ?? 0)), 0) + 1;
  }
  appendEvent(campaignId: string, event: Record<string, unknown>): void {
    const key = this.key(campaignId, String(event.worldlineId));
    const rows = this.events.get(key) ?? [];
    rows.push({ seq: event.seq ?? this.nextEventSeq(campaignId), ...this.clone(event) });
    this.events.set(key, rows);
  }
  commit(campaignId: string, worldlineId: string, snapshot: Snapshot, event: Record<string, unknown>): void {
    const previous = this.snapshots.has(this.key(campaignId, worldlineId)) ? this.read(campaignId, worldlineId) : null;
    try {
      this.write(campaignId, worldlineId, snapshot);
      this.appendEvent(campaignId, { ...event, worldlineId });
      this.putOperation(`evt:${campaignId}:${worldlineId}:${event.id}`, { appliedAt: new Date().toISOString(), eventId: event.id });
    } catch (err) {
      if (previous) this.write(campaignId, worldlineId, previous);
      throw err;
    }
  }
  events(campaignId: string, worldlineId: string): Record<string, unknown>[] {
    return this.clone(this.events.get(this.key(campaignId, worldlineId)) ?? []);
  }
  getOperation(key: string): Record<string, unknown> | null { return this.ops.has(key) ? this.clone(this.ops.get(key)!) : null; }
  putOperation(key: string, result: Record<string, unknown>): void { this.ops.set(key, this.clone(result)); }
  saveCheckpoint(campaignId: string, cp: Checkpoint): void { this.checkpoints.set(`${campaignId}::${cp.id}`, this.clone(cp)); }
  loadCheckpoint(campaignId: string, checkpointId: string): Checkpoint | null {
    const cp = this.checkpoints.get(`${campaignId}::${checkpointId}`);
    return cp ? this.clone(cp) : null;
  }
  listCheckpoints(campaignId: string): Checkpoint[] {
    return [...this.checkpoints.entries()].filter(([k]) => k.startsWith(`${campaignId}::`)).map(([, v]) => this.clone(v));
  }
  deleteCheckpoint(campaignId: string, checkpointId: string): void { this.checkpoints.delete(`${campaignId}::${checkpointId}`); }
  listCampaigns(): { id: string; worldlineId: string; title: string }[] {
    return [...this.manifests.entries()].map(([id, m]) => ({ id, worldlineId: m.worldlineId, title: m.title }));
  }
  listWorldlines(campaignId: string): string[] {
    const keys = [...this.snapshots.keys()].filter(k => k.startsWith(`${campaignId}::`)).map(k => k.split('::')[1]);
    const main = this.manifests.get(campaignId)?.worldlineId ?? 'wl-main';
    return [main, ...keys.filter(k => k !== main)];
  }
  createWorldline(campaignId: string, _from: string, to: string, snapshot: Snapshot): void {
    this.write(campaignId, to, snapshot);
  }
}

/** D1 侧保留生产迁移表结构与分片编码契约；实际执行仍由 Worker 的 storage-v2 承担。 */
export const D1_SCHEMA = {
  head: 'CREATE TABLE IF NOT EXISTS noa_head (owner_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, version INTEGER NOT NULL, migration TEXT NOT NULL)',
  shard: 'CREATE TABLE IF NOT EXISTS noa_shard (owner_id TEXT NOT NULL, epoch TEXT NOT NULL, family TEXT NOT NULL, slot TEXT NOT NULL, ordinal INTEGER NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 240000), digest TEXT NOT NULL, PRIMARY KEY(owner_id,epoch,family,slot,part)) WITHOUT ROWID',
  guard: 'CREATE TABLE IF NOT EXISTS noa_cas_guard (success INTEGER CHECK(success=1))',
  fence: "CREATE TRIGGER IF NOT EXISTS noa_v1_fence BEFORE UPDATE ON noa_vault WHEN EXISTS (SELECT 1 FROM noa_head WHERE owner_id=OLD.owner_id) BEGIN SELECT RAISE(ABORT,'noa_v2_active'); END"
};

export function d1ShardKey(campaignId: string, worldlineId: string): { family: string; slot: string } {
  return { family: 'snapshot', slot: `${campaignId}::${worldlineId}` };
}
export function encodeD1Shard(snapshot: Snapshot): { body: string; digest: string } {
  const body = stableStringify(snapshot);
  return { body, digest: sha256(snapshot) };
}
export function decodeD1Shard(body: string): Snapshot { return JSON.parse(body) as Snapshot; }

/** Node 侧 SQLite 适配器：与内存/FS 适配器共享同一 SnapshotRepo 契约。 */
export class SqliteStorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'sqlite';
  private repo: SnapshotRepo;
  constructor(repo: SnapshotRepo) { this.repo = repo; }
  get root(): string { return this.repo.root; }
  read(c: string, w: string): Snapshot { return this.repo.read(c, w); }
  write(c: string, w: string, s: Snapshot): void { this.repo.write(c, w, s); }
  patch?(c: string, w: string, s: Snapshot): void { this.repo.patch?.(c, w, s) ?? this.repo.write(c, w, s); }
  nextEventSeq?(c: string): number { return this.repo.nextEventSeq?.(c) ?? 0; }
  commit?(c: string, w: string, s: Snapshot, e: Record<string, unknown>): void {
    if (this.repo.commit) this.repo.commit(c, w, s, e); else this.repo.write(c, w, s);
  }
  writeManifest(c: string, m: any): void { this.repo.writeManifest(c, m); }
  appendEvent(c: string, e: Record<string, unknown>): void { this.repo.appendEvent(c, e); }
  events(c: string, w: string): Record<string, unknown>[] { return this.repo.events(c, w); }
  getOperation(k: string): Record<string, unknown> | null { return this.repo.getOperation(k); }
  putOperation(k: string, v: Record<string, unknown>): void { this.repo.putOperation(k, v); }
  saveCheckpoint(c: string, cp: Checkpoint): void { this.repo.saveCheckpoint(c, cp); }
  loadCheckpoint(c: string, cp: string): Checkpoint | null { return this.repo.loadCheckpoint(c, cp); }
  listCheckpoints(c: string): Checkpoint[] { return this.repo.listCheckpoints(c); }
  deleteCheckpoint?(c: string, id: string): void { this.repo.deleteCheckpoint?.(c, id); }
  listCampaigns(): { id: string; worldlineId: string; title: string }[] { return this.repo.listCampaigns(); }
  listWorldlines(c: string): string[] { return this.repo.listWorldlines(c); }
  createWorldline(c: string, from: string, to: string, s: Snapshot): void { this.repo.createWorldline(c, from, to, s); }
}

/** 跨平台摘要：屏蔽 backend 差异后比较同一业务结果。 */
export function snapshotDigest(repo: SnapshotRepo, campaignId: string, worldlineId: string): Result<{ hash: string; stateRevision: number; memoryRevision: number }> {
  try {
    const snap = repo.read(campaignId, worldlineId);
    const byId = (rows: any[]) => [...rows].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    const hash = createHash('sha256').update(stableStringify({
      state: snap.state, entities: byId(snap.entities), relations: byId(snap.relations),
      episodes: byId(snap.episodes), working: snap.working
    })).digest('hex');
    return { ok: true, data: { hash, stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0 } };
  } catch (err: any) { return { ok: false, code: 'snapshot_unavailable', message: String(err?.message ?? err) }; }
}
