#!/usr/bin/env node
/**
 * NOA-INFRA-002: R1550 large-archive offline recovery.
 * Reuses the existing V2 restore + V3 migration implementation; never contacts a hosted instance.
 * Commands: restore | smoke | artifacts | load | all
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import '../apps/sites/src/shared-hash.ts';
import { sha256, hashText } from '../packages/core/shared.ts';
import { D1Sqlite, applyMigrations } from '../apps/sites/test/d1-sqlite.mjs';
import { promoteVault } from '../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, documentV3, unfreezeAuthority, V3_SCHEMA_SQL } from '../apps/sites/src/storage-v3.js';
import { COMPONENT_SCHEMA_SQL } from '../apps/sites/src/state-core.js';
import { stateFromComponents } from '../apps/sites/src/state-core.js';
import { openLocalHost } from '../packages/local/host.ts';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const command = argv[0] ?? 'all';
const flag = (name, fallback = '') => {
  const current = process.argv.slice(2);
  const i = current.indexOf(`--${name}`);
  return i >= 0 ? (current[i + 1] ?? fallback) : fallback;
};
const bool = name => process.argv.slice(2).includes(`--${name}`);
const DEFAULT_BACKUP = join(ROOT, 'backups/R1550/noa-library-backup.json');
const DEFAULT_OUT = join(ROOT, 'deploy/data/r1550-recovery');
const EXPECTED_BACKUP_SHA256 = '80babb0ba6e5cab6166558c7dc1120791477a557f0508dda2b2b104823eb36f3';
const EXPECTED_GZ_SHA256 = 'bb760fd27cebf94fd2de892f1ef9bafe49baba827965a8920e0f7ec86bd58db9';
const MAX_REQUEST_BYTES = 1950000;
const utf8 = value => Buffer.byteLength(value, 'utf8');
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const stable = value => sha256(value);
const out = (cmd, value) => process.stdout.write(`${JSON.stringify({ command: cmd, ...value }, null, 2)}\n`);
const fail = message => { throw new Error(message); };

function closeDb(db) {
  try { db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  db.close();
}
function removeDb(path) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}
function quote(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}
function splitSql(sql) {
  return sql.split('--> statement-breakpoint')
    .flatMap(part => part.split(/;\s*(?:\n|$)/))
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(s => `${s};`);
}
function schemaStatements() {
  const files = ['0000_vault.sql', '0001_shards.sql'];
  const fromFiles = files.flatMap(file => splitSql(readFileSync(join(ROOT, 'apps/sites/drizzle', file), 'utf8')));
  return [...fromFiles, ...V3_SCHEMA_SQL, ...COMPONENT_SCHEMA_SQL].map(s => splitSql(s).join('\n')).join('\n');
}
function xmlSafeDate() { return new Date().toISOString(); }
function tableHashes(db) {
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  const result = {};
  for (const table of tables) {
    let rows;
    try { rows = db.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(); }
    catch { rows = db.db.prepare(`SELECT * FROM "${table}"`).all().slice().sort((a, b) => stable(a).localeCompare(stable(b))); }
    result[table] = { rows: rows.length, sha256: stable(rows) };
  }
  return result;
}
async function readV3Doc(db, owner, family, campaignId, worldlineId) {
  const row = await db.prepare('SELECT body,digest FROM noa_v3_doc WHERE owner_id=? AND family=? AND slot=?').bind(owner, family, '').first();
  if (!row) return null;
  let text = row.body;
  if (!text) {
    const chunks = await db.prepare('SELECT body FROM noa_v3_doc_chunk WHERE owner_id=? AND family=? AND slot=? ORDER BY ordinal').bind(owner, family, '').all();
    const bytes = new Uint8Array(chunks.results.reduce((n, r) => n + atob(r.body).length, 0));
    let offset = 0;
    for (const r of chunks.results) { const part = atob(r.body); for (let i = 0; i < part.length; i++) bytes[offset++] = part.charCodeAt(i); }
    text = new TextDecoder().decode(bytes);
  }
  if (hashText(text) !== row.digest) fail(`v3 shard checksum mismatch: ${family}`);
  const value = JSON.parse(text);
  if (family.startsWith('working:')) {
    const todos = await db.prepare('SELECT todo_id,status FROM noa_v3_todo WHERE owner_id=? AND campaign_id=? AND worldline_id=?').bind(owner, campaignId, worldlineId).all();
    const map = new Map(todos.results.map(r => [r.todo_id, r.status]));
    value.pendingEvents = (value.pendingEvents ?? []).map(t => ({ ...t, status: map.get(t.id) ?? t.status }));
  }
  return value;
}

async function verifyDomains(db, owner, document, backup, restoreMeta) {
  const checks = [];
  const check = (name, ok, detail = {}) => checks.push({ name, ok: Boolean(ok), ...detail });
  const count = async (sql, ...params) => Number((await db.prepare(sql).bind(...params).first())?.n ?? 0);
  const sourceLine = document.campaigns['SAVE-481'].lines['wl-main'];
  const campaignId = document.active.campaignId;
  const worldlineId = document.active.worldlineId;
  const allLines = Object.values(document.campaigns).flatMap(c => Object.values(c.lines ?? {}));
  const expected = {
    events: document.events.length,
    receipts: Object.keys(document.receipts).length,
    checkpoints: Object.keys(document.checkpoints).length,
    entities: allLines.reduce((n, l) => n + (l.entities?.length ?? 0), 0),
    relations: allLines.reduce((n, l) => n + (l.relations?.length ?? 0), 0),
    episodes: allLines.reduce((n, l) => n + (l.episodes?.length ?? 0), 0),
    rng: Object.values(document.receipts).filter(r => ['runtime_execute', 'runtime_execute_roll'].includes((r.receipt ?? r).op)).length
  };
  const actual = {
    events: await count('SELECT count(*) n FROM noa_v3_event WHERE owner_id=?', owner),
    receipts: await count('SELECT count(*) n FROM noa_v3_tx WHERE owner_id=?', owner),
    checkpoints: await count('SELECT count(*) n FROM noa_v3_checkpoint WHERE owner_id=?', owner),
    entities: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'entity:%'", owner),
    relations: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'relation:%'", owner),
    episodes: await count("SELECT count(*) n FROM noa_v3_doc WHERE owner_id=? AND family LIKE 'episode:%'", owner),
    rng: await count('SELECT count(*) n FROM noa_v3_rng WHERE owner_id=?', owner)
  };
  for (const key of Object.keys(expected)) check(`count:${key}`, actual[key] === expected[key], { actual: actual[key], expected: expected[key] });

  const rebuilt = await documentV3(db, owner);
  check('domain:active', stable(rebuilt.active) === stable(document.active));
  check('domain:persona', stable(rebuilt.persona) === stable(document.persona));
  check('domain:campaigns', stable(rebuilt.campaigns) === stable(document.campaigns));
  check('domain:campaignPersonas', stable(rebuilt.campaignPersonas) === stable(document.campaignPersonas ?? {}));

  const sortById = rows => rows.slice().sort((a, b) => String(a.id ?? a.eventId ?? a.receipt?.id ?? '').localeCompare(String(b.id ?? b.eventId ?? b.receipt?.id ?? '')));
  const eventHash = stable(sortById(rebuilt.events));
  const sourceEventHash = stable(sortById(document.events));
  check('history:events', eventHash === sourceEventHash, { hash: eventHash, expected: sourceEventHash });
  const receiptHash = stable(sortById(Object.values(rebuilt.receipts)));
  const sourceReceiptHash = stable(sortById(Object.values(document.receipts)));
  check('history:receipts', receiptHash === sourceReceiptHash, { hash: receiptHash, expected: sourceReceiptHash });
  const cpView = value => sortById(Object.values(value).map(cp => ({ id: cp.id, snapshot: cp.snapshot })));
  check('history:checkpoints', stable(cpView(rebuilt.checkpoints)) === stable(cpView(document.checkpoints)));

  const builtState = await stateFromComponents(db, owner, { campaignId, worldlineId });
  check('business:state', stable(builtState) === stable(sourceLine.state), { revision: builtState.revision });
  const working = await readV3Doc(db, owner, `working:${campaignId}:${worldlineId}`, campaignId, worldlineId);
  check('business:working', Boolean(working) && stable(working) === stable(sourceLine.working));
  const revision = await db.prepare('SELECT revision,rng_cursor,state_hash FROM noa_v3_revision WHERE owner_id=? AND campaign_id=? AND worldline_id=?')
    .bind(owner, campaignId, worldlineId).first();
  check('business:revision', Number(revision?.revision) === 1550, { revision: revision?.revision });
  check('business:rng-cursor', Number(revision?.rng_cursor) === 657 && sourceLine.state.rng.cursor === 657, { cursor: revision?.rng_cursor });
  check('business:rng-seed', sourceLine.state.rng.seed === 1581654255, { seed: sourceLine.state.rng.seed });

  const graphRows = await db.prepare('SELECT count(*) n FROM noa_v3_adjacency WHERE owner_id=?').bind(owner).all();
  check('graph:adjacency', Number(graphRows.results[0]?.n ?? 0) >= expected.relations, { edges: graphRows.results[0]?.n, relations: expected.relations });
  const traverse = await (await import('../apps/sites/src/storage-v3.js')).memoryTraverseV3(db, owner, {
    campaignId, worldlineId, viewer: 'gm', start: sourceLine.relations[0]?.subject ?? 'person.player', hops: 2
  });
  check('graph:traverse', traverse.ok === true && traverse.data.nodes.length > 1, { nodes: traverse.data?.nodes?.length });

  check('migration:gate', restoreMeta?.ok === true && restoreMeta?.data?.status === 'active', { status: restoreMeta?.data?.status });
  check('authority:frozen', (await db.prepare('SELECT frozen,target FROM noa_authority_pointer WHERE owner_id=?').bind(owner).first())?.frozen === 1);

  const evidence = {
    backupSha256: fileHash(flag('backup', DEFAULT_BACKUP)),
    documentSha256: stable(document),
    businessSha256: stable(document.campaigns),
    stateSha256: stable(sourceLine.state),
    workingSha256: stable(sourceLine.working),
    eventSha256: sourceEventHash,
    receiptSha256: sourceReceiptHash,
    checkpointSha256: stable(cpView(document.checkpoints)),
    personaSha256: stable(document.persona),
    graphSha256: stable((graphRows.results ?? []).map(r => r.n)),
    tableHashes: tableHashes(db),
    revision: 1550,
    rngCursor: 657,
    rngSeed: sourceLine.state.rng.seed,
    sourceVersion: backup.manifest?.sourceVersion ?? null,
    storageVersion: backup.manifest?.storageVersion ?? null,
    counts: { ...expected, operations: (document.operations ?? []).length, campaigns: Object.keys(document.campaigns).length, worldlines: allLines.length }
  };
  return { checks, evidence };
}

async function restore() {
  const backupPath = resolve(flag('backup', DEFAULT_BACKUP));
  const outDir = resolve(flag('out', DEFAULT_OUT));
  const owner = flag('owner', process.env.NOA_RECOVERY_OWNER ?? 'save481-recovery');
  mkdirSync(outDir, { recursive: true });
  const backupBytes = readFileSync(backupPath);
  const backupSha256 = createHash('sha256').update(backupBytes).digest('hex');
  if (backupSha256 !== EXPECTED_BACKUP_SHA256) fail(`backup sha256 mismatch: ${backupSha256}`);
  const backup = JSON.parse(backupBytes.toString('utf8'));
  if (backup.format !== 'noa-sites-v2' || backup.document?.format !== 'noa-sites-v1') fail('unsupported backup format');
  const document = backup.document;
  const line = document.campaigns['SAVE-481']?.lines?.['wl-main'];
  if (!line || line.state.revision !== 1550 || line.state.rng?.cursor !== 657) fail('R1550/rng cursor baseline mismatch');
  const dbPath = join(outDir, 'clean.sqlite');
  if (existsSync(dbPath) && !bool('force')) fail(`${dbPath} exists; use --force`);
  if (existsSync(dbPath)) removeDb(dbPath);
  const db = new D1Sqlite(dbPath);
  applyMigrations(db, join(ROOT, 'apps/sites'));
  const v2 = await promoteVault(db, owner, { dryRun: false }, null, document);
  const v3 = await promoteV3AndActivate(db, owner, document, {
    source: 'r1550-offline', sourceVersion: String(backup.manifest?.sourceVersion ?? ''), frozen: 1
  });
  if (!v3.ok) fail(`promoteV3AndActivate failed: ${JSON.stringify(v3)}`);
  const { checks, evidence } = await verifyDomains(db, owner, document, backup, v3);
  closeDb(db);
  const failed = checks.filter(c => !c.ok);
  const report = {
    verdict: failed.length ? 'FAIL' : 'PASS', owner,
    backup: { path: backupPath, sha256: backupSha256, bytes: backupBytes.length,
      gzSha256: EXPECTED_GZ_SHA256, manifest: backup.manifest },
    cleanDb: { path: dbPath, sha256: fileHash(dbPath) },
    restore: { v2, v3 }, evidence, checks, failed: failed.length,
    note: '只读离线副本；未连接线上实例，未写入正式 V2。'
  };
  writeFileSync(join(outDir, 'restore-report.json'), JSON.stringify(report, null, 2) + '\n');
  out('restore', { verdict: report.verdict, checks: checks.length, failed: failed.length, evidence: report.evidence });
  if (failed.length) process.exitCode = 1;
}

async function mcpWrite(input) {
  const { dbPath, owner, outDir, name } = input;
  const originalHash = fileHash(dbPath);
  const runtimeDb = join(outDir, `${name}.sqlite`);
  if (existsSync(runtimeDb)) removeDb(runtimeDb);
  copyFileSync(dbPath, runtimeDb);
  const db = new D1Sqlite(runtimeDb);
  const thaw = await unfreezeAuthority(db, owner);
  closeDb(db);
  if (!thaw.ok) fail(`unfreeze failed: ${JSON.stringify(thaw)}`);
  const host = await openLocalHost({ dbPath: runtimeDb, owner, seed: false });
  try {
    const before = await host.call('state_read', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    const commit = await host.call('event_commit', {
      campaignId: 'SAVE-481', worldlineId: 'wl-main', eventId: `NOA-INFRA-002-${name.toUpperCase()}`,
      expectedRevision: before.data.state.revision, idempotencyKey: `NOA-INFRA-002-${name.toUpperCase()}`,
      statePatch: { flags: { [`noaInfra002${name}`]: true } }
    });
    const receipt = await host.call('event_receipt', { campaignId: 'SAVE-481', worldlineId: 'wl-main', lookup: `NOA-INFRA-002-${name.toUpperCase()}` });
    const after = await host.call('state_read', { campaignId: 'SAVE-481', worldlineId: 'wl-main' });
    const ok = before.ok && commit.ok && receipt.ok && after.ok
      && Number(after.data.state.revision) === Number(before.data.state.revision) + 1
      && receipt.data.receipt?.eventId === `NOA-INFRA-002-${name.toUpperCase()}`;
    return { ok, runtimeDb, runtimeSha256: fileHash(runtimeDb), originalSha256: originalHash,
      originalUnchanged: fileHash(dbPath) === originalHash, beforeRevision: before.data?.state?.revision,
      afterRevision: after.data?.state?.revision, commit, receipt };
  } finally { host.close(); }
}

async function smoke() {
  const outDir = resolve(flag('out', DEFAULT_OUT));
  const owner = flag('owner', process.env.NOA_RECOVERY_OWNER ?? 'save481-recovery');
  const result = await mcpWrite({ dbPath: join(outDir, 'clean.sqlite'), owner, outDir, name: 'smoke' });
  writeFileSync(join(outDir, 'smoke-report.json'), JSON.stringify(result, null, 2) + '\n');
  out('smoke', result);
  if (!result.ok || !result.originalUnchanged) process.exitCode = 1;
}

function sqlBatches(outDir, owner, evidence, shardBytes) {
  const db = new D1Sqlite(join(outDir, 'clean.sqlite'));
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  const batches = [];
  let current = { statements: [], bytes: 0, rows: 0, tables: [] };
  const flush = () => {
    if (!current.statements.length) return;
    const index = batches.length;
    const file = `data-${String(index).padStart(3, '0')}.sql`;
    const text = current.statements.join('\n') + '\n';
    writeFileSync(join(outDir, 'sql', file), text, 'utf8');
    batches.push({ file, bytes: utf8(text), sha256: createHash('sha256').update(text).digest('hex'), rows: current.rows, tables: [...new Set(current.tables)] });
    current = { statements: [], bytes: 0, rows: 0, tables: [] };
  };
  for (const table of tables) {
    const columns = db.db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name);
    let rows;
    try { rows = db.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(); }
    catch { rows = db.db.prepare(`SELECT * FROM "${table}"`).all().slice().sort((a, b) => stable(a).localeCompare(stable(b))); }
    for (const row of rows) {
      const sql = `INSERT OR REPLACE INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(c => quote(row[c])).join(',')});`;
      const bytes = utf8(sql) + 1;
      if (sql.slice(0, 6).toLowerCase() !== 'insert') fail(`unexpected statement for ${table}`);
      if (current.statements.length && current.bytes + bytes > shardBytes) flush();
      if (bytes > shardBytes) fail(`single row in ${table} exceeds shardBytes (${bytes}>${shardBytes}); adjust --shard-bytes below request cap`);
      current.statements.push(sql);
      current.bytes += bytes;
      current.rows++;
      current.tables.push(table);
    }
  }
  flush();
  closeDb(db);
  const schema = schemaStatements();
  writeFileSync(join(outDir, 'sql', '000_schema.sql'), schema, 'utf8');
  const activation = [
    `UPDATE noa_authority_pointer SET frozen=0, updated_at='${xmlSafeDate()}' WHERE owner_id='${owner}';`,
    `INSERT OR REPLACE INTO noa_authority_smoke (owner_id, started_at) VALUES ('${owner}', '${xmlSafeDate()}');`
  ].join('\n') + '\n';
  writeFileSync(join(outDir, 'sql', 'zzz_activate.sql'), activation, 'utf8');
  const order = ['000_schema.sql', ...batches.map(b => b.file)];
  const manifest = {
    format: 'noa-v3-init-batch', version: 1, kind: 'save481-r1550-offline',
    ownerMapping: {
      source: 'R1550 V2 archive carries no owner binding',
      target: owner, env: 'NOA_REPAIR_OWNER', note: 'Set the same owner on the isolated Sites instance before importing.'
    },
    shardBytes, maxRequestBytes: MAX_REQUEST_BYTES,
    schema: { file: '000_schema.sql', bytes: utf8(schema), sha256: createHash('sha256').update(schema).digest('hex') },
    order, batches, activation: { file: 'zzz_activate.sql', sha256: createHash('sha256').update(activation).digest('hex'), executeOnlyAfterVerification: true },
    conditions: [
      'Apply 000_schema.sql then every data-* batch in ascending order; stop on any SQL error.',
      'Recompute sha256 for every applied file and compare with this manifest.',
      'Verify noa_v3_head.migration.status=complete, authority pointer target=v3 and frozen=1.',
      'Verify revision=1550, rng cursor=657, and all domain hashes/counts in evidence.',
      'Only after hosted acceptance, execute zzz_activate.sql to unfreeze; never before verification.'
    ],
    evidence
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function artifacts() {
  const outDir = resolve(flag('out', DEFAULT_OUT));
  const owner = flag('owner', process.env.NOA_RECOVERY_OWNER ?? 'save481-recovery');
  const shardBytes = Number(flag('shard-bytes', '900000'));
  if (!(shardBytes > 0 && shardBytes < MAX_REQUEST_BYTES)) fail(`shard-bytes must be 1..${MAX_REQUEST_BYTES - 1}`);
  const before = fileHash(join(outDir, 'clean.sqlite'));
  const sqlDir = join(outDir, 'sql');
  mkdirSync(sqlDir, { recursive: true });
  for (const file of readdirSync(sqlDir)) if (file.endsWith('.sql')) rmSync(join(sqlDir, file), { force: true });
  const report = JSON.parse(readFileSync(join(outDir, 'restore-report.json'), 'utf8'));
  if (report.verdict !== 'PASS') fail('restore report is not PASS');
  const manifest = sqlBatches(outDir, owner, report.evidence, shardBytes);
  const after = fileHash(join(outDir, 'clean.sqlite'));
  if (before !== after) fail('clean DB changed while generating artifacts');
  out('artifacts', { sqlDir, order: manifest.order.length, batches: manifest.batches.length,
    largestBatchBytes: Math.max(...manifest.batches.map(b => b.bytes)), owner, cleanDbUnchanged: before === after });
}

async function load() {
  const artifactDir = resolve(flag('artifact', flag('out', DEFAULT_OUT)));
  const manifest = JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8'));
  const dbPath = resolve(flag('db', join(artifactDir, 'loaded.sqlite')));
  if (existsSync(dbPath) && !bool('force')) fail(`${dbPath} exists; use --force`);
  if (existsSync(dbPath)) removeDb(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new D1Sqlite(dbPath);
  for (const file of manifest.order) {
    const path = join(artifactDir, 'sql', file);
    const bytes = readFileSync(path);
    const expected = file === manifest.schema.file ? manifest.schema.sha256 : manifest.batches.find(b => b.file === file)?.sha256;
    if (createHash('sha256').update(bytes).digest('hex') !== expected) fail(`artifact hash mismatch: ${file}`);
    db.db.exec(bytes.toString('utf8'));
  }
  const owner = manifest.ownerMapping.target;
  const revision = await db.prepare('SELECT revision,rng_cursor FROM noa_v3_revision WHERE owner_id=? AND campaign_id=? AND worldline_id=?')
    .bind(owner, 'SAVE-481', 'wl-main').first();
  const pointer = await db.prepare('SELECT target,frozen FROM noa_authority_pointer WHERE owner_id=?').bind(owner).first();
  const head = await db.prepare('SELECT migration FROM noa_v3_head WHERE owner_id=?').bind(owner).first();
  const evidence = manifest.evidence;
  const checks = [
    { name: 'revision', ok: Number(revision?.revision) === evidence.revision },
    { name: 'rng cursor', ok: Number(revision?.rng_cursor) === evidence.rngCursor },
    { name: 'authority frozen', ok: pointer?.target === 'v3' && Number(pointer?.frozen) === 1 },
    { name: 'head complete', ok: JSON.parse(head?.migration ?? '{}').status === 'complete' }
  ];
  for (const [key, value] of Object.entries(evidence.counts)) {
    const table = { events: 'noa_v3_event', receipts: 'noa_v3_tx', checkpoints: 'noa_v3_checkpoint', entities: 'noa_v3_doc', relations: 'noa_v3_doc', episodes: 'noa_v3_doc', rng: 'noa_v3_rng' }[key];
    if (!table) continue;
    const familyKind = { entities: 'entity', relations: 'relation', episodes: 'episode' }[key];
    const filter = familyKind ? ` AND family LIKE '${familyKind}:%'` : '';
    const n = Number((await db.prepare(`SELECT count(*) n FROM ${table} WHERE owner_id=?${filter}`).bind(owner).first())?.n ?? 0);
    checks.push({ name: `count:${key}`, ok: n === value, actual: n, expected: value });
  }
  const loadedTables = tableHashes(db);
  for (const [table, meta] of Object.entries(evidence.tableHashes ?? {})) {
    const actual = loadedTables[table];
    checks.push({ name: `table:${table}`, ok: actual?.rows === meta.rows && actual?.sha256 === meta.sha256,
      actualRows: actual?.rows, expectedRows: meta.rows, actualSha256: actual?.sha256, expectedSha256: meta.sha256 });
  }
  closeDb(db);
  let mcp = null;
  if (bool('smoke')) {
    mcp = await mcpWrite({ dbPath, owner, outDir: artifactDir, name: 'runtime' });
    checks.push({ name: 'mcp write', ok: mcp.ok && mcp.originalUnchanged });
  }
  const failed = checks.filter(c => !c.ok);
  const report = { verdict: failed.length ? 'FAIL' : 'PASS', artifactDir, dbPath, sha256: fileHash(dbPath), checks, mcp, failed: failed.length };
  writeFileSync(join(artifactDir, 'load-report.json'), JSON.stringify(report, null, 2) + '\n');
  out('load', report);
  if (failed.length) process.exitCode = 1;
}

async function all() {
  const outDir = resolve(flag('out', DEFAULT_OUT));
  const owner = flag('owner', process.env.NOA_RECOVERY_OWNER ?? 'save481-recovery');
  const args = process.argv.slice(2).filter(a => !['all', 'restore', 'smoke', 'artifacts', 'load'].includes(a));
  const run = async (name, extra = []) => {
    const previous = process.argv;
    process.argv = [previous[0], previous[1], name, ...args, ...extra];
    try {
      if (name === 'restore') await restore();
      else if (name === 'smoke') await smoke();
      else if (name === 'artifacts') await artifacts();
      else if (name === 'load') await load();
    } finally { process.argv = previous; }
  };
  await run('restore', ['--force']);
  await run('smoke');
  await run('artifacts', ['--force']);
  await run('load', ['--force', '--smoke']);
  out('all', { outDir, owner, verdict: 'PASS' });
}

const handlers = { restore, smoke, artifacts, load, all };
if (!handlers[command]) fail(`unknown command: ${command}`);
await handlers[command]();
