import type { SnapshotRepo } from '../library/store.ts';
import { buildColdStart } from '../library/coldstart.ts';
import * as ops from '../library/operations.ts';
import type { Result } from '../core/util.ts';
import { AssetStore } from '../assets/asset-store.ts';

export const TOOLS = [
  'session.bootstrap', 'session.close', 'persona.load', 'library.search',
  'memory.recall', 'memory.traverse', 'memory.record', 'memory.revise',
  'memory.consolidate', 'state.read', 'state.commit', 'runtime.execute',
  'save.checkpoint', 'save.restore', 'worldline.fork',
  'asset.register', 'asset.upload', 'asset.resolve', 'asset.search',
  'asset.link', 'asset.revise', 'asset.gc'
] as const;
export type ToolName = typeof TOOLS[number];

export function withDefaults(body: Record<string, any>): Record<string, any> {
  return { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.player', actor: 'gm', ...body };
}

/** HTTP 与 MCP 共用同一套领域逻辑，避免两套语义。 */
export async function dispatchTool(store: SnapshotRepo, tool: string, raw: Record<string, any>): Promise<Result<any>> {
  const input = withDefaults(raw);
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
