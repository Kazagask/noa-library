import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readText, parseYaml, stableStringify } from '../core/util.ts';
import type { CampaignManifest, Entity, Episode, Relation } from '../library/domain.ts';
import type { Checkpoint, Snapshot, SnapshotRepo } from '../library/store.ts';

/** P1：SQLite 权威存储。worldlines 表保存完整快照，派生表用于索引与检索。 */
export class SqliteStore implements SnapshotRepo {
  readonly root: string;
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(root: string, dbPath: string) {
    this.root = root;
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worldlines (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, body TEXT NOT NULL, at TEXT);
      CREATE INDEX IF NOT EXISTS idx_events_cw ON events(campaign_id, worldline_id);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_docs (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id));
      CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE TABLE IF NOT EXISTS relations (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, subject TEXT, predicate TEXT, object TEXT, valid_until TEXT, epistemic TEXT, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE INDEX IF NOT EXISTS idx_rel_subject ON relations(campaign_id, worldline_id, subject);
      CREATE INDEX IF NOT EXISTS idx_rel_object ON relations(campaign_id, worldline_id, object);
      CREATE TABLE IF NOT EXISTS episodes (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(id UNINDEXED, title, summary, excerpt, tags);
    `);
  }

  close(): void { this.db.close(); }

  private manifest(campaignId: string): CampaignManifest {
    const row = this.db.prepare('SELECT manifest FROM campaigns WHERE id = ?').get(campaignId) as { manifest: string } | undefined;
    if (!row) throw new Error(`campaign ${campaignId} 不存在`);
    return JSON.parse(row.manifest) as CampaignManifest;
  }

  private loadSnapshot(campaignId: string, worldlineId: string): Snapshot {
    const row = this.db.prepare('SELECT snapshot FROM worldlines WHERE campaign_id = ? AND worldline_id = ?').get(campaignId, worldlineId) as { snapshot: string } | undefined;
    if (!row) throw new Error(`世界线 ${worldlineId} 不存在`);
    const data = JSON.parse(row.snapshot);
    return { manifest: this.manifest(campaignId), state: data.state, entities: data.entities, relations: data.relations, episodes: data.episodes, working: data.working };
  }

  read(campaignId: string, worldlineId: string): Snapshot { return this.loadSnapshot(campaignId, worldlineId); }

  write(campaignId: string, worldlineId: string, snapshot: Snapshot): void {
    const tx = this.db.prepare('BEGIN IMMEDIATE');
    tx.run();
    try {
      this.db.prepare('INSERT OR REPLACE INTO campaigns(id, manifest) VALUES (?, ?)').run(campaignId, stableStringify(snapshot.manifest));
      this.db.prepare('INSERT OR REPLACE INTO worldlines(campaign_id, worldline_id, snapshot) VALUES (?, ?, ?)').run(campaignId, worldlineId, stableStringify({
        state: snapshot.state, entities: snapshot.entities, relations: snapshot.relations,
        episodes: snapshot.episodes, working: snapshot.working
      }));
      this.db.prepare('INSERT OR REPLACE INTO state_docs(campaign_id, worldline_id, revision, body) VALUES (?, ?, ?, ?)').run(campaignId, worldlineId, snapshot.state.revision, stableStringify(snapshot.state));

      this.db.prepare('DELETE FROM entities WHERE campaign_id = ? AND worldline_id = ?').run(campaignId, worldlineId);
      const insEntity = this.db.prepare('INSERT INTO entities(campaign_id, worldline_id, id, body) VALUES (?, ?, ?, ?)');
      for (const e of snapshot.entities as Entity[]) insEntity.run(campaignId, worldlineId, e.id, stableStringify(e));

      this.db.prepare('DELETE FROM relations WHERE campaign_id = ? AND worldline_id = ?').run(campaignId, worldlineId);
      const insRel = this.db.prepare('INSERT INTO relations(campaign_id, worldline_id, id, subject, predicate, object, valid_until, epistemic, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of snapshot.relations as Relation[]) {
        insRel.run(campaignId, worldlineId, r.id, r.subject, r.predicate, r.object, r.validUntil, r.epistemic, stableStringify(r));
      }

      this.db.prepare('DELETE FROM episodes WHERE campaign_id = ? AND worldline_id = ?').run(campaignId, worldlineId);
      this.db.prepare('DELETE FROM episode_fts WHERE id IN (SELECT id FROM episodes WHERE campaign_id = ? AND worldline_id = ?)').run(campaignId, worldlineId);
      const insEp = this.db.prepare('INSERT INTO episodes(campaign_id, worldline_id, id, body) VALUES (?, ?, ?, ?)');
      const insFts = this.db.prepare('INSERT INTO episode_fts(id, title, summary, excerpt, tags) VALUES (?, ?, ?, ?, ?)');
      for (const e of snapshot.episodes as Episode[]) {
        insEp.run(campaignId, worldlineId, e.id, stableStringify(e));
        insFts.run(e.id, e.title, e.summary, e.excerpt ?? '', e.tags.join(' '));
      }
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  writeManifest(campaignId: string, manifest: CampaignManifest): void {
    this.db.prepare('INSERT OR REPLACE INTO campaigns(id, manifest) VALUES (?, ?)').run(campaignId, stableStringify(manifest));
  }

  appendEvent(campaignId: string, event: Record<string, unknown>): void {
    this.db.prepare('INSERT OR REPLACE INTO events(id, campaign_id, worldline_id, body, at) VALUES (?, ?, ?, ?, ?)')
      .run(String(event.id), campaignId, String(event.worldlineId), stableStringify(event), String(event.at ?? ''));
  }

  events(campaignId: string, worldlineId: string): Record<string, unknown>[] {
    const rows = this.db.prepare('SELECT body FROM events WHERE campaign_id = ? AND worldline_id = ? ORDER BY at').all(campaignId, worldlineId) as { body: string }[];
    return rows.map(r => JSON.parse(r.body));
  }

  getOperation(key: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT result FROM operations WHERE key = ?').get(key) as { result: string } | undefined;
    return row ? JSON.parse(row.result) : null;
  }

  putOperation(key: string, result: Record<string, unknown>): void {
    this.db.prepare('INSERT OR REPLACE INTO operations(key, result, created_at) VALUES (?, ?, ?)').run(key, stableStringify(result), new Date().toISOString());
  }

  saveCheckpoint(campaignId: string, checkpoint: Checkpoint): void {
    this.db.prepare('INSERT OR REPLACE INTO checkpoints(id, campaign_id, body) VALUES (?, ?, ?)').run(checkpoint.id, campaignId, stableStringify(checkpoint));
  }

  loadCheckpoint(campaignId: string, checkpointId: string): Checkpoint | null {
    const row = this.db.prepare('SELECT body FROM checkpoints WHERE id = ? AND campaign_id = ?').get(checkpointId, campaignId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Checkpoint : null;
  }

  listCheckpoints(campaignId: string): Checkpoint[] {
    const rows = this.db.prepare('SELECT body FROM checkpoints WHERE campaign_id = ?').all(campaignId) as { body: string }[];
    return rows.map(r => JSON.parse(r.body) as Checkpoint);
  }

  listCampaigns(): { id: string; worldlineId: string; title: string }[] {
    const rows = this.db.prepare('SELECT id, manifest FROM campaigns').all() as { id: string; manifest: string }[];
    return rows.map(r => {
      const m = JSON.parse(r.manifest) as CampaignManifest;
      return { id: r.id, worldlineId: m.worldlineId, title: m.title };
    });
  }

  listWorldlines(campaignId: string): string[] {
    const rows = this.db.prepare('SELECT worldline_id FROM worldlines WHERE campaign_id = ?').all(campaignId) as { worldline_id: string }[];
    const manifest = this.manifest(campaignId);
    return [manifest.worldlineId, ...rows.map(r => r.worldline_id).filter(w => w !== manifest.worldlineId)];
  }

  createWorldline(campaignId: string, from: string, to: string, snapshot: Snapshot): void {
    void from;
    this.write(campaignId, to, snapshot);
  }

  /** FTS5 全文检索：只返回 id 与匹配片段，权限过滤由 domain 层完成。 */
  searchFts(campaignId: string, worldlineId: string, query: string, limit = 20): { id: string; snippet: string }[] {
    if (!query.trim()) return [];
    const phrase = `"${query.replace(/"/g, '""')}"`;
    try {
      return (this.db.prepare(`
        SELECT e.id AS id, snippet(episode_fts, 1, '', '', '…', 24) AS snippet
        FROM episode_fts JOIN episodes e ON e.id = episode_fts.id
        WHERE e.campaign_id = ? AND e.worldline_id = ? AND episode_fts MATCH ? LIMIT ?
      `).all(campaignId, worldlineId, phrase, limit) as { id: string; snippet: string }[]);
    } catch { return []; }
  }

  /** 从仓库文件冷导入一个 campaign（只在服务端启动时使用，不暴露为游戏工具）。 */
  seedFromFiles(campaignId: string): void {
    const dir = join(this.root, 'campaigns', campaignId);
    const manifest = parseYaml(readText(join(dir, 'manifest.yaml'))) as CampaignManifest;
    const snapshot: Snapshot = {
      manifest,
      state: JSON.parse(readText(join(dir, manifest.paths.state))),
      entities: readJsonlRaw(join(dir, manifest.paths.entities)),
      relations: readJsonlRaw(join(dir, manifest.paths.relations)),
      episodes: readJsonlRaw(join(dir, manifest.paths.episodesIndex)),
      working: JSON.parse(readText(join(dir, manifest.paths.working)))
    };
    this.write(campaignId, manifest.worldlineId, snapshot);
  }
}

function readJsonlRaw(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
}
