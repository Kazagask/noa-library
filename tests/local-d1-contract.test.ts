import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDb } from '../packages/local/d1-sqlite.ts';

test('LocalD1 contract: prepare/bind/all/first/run/batch 语义', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-d1-contract-'));
  const db = openLocalDb(join(dir, 'db.sqlite'), join(process.cwd(), 'apps/sites'));
  try {
    const create = db.prepare('CREATE TABLE IF NOT EXISTS qa_contract (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await create.run();
    const insert = db.prepare('INSERT INTO qa_contract VALUES (?,?)').bind('a', 'one');
    assert.equal(insert.sql, 'INSERT INTO qa_contract VALUES (?,?)');
    await insert.run();
    assert.deepEqual((await db.prepare('SELECT value FROM qa_contract WHERE id=?').bind('a').first())?.value, 'one');
    const all = await db.prepare('SELECT * FROM qa_contract').all();
    assert.equal(all.success, true);
    assert.equal(all.results.length, 1);
    const bad = db.prepare('INSERT INTO qa_contract VALUES (?,?)').bind('a', 'duplicate');
    const good = db.prepare('INSERT INTO qa_contract VALUES (?,?)').bind('b', 'two');
    await assert.rejects(() => db.batch([good, bad]));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM qa_contract').first())?.n, 1, 'batch 应整体回滚');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
