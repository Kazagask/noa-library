import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalHost } from '../packages/local/host.ts';

test('local host 可启动、重启并读取真实 V3 SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-local-host-'));
  const dbPath = join(dir, 'local.sqlite');
  try {
    const host = await openLocalHost({ dbPath });
    const boot = await host.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(boot.ok, true, JSON.stringify(boot));
    assert.equal(boot.data.release, '2.2.4-storage-reliability');
    const archive = await host.call('archive_export', { pageBytes: 12000 });
    assert.equal(archive.ok, true, JSON.stringify(archive));
    host.close();
    const restarted = await openLocalHost({ dbPath });
    const recover = await restarted.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(recover.ok, true, JSON.stringify(recover));
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
