import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V3_SCHEMA_SQL } from '../apps/sites/src/storage-v3.js';
import { COMPONENT_SCHEMA_SQL } from '../apps/sites/src/state-core.js';
import { seedDocument } from '../packages/local/host.ts';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate } from '../apps/sites/src/storage-v3.js';

let Miniflare: any = null;
try { ({ Miniflare } = await import('miniflare')); } catch {}

test('Miniflare workerd D1 Binding 复用 Worker 契约', { skip: !Miniflare ? 'miniflare 未安装' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-miniflare-'));
  const mf = new Miniflare({ modules: true, scriptPath: join(process.cwd(), 'apps/sites/dist/server/index.js'), d1Databases: ['DB'], compatibilityFlags: ['nodejs_compat'], persist: join(dir, 'd1') });
  try {
    const db: any = await mf.getD1Database('DB');
    for (const file of ['0000_vault.sql', '0001_shards.sql']) {
      const sql = readFileSync(join(process.cwd(), 'apps/sites/drizzle', file), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').flatMap(part => part.split(/;\s*(?:\n|$)/))) if (statement.trim()) await db.exec(statement.replace(/\s+/g, ' ').trim() + ';');
    }
    for (const sql of [...V3_SCHEMA_SQL, ...COMPONENT_SCHEMA_SQL]) await db.exec(sql.replace(/\s+/g, ' ').trim() + ';');
    const document = seedDocument();
    await promoteVault(db, 'miniflare-owner', { dryRun: false }, null, document);
    const active = await promoteV3AndActivate(db, 'miniflare-owner', document, { frozen: false });
    assert.equal((active as any).ok, true, JSON.stringify(active));
    const response = await mf.dispatchFetch('http://local/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'miniflare-owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const json: any = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(json.result.tools));
    const boot = await mf.dispatchFetch('http://local/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'miniflare-owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_bootstrap', arguments: { campaignId: 'demo', worldlineId: 'wl-main' } } }) });
    const bootJson: any = await boot.json();
    assert.equal(JSON.parse(bootJson.result.content[0].text).ok, true);
  } finally { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
