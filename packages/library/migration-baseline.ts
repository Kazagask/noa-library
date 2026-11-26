import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../core/util.ts';
import { ok, fail, type Result } from '../core/shared.ts';

/**
 * 公共仓库不保存正式存档常量。迁移基准必须从私有备份动态生成：
 * - NOA_BASELINE_FILE 指向隔离环境生成的 baseline JSON；
 * - 或 <repo>/campaigns/<campaignId>/migration/baseline.json（私有环境）。
 */
export interface ProductionBaseline {
  campaignId: string; worldlineId?: string; eventId?: string;
  stateRevision: number; memoryRevision: number; rngCursor: number;
  gold?: number; realm?: string; exp?: number; expMax?: number;
  skill?: string; skillStage?: string; pendingTransform?: string;
  originalRolls?: number[]; hashes?: Record<string, string>;
  generatedAt: string; source: string;
}

export function loadProductionBaseline(repoRoot: string, campaignId = 'SAVE-481'): Result<ProductionBaseline> {
  const fromEnv = process.env.NOA_BASELINE_FILE;
  const path = fromEnv || join(repoRoot, 'campaigns', campaignId, 'migration', 'baseline.json');
  if (!fromEnv && !existsSync(path)) return fail('baseline_missing', '缺少私有迁移基准，fail-closed');
  try {
    const value = readJson(path) as ProductionBaseline;
    if (!Number.isFinite(value.stateRevision) || !Number.isFinite(value.memoryRevision)) return fail('baseline_invalid', '基准缺少修订号');
    return ok(value);
  } catch (err: any) { return fail('baseline_unreadable', String(err?.message ?? err)); }
}

export function verifyProductionBaseline(snapshot: any, baseline: ProductionBaseline): Result<{ checked: number }> {
  const s = snapshot?.state ?? {};
  const w = snapshot?.working ?? {};
  const checks: Array<[boolean, string]> = [
    [s.revision === baseline.stateRevision, 'stateRevision'],
    [w.memoryRevision === baseline.memoryRevision, 'memoryRevision'],
    [s.rng?.cursor === baseline.rngCursor, 'rngCursor']
  ];
  if (baseline.gold !== undefined) checks.push([s.resources?.gold === baseline.gold, 'gold']);
  if (baseline.realm !== undefined) checks.push([Object.values(s.actors ?? {}).some((a: any) => a?.realm === baseline.realm), 'realm']);
  if (baseline.exp !== undefined) checks.push([Object.values(s.actors ?? {}).some((a: any) => Number(a?.exp) === baseline.exp), 'exp']);
  if (baseline.skill && baseline.skillStage) {
    checks.push([String(s.cultivation?.skills?.[baseline.skill]?.stage ?? '').includes(baseline.skillStage), 'skillStage']);
  }
  const failed = checks.filter(([pass]) => !pass).map(([, name]) => name);
  if (failed.length) return fail('baseline_mismatch', '迁移基准校验失败', { failed, baseline: baseline.source });
  return ok({ checked: checks.length });
}
