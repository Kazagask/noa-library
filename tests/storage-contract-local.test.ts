import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { openLocalDb } from '../packages/local/d1-sqlite.ts';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, stateReadV3, checkpointV3, restoreCheckpointV3 } from '../apps/sites/src/storage-v3.js';
import { seedDocument } from '../packages/local/host.ts';

for (const name of ['LocalD1', 'D1Sqlite']) {
  test(`Storage contract: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noa-contract-'));
    const path = join(dir, 'db.sqlite');
    const db: any = name === 'LocalD1' ? openLocalDb(path, join(process.cwd(), 'apps/sites')) : new D1Sqlite(path);
    if (name === 'D1Sqlite') applyMigrations(db, join(process.cwd(), 'apps/sites'));
    const owner = `contract-${name}`;
    const document = seedDocument();
    try {
      await promoteVault(db, owner, { dryRun: false }, null, document);
      const active = await promoteV3AndActivate(db, owner, document, { frozen: false });
      assert.equal((active as any).ok, true, JSON.stringify(active));
      const read = await stateReadV3(db, owner, { campaignId: 'demo', worldlineId: 'wl-main' });
      assert.equal(read.ok, true);
      const cp = await checkpointV3(db, owner, { campaignId: 'demo', worldlineId: 'wl-main', id: `CP-${name}`, label: 'contract' });
      assert.equal(cp.ok, true, JSON.stringify(cp));
      const restore = await restoreCheckpointV3(db, owner, `CP-${name}`, { campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: `R-${name}` });
      assert.equal(restore.ok, true, JSON.stringify(restore));
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
