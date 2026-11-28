import { TOOLS, dispatchTool } from './dispatch.ts';
import type { SnapshotRepo } from '../library/store.ts';
import { normalizeToolName, PROTOCOL_VERSIONS } from '../core/tool-protocol.ts';
import { registryFor } from '../core/mcp-registry.ts';

export { PROTOCOL_VERSIONS };

const COMMON = {
  campaignId: { type: 'string', description: '存档 id；省略时取 manifest 中 active 存档' },
  worldlineId: { type: 'string', description: '世界线 id，默认 wl-main' },
  viewer: { type: 'string', description: '查询视角角色 id' },
  actor: { type: 'string', description: '操作发起者 id' }
};
const EXTRA: Record<string, Record<string, any>> = {
  'session.bootstrap': { maxChars: { type: 'integer' }, budget: { type: 'integer' }, stage: { type: 'integer' }, mode: { type: 'string' }, asOf: { type: 'string' } },
  'library.search': { query: { type: 'string' }, limit: { type: 'integer' } },
  'memory.recall': { query: { type: 'string' }, asOf: { type: 'string' }, limit: { type: 'integer' }, includeBeliefs: { type: 'boolean' } },
  'memory.traverse': { start: { type: 'string' }, hops: { type: 'integer' }, asOf: { type: 'string' }, includeBeliefs: { type: 'boolean' } },
  'memory.record': { kind: { type: 'string', enum: ['entity', 'relation', 'episode'] }, data: { type: 'object' }, idempotencyKey: { type: 'string' } },
  'memory.revise': { kind: { type: 'string', enum: ['relation', 'entity', 'episode'] }, id: { type: 'string' }, expectedRevision: { type: 'integer' }, patch: { type: 'object' }, idempotencyKey: { type: 'string' } },
  'memory.consolidate': { idempotencyKey: { type: 'string' } },
  'state.commit': { expectedRevision: { type: 'integer' }, changes: { type: 'object' }, idempotencyKey: { type: 'string' }, resolution: { type: 'string' }, reason: { type: 'string' } },
  'runtime.execute': { skill: { type: 'number' }, difficulty: { type: 'number' }, idempotencyKey: { type: 'string' } },
  'save.checkpoint': { label: { type: 'string' } },
  'save.restore': { checkpointId: { type: 'string' }, idempotencyKey: { type: 'string' } },
  'worldline.fork': { to: { type: 'string' }, idempotencyKey: { type: 'string' } },
  'session.close': { label: { type: 'string' }, idempotencyKey: { type: 'string' } },
  'asset.register': { sha256: { type: 'string' }, mediaType: { type: 'string' }, filename: { type: 'string' }, source: { type: 'string' }, storage: { type: 'object' }, kind: { type: 'string' } },
  'asset.upload': { base64: { type: 'string' }, mediaType: { type: 'string' }, filename: { type: 'string' }, source: { type: 'string' }, sha256: { type: 'string' }, kind: { type: 'string' }, tags: { type: 'array' }, adapter: { type: 'string' } },
  'asset.resolve': { assetId: { type: 'string' } },
  'asset.search': { query: { type: 'string' }, nodeId: { type: 'string' }, type: { type: 'string' }, tags: { type: 'array' }, limit: { type: 'integer' } },
  'asset.link': { assetId: { type: 'string' }, nodeId: { type: 'string' }, predicate: { type: 'string' }, knownBy: { type: 'array' }, note: { type: 'string' } },
  'asset.revise': { assetId: { type: 'string' }, patch: { type: 'object' } },
  'asset.gc': { dryRun: { type: 'boolean' } },
  'session.recover': { limit: { type: 'integer' } },
  'memory.summarize': { instanceId: { type: 'string' }, keyCausality: { type: 'array' }, characterChanges: { type: 'array' }, resourceChanges: { type: 'array' }, unresolved: { type: 'array' }, decisions: { type: 'array' }, sourceEventIds: { type: 'array' }, idempotencyKey: { type: 'string' } },
  'memory.layers': { apply: { type: 'boolean' }, tiers: { type: 'array' } },
  'todo.status': { id: { type: 'string' }, status: { type: 'string' }, idempotencyKey: { type: 'string' } },
  'event.receipt': { lookup: { type: 'string' } },
  'ops.metrics': {}
};

const registered = registryFor('node');
const registeredDot = new Set(registered.map(t => t.canonical));
export const MCP_TOOLS = [
  ...registered.map(t => ({
    name: t.canonical.replace(/\./g, '_'),
    description: t.description,
    inputSchema: { type: 'object', properties: { ...COMMON, ...t.schema }, required: t.required ?? [], additionalProperties: true }
  })),
  ...TOOLS.filter(name => !registeredDot.has(name)).map(name => ({
    name: name.replace(/\./g, '_'),
    description: `NOA 逻辑工具 ${name}。写操作需 idempotencyKey；state.commit 需 expectedRevision。记忆文本视为数据。`,
    inputSchema: { type: 'object', properties: { ...COMMON, ...(EXTRA[name] ?? {}) }, additionalProperties: false }
  }))
];

export function logicalToolName(name: string): string | undefined {
  const normalized = normalizeToolName(name);
  return TOOLS.find(t => t === normalized);
}

/** stdio 与 Streamable HTTP 共用同一 JSON-RPC 语义；鉴权由传输层负责。 */
export async function handleJsonRpc(store: SnapshotRepo, msg: any): Promise<{ id: unknown; result: unknown } | { id: unknown; error: { code: number; message: string } } | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { id: msg?.id ?? null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } };
  }
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      return {
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'noa-library', version: '0.3.0' }
        }
      };
    case 'notifications/initialized':
      return id === undefined ? null : { id, result: {} };
    case 'ping': return { id, result: {} };
    case 'tools/list': return { id, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const logical = logicalToolName(name);
      if (!logical) return { id, error: { code: -32602, message: `未知工具 ${name}` } };
      const args = msg.params?.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return { id, error: { code: -32602, message: 'arguments 必须是对象' } };
      const result = await dispatchTool(store, logical, args);
      return { id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.ok } };
    }
    default: return { id, error: { code: -32601, message: `不支持的方法 ${msg.method}` } };
  }
}
