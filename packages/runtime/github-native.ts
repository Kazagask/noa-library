import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readJson, writeJsonAtomic, validateSchema, sha256, newId, isObject, ok, fail, type Result
} from '../core/util.ts';
import type { SnapshotRepo } from '../library/store.ts';
import { FsStore } from '../library/fs-store.ts';
import * as ops from '../library/operations.ts';

const OP_WHITELIST = new Set(['state.commit', 'memory.record', 'memory.revise', 'memory.consolidate', 'runtime.execute', 'session.close']);
const ALLOWED_KEYS: Record<string, string[]> = {
  'state.commit': ['op', 'changes', 'resolution', 'reason'],
  'memory.record': ['op', 'kind', 'data', 'idempotencyKey'],
  'memory.revise': ['op', 'kind', 'id', 'expectedRevision', 'patch', 'idempotencyKey'],
  'memory.consolidate': ['op', 'idempotencyKey'],
  'runtime.execute': ['op', 'skill', 'difficulty', 'idempotencyKey'],
  'session.close': ['op', 'label', 'idempotencyKey']
};
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_LOCK_AGE_MS = 5 * 60 * 1000;

export interface RequestOp { op: string; [key: string]: unknown }
export interface RuntimeRequest {
  requestId: string; campaignId: string; worldlineId: string; baseCommitSha?: string;
  expectedRevision: number; idempotencyKey: string; actor: string;
  createdAt: string; expiresAt: string; note?: string; operations: RequestOp[];
}
export interface Receipt {
  status: 'applied' | 'duplicate' | 'partial';
  requestId: string; campaignId: string; worldlineId: string;
  baseRevision: number; appliedRevision?: number; baseCommitSha?: string;
  executedAt: string; duplicate: boolean; operations: { op: string; result: unknown }[];
  hash: string;
}
export interface Rejection {
  status: 'rejected'; requestId: string; code: string; message: string;
  details?: unknown; recovery: string; receivedAt: string;
}

function dirs(root: string) {
  const base = join(root, 'runtime');
  return {
    base, pending: join(base, 'pending'), receipts: join(base, 'receipts'),
    rejected: join(base, 'rejected'), processed: join(base, 'processed.json'), lock: join(base, '.lock')
  };
}

export function headSha(root: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unavailable'; }
}

function safeName(value: string, fallback: string): string {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

function hasDangerousKeys(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => hasDangerousKeys(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) return true;
    if (hasDangerousKeys(v, depth + 1)) return true;
  }
  return false;
}

function validateRequest(root: string, raw: unknown): Result<RuntimeRequest> {
  const schema = readJson(join(root, 'schemas', 'runtime-request.schema.json'));
  const errors = validateSchema(raw, schema);
  if (errors.length) return fail('invalid_request', '请求未通过 Schema 校验', { errors });
  const req = raw as RuntimeRequest;
  if (hasDangerousKeys(req)) return fail('invalid_request', '请求包含不允许的对象键');
  for (const op of req.operations) {
    if (!OP_WHITELIST.has(op.op)) return fail('unsupported_operation', `不支持的操作 ${op.op}`);
    const allowed = new Set(ALLOWED_KEYS[op.op]);
    if (Object.keys(op).some(k => !allowed.has(k))) return fail('invalid_request', `操作 ${op.op} 含未授权字段`);
  }
  return ok(req);
}

export function runtimeStatus(root: string, campaignId: string, worldlineId: string): Result {
  const store = new FsStore(root);
  try {
    const snap = store.read(campaignId, worldlineId);
    return ok({
      campaignId, worldlineId, revision: snap.state.revision,
      memoryRevision: snap.working.memoryRevision ?? 0,
      gitCommitSha: headSha(root),
      receiptDir: 'runtime/receipts', pendingDir: 'runtime/pending'
    });
  } catch (err: any) { return fail('campaign_load_failed', err.message); }
}

/** ChatGPT 写入侧：只写 pending，不接触权威状态。 */
export function submitRequest(root: string, raw: unknown, at: string = new Date().toISOString()): Result {
  const validated = validateRequest(root, raw);
  if (!validated.ok) return validated;
  const req = validated.data;
  const d = dirs(root);
  mkdirSync(d.pending, { recursive: true });
  const name = `${safeName(req.requestId, newId('req'))}.json`;
  const path = join(d.pending, name);
  if (existsSync(path)) {
    const existing = readJson(path);
    if (sha256(existing) === sha256(req)) return ok({ status: 'duplicate_pending', requestId: req.requestId, path: `runtime/pending/${name}` });
    return fail('request_id_conflict', 'requestId 已存在但内容不同', { path: `runtime/pending/${name}` });
  }
  writeJsonAtomic(path, req);
  return ok({ status: 'pending', requestId: req.requestId, path: `runtime/pending/${name}`, next: '等待可信执行器生成 receipt' });
}

function loadProcessed(root: string): Record<string, { requestId: string; receipt: Receipt }> {
  const path = dirs(root).processed;
  return existsSync(path) ? readJson(path) : {};
}

function writeRejection(root: string, rejection: Rejection): void {
  const d = dirs(root);
  mkdirSync(d.rejected, { recursive: true });
  writeJsonAtomic(join(d.rejected, `${safeName(rejection.requestId, 'invalid')}.json`), rejection);
}

function reject(root: string, requestId: string, code: string, message: string, details?: unknown): Result<never> {
  const recoveryByCode: Record<string, string> = {
    revision_conflict: '重新读取 state.revision 与 gitCommitSha，提交新的 requestId。',
    base_commit_mismatch: '仓库 HEAD 已变化，重新确认基线后提交新请求。',
    request_expired: '重新提交并设置新的 expiresAt。',
    unsupported_operation: '仅允许白名单操作，禁止脚本或 shell。',
    invalid_request: '按 schemas/runtime-request.schema.json 修正后重新提交。',
    execution_failed: '查看回执详情；修复输入后使用新 idempotencyKey 重试。'
  };
  const rejection: Rejection = {
    status: 'rejected', requestId: safeName(requestId, 'invalid'), code, message,
    details, recovery: recoveryByCode[code] ?? '修正请求后使用新 requestId 重新提交。',
    receivedAt: new Date().toISOString()
  };
  writeRejection(root, rejection);
  return fail(code, message, details);
}

function acquireLock(root: string): boolean {
  const path = dirs(root).lock;
  const d = dirs(root);
  mkdirSync(d.base, { recursive: true });
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age > MAX_LOCK_AGE_MS) { unlinkSync(path); return acquireLock(root); }
    } catch { /* 锁可能已被释放 */ }
    return false;
  }
}

function releaseLock(root: string): void {
  const path = dirs(root).lock;
  try { if (existsSync(path)) unlinkSync(path); } catch { /* 忽略 */ }
}

/** 可信执行器：只接受白名单操作，不执行请求中的代码或命令。 */
export function executeRequest(root: string, raw: unknown, opts: { baseCommitSha?: string; at?: string } = {}): Result<Receipt> {
  const validated = validateRequest(root, raw);
  if (!validated.ok) return reject(root, 'invalid', validated.code, validated.message, validated.details);
  const req = validated.data;
  const at = opts.at ?? new Date().toISOString();
  const d = dirs(root);
  mkdirSync(d.receipts, { recursive: true });

  const processed = loadProcessed(root);
  const idemKey = `${req.campaignId}:${req.worldlineId}:${req.idempotencyKey}`;
  if (processed[idemKey]) {
    return ok({ ...processed[idemKey].receipt, status: 'duplicate', duplicate: true });
  }
  if (req.expiresAt <= at) return reject(root, req.requestId, 'request_expired', '请求已过期', { expiresAt: req.expiresAt, at });
  if (!acquireLock(root)) return fail('executor_busy', '另一请求正在执行，请稍后重试');

  const store = new FsStore(root);
  try {
    let snap;
    try { snap = store.read(req.campaignId, req.worldlineId); }
    catch (err: any) { return reject(root, req.requestId, 'invalid_request', err.message); }
    if (snap.state.revision !== req.expectedRevision) {
      return reject(root, req.requestId, 'revision_conflict', 'revision 已变化，未执行任何操作', {
        expected: req.expectedRevision, actual: snap.state.revision
      });
    }
    const currentSha = opts.baseCommitSha ?? headSha(root);
    if (req.baseCommitSha && currentSha !== 'unavailable' && req.baseCommitSha !== currentSha) {
      return reject(root, req.requestId, 'base_commit_mismatch', '基线 commit 已变化', {
        expected: req.baseCommitSha, actual: currentSha
      });
    }

    const before = structuredClone(snap);
    const results: { op: string; result: unknown }[] = [];
    let currentRevision = snap.state.revision;
    try {
      for (let i = 0; i < req.operations.length; i++) {
        const item = req.operations[i];
        const key = `${req.idempotencyKey}:${i}`;
        const base = { campaignId: req.campaignId, worldlineId: req.worldlineId, actor: req.actor, at, idempotencyKey: key };
        let result: Result<any>;
        switch (item.op) {
          case 'state.commit':
            result = ops.commitState(store, { ...base, expectedRevision: currentRevision, changes: isObject(item.changes) ? item.changes : {}, resolution: item.resolution as any, reason: typeof item.reason === 'string' ? item.reason : undefined });
            if (result.ok) currentRevision = result.data.revision;
            break;
          case 'memory.record':
            result = ops.recordMemory(store, { ...base, kind: item.kind as any, data: isObject(item.data) ? item.data : {}, idempotencyKey: typeof item.idempotencyKey === 'string' ? `${key}:${item.idempotencyKey}` : key });
            break;
          case 'memory.revise':
            result = ops.reviseMemory(store, { ...base, kind: item.kind as any, id: String(item.id ?? ''), expectedRevision: Number(item.expectedRevision ?? 1), patch: isObject(item.patch) ? item.patch : {}, idempotencyKey: typeof item.idempotencyKey === 'string' ? `${key}:${item.idempotencyKey}` : key });
            break;
          case 'memory.consolidate':
            result = ops.consolidate(store, { ...base, idempotencyKey: typeof item.idempotencyKey === 'string' ? `${key}:${item.idempotencyKey}` : key });
            break;
          case 'runtime.execute':
            result = ops.executeRoll(store, { ...base, skill: Number(item.skill ?? 0), difficulty: Number(item.difficulty ?? 0), idempotencyKey: typeof item.idempotencyKey === 'string' ? `${key}:${item.idempotencyKey}` : key });
            break;
          case 'session.close':
            result = ops.closeSession(store, { ...base, label: typeof item.label === 'string' ? item.label : 'runtime-close', idempotencyKey: typeof item.idempotencyKey === 'string' ? `${key}:${item.idempotencyKey}` : key });
            break;
          default:
            result = fail('unsupported_operation', `不支持 ${item.op}`);
        }
        if (!result.ok) throw new Error(`${item.op}: ${result.code} ${result.message}`);
        results.push({ op: item.op, result: result.data });
      }
    } catch (err: any) {
      store.write(req.campaignId, req.worldlineId, before);
      return reject(root, req.requestId, 'execution_failed', err.message, { operations: results });
    }

    const finalState = store.read(req.campaignId, req.worldlineId);
    const receipt: Receipt = {
      status: 'applied', requestId: req.requestId, campaignId: req.campaignId, worldlineId: req.worldlineId,
      baseRevision: req.expectedRevision, appliedRevision: finalState.state.revision,
      baseCommitSha: req.baseCommitSha, executedAt: at, duplicate: false, operations: results,
      hash: ''
    };
    receipt.hash = sha256(receipt);
    writeJsonAtomic(join(d.receipts, `${safeName(req.requestId, newId('req'))}.json`), receipt);
    processed[idemKey] = { requestId: req.requestId, receipt };
    writeJsonAtomic(d.processed, processed);
    store.appendEvent(req.campaignId, {
      id: newId('evt'), worldlineId: req.worldlineId, at, actor: req.actor,
      op: 'runtime.request', idempotencyKey: req.idempotencyKey,
      requestId: req.requestId, receiptHash: receipt.hash
    });
    return ok(receipt);
  } finally { releaseLock(root); }
}

export function executeAll(root: string, opts: { baseCommitSha?: string; at?: string } = {}): Result {
  const d = dirs(root);
  mkdirSync(d.pending, { recursive: true });
  const files = readdirSync(d.pending).filter(f => f.endsWith('.json')).sort();
  const processed = loadProcessed(root);
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: { requestId: string; code: string }[] = [];
  for (const file of files) {
    let request: RuntimeRequest;
    try { request = readJson(join(d.pending, file)); }
    catch { failed.push({ requestId: file, code: 'invalid_json' }); continue; }
    const idemKey = `${request.campaignId}:${request.worldlineId}:${request.idempotencyKey}`;
    if (processed[idemKey]) { skipped.push(request.requestId); continue; }
    const result = executeRequest(root, request, opts);
    if (result.ok) applied.push(request.requestId);
    else failed.push({ requestId: request.requestId, code: result.code });
  }
  return ok({ applied, skipped, failed, pendingCount: files.length });
}

export function readReceipt(root: string, requestId: string): Receipt | null {
  const path = join(dirs(root).receipts, `${safeName(requestId, 'invalid')}.json`);
  return existsSync(path) ? readJson(path) as Receipt : null;
}
