import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 最小 D1 兼容层：只实现生产 storage-v2 使用的 prepare/bind/all/first/run/batch。 */
class BoundStatement {
  constructor(db, sql, params) { this.db = db; this.sql = sql; this.params = params; }
  async all() {
    const results = this.db.db.prepare(this.sql).all(...this.params);
    this.db.metrics.rows += results.length;
    this.db.metrics.bytes += results.reduce((n, row) => n + JSON.stringify(row).length, 0);
    return { results, success: true };
  }
  async first() {
    const row = this.db.db.prepare(this.sql).get(...this.params) ?? null;
    this.db.metrics.rows += row ? 1 : 0;
    this.db.metrics.bytes += row ? JSON.stringify(row).length : 0;
    return row;
  }
  async run() {
    const info = this.db.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info?.changes ?? 0) } };
  }
}
export class D1Sqlite {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.metrics = { prepare: 0, batch: 0, rows: 0, bytes: 0 };
  }
  prepare(sql) {
    const self = this;
    self.metrics.prepare++;
    return {
      sql, params: [],
      bind(...params) { return new BoundStatement(self, sql, params); },
      async all() { return new BoundStatement(self, sql, []).all(); },
      async first() { return new BoundStatement(self, sql, []).first(); },
      async run() { return new BoundStatement(self, sql, []).run(); }
    };
  }
  async batch(statements) {
    this.metrics.batch++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...statement.params);
      }
      this.db.exec('COMMIT');
      return [];
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  close() { this.db.close(); }
}

export function applyMigrations(db, sitesDir) {
  for (const file of ['0000_vault.sql', '0001_shards.sql']) {
    const sql = readFileSync(join(sitesDir, 'drizzle', file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.db.exec(statement);
    }
  }
  // V1 fence 只允许在 V2 head 不存在时写入旧库。
  db.db.exec(`CREATE TRIGGER IF NOT EXISTS noa_v1_insert_fence BEFORE INSERT ON noa_vault
    WHEN EXISTS (SELECT 1 FROM noa_head WHERE owner_id=NEW.owner_id)
    BEGIN SELECT RAISE(ABORT,'noa_v2_active'); END`);
}
