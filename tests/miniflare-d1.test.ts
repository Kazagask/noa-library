import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sha256 } from '../packages/core/shared.ts';
import { V3_SCHEMA_SQL } from '../apps/sites/src/storage-v3.js';
import { COMPONENT_SCHEMA_SQL } from '../apps/sites/src/state-core.js';
import { seedDocument } from '../packages/local/host.ts';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate } from '../apps/sites/src/storage-v3.js';

let Miniflare: any = null;
try { ({ Miniflare } = await import('miniflare')); } catch {}

test('Miniflare workerd D1 Binding 复用 Worker 契约', { skip: !Miniflare ? 'miniflare 未安装' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-miniflare-'));
  const mf = new Miniflare({ modules: true, scriptPath: join(process.cwd(), 'apps/sites/dist/server/index.js'), d1Databases: ['DB'], bindings: { NOA_REPAIR_OWNER: 'miniflare-owner', NOA_ALLOW_LEGACY_GOVERNANCE: '0' }, compatibilityFlags: ['nodejs_compat'], persist: join(dir, 'd1') });
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
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await mf.dispatchFetch('http://local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'miniflare-owner' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      });
      assert.equal(response.status, 200);
      const json: any = await response.json();
      assert.ok(json.result?.content?.[0]?.text, JSON.stringify(json));
      return JSON.parse(json.result.content[0].text);
    };
    // 真实业务写入 → 回执 → 状态推进 → 归档分页/摘要，全部经 workerd D1 绑定与 Worker 入口。
    const read = await call(3, 'state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(read.ok, true, JSON.stringify(read));
    const revision = Number(read.data.state.revision);
    assert.ok(Number.isFinite(revision));
    const commit = await call(4, 'event_commit', {
      campaignId: 'demo', worldlineId: 'wl-main', eventId: 'MINIFLARE-EVENT',
      expectedRevision: revision, idempotencyKey: 'MINIFLARE-EVENT-K',
      statePatch: { flags: { miniflareWrite: true } }
    });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const receipt = await call(5, 'event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'MINIFLARE-EVENT' });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.data.receipt?.eventId, 'MINIFLARE-EVENT');
    const after = await call(6, 'state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.ok(Number(after.data.state.revision) > revision, '业务写入必须推进 revision');
    assert.equal(after.data.state.flags?.miniflareWrite, true);
    const header = await call(7, 'archive_export', { pageBytes: 12000 });
    assert.equal(header.ok, true, JSON.stringify(header));
    const chunks: Buffer[] = [];
    for (let page = 0; page < header.data.pages; page++) {
      const part = await call(8 + page, 'archive_export', { pageBytes: 12000, page, archiveId: header.data.archiveId });
      assert.equal(part.ok, true, `${page}:${JSON.stringify(part)}`);
      const bytes = Buffer.from(part.data.base64, 'base64');
      const expected = Math.min(header.data.pageBytes, header.data.bytes - page * header.data.pageBytes);
      assert.equal(part.data.page, page);
      assert.equal(bytes.length, expected);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), part.data.pageHash);
      chunks.push(bytes);
    }
    const archiveBytes = Buffer.concat(chunks);
    assert.equal(archiveBytes.length, header.data.bytes);
    const parsed = JSON.parse(archiveBytes.toString('utf8'));
    assert.equal(sha256(parsed), header.data.sha256);
  } finally { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
