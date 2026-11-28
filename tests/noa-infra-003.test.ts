import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { sha256 } from '../packages/core/shared.ts';
import { openLocalDb } from '../packages/local/d1-sqlite.ts';
import worker from '../apps/sites/src/worker.js';
import {
  RECOVERY_BATCH_FORMAT, RECOVERY_MANIFEST_FORMAT, normalizeBatch, recoveryBatchSha256,
  recoveryBegin, recoveryPush, recoveryStatus, recoveryFinalize, recoveryAbort
} from '../apps/sites/src/recovery-batch.js';
import { unfreezeAuthority } from '../apps/sites/src/storage-v3.js';
import { prepareBatches } from '../scripts/noa-infra-003.mjs';

const ROOT = resolve(process.cwd());
const ARTIFACT = join(ROOT, 'deploy/data/r1550-recovery');
const DATA_OWNER = 'save481-recovery';
const CALLER = 'sites-owner';

function makeBatch(batchId: string, ordinal: number, key: string) {
  return {
    format: RECOVERY_BATCH_FORMAT, version: 1, batchId, ordinal,
    records: [{ table: 'noa_v3_index', columns: ['owner_id', 'kind', 'key', 'value'], rows: [[DATA_OWNER, 'probe', key, '1']] }]
  };
}

function makeManifest(batches: any[]) {
  const meta = batches.map((batch, ordinal) => {
    const normalized = normalizeBatch(batch);
    assert.equal(normalized.ok, true, JSON.stringify(normalized));
    return { batchId: batch.batchId, ordinal, sha256: recoveryBatchSha256(batch), rows: 1, bytes: normalized.data.bytes };
  });
  return {
    format: RECOVERY_MANIFEST_FORMAT, version: 1,
    ownerMapping: { target: DATA_OWNER, env: 'NOA_RECOVERY_OWNER' },
    maxRequestBytes: 1_950_000,
    evidence: { revision: 1550, rngCursor: 657, rngSeed: 1581654255, counts: {}, tableHashes: {} },
    batches: meta, order: meta.map(row => row.batchId)
  };
}

test('INFRA-003 白名单拒绝任意表与字段', () => {
  const base = makeBatch('b-1', 0, 'a');
  const wrongTable = normalizeBatch({ ...base, records: [{ table: 'sqlite_master', columns: ['name'], rows: [['x']] }] });
  assert.equal(wrongTable.ok, false);
  assert.equal(wrongTable.code, 'recovery_table_not_allowed');
  const wrongField = normalizeBatch({ ...base, records: [{ table: 'noa_v3_index', columns: ['owner_id', 'evil'], rows: [[DATA_OWNER, 'x']] }] });
  assert.equal(wrongField.ok, false);
  assert.equal(wrongField.code, 'recovery_field_not_allowed');
});

test('INFRA-003 begin/push/status/abort：幂等、哈希冲突、断点与冲突拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-infra003-unit-'));
  const db = openLocalDb(join(dir, 'unit.sqlite'), join(ROOT, 'apps/sites'));
  try {
    const batchA = makeBatch('b-1', 0, 'a');
    const batchB = makeBatch('b-2', 1, 'b');
    const manifest = makeManifest([batchA, batchB]);
    const manifestSha256 = sha256(manifest);

    const begun = await recoveryBegin(db, DATA_OWNER, { manifest, manifestSha256 });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const again = await recoveryBegin(db, DATA_OWNER, { manifest, manifestSha256 });
    assert.equal(again.ok, true);
    assert.equal(again.data.duplicate, true);

    const digestA = recoveryBatchSha256(batchA) as any;
    const pushed = await recoveryPush(db, DATA_OWNER, { sessionId: begun.data.sessionId, batchId: 'b-1', sha256: digestA, batch: batchA });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    const duplicate = await recoveryPush(db, DATA_OWNER, { sessionId: begun.data.sessionId, batchId: 'b-1', sha256: digestA, batch: batchA });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.data.duplicate, true);

    const conflict = await recoveryPush(db, DATA_OWNER, {
      sessionId: begun.data.sessionId, batchId: 'b-1', sha256: digestA,
      batch: makeBatch('b-1', 0, 'different')
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'recovery_sha256_mismatch');

    const early = await recoveryFinalize(db, DATA_OWNER, { sessionId: begun.data.sessionId });
    assert.equal(early.ok, false);
    assert.equal(early.code, 'recovery_incomplete');

    const status = await recoveryStatus(db, DATA_OWNER, { sessionId: begun.data.sessionId });
    assert.equal(status.ok, true);
    assert.equal(status.data.appliedBatches, 1);
    assert.deepEqual(status.data.applied, ['b-1']);

    const targetConflict = await recoveryBegin(db, DATA_OWNER, { manifest, manifestSha256, sessionId: 'rec-conflict' });
    assert.equal(targetConflict.ok, false);
    assert.equal(targetConflict.code, 'recovery_target_conflict');

    const aborted = await recoveryAbort(db, DATA_OWNER, { sessionId: begun.data.sessionId });
    assert.equal(aborted.ok, true, JSON.stringify(aborted));
    const rows = await db.prepare('SELECT count(*) n FROM noa_v3_index WHERE owner_id=?').bind(DATA_OWNER).first();
    assert.equal(rows.n, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('INFRA-003 隔离环境与真实 MCP 身份映射不可绕过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-infra003-auth-'));
  const db = openLocalDb(join(dir, 'auth.sqlite'), join(ROOT, 'apps/sites'));
  try {
    const call = async (env: any, user: string) => {
      const req = new Request('https://sites.local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recovery_status', arguments: { sessionId: 'rec-none' } } })
      });
      const res = await (worker.fetch as any)(req, env, {});
      const json: any = await res.json();
      return JSON.parse(json.result.content[0].text);
    };
    const base = { DB: db, NOA_REPAIR_OWNER: CALLER, NOA_ALLOW_LEGACY_GOVERNANCE: '0' };
    const notIsolated = await call(base, CALLER);
    assert.equal(notIsolated.ok, false);
    assert.equal(notIsolated.code, 'recovery_not_allowed');

    const isolated = { ...base, NOA_RECOVERY_MODE: 'isolated', NOA_RECOVERY_OWNER: DATA_OWNER };
    const wrongCaller = await call(isolated, 'other-user');
    assert.equal(wrongCaller.ok, false);
    assert.equal(wrongCaller.code, 'forbidden');
    const noSession = await call(isolated, CALLER);
    assert.equal(noSession.ok, false);
    assert.equal(noSession.code, 'recovery_session_not_found');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

let Miniflare: any = null;
try { ({ Miniflare } = await import('miniflare')); } catch {}

test('INFRA-003 实际 R1550 产物在 workerd D1 端到端恢复与业务冒烟', { skip: !Miniflare ? 'miniflare 未安装' : false }, async () => {
  const prepared = prepareBatches(ARTIFACT);
  assert.equal(prepared.source.format, 'noa-v3-init-batch');
  assert.equal(prepared.manifest.ownerMapping.target, DATA_OWNER);
  assert.ok(prepared.batches.length > 300);
  assert.equal(prepared.manifest.totalRows, 15182);
  assert.ok(Math.max(...prepared.batches.map((batch: any) => batch.bytes)) <= 900_000);

  const dir = mkdtempSync(join(tmpdir(), 'noa-infra003-mf-'));
  const mf = new Miniflare({
    modules: true,
    scriptPath: join(ROOT, 'apps/sites/dist/server/index.js'),
    d1Databases: ['DB'],
    bindings: {
      NOA_REPAIR_OWNER: CALLER, NOA_ALLOW_LEGACY_GOVERNANCE: '0',
      NOA_RECOVERY_MODE: 'isolated', NOA_RECOVERY_OWNER: DATA_OWNER
    },
    compatibilityFlags: ['nodejs_compat'],
    persist: join(dir, 'd1')
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}, user = CALLER) => {
    const response = await mf.dispatchFetch('https://sites.local/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.ok(json.result?.content?.[0]?.text, JSON.stringify(json));
    return JSON.parse(json.result.content[0].text);
  };
  try {
    const db: any = await mf.getD1Database('DB');
    const schema = readFileSync(join(ARTIFACT, 'sql', prepared.source.schema.file), 'utf8');
    for (const statement of schema.split('--> statement-breakpoint').flatMap(part => part.split(/;\s*(?:\n|$)/))) {
      if (statement.trim()) await db.exec(statement.replace(/\s+/g, ' ').trim() + ';');
    }

    const manifestSha256 = sha256(prepared.manifest);
    const sessionId = `rec-${manifestSha256.slice(0, 16)}`;
    const begun = await call('recovery_begin', { manifestSha256, manifest: prepared.manifest, sessionId });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    const early = await call('recovery_finalize', { sessionId });
    assert.equal(early.ok, false);
    assert.equal(early.code, 'recovery_incomplete');

    const wrongCaller = await call('recovery_status', { sessionId }, 'other-user');
    assert.equal(wrongCaller.ok, false);
    assert.equal(wrongCaller.code, 'forbidden');

    for (const [index, batch] of prepared.batches.entries()) {
      const meta = prepared.manifest.batches[index];
      const result = await call('recovery_push', { sessionId, batchId: batch.batchId, sha256: meta.sha256, batch });
      assert.equal(result.ok, true, `${batch.batchId}: ${JSON.stringify(result)}`);
      if (index === 0) {
        const duplicate = await call('recovery_push', { sessionId, batchId: batch.batchId, sha256: meta.sha256, batch });
        assert.equal(duplicate.ok, true);
        assert.equal(duplicate.data.duplicate, true);
      }
    }

    const status = await call('recovery_status', { sessionId });
    assert.equal(status.ok, true);
    assert.equal(status.data.appliedBatches, prepared.batches.length);
    assert.equal(status.data.appliedRows, 15182);
    assert.equal(status.data.authority?.target ?? null, null);

    const finalized = await call('recovery_finalize', { sessionId });
    assert.equal(finalized.ok, true, JSON.stringify(finalized));
    assert.equal(finalized.data.authority.target, 'v3');
    assert.equal(finalized.data.authority.frozen, 1);
    assert.ok(finalized.data.checks > 30);

    const read = await call('state_read', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.data.state.revision, 1550);
    assert.equal(read.data.state.rng.cursor, 657);
    const boot = await call('session_bootstrap', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    assert.equal(boot.ok, true, JSON.stringify(boot));
    const recall = await call('memory_recall', { campaignId: 'SAVE-481', worldlineId: 'wl-main', query: '萧炎', limit: 3 });
    assert.equal(recall.ok, true, JSON.stringify(recall));
    const archive = await call('archive_export', { pageBytes: 40000 });
    assert.equal(archive.ok, true, JSON.stringify(archive));
    const frozenWrite = await call('event_commit', {
      campaignId: 'SAVE-481', worldlineId: 'wl-main', eventId: 'INFRA003-FROZEN',
      expectedRevision: 1550, idempotencyKey: 'INFRA003-FROZEN', statePatch: { flags: { infra003Frozen: true } }
    });
    assert.equal(frozenWrite.ok, false);
    assert.equal(frozenWrite.code, 'authority_frozen');

    const thaw = await unfreezeAuthority(db, DATA_OWNER);
    assert.equal(thaw.ok, true, JSON.stringify(thaw));
    const commit = await call('event_commit', {
      campaignId: 'SAVE-481', worldlineId: 'wl-main', eventId: 'INFRA003-WRITE',
      expectedRevision: 1550, idempotencyKey: 'INFRA003-WRITE', statePatch: { flags: { infra003Write: true } }
    });
    assert.equal(commit.ok, true, JSON.stringify(commit));
    const receipt = await call('event_receipt', { campaignId: 'SAVE-481', worldlineId: 'wl-main', lookup: 'INFRA003-WRITE' });
    assert.equal(receipt.ok, true);
    const after = await call('state_read', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    assert.equal(after.data.state.revision, 1551);
    assert.equal(after.data.state.flags.infra003Write, true);
  } finally { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
