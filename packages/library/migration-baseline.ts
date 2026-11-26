import { ok, fail, type Result } from '../core/shared.ts';

/** 来自用户确认的 SAVE-481 生产基准；仅作校验常量，不含原始档案内容。 */
export const PRODUCTION_BASELINE = {
  campaignId: 'SAVE-481', worldlineId: 'wl-main',
  eventId: 'EDEN-NARRATIVE-REFINE-CLOSURE-V1',
  stateRevision: 1075, memoryRevision: 586, rngCursor: 472,
  gold: 819921, realm: '七星斗尊', exp: 24700.73955, expMax: 40000,
  skill: '焚诀', skillStage: '天阶高级', pendingTransform: '第八蜕变待选',
  originalRolls: [98, 95],
  note: '原始失败骰保留；最终炼化由玩家叙事裁决成功。不得补骰、重复扣费或推进时间。'
} as const;

export function verifyProductionBaseline(snapshot: any): Result<{ checked: number }> {
  const s = snapshot?.state ?? {};
  const w = snapshot?.working ?? {};
  const checks: Array<[boolean, string]> = [
    [s.revision === PRODUCTION_BASELINE.stateRevision, 'stateRevision'],
    [w.memoryRevision === PRODUCTION_BASELINE.memoryRevision, 'memoryRevision'],
    [s.rng?.cursor === PRODUCTION_BASELINE.rngCursor, 'rngCursor'],
    [s.resources?.gold === PRODUCTION_BASELINE.gold, 'gold'],
    [String(Object.values(s.actors ?? {}).some((a: any) => a?.realm === PRODUCTION_BASELINE.realm)), 'realm'],
    [Object.values(s.actors ?? {}).some((a: any) => Number(a?.exp) === PRODUCTION_BASELINE.exp), 'exp'],
    [String(s.cultivation?.skills?.[PRODUCTION_BASELINE.skill]?.stage ?? '').includes(PRODUCTION_BASELINE.skillStage), 'skillStage']
  ];
  const failed = checks.filter(([pass]) => !pass).map(([, name]) => name);
  if (failed.length) return fail('baseline_mismatch', '迁移基准校验失败', { failed, expected: PRODUCTION_BASELINE });
  return ok({ checked: checks.length });
}
