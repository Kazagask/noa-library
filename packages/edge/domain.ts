import { isObject } from './util.ts';

export interface Entity {
  id: string; type: string; name: string; aliases?: string[];
  worldlineId: string; scope: string; knownBy: string[];
  attributes?: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface Relation {
  id: string; subject: string; predicate: string; object: string; description: string;
  worldlineId: string; validFrom: string; validUntil: string | null; recordedAt: string;
  scope: string; knownBy: string[]; confidence: number; sourceEventId: string;
  epistemic: 'fact' | 'belief'; holder: string | null;
  status: 'active' | 'superseded' | 'rejected'; revision: number;
  supersedes?: string | null; idempotencyKey?: string;
}
export interface Episode {
  id: string; at: string; turn: number; title: string; summary: string; excerpt?: string;
  worldlineId: string; entities: string[]; relationIds: string[]; knownBy: string[];
  sourceEventId?: string; path: string; tags: string[]; confidence: number;
}
export interface ViewContext {
  viewer: string; worldlineId: string; asOf: string; includeBeliefs?: boolean; gm?: boolean;
}
export interface RecallHit {
  kind: 'entity' | 'relation' | 'episode'; id: string; title: string; text: string;
  score: number; source: string; meta: Record<string, unknown>;
}
export interface CampaignPaths {
  state: string; events: string; entities: string; relations: string;
  episodesIndex: string; episodesDir: string; journals: string; checkpoints: string; working: string;
}
export interface ConsistencyRule {
  id: string; relationId: string; description?: string; statePath: string;
  match: { field: string; value: string }; requireWhenRelationActive: 'present' | 'absent';
}
export interface CampaignManifest {
  manifestVersion: number; id: string; title: string; worldId: string;
  worldlineId: string; status: string; paths: CampaignPaths;
  timeIndex?: { at: string; episodeId: string }[];
  consistencyRules?: ConsistencyRule[];
}

export function knownByAllows(knownBy: string[] | undefined, viewer: string): boolean {
  if (!knownBy || !knownBy.length) return false;
  return knownBy.includes('*') || knownBy.includes(viewer);
}

export function timeValid(validFrom: string, validUntil: string | null, asOf: string): boolean {
  return validFrom <= asOf && (validUntil === null || validUntil > asOf);
}

export function relationVisible(rel: Relation, ctx: ViewContext): boolean {
  if (rel.worldlineId !== ctx.worldlineId) return false;
  if (rel.status === 'rejected') return false;
  // 已失效的关系只在 asOf 早于失效点时用于历史查询，不作为当前事实。
  if (rel.status === 'superseded' && (rel.validUntil === null || rel.validUntil <= ctx.asOf)) return false;
  if (!timeValid(rel.validFrom, rel.validUntil, ctx.asOf)) return false;
  if (!ctx.gm && !knownByAllows(rel.knownBy, ctx.viewer)) return false;
  if (rel.epistemic === 'belief') {
    if (!ctx.includeBeliefs || (!ctx.gm && rel.holder !== ctx.viewer)) return false;
  }
  return true;
}

export function entityVisible(entity: Entity, ctx: ViewContext): boolean {
  return entity.worldlineId === ctx.worldlineId && entity.createdAt <= ctx.asOf && (ctx.gm || knownByAllows(entity.knownBy, ctx.viewer));
}

export function episodeVisible(ep: Episode, ctx: ViewContext): boolean {
  return ep.worldlineId === ctx.worldlineId && ep.at <= ctx.asOf && (ctx.gm || knownByAllows(ep.knownBy, ctx.viewer));
}

function tokensOf(text: string): string[] {
  const lower = text.toLowerCase();
  const parts = lower.split(/[\s,.;:!?，。；：！？、]+/).filter(Boolean);
  const cjk = lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const word of cjk) {
    for (let i = 0; i + 2 <= word.length; i++) parts.push(word.slice(i, i + 2));
  }
  return [...new Set(parts)];
}

export function relevanceScore(text: string, query: string): number {
  if (!query.trim()) return 0;
  const lower = text.toLowerCase();
  const q = query.toLowerCase().trim();
  let score = lower.includes(q) ? 12 : 0;
  for (const token of tokensOf(q)) if (lower.includes(token)) score += 3;
  return score;
}

export function statePathValue(state: unknown, path: string): unknown {
  let current: any = state;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function checkConsistency(
  state: Record<string, unknown>, relations: Relation[], rules: ConsistencyRule[] | undefined,
  ctx: ViewContext
): { ruleId: string; relationId: string; message: string }[] {
  const conflicts: { ruleId: string; relationId: string; message: string }[] = [];
  for (const rule of rules ?? []) {
    const rel = relations.find(r => r.id === rule.relationId && r.worldlineId === ctx.worldlineId && r.epistemic === 'fact');
    if (!rel || !relationVisible(rel, ctx)) continue;
    const bucket = statePathValue(state, rule.statePath);
    const present = Array.isArray(bucket) && bucket.some(item => isObject(item) && item[rule.match.field] === rule.match.value);
    const required = rule.requireWhenRelationActive === 'present';
    if (required !== present) {
      conflicts.push({
        ruleId: rule.id, relationId: rel.id,
        message: `${rule.id}: 关系 ${rel.id} 处于 active，但 state.${rule.statePath} 中${required ? '缺少' : '仍存在'} ${rule.match.field}=${rule.match.value}`
      });
    }
  }
  return conflicts;
}

export const MUTABLE_STATE_KEYS = ['clock', 'actors', 'inventory', 'resources', 'quests', 'flags', 'extension', 'rngCursor'] as const;

export function applyChanges(state: Record<string, any>, changes: Record<string, unknown>): Record<string, any> {
  const next = structuredClone(state);
  for (const [key, value] of Object.entries(changes)) {
    if (!(MUTABLE_STATE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`不允许修改权威字段: ${key}`);
    }
    if (key === 'rngCursor') {
      if (!Number.isInteger(value) || (value as number) < 0) throw new Error('rngCursor 必须是非负整数');
      next.rng.cursor = value;
    } else next[key] = structuredClone(value);
  }
  return next;
}

export interface TraverseResult {
  start: string; hops: number;
  nodes: { id: string; kind: string; label: string; depth: number }[];
  edges: Relation[];
}

export function traverseGraph(
  start: string, hops: number, ctx: ViewContext,
  entities: Entity[], relations: Relation[]
): TraverseResult {
  const depthMap = new Map<string, number>([[start, 0]]);
  const edges: Relation[] = [];
  let frontier = [start];
  for (let d = 0; d < hops; d++) {
    const next: string[] = [];
    for (const rel of relations) {
      if (!relationVisible(rel, ctx)) continue;
      const from = frontier.find(id => id === rel.subject || id === rel.object);
      if (!from) continue;
      const other = from === rel.subject ? rel.object : rel.subject;
      edges.push(rel);
      if (!depthMap.has(other)) { depthMap.set(other, d + 1); next.push(other); }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  const nodes = [...depthMap.entries()].map(([id, depth]) => {
    const entity = entities.find(e => e.id === id);
    return { id, kind: entity?.type ?? 'unknown', label: entity?.name ?? id, depth };
  });
  return { start, hops, nodes, edges };
}
