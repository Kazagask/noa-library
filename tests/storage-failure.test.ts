import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { openLocalDb } from '../packages/local/d1-sqlite.ts';

for (const name of ['LocalD1', 'D1Sqlite']) {
  test(`batch 原子性：${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noa-failure-'));
    const path = join(dir, 'db.sqlite');
    const db: any = name === 'LocalD1' ? openLocalDb(path, join(process.cwd(), 'apps/sites')) : new D1Sqlite(path);
    if (name === 'D1Sqlite') applyMigrations(db, join(process.cwd(), 'apps/sites'));
    try {
      const a = db.prepare('CREATE TABLE IF NOT EXISTS qa_atomic (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      await a.run();
      const first = db.prepare('INSERT INTO qa_atomic VALUES (?,?)').bind('a', 'one');
      const second = db.prepare('INSERT INTO qa_atomic VALUES (?,?)').bind('a', 'duplicate');
      await assert.rejects(() => db.batch([first, second]));
      const rows = await db.prepare('SELECT * FROM qa_atomic').all();
      assert.equal(rows.results.length, 0, 'batch 失败后不得留下部分写入');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
