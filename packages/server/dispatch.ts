import type { SnapshotRepo } from '../library/store.ts';
import { buildColdStart } from '../library/coldstart.ts';
import * as ops from '../library/operations.ts';
import type { Result } from '../core/util.ts';
import { AssetStore } from '../assets/asset-store.ts';
import { enforceBudget, budgetFor, clampBudget } from './read-budget.ts';
import { recordMetric } from './observability.ts';
import { recoverySnapshot } from '../library/recovery.ts';
import { submitChapterSummary, lifecycleOf } from '../library/lifecycle.ts';
import { buildMemoryLayerIndex, loadMemoryLayerIndex, refsForTiers, checkIndexFreshness } from '../library/memory-tiers.ts';
import { setTodoStatus } from '../library/todos.ts';
import { metricsTool } from './observability.ts';

export const TOOLS = [
  'session.bootstrap', 'session.close', 'persona.load', 'library.search',
  'memory.recall', 'memory.traverse', 'memory.record', 'memory.revise',
  'memory.consolidate', 'state.read', 'state.commit', 'runtime.execute',
  'save.checkpoint', 'save.restore', 'worldline.fork',
  'asset.register', 'asset.upload', 'asset.resolve', 'asset.search',
  'asset.link', 'asset.revise', 'asset.gc',
  'session.recover', 'memory.summarize', 'memory.layers', 'todo.status',
  'event.receipt', 'ops.metrics'
] as const;
export type ToolName = typeof TOOLS[number];

export function withDefaults(body: Record<string, any>): Record<string, any> {
  return { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', actor: 'gm', ...body };
}

const READ_TOOLS = new Set([
  'session.bootstrap', 'persona.load', 'library.search', 'memory.recall', 'memory.traverse',
  'state.read', 'event.receipt', 'archive.export', 'session.recover', 'memory.layers', 'ops.metrics'
]);

async function runTool(store: SnapshotRepo, tool: string, input: Record<string, any>): Promise<Result<any>> {
  const assets = () => new AssetStore(store.root);
  switch (tool) {
    case 'session.bootstrap': {
      const cold = buildColdStart(store, {
        campaignId: input.campaignId, worldlineId: input.worldlineId, viewer: input.viewer,
        maxChars: input.maxChars, asOf: input.asOf
      });
      if (!cold.ok) return cold;
      const persona = ops.personaLoad(store);
      return { ok: true, data: { ...cold.data, persona: persona.ok ? persona.data : null } };
    }
    case 'session.recover': return recoverySnapshot(store, input);
    case 'memory.layers': {
      const index = input.apply
        ? buildMemoryLayerIndex(store, input.campaignId, input.worldlineId, { apply: true })
        : loadMemoryLayerIndex(store, input.campaignId, input.worldlineId);
      if (!index.ok) return index;
      const freshness = checkIndexFreshness(store, index.data);
      if (!freshness.ok) return freshness;
      return { ok: true, data: {
        ...index.data, stale: !freshness.data.fresh, staleReason: freshness.data.reason ?? null,
        refs: refsForTiers(index.data, input.tiers ?? ['L0', 'L1', 'L2'], {
          viewer: input.viewer, gm: input.viewer === 'gm', includeBeliefs: input.includeBeliefs === true, asOf: input.asOf
        })
      } };
    }
    case 'memory.summarize': return submitChapterSummary(store, input);
    case 'todo.status': return setTodoStatus(store, input);
    case 'event.receipt': {
      const events = store.events(input.campaignId, input.worldlineId);
      const hit = events.find(e => [e.id, e.eventId, e.idempotencyKey].includes(input.lookup));
      if (!hit) return { ok: false, code: 'receipt_not_found', message: '未找到对应事务回执' };
      return { ok: true, data: { receipt: hit, lifecycle: lifecycleOf(store, input.campaignId, String(hit.id)) } };
    }
    case 'archive.export': return { ok: false, code: 'backup_only', message: 'archive_export 仅用于备份，不参与常规 GM 工作流；请使用 backup CLI' };
    case 'ops.metrics': return metricsTool();
    case 'persona.load': return ops.personaLoad(store);
    case 'library.search': return ops.librarySearch(store, input);
    case 'memory.recall': return ops.recall(store, input);
    case 'memory.traverse': return ops.traverse(store, input);
    case 'memory.record': return ops.recordMemory(store, input);
    case 'memory.revise': return ops.reviseMemory(store, input);
    case 'memory.consolidate': return ops.consolidate(store, input);
    case 'state.read': return ops.readState(store, input);
    case 'state.commit': return ops.commitState(store, input);
    case 'runtime.execute': return ops.executeRoll(store, input);
    case 'save.checkpoint': return ops.checkpoint(store, input);
    case 'save.restore': return ops.restore(store, input);
    case 'worldline.fork': return ops.forkWorldline(store, input);
    case 'session.close': return ops.closeSession(store, input);
    case 'asset.register': return assets().register(input as any);
    case 'asset.upload': {
      const base64 = typeof input.base64 === 'string' ? input.base64 : '';
      return await assets().upload({
        bytes: Buffer.from(base64, 'base64'), mediaType: input.mediaType ?? 'application/octet-stream',
        filename: input.filename ?? 'asset', source: input.source ?? 'tool',
        kind: input.kind ?? 'original', declaredSha256: input.sha256,
        campaignId: input.campaignId, personaId: input.personaId, tags: input.tags ?? [], adapter: input.adapter
      });
    }
    case 'asset.resolve': return await assets().resolve(input.assetId, input.viewer, input.worldlineId);
    case 'asset.search': return assets().search({ query: input.query, nodeId: input.nodeId, type: input.type, tags: input.tags, worldlineId: input.worldlineId, viewer: input.viewer, limit: input.limit });
    case 'asset.link': return assets().link(input.assetId, input.nodeId, input.predicate ?? '关联', input.knownBy ?? ['*'], input.note);
    case 'asset.revise': return assets().revise(input.assetId, input.patch ?? {});
    case 'asset.gc': return await assets().gc({ dryRun: input.dryRun !== false });
    default: return { ok: false, code: 'not_found', message: `工具 ${tool} 未实现` };
  }
}

/** HTTP 与 MCP 共用同一套领域逻辑；读取接口统一强制体积预算并记录可观测性。 */
export async function dispatchTool(store: SnapshotRepo, tool: string, raw: Record<string, any>): Promise<Result<any>> {
  const started = Date.now();
  const input = withDefaults(raw);
  let result = await runTool(store, tool, input);
  if (READ_TOOLS.has(tool) && result.ok) {
    const budget = clampBudget(budgetFor(tool), {
      maxBytes: raw.maxBytes, maxItems: raw.limit ?? raw.maxItems, cursor: raw.cursor
    });
    result = enforceBudget(result, budget);
  }
  const bytes = result.ok ? Buffer.byteLength(JSON.stringify(result.data), 'utf8') : Buffer.byteLength(JSON.stringify(result), 'utf8');
  recordMetric(tool, {
    bytes, durationMs: Date.now() - started, ok: result.ok,
    idempotentHit: Boolean((result as any).data?.duplicate || (result as any).data?.deduplicated),
    truncated: Boolean((result as any).data?.budget?.truncated)
  });
  return result;
}
