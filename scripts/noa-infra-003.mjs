#!/usr/bin/env node
/**
 * NOA-INFRA-003: convert INFRA-002 SQL shards to structured record batches and
 * import them through the Worker's owner-only recovery tools.
 * No SQL is sent to the Worker: only whitelisted table/column rows.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import '../apps/sites/src/shared-hash.ts';
import { sha256, stableStringify } from '../packages/core/shared.ts';
import {
  RECOVERY_BATCH_FORMAT, RECOVERY_MANIFEST_FORMAT, RECOVERY_LIMITS, RECOVERY_TABLES,
  normalizeBatch, recoveryBatchSha256, recoveryStatementBytes
} from '../apps/sites/src/recovery-batch.js';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_ARTIFACT = join(ROOT, 'deploy/data/r1550-recovery');
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const utf8 = value => Buffer.byteLength(value, 'utf8');
const flag = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

function fail(message) { throw new Error(message); }
function out(command, value) { process.stdout.write(`${JSON.stringify({ command, ...value }, null, 2)}\n`); }

function parseIdentifiers(text) {
  const columns = [];
  const re = /"([^"]+)"/g;
  let match;
  while ((match = re.exec(text))) columns.push(match[1]);
  if (!columns.length) fail(`无法解析字段: ${text}`);
  return columns;
}

function parseScalar(text) {
  const value = text.trim();
  if (value === 'NULL') return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replaceAll("''", "'");
  return fail(`无法解析 SQL 标量: ${value.slice(0, 80)}`);
}

function parseValues(text) {
  const values = [];
  let current = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'") {
      if (quoted && text[i + 1] === "'") { current += "'"; i++; }
      else { quoted = !quoted; current += char; }
      continue;
    }
    if (char === ',' && !quoted) { values.push(parseScalar(current)); current = ''; continue; }
    current += char;
  }
  if (quoted) fail('SQL 字符串未闭合');
  values.push(parseScalar(current));
  return values;
}

function parseSqlShard(text, sourceFile) {
  const rows = [];
  const statement = /^INSERT OR REPLACE INTO "([^"]+)" \(([^)]*)\) VALUES \((.*)\);$/;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(statement);
    if (!match) fail(`${sourceFile} 出现非预期语句: ${line.slice(0, 120)}`);
    const [, table, columnText, valueText] = match;
    if (!RECOVERY_TABLES[table]) {
      if (['noa_authority_pointer', 'noa_authority_smoke', 'noa_cas_guard', 'noa_v3_cas_guard'].includes(table)) continue;
      fail(`${sourceFile} 出现非白名单表: ${table}`);
    }
    const columns = parseIdentifiers(columnText);
    if (columns.some(column => !RECOVERY_TABLES[table].includes(column))) fail(`${sourceFile} 出现非白名单字段: ${table}.${columns}`);
    const values = parseValues(valueText);
    if (values.length !== columns.length) fail(`${sourceFile} 列值数量不一致: ${table}`);
    rows.push({ table, columns, values });
  }
  return rows;
}

export function prepareBatches(artifactDir = DEFAULT_ARTIFACT) {
  const sourcePath = join(artifactDir, 'manifest.json');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  if (source.format !== 'noa-v3-init-batch') fail('源清单格式不支持');
  if (fileHash(join(artifactDir, 'sql', source.schema.file)) !== source.schema.sha256) fail('schema SHA-256 不匹配');
  for (const batch of source.batches) {
    if (fileHash(join(artifactDir, 'sql', batch.file)) !== batch.sha256) fail(`源批次 SHA-256 不匹配: ${batch.file}`);
  }

  const batches = [];
  let current = null;
  const flush = () => {
    if (!current || current.rows === 0) return;
    current.ordinal = batches.length;
    current.batchId = `b-${String(current.ordinal).padStart(6, '0')}`;
    current.format = RECOVERY_BATCH_FORMAT;
    current.version = 1;
    const canonical = {
      format: RECOVERY_BATCH_FORMAT, version: 1,
      batchId: current.batchId, ordinal: current.ordinal, records: current.records
    };
    const normalized = normalizeBatch(canonical);
    if (!normalized.ok) fail(`${current.batchId} 规范化失败: ${normalized.message}`);
    current.sha256 = recoveryBatchSha256(canonical);
    current.bytes = recoveryStatementBytes(canonical);
    batches.push(current);
    current = null;
  };
  const next = () => ({ records: [], byTable: new Map(), rows: 0, bytes: 0, sourceFiles: [] });
  const probeBytes = (batch, row) => {
    const existing = batch.byTable.get(row.table);
    const probe = existing ? { table: row.table, columns: existing.columns, rows: [...existing.rows, row.values] }
      : { table: row.table, columns: row.columns, rows: [row.values] };
    const records = existing ? batch.records.map(entry => entry === existing ? probe : entry) : [...batch.records, probe];
    return recoveryStatementBytes({ format: RECOVERY_BATCH_FORMAT, version: 1, batchId: 'x', ordinal: 0, records });
  };
  current = next();

  for (const file of source.order) {
    if (file === source.schema.file || file === source.activation?.file) continue;
    const rows = parseSqlShard(readFileSync(join(artifactDir, 'sql', file), 'utf8'), file);
    for (const row of rows) {
      let bytes = probeBytes(current, row);
      if (current.rows > 0 && (current.rows >= RECOVERY_LIMITS.maxRowsPerBatch || bytes > RECOVERY_LIMITS.maxPayloadBytes)) {
        flush();
        current = next();
        bytes = probeBytes(current, row);
      }
      if (bytes > RECOVERY_LIMITS.maxPayloadBytes) fail(`单行超出分片上限: ${row.table}`);
      let record = current.byTable.get(row.table);
      if (!record) {
        record = { table: row.table, columns: row.columns, rows: [] };
        current.byTable.set(row.table, record);
        current.records.push(record);
      }
      if (stableStringify(row.columns) !== stableStringify(record.columns)) fail(`${file} 同表字段顺序不一致: ${row.table}`);
      record.rows.push(row.values);
      current.rows++;
      current.bytes = bytes;
      if (!current.sourceFiles.includes(file)) current.sourceFiles.push(file);
    }
  }
  flush();

  const manifest = {
    format: RECOVERY_MANIFEST_FORMAT, version: 1,
    sourceManifestFile: 'manifest.json', sourceManifestSha256: sha256(source),
    ownerMapping: source.ownerMapping, evidence: source.evidence,
    schema: source.schema, maxRequestBytes: RECOVERY_LIMITS.maxRequestBytes,
    limits: RECOVERY_LIMITS,
    batches: batches.map(batch => ({ batchId: batch.batchId, ordinal: batch.ordinal, sha256: batch.sha256, rows: batch.rows, bytes: batch.bytes, sourceFiles: batch.sourceFiles, tables: batch.records.map(r => r.table) })),
    order: batches.map(batch => batch.batchId),
    totalRows: batches.reduce((n, batch) => n + batch.rows, 0)
  };
  return { source, manifest, batches };
}

async function prepare() {
  const artifactDir = resolve(flag('artifact', DEFAULT_ARTIFACT));
  const { source, manifest, batches } = prepareBatches(artifactDir);
  const outDir = join(artifactDir, 'recovery');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'recovery-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(outDir, 'recovery-batches.jsonl'), batches.map(batch => JSON.stringify({
    format: RECOVERY_BATCH_FORMAT, version: 1, batchId: batch.batchId, ordinal: batch.ordinal, records: batch.records
  })).join('\n') + '\n');
  out('prepare', {
    outDir, sourceManifestSha256: manifest.sourceManifestSha256, manifestSha256: sha256(manifest),
    batches: batches.length, rows: manifest.totalRows,
    largestBatchBytes: Math.max(...batches.map(batch => batch.bytes)),
    owner: manifest.ownerMapping.target, sourceBatches: source.batches.length
  });
}

async function callWorker(endpoint, owner, name, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } })
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { fail(`Worker 返回非 JSON: ${text.slice(0, 300)}`); }
  if (!response.ok || json.error) fail(`${name} 调用失败: ${json.error?.message ?? text.slice(0, 300)}`);
  const result = JSON.parse(json.result.content[0].text);
  if (!result.ok) fail(`${name} 失败: ${result.code ?? ''} ${result.message ?? ''}`);
  return result.data;
}

function loadRecovery(artifactDir) {
  const dir = join(resolve(artifactDir), 'recovery');
  const manifest = JSON.parse(readFileSync(join(dir, 'recovery-manifest.json'), 'utf8'));
  const batches = readFileSync(join(dir, 'recovery-batches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, manifest, batches };
}

async function importBatches() {
  const artifactDir = resolve(flag('artifact', DEFAULT_ARTIFACT));
  const endpoint = flag('endpoint', process.env.NOA_SITES_MCP_URL ?? 'http://127.0.0.1:8787/mcp');
  const caller = flag('owner', process.env.NOA_SITES_MCP_OWNER ?? '');
  if (!caller) fail('必须提供 --owner（Sites 网关认证的真实 MCP 所有者身份）');
  const { dir, manifest, batches } = loadRecovery(artifactDir);
  if (batches.length !== manifest.batches.length) fail('批次文件数量与清单不一致');
  const manifestSha256 = sha256(manifest);
  const sessionId = flag('session', `rec-${manifestSha256.slice(0, 16)}`);
  const begin = await callWorker(endpoint, caller, 'recovery_begin', { manifestSha256, manifest, sessionId });
  if (begin.manifestSha256 !== manifestSha256) fail('服务端清单哈希不一致');
  const status = await callWorker(endpoint, caller, 'recovery_status', { sessionId });
  const applied = new Set(status.applied);
  let pushed = 0, skipped = 0;
  for (const batch of batches) {
    if (applied.has(batch.batchId)) { skipped++; continue; }
    const meta = manifest.batches.find(row => row.batchId === batch.batchId);
    if (!meta) fail(`批次不在清单: ${batch.batchId}`);
    const result = await callWorker(endpoint, caller, 'recovery_push', { sessionId, batchId: batch.batchId, sha256: meta.sha256, batch });
    if (result.sha256 !== meta.sha256) fail(`批次哈希回传不一致: ${batch.batchId}`);
    pushed++;
  }
  const finalize = await callWorker(endpoint, caller, 'recovery_finalize', { sessionId });
  if (finalize.authority?.target !== 'v3' || finalize.authority?.frozen !== 1) fail('finalize 后权威指针不符合预期');
  const report = { endpoint, caller, sessionId, manifestSha256, pushed, skipped, finalize, verdict: 'PASS' };
  writeFileSync(join(dir, 'import-report.json'), JSON.stringify(report, null, 2) + '\n');
  out('import', report);
}

async function simpleCommand(command) {
  const artifactDir = resolve(flag('artifact', DEFAULT_ARTIFACT));
  const endpoint = flag('endpoint', process.env.NOA_SITES_MCP_URL ?? 'http://127.0.0.1:8787/mcp');
  const caller = flag('owner', process.env.NOA_SITES_MCP_OWNER ?? '');
  if (!caller) fail('必须提供 --owner');
  const { dir, manifest } = loadRecovery(artifactDir);
  const sessionId = flag('session', `rec-${sha256(manifest).slice(0, 16)}`);
  const data = await callWorker(endpoint, caller, `recovery_${command}`, { sessionId });
  writeFileSync(join(dir, `${command}-report.json`), JSON.stringify(data, null, 2) + '\n');
  out(command, data);
}

const handlers = { prepare, import: importBatches, status: () => simpleCommand('status'), finalize: () => simpleCommand('finalize'), abort: () => simpleCommand('abort') };
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const command = process.argv[2] ?? 'prepare';
  if (!handlers[command]) fail(`未知命令: ${command}`);
  await handlers[command]();
}
