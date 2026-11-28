import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { seedDocument } from '../packages/local/host.ts';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, stateReadV3, checkpointV3, archiveExportV3, archiveImportV3, documentV3 } from '../apps/sites/src/storage-v3.js';
import { sha256 } from '../packages/core/shared.ts';

function saveLikeDocument() {
  const document = seedDocument();
  const line = document.campaigns.demo.lines['wl-main'];
  const at = '2026-11-28T00:00:00.000Z';
  line.state.revision = 1550;
  line.episodes = Array.from({ length: 486 }, (_, i) => ({
    ...(line.episodes[i % line.episodes.length] ?? {}),
    id: `ep-save-${i}`, title: `SAVE-like 情景 ${i}`, summary: `历史摘要 ${i} 九星斗圣`,
    sourceEventId: `evt-save-${i}`, at, path: `episode/save-${i}.md`, tags: ['save481-like']
  }));
  line.entities = Array.from({ length: 20 }, (_, i) => ({
    ...(line.entities[0] ?? {}), id: `entity.save-${i}`, name: `实体 ${i}`, type: 'generic',
    worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], aliases: [], attributes: {}, createdAt: at, updatedAt: at
  }));
  line.relations = Array.from({ length: 48 }, (_, i) => ({
    ...(line.relations[0] ?? {}), id: `rel-save-${i}`, subject: `entity.save-${i % 20}`, object: `entity.save-${(i + 1) % 20}`,
    predicate: 'links', description: `关系 ${i}`, worldlineId: 'wl-main', knownBy: ['*'], validFrom: at, validUntil: null,
    recordedAt: at, scope: 'world', confidence: 1, epistemic: 'fact', holder: null, status: 'active', revision: 1,
    supersedes: null, sourceEventId: `evt-save-${i}`
  }));
  document.events = Array.from({ length: 1992 }, (_, i) => ({ id: `evt-save-${i}`, eventId: `evt-save-${i}`, campaignId: 'demo', worldlineId: 'wl-main', at, op: 'synthetic' }));
  document.receipts = Object.fromEntries(Array.from({ length: 1372 }, (_, i) => [`demo:wl-main:save-${i}`, { fingerprint: `f-${i}`, receipt: { id: `req-save-${i}`, eventId: `evt-save-${i}`, op: 'event_commit', status: 'applied', campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: `save-${i}`, appliedRevision: 1, hash: 'synthetic' } }]));
  document.checkpoints = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`demo:cp-save-${i}`, { id: `cp-save-${i}`, campaignId: 'demo', worldlineId: 'wl-main', label: `save-${i}`, createdAt: at, source: 'save481-like', snapshot: { state: line.state, working: line.working } }]));
  return document;
}

test('SAVE-481 同结构同规模本地生命周期', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-save481-'));
  const source = new D1Sqlite(join(dir, 'source.sqlite'));
  const target = new D1Sqlite(join(dir, 'target.sqlite'));
  applyMigrations(source, join(process.cwd(), 'apps/sites'));
  applyMigrations(target, join(process.cwd(), 'apps/sites'));
  const document = saveLikeDocument();
  try {
    await promoteVault(source, 'save-owner', { dryRun: false }, null, document);
    const migrated = await promoteV3AndActivate(source, 'save-owner', document, { frozen: false });
    assert.equal(migrated.ok, true, JSON.stringify(migrated));
    assert.equal(migrated.data.episodes, 486);
    assert.equal(migrated.data.events, 1992);
    const read = await stateReadV3(source, 'save-owner', { campaignId: 'demo', worldlineId: 'wl-main' });
    assert.equal(read.ok, true);
    const header = await archiveExportV3(source, 'save-owner', { pageBytes: 48000 });
    assert.equal(header.ok, true, JSON.stringify(header));
    const chunks = [];
    for (let page = 0; page < header.data.pages; page++) {
      const part = await archiveExportV3(source, 'save-owner', { pageBytes: 48000, page, archiveId: header.data.archiveId });
      assert.equal(part.ok, true, `${page}:${JSON.stringify(part)}`);
      chunks.push(Buffer.from(part.data.base64, 'base64'));
    }
    const archive = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(sha256(archive), header.data.sha256);
    const imported = await archiveImportV3(target, 'save-owner', { ...archive, sha256: header.data.sha256 });
    assert.equal(imported.ok, true, JSON.stringify(imported));
    const sourceDoc = await documentV3(source, 'save-owner');
    const targetDoc = await documentV3(target, 'save-owner');
    assert.equal(sha256(sourceDoc.campaigns), sha256(targetDoc.campaigns));
    assert.equal(Object.keys(sourceDoc.checkpoints).length, 7);
    assert.equal(Object.keys(targetDoc.checkpoints).length, 7);
    const cp = await checkpointV3(source, 'save-owner', { campaignId: 'demo', worldlineId: 'wl-main', id: 'SAVE-LIKE-CP', label: 'save-like' });
    assert.equal(cp.ok, true, JSON.stringify(cp));
  } finally { source.close(); target.close(); rmSync(dir, { recursive: true, force: true }); }
});
