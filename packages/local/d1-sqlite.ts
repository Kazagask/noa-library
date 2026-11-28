/**
 * Local D1-compatible SQLite adapter.
 * This is a driver adapter only: it implements the exact prepare/bind/all/first/run/batch
 * surface used by apps/sites. No business logic lives here.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { V3_SCHEMA_SQL } from '../../apps/sites/src/storage-v3.js';
import { COMPONENT_SCHEMA_SQL } from '../../apps/sites/src/state-core.js';

class BoundStatement {
  readonly sql: string;
  readonly params: unknown[];
  private readonly owner: LocalD1;
  constructor(owner: LocalD1, sql: string, params: unknown[]) { this.owner = owner; this.sql = sql; this.params = params; }
  async all() { return { results: this.owner.raw.prepare(this.sql).all(...this.params as any[]), success: true }; }
  async first() { return this.owner.raw.prepare(this.sql).get(...this.params as any[]) ?? null; }
  async run() { const info = this.owner.raw.prepare(this.sql).run(...this.params as any[]); return { success: true, meta: { changes: Number(info?.changes ?? 0) } }; }
}

export class LocalD1 {
  readonly raw: DatabaseSync;
  readonly path: string;
  constructor(path: string) { mkdirSync(dirname(path), { recursive: true }); this.path = path; this.raw = new DatabaseSync(path); this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;'); }
  prepare(sql: string) {
    return {
      sql,
      params: [] as unknown[],
      bind: (...params: unknown[]) => new BoundStatement(this, sql, params),
      all: () => new BoundStatement(this, sql, []).all(),
      first: () => new BoundStatement(this, sql, []).first(),
      run: () => new BoundStatement(this, sql, []).run()
    };
  }
  async batch(statements: BoundStatement[]) {
    this.raw.exec('BEGIN IMMEDIATE');
    try { for (const statement of statements) this.raw.prepare(statement.sql).run(...statement.params as any[]); this.raw.exec('COMMIT'); return []; }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  close() { this.raw.close(); }
}

export function applyLocalSchema(db: LocalD1, sitesDir: string) {
  const exists = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='noa_vault'").get();
  if (!exists) for (const file of ['0000_vault.sql', '0001_shards.sql']) {
    const sql = readFileSync(join(sitesDir, 'drizzle', file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) if (statement.trim()) db.raw.exec(statement);
  }
  for (const sql of [...V3_SCHEMA_SQL, ...COMPONENT_SCHEMA_SQL]) db.raw.exec(sql);
}

export function openLocalDb(path: string, sitesDir: string): LocalD1 {
  const db = new LocalD1(path);
  applyLocalSchema(db, sitesDir);
  return db;
}
