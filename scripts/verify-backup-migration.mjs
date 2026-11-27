import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { sha256 } from '../packages/core/shared.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3, documentV3 } from '../apps/sites/src/storage-v3.js';
import { stateFromComponents } from '../apps/sites/src/state-core.js';

const ROOT = resolve(process.cwd());
const BACKUP = resolve(ROOT, 'backups/R1365/noa-library-backup.json');
const backup = JSON.parse(readFileSync(BACKUP, 'utf8'));
const verification = JSON.parse(readFileSync(resolve(ROOT, 'backups/R1365/verification.json'), 'utf8'));
const document = backup.document;
const owner = 'offline-verification';
const db = new D1Sqlite(':memory:');
applyMigrations(db, resolve(ROOT, 'apps/sites'));

const documentHash = createHash('sha256').update(readFileSync(BACKUP)).digest('hex');
const checks = [];
const check = (name, ok, detail = {}) => { checks.push({ name, ok, ...detail }); if (!ok) console.error(`FAIL ${name}`, detail); };

check('backup sha256 matches verification.json', documentHash === verification.sha256, { actual: documentHash, expected: verification.sha256 });
check('verification metadata revision', verification.revision === document.campaigns['SAVE-481'].lines['wl-main'].state.revision, { actual: verification.revision });

await promoteVault(db, owner, { dryRun: false }, null, document);
const migrated = await promoteV3(db, owner, document);
check('promoteV3 ok', migrated.ok, migrated);

const count = async (sql, ...params) => (await db.prepare(sql).bind(...params).first()).n;
const txCount = await count('SELECT count(*) AS n FROM noa_v3_tx WHERE owner_id=?', owner);
const rngCount = await count('SELECT count(*) AS n FROM noa_v3_rng WHERE owner_id=?', owner);
const cpCount = await count('SELECT count(*) AS n FROM noa_v3_checkpoint WHERE owner_id=?', owner);
const memoryDocCount = await count(`SELECT count(*) AS n FROM noa_v3_doc WHERE owner_id=? AND (family LIKE 'entity:%' OR family LIKE 'relation:%' OR family LIKE 'episode:%')`, owner);
const memoryIndexCount = await count(`SELECT count(*) AS n FROM noa_v3_component_index WHERE owner_id=? AND index_name='memory.tier'`, owner);
const expectedMemoryDocs = Object.values(document.campaigns).reduce((n, c) => n + Object.values(c.lines ?? {}).reduce((m, s) => m + (s.entities?.length ?? 0) + (s.relations?.length ?? 0) + (s.episodes?.length ?? 0), 0), 0);
check('all receipts and events migrated', txCount >= Object.keys(document.receipts).length, { txCount, receipts: Object.keys(document.receipts).length, events: document.events.length });
check('RNG history migrated', rngCount === Object.values(document.receipts).filter(r => (r.receipt ?? r).op === 'runtime_execute').length, { rngCount });
check('all checkpoints migrated', cpCount === Object.keys(document.checkpoints).length, { cpCount, expected: Object.keys(document.checkpoints).length });
check('all memory docs migrated', memoryDocCount === expectedMemoryDocs, { memoryDocCount, expectedMemoryDocs });
check('all memory tier indexes migrated', memoryIndexCount === expectedMemoryDocs, { memoryIndexCount, expectedMemoryDocs });
check('all worldlines migrated', migrated.data.worldlines === Object.values(document.campaigns).reduce((n, c) => n + Object.keys(c.lines ?? {}).length, 0), migrated.data);
check('campaign personas migrated', migrated.data.personas === Object.keys(document.campaignPersonas ?? {}).length, migrated.data);

for (const [campaignId, campaign] of Object.entries(document.campaigns)) {
  for (const [worldlineId, snapshot] of Object.entries(campaign.lines ?? {})) {
    const built = await stateFromComponents(db, owner, { campaignId, worldlineId });
    check(`${campaignId}/${worldlineId} state exact`, sha256(built) === sha256(snapshot.state), {
      sourceRevision: snapshot.state.revision, builtRevision: built.revision,
      sourceKeys: Object.keys(snapshot.state), builtKeys: Object.keys(built)
    });
    const working = JSON.parse((await db.prepare('SELECT body FROM noa_v3_doc WHERE owner_id=? AND family=?').bind(owner, `working:${campaignId}:${worldlineId}`).first()).body);
    check(`${campaignId}/${worldlineId} working exact`, sha256(working) === sha256(snapshot.working));
  }
}

const rebuilt = await documentV3(db, owner);
check('rebuilt active campaign', rebuilt.active?.campaignId === document.active.campaignId, { active: rebuilt.active });
check('rebuilt events count', rebuilt.events.length === document.events.length, { actual: rebuilt.events.length, expected: document.events.length });
check('rebuilt receipts count', Object.keys(rebuilt.receipts).length === Object.keys(document.receipts).length, { actual: Object.keys(rebuilt.receipts).length, expected: Object.keys(document.receipts).length });

const main = document.campaigns['SAVE-481'].lines['wl-main'];
check('production revision preserved', main.state.revision === 1365, { revision: main.state.revision });
check('production rng cursor preserved', main.state.rng.cursor === 602, { cursor: main.state.rng.cursor });
check('pending events array preserved', Array.isArray(main.working.pendingEvents) && main.working.pendingEvents.length === 245, { length: main.working.pendingEvents?.length });

const failed = checks.filter(c => !c.ok);
const report = {
  backup: 'NOA-Library-V2-R1365-backup.zip',
  documentHash, meta: backup.manifest,
  migration: migrated.data,
  counts: { txCount, rngCount, cpCount, memoryDocCount, memoryIndexCount, expectedMemoryDocs, events: rebuilt.events.length, receipts: Object.keys(rebuilt.receipts).length },
  checks, failed: failed.length,
  verdict: failed.length ? 'FAIL' : 'PASS',
  note: '离线只读迁移校验；未连接正式库、未写入生产。'
};
writeFileSync(resolve(ROOT, 'reports/r1365-migration-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.verdict === 'PASS' ? { verdict: 'PASS', checks: checks.length, counts: report.counts } : report, null, 2));
process.exit(failed.length ? 1 : 0);
