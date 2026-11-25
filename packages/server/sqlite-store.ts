import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readText, parseYaml, stableStringify } from '../core/util.ts';
import type { CampaignManifest, Entity, Episode, Relation } from '../library/domain.ts';
import type { Checkpoint, Snapshot, SnapshotRepo } from '../library/store.ts';

/** P1：SQLite 权威存储。派生表是读取源，快照表仅作兼容缓存。 */
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
      CREATE TABLE IF NOT EXISTS working_docs (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id));
      CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE TABLE IF NOT EXISTS relations (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_until TEXT, epistemic TEXT, holder TEXT, known_by TEXT, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE INDEX IF NOT EXISTS idx_rel_subject ON relations(campaign_id, worldline_id, subject);
      CREATE INDEX IF NOT EXISTS idx_rel_object ON relations(campaign_id, worldline_id, object);
      CREATE INDEX IF NOT EXISTS idx_rel_valid ON relations(campaign_id, worldline_id, valid_from, valid_until);
      CREATE TABLE IF NOT EXISTS episodes (campaign_id TEXT NOT NULL, worldline_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(campaign_id, worldline_id, id));
      CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts_v2 USING fts5(key UNINDEXED, id UNINDEXED, title, summary, excerpt, tags);
      CREATE TABLE IF NOT EXISTS noa_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrateColumns();
    this.ensureFtsV2();
  }

  close(): void { this.db.close(); }

  private migrateColumns(): void {
    const columns = new Set((this.db.prepare('PRAGMA table_info(relations)').all() as { name: string }[]).map(r => r.name));
    for (const col of ['valid_from', 'holder', 'known_by']) {
      if (!columns.has(col)) this.db.exec(`ALTER TABLE relations ADD COLUMN ${col} TEXT`);
    }
  }

  private ftsKey(campaignId: string, worldlineId: string, id: string): string {
    return `${campaignId}|${worldlineId}|${id}`;
  }

  private ensureFtsV2(): void {
    const row = this.db.prepare("SELECT value FROM noa_meta WHERE key = 'fts_v2_ready'").get() as { value: string } | undefined;
    if (row?.value === '1') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM episode_fts_v2');
      const rows = this.db.prepare('SELECT campaign_id, worldline_id, id, body FROM episodes').all() as { campaign_id: string; worldline_id: string; id: string; body: string }[];
      const ins = this.db.prepare('INSERT INTO episode_fts_v2(key, id, title, summary, excerpt, tags) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of rows) {
        const e = JSON.parse(r.body) as Episode;
        ins.run(this.ftsKey(r.campaign_id, r.worldline_id, r.id), r.id, e.title, e.summary, e.excerpt ?? '', e.tags.join(' '));
      }
      this.db.prepare("INSERT OR REPLACE INTO noa_meta(key, value) VALUES ('fts_v2_ready', '1')").run();
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  private manifest(campaignId: string): CampaignManifest {
    const row = this.db.prepare('SELECT manifest FROM campaigns WHERE id = ?').get(campaignId) as { manifest: string } | undefined;
    if (!row) throw new Error(`campaign ${campaignId} 不存在`);
    return JSON.parse(row.manifest) as CampaignManifest;
  }

  read(campaignId: string, worldlineId: string): Snapshot {
    const state = this.db.prepare('SELECT body FROM state_docs WHERE campaign_id = ? AND worldline_id = ?').get(campaignId, worldlineId) as { body: string } | undefined;
    if (!state) throw new Error(`世界线 ${worldlineId} 不存在`);
    const work = this.db.prepare('SELECT body FROM working_docs WHERE campaign_id = ? AND worldline_id = ?').get(campaignId, worldlineId) as { body: string } | undefined;
    const rows = <T>(sql: string): T[] => (this.db.prepare(sql).all(campaignId, worldlineId) as { body: string }[]).map(r => JSON.parse(r.body) as T);
    return {
      manifest: this.manifest(campaignId),
      state: JSON.parse(state.body),
      entities: rows<Entity>('SELECT body FROM entities WHERE campaign_id = ? AND worldline_id = ?'),
      relations: rows<Relation>('SELECT body FROM relations WHERE campaign_id = ? AND worldline_id = ?'),
      episodes: rows<Episode>('SELECT body FROM episodes WHERE campaign_id = ? AND worldline_id = ?'),
      working: work ? JSON.parse(work.body) : { campaignId, worldlineId, memoryRevision: 0 }
    };
  }

  /** 增量持久化：只写变化行；FTS 只更新变化的 episode。 */
  patch(campaignId: string, worldlineId: string, snapshot: Snapshot): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO campaigns(id, manifest) VALUES (?, ?)').run(campaignId, stableStringify(snapshot.manifest));
      this.db.prepare('INSERT OR REPLACE INTO worldlines(campaign_id, worldline_id, snapshot) VALUES (?, ?, ?)').run(campaignId, worldlineId, stableStringify({
        state: snapshot.state, entities: snapshot.entities, relations: snapshot.relations, episodes: snapshot.episodes, working: snapshot.working
      }));
      this.db.prepare('INSERT OR REPLACE INTO state_docs(campaign_id, worldline_id, revision, body) VALUES (?, ?, ?, ?)').run(campaignId, worldlineId, snapshot.state.revision, stableStringify(snapshot.state));
      this.db.prepare('INSERT OR REPLACE INTO working_docs(campaign_id, worldline_id, body) VALUES (?, ?, ?)').run(campaignId, worldlineId, stableStringify(snapshot.working));

      const syncTable = (table: 'entities' | 'relations' | 'episodes', rows: any[], extra?: (row: any) => unknown[]) => {
        const existing = new Map((this.db.prepare(`SELECT id, body FROM ${table} WHERE campaign_id = ? AND worldline_id = ?`).all(campaignId, worldlineId) as { id: string; body: string }[]).map(r => [r.id, r.body]));
        const incoming = new Set(rows.map(r => r.id));
        const del = this.db.prepare(`DELETE FROM ${table} WHERE campaign_id = ? AND worldline_id = ? AND id = ?`);
        for (const id of existing.keys()) if (!incoming.has(id)) del.run(campaignId, worldlineId, id);
        if (table === 'episodes') {
          const delFts = this.db.prepare('DELETE FROM episode_fts_v2 WHERE key = ?');
          for (const id of existing.keys()) if (!incoming.has(id)) delFts.run(this.ftsKey(campaignId, worldlineId, id));
        }
        const sql = extra
          ? `INSERT OR REPLACE INTO ${table}(campaign_id, worldline_id, id, subject, predicate, object, valid_from, valid_until, epistemic, holder, known_by, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT OR REPLACE INTO ${table}(campaign_id, worldline_id, id, body) VALUES (?, ?, ?, ?)`;
        const ins = this.db.prepare(sql);
        for (const row of rows) {
          const body = stableStringify(row);
          if (existing.get(row.id) === body) continue;
          ins.run(...(extra ? [campaignId, worldlineId, row.id, ...extra(row), body] : [campaignId, worldlineId, row.id, body]));
          if (table === 'episodes') {
            this.db.prepare('DELETE FROM episode_fts_v2 WHERE key = ?').run(this.ftsKey(campaignId, worldlineId, row.id));
            this.db.prepare('INSERT INTO episode_fts_v2(key, id, title, summary, excerpt, tags) VALUES (?, ?, ?, ?, ?, ?)').run(
              this.ftsKey(campaignId, worldlineId, row.id), row.id, row.title, row.summary, row.excerpt ?? '', (row.tags ?? []).join(' ')
            );
          }
        }
      };
      syncTable('entities', snapshot.entities);
      syncTable('relations', snapshot.relations, r => [
        r.subject, r.predicate, r.object, r.validFrom ?? null, r.validUntil ?? null,
        r.epistemic ?? 'fact', r.holder ?? null, stableStringify(r.knownBy ?? [])
      ]);
      syncTable('episodes', snapshot.episodes);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  write(campaignId: string, worldlineId: string, snapshot: Snapshot): void { this.patch(campaignId, worldlineId, snapshot); }

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

  deleteCheckpoint(campaignId: string, checkpointId: string): void {
    this.db.prepare('DELETE FROM checkpoints WHERE campaign_id = ? AND id = ?').run(campaignId, checkpointId);
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

  /**
   * 分层 BFS：每层按批量 ID 查邻接索引，全局 visited 去重。
   * 只扩展 depth<hops 的 frontier，因此不会产生超出请求跳数的边。
   */
  traverseAdjacent(input: {
    campaignId: string; worldlineId: string; start: string; hops: number; viewer: string;
    asOf: string; includeBeliefs: boolean; limit?: number
  }): { nodes: { id: string; depth: number }[]; edges: Relation[]; edgesTruncated: boolean; queries: number } {
    const { campaignId, worldlineId, start, hops, viewer, asOf } = input;
    const includeBeliefs = input.includeBeliefs ? 1 : 0;
    const maxNodes = input.limit ?? 200;
    const maxEdges = 400;
    const maxQueries = 24;
    const batchSize = 64;
    const perQuery = 100;
    const visible = `
      r.campaign_id = ? AND r.worldline_id = ?
      AND (r.valid_from IS NULL OR r.valid_from <= ?)
      AND (r.valid_until IS NULL OR r.valid_until > ?)
      AND instr(r.body, '"status":"active"') > 0
      AND (instr(r.known_by, '"*"') > 0 OR instr(r.known_by, '"' || ? || '"') > 0)
      AND (r.epistemic = 'fact' OR (? = 1 AND r.holder = ?))
    `;
    const params = [campaignId, worldlineId, asOf, asOf, viewer, includeBeliefs, viewer];
    const visited = new Map<string, number>([[start, 0]]);
    const edges: Relation[] = [];
    const edgeIds = new Set<string>();
    let frontier = [start];
    let depth = 0, queries = 0, truncated = false;

    while (frontier.length && depth < hops && visited.size < maxNodes && queries < maxQueries && edges.length < maxEdges) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += batchSize) {
        const batch = frontier.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        for (const side of ['subject', 'object'] as const) {
          if (queries >= maxQueries) { truncated = true; break; }
          queries++;
          const rows = this.db.prepare(
            `SELECT body FROM relations r WHERE ${visible} AND r.${side} IN (${placeholders}) LIMIT ?`
          ).all(...params, ...batch, perQuery) as { body: string }[];
          if (rows.length >= perQuery) truncated = true;
          for (const row of rows) {
            const rel = JSON.parse(row.body) as Relation;
            if (edgeIds.has(rel.id)) continue;
            if (edges.length >= maxEdges) { truncated = true; break; }
            edgeIds.add(rel.id);
            edges.push(rel);
            const neighbor = side === 'subject' ? rel.object : rel.subject;
            if (!visited.has(neighbor)) {
              if (visited.size >= maxNodes) { truncated = true; continue; }
              visited.set(neighbor, depth + 1);
              next.push(neighbor);
            }
          }
        }
        if (queries >= maxQueries || edges.length >= maxEdges) break;
      }
      if (next.length === 0 && frontier.length > 0) truncated = true;
      frontier = next;
      depth++;
    }
    if (frontier.length && depth <= hops) truncated = true;
    const nodes = [...visited.entries()].map(([id, d]) => ({ id, depth: d })).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
    return { nodes, edges, edgesTruncated: truncated, queries };
  }

  searchText(input: { campaignId: string; worldlineId: string; query: string; limit?: number }): { kind: string; id: string; snippet: string }[] {
    const q = `%${input.query.toLowerCase()}%`;
    const limit = input.limit ?? 20;
    const out: { kind: string; id: string; snippet: string }[] = [];
    for (const [kind, table] of [['entity', 'entities'], ['relation', 'relations'], ['episode', 'episodes']] as const) {
      const rows = this.db.prepare(`SELECT id, body FROM ${table} WHERE campaign_id = ? AND worldline_id = ? AND lower(body) LIKE ? LIMIT ?`)
        .all(input.campaignId, input.worldlineId, q, limit) as { id: string; body: string }[];
      for (const r of rows) out.push({ kind, id: r.id, snippet: r.body.slice(0, 160) });
    }
    return out;
  }

  searchFts(campaignId: string, worldlineId: string, query: string, limit = 20): { id: string; snippet: string }[] {
    if (!query.trim()) return [];
    const phrase = `"${query.replace(/"/g, '""')}"`;
    try {
      return (this.db.prepare(`
        SELECT e.id AS id, snippet(episode_fts_v2, 2, '', '', '…', 24) AS snippet
        FROM episode_fts_v2 JOIN episodes e ON e.id = episode_fts_v2.id
        WHERE e.campaign_id = ? AND e.worldline_id = ?
          AND instr(episode_fts_v2.key, ? || '|' || ? || '|') = 1
          AND episode_fts_v2 MATCH ? LIMIT ?
      `).all(campaignId, worldlineId, campaignId, worldlineId, phrase, limit) as { id: string; snippet: string }[]);
    } catch { return []; }
  }

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
