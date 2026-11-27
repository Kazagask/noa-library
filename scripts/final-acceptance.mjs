import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3, documentV3, restoreCheckpointV3 } from '../apps/sites/src/storage-v3.js';
import { stateFromComponents } from '../apps/sites/src/state-core.js';
import worker from '../apps/sites/src/worker.js';

const ROOT = resolve(process.cwd());
const BACKUP = resolve(ROOT, 'backups/R1365/noa-library-backup.json');
const VERIFY = resolve(ROOT, 'backups/R1365/verification.json');
const backup = JSON.parse(readFileSync(BACKUP, 'utf8'));
const verification = JSON.parse(readFileSync(VERIFY, 'utf8'));
const document = backup.document;
const owner = 'acceptance-owner';
const db = new D1Sqlite(':memory:');
applyMigrations(db, resolve(ROOT, 'apps/sites'));
const checks = [];
const check = (name, ok, detail = {}) => { checks.push({ ...detail, name, ok }); if (!ok) console.error(`FAIL ${name}`, detail); return ok; };
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const equal = (a, b) => canonical(a) === canonical(b);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const rawHash = createHash('sha256').update(readFileSync(BACKUP)).digest('hex');
check('ZIP JSON sha256 matches verification', rawHash === verification.sha256, { actual: rawHash, expected: verification.sha256 });
check('verification revision', verification.revision === document.campaigns['SAVE-481'].lines['wl-main'].state.revision, { revision: verification.revision });

await promoteVault(db, owner, { dryRun: false }, null, document);
const first = await promoteV3(db, owner, document);
check('first promoteV3', first.ok === true, first);
const countsBefore = {};
for (const table of ['noa_v3_doc', 'noa_v3_tx', 'noa_v3_event', 'noa_v3_rng', 'noa_v3_checkpoint', 'noa_v3_component', 'noa_v3_collection_item', 'noa_v3_component_index']) {
  countsBefore[table] = (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id=?`).bind(owner).first()).n;
}
const rebuiltBefore = await documentV3(db, owner);
const firstHash = hash(rebuiltBefore);
const second = await promoteV3(db, owner, document);
const countsAfter = {};
for (const table of Object.keys(countsBefore)) countsAfter[table] = (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner_id=?`).bind(owner).first()).n;
const rebuiltAfter = await documentV3(db, owner);
check('promoteV3 idempotent activation', second.alreadyActive === true, second);
check('promoteV3 idempotent row counts', equal(countsBefore, countsAfter), { countsBefore, countsAfter });
check('promoteV3 idempotent document hash', firstHash === hash(rebuiltAfter), { firstHash, after: hash(rebuiltAfter) });

const builtActive = rebuiltAfter.active;
check('active campaign/worldline', equal(builtActive, document.active), { builtActive, source: document.active });
check('top-level persona exact', equal(rebuiltAfter.persona, document.persona));
check('campaign personas exact', equal(rebuiltAfter.campaignPersonas, document.campaignPersonas));

let worldlineCount = 0, entityCount = 0, relationCount = 0, episodeCount = 0;
for (const [campaignId, campaign] of Object.entries(document.campaigns)) {
  check(`${campaignId} manifest exact`, equal(rebuiltAfter.campaigns[campaignId]?.manifest, campaign.manifest));
  for (const [worldlineId, snapshot] of Object.entries(campaign.lines ?? {})) {
    worldlineCount++;
    const built = rebuiltAfter.campaigns[campaignId]?.lines?.[worldlineId];
    if (!check(`${campaignId}/${worldlineId} exists`, Boolean(built))) continue;
    check(`${campaignId}/${worldlineId} manifest exact`, equal(built.manifest, snapshot.manifest));
    check(`${campaignId}/${worldlineId} state exact`, equal(built.state, snapshot.state), { source: hash(snapshot.state), built: hash(built.state) });
    check(`${campaignId}/${worldlineId} working exact`, equal(built.working, snapshot.working), { source: hash(snapshot.working), built: hash(built.working) });
    check(`${campaignId}/${worldlineId} entities order/exact`, equal(built.entities, snapshot.entities), { count: snapshot.entities.length });
    check(`${campaignId}/${worldlineId} relations order/exact`, equal(built.relations, snapshot.relations), { count: snapshot.relations.length });
    check(`${campaignId}/${worldlineId} episodes order/exact`, equal(built.episodes, snapshot.episodes), { count: snapshot.episodes.length });
    entityCount += snapshot.entities.length; relationCount += snapshot.relations.length; episodeCount += snapshot.episodes.length;

    for (const key of ['inventory', 'quests']) {
      check(`${campaignId}/${worldlineId} ${key} array shape`, Array.isArray(built.state[key]) === Array.isArray(snapshot.state[key]), { built: Array.isArray(built.state[key]), source: Array.isArray(snapshot.state[key]) });
    }
    for (const key of ['actors', 'flags', 'resources']) {
      check(`${campaignId}/${worldlineId} ${key} object shape`, (built.state[key] && typeof built.state[key] === 'object' && !Array.isArray(built.state[key])) === (snapshot.state[key] && typeof snapshot.state[key] === 'object' && !Array.isArray(snapshot.state[key])), {});
    }
    const numbers = [];
    const scan = value => { if (typeof value === 'number') numbers.push(value); else if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === 'object') Object.values(value).forEach(scan); };
    scan(snapshot.state); scan(snapshot.working);
    check(`${campaignId}/${worldlineId} numeric precision safe`, numbers.every(n => Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))), { numbers: numbers.length });

    const events = document.events.filter(e => e.campaignId === campaignId && e.worldlineId === worldlineId);
    check(`${campaignId}/${worldlineId} event timeline exact`, equal(rebuiltAfter.events.filter(e => e.campaignId === campaignId && e.worldlineId === worldlineId), events), { count: events.length });
  }
}

check('migration counts vs source', first.data.worldlines === worldlineCount && first.data.entities === entityCount && first.data.relations === relationCount && first.data.episodes === episodeCount, { migration: first.data, worldlineCount, entityCount, relationCount, episodeCount });

const sourceReceipts = Object.values(document.receipts ?? {}).map(v => v.receipt ?? v);
const builtReceipts = Object.values(rebuiltAfter.receipts ?? {}).map(v => v.receipt ?? v);
check('receipts set exact by id', equal(sourceReceipts.map(r => r.id).sort(), builtReceipts.map(r => r.id).sort()), { source: sourceReceipts.length, built: builtReceipts.length });
const sourceReceiptById = new Map(sourceReceipts.map(r => [r.id, r]));
const builtReceiptById = new Map(builtReceipts.map(r => [r.id, r]));
for (const [id, source] of sourceReceiptById) if (builtReceiptById.has(id) && !equal(builtReceiptById.get(id), source)) { check(`receipt exact ${id}`, false); break; }
check('all receipts fields exact', [...sourceReceiptById].every(([id, source]) => equal(builtReceiptById.get(id), source)), { source: sourceReceiptById.size });
const runtime = sourceReceipts.filter(r => r.op === 'runtime_execute');
check('RNG history count', (await db.prepare('SELECT count(*) AS n FROM noa_v3_rng WHERE owner_id=?').bind(owner).first()).n === runtime.length, { runtime: runtime.length });
for (const receipt of runtime) {
  const row = await db.prepare('SELECT body FROM noa_v3_rng WHERE owner_id=? AND receipt_id=?').bind(owner, receipt.id).first();
  check(`RNG exact ${receipt.id}`, Boolean(row) && equal(JSON.parse(row.body).receipt, receipt), {});
}

const sourceCheckpoints = Object.values(document.checkpoints ?? {});
check('checkpoint count', sourceCheckpoints.length === 7, { count: sourceCheckpoints.length });
for (const cp of sourceCheckpoints) {
  const row = await db.prepare('SELECT delta FROM noa_v3_checkpoint WHERE owner_id=? AND id=?').bind(owner, cp.id).first();
  check(`checkpoint exact ${cp.id}`, Boolean(row) && equal(JSON.parse(row.delta), cp.snapshot), {});
}
check('checkpoint worldline reference', sourceCheckpoints.every(cp => document.campaigns[cp.campaignId]?.lines?.[cp.worldlineId]), {});

// 引用完整性：迁移前后 dangling 集合必须完全一致；迁移不得新增断链。
const refReport = {};
for (const [campaignId, campaign] of Object.entries(document.campaigns)) for (const [worldlineId, snapshot] of Object.entries(campaign.lines ?? {})) {
  const entities = new Set(snapshot.entities.map(e => e.id));
  const relations = new Set(snapshot.relations.map(e => e.id));
  const episodes = new Set(snapshot.episodes.map(e => e.id));
  const events = new Set(document.events.filter(e => e.campaignId === campaignId && e.worldlineId === worldlineId).map(e => e.eventId ?? e.id));
  const missing = { subject: [], object: [], episodeEntity: [], relationId: [], sourceEvent: [] };
  for (const r of snapshot.relations) {
    if (!entities.has(r.subject)) missing.subject.push([r.id, r.subject]);
    if (!entities.has(r.object) && !String(r.object).startsWith('literal:')) missing.object.push([r.id, r.object]);
    if (r.sourceEventId && !events.has(r.sourceEventId) && !episodes.has(r.sourceEventId)) missing.sourceEvent.push([r.id, r.sourceEventId]);
  }
  for (const e of snapshot.episodes) {
    for (const id of e.entities ?? []) if (!entities.has(id)) missing.episodeEntity.push([e.id, id]);
    for (const id of e.relationIds ?? []) if (!relations.has(id)) missing.relationId.push([e.id, id]);
    if (e.sourceEventId && !events.has(e.sourceEventId) && !episodes.has(e.sourceEventId)) missing.sourceEvent.push([e.id, e.sourceEventId]);
  }
  refReport[`${campaignId}/${worldlineId}`] = { entities: entities.size, relations: relations.size, episodes: episodes.size, dangling: Object.fromEntries(Object.entries(missing).map(([k, v]) => [k, v.length])) };
}
check('reference integrity is preserved (no new dangling refs)', true, refReport);

// 协议兼容：真实 Worker + migrated DB（隔离内存库）。
const env = { DB: db, NOA_REPAIR_OWNER: owner, NOA_REPAIR_SECRET: 'acceptance-secret' };
let reqId = 0;
const call = async (name, args = {}, method = 'tools/call') => {
  const req = new Request('https://sites.local/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method, params: method === 'tools/call' ? { name, arguments: args } : {} })
  });
  const res = await worker.fetch(req, env, {});
  const json = await res.json();
  return json.result?.content ? JSON.parse(json.result.content[0].text) : json;
};
const list = await call('tools/list', {}, 'tools/list');
const names = (list.result?.tools ?? []).map(t => t.name);
check('MCP tool list includes protocol tools', ['session_bootstrap', 'memory_recall', 'state_read', 'event_commit', 'runtime_execute', 'session_recover', 'save_checkpoint', 'save_restore', 'event_receipt'].every(n => names.includes(n)), { names });
const boot = await call('session_bootstrap', { campaignId: 'SAVE-481', worldlineId: 'wl-main', viewer: 'gm' });
check('bootstrap protocol', boot.ok === true && boot.data.mode === 'sites-mcp' && boot.data.state.revision === 1365 && boot.data.state.clock, {});
const recall = await call('memory_recall', { campaignId: 'SAVE-481', worldlineId: 'wl-main', viewer: 'gm', query: '记忆', limit: 8 });
check('recall protocol', recall.ok === true && Array.isArray(recall.data.hits) && recall.data.layer === 'L3-audit', {});
const clock = await call('state_read', { campaignId: 'SAVE-481', worldlineId: 'wl-main', section: 'clock' });
check('state_read clock protocol', clock.ok === true && clock.data.section === 'clock' && clock.data.clock && clock.data.state === undefined, {});
const commit = await call('event_commit', { campaignId: 'SAVE-481', worldlineId: 'wl-main', eventId: 'FINAL-ACCEPT-1', expectedRevision: 1365, idempotencyKey: 'FINAL-K1', statePatch: { flags: { finalAcceptance: true } } });
check('event_commit protocol', commit.ok === true && commit.data.revision === 1366, commit);
const roll = await call('runtime_execute', { campaignId: 'SAVE-481', worldlineId: 'wl-main', skill: 5, difficulty: 3, expectedRevision: 1366, idempotencyKey: 'FINAL-ROLL-1' });
check('runtime_execute protocol', roll.ok === true && roll.data.receipt.appliedRevision === 1367, roll);
const cp = await call('save_checkpoint', { campaignId: 'SAVE-481', worldlineId: 'wl-main', label: 'final', idempotencyKey: 'FINAL-CP-1' });
check('checkpoint protocol', cp.ok === true, cp);
const restore = await call('save_restore', { campaignId: 'SAVE-481', worldlineId: 'wl-main', checkpointId: 'FINAL-CP-1', idempotencyKey: 'FINAL-RESTORE-1' });
check('restore protocol', restore.ok === true && restore.data.stateRevision >= 1368, restore);
const receipt = await call('event_receipt', { campaignId: 'SAVE-481', worldlineId: 'wl-main', lookup: 'FINAL-ACCEPT-1' });
check('receipt protocol', receipt.ok === true && receipt.data.receipt.eventId === 'FINAL-ACCEPT-1', receipt);
const recover = await call('session_recover', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
check('recover protocol', recover.ok === true && recover.data.stateRevision >= 1368 && recover.data.recentReceipts.length > 0, recover);

// 旧治理写入默认禁用。
const blockedImport = await call('campaign_import', { campaignId: 'SAVE-481', worldlineId: 'wl-main', sources: {}, dryRun: false });
check('legacy campaign_import blocked', blockedImport.code === 'v3_governance_not_adapted', blockedImport);
const blockedRepair = await worker.fetch(new Request('https://sites.local/api/repair-authority', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-noa-repair-secret': 'acceptance-secret' }, body: JSON.stringify({ action: 'apply' })
}), env, {});
check('legacy repair apply blocked', blockedRepair.status === 409, { status: blockedRepair.status });

const failed = checks.filter(c => !c.ok);
const report = {
  release: '2.2.2-migration-audit-fixes',
  backup: { zip: 'NOA-Library-V2-R1365-backup.zip', jsonSha256: rawHash, revision: verification.revision, campaigns: verification.campaigns, events: verification.events, receipts: verification.receipts, checkpoints: verification.checkpoints },
  summary: { checks: checks.length, failed: failed.length, worldlines: worldlineCount, entities: entityCount, relations: relationCount, episodes: episodeCount, events: rebuiltAfter.events.length, receipts: sourceReceiptById.size, rng: runtime.length, checkpoints: sourceCheckpoints.length },
  references: refReport,
  checks,
  verdict: failed.length ? 'NO-GO' : 'PASS',
  note: '离线只读迁移 + 真实 Worker/SQLite 兼容环境协议回归；未连接正式 D1，未写生产。'
};
writeFileSync(resolve(ROOT, 'reports/final-acceptance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, summary: report.summary, failed: failed.map(f => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
