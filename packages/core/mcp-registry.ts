import { validateSchema, type Result, ok, fail } from './shared.ts';
import { normalizeToolName } from './tool-protocol.ts';

export type ToolScope = 'read' | 'write' | 'admin';
export interface RegistryTool {
  canonical: string; aliases: string[]; scope: ToolScope; backends: Array<'node' | 'sites'>;
  description: string; schema: any; required?: string[];
}
const obj = { type: 'object' };
const str = { type: 'string' };
const int = { type: 'integer', minimum: 0 };
const scopeFields = { campaignId: str, worldlineId: str };
const idem = { idempotencyKey: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{4,128}$' } };

/** Node 与 Sites 共用的声明式工具注册表：名称/Schema/权限/后端唯一来源。 */
export const MCP_REGISTRY: RegistryTool[] = [
  { canonical: 'session.bootstrap', aliases: ['session_bootstrap'], scope: 'read', backends: ['node', 'sites'], description: '恢复最小冷启动上下文', schema: { ...scopeFields, viewer: str, maxChars: int, maxBytes: int, asOf: str } },
  { canonical: 'session.recover', aliases: ['session_recover'], scope: 'read', backends: ['node', 'sites'], description: '轻量事务恢复', schema: { ...scopeFields, limit: int, maxBytes: int } },
  { canonical: 'persona.load', aliases: ['persona_load'], scope: 'read', backends: ['node', 'sites'], description: '读取诺娅人格', schema: { maxBytes: int } },
  { canonical: 'state.read', aliases: ['state_read'], scope: 'read', backends: ['node', 'sites'], description: '读取权威状态或业务分片', schema: { ...scopeFields, section: str, paths: { type: 'array' }, maxBytes: int, cursor: int }, required: [] },
  { canonical: 'state.commit', aliases: ['state_commit'], scope: 'write', backends: ['node'], description: '原子提交状态', schema: { ...scopeFields, expectedRevision: int, changes: obj, ...idem }, required: ['expectedRevision', 'changes', 'idempotencyKey'] },
  { canonical: 'memory.recall', aliases: ['memory_recall'], scope: 'read', backends: ['node', 'sites'], description: '按认知权限召回记忆', schema: { ...scopeFields, viewer: str, query: str, limit: int, maxBytes: int, cursor: int, includeL3: { type: 'boolean' } }, required: ['query'] },
  { canonical: 'memory.traverse', aliases: ['memory_traverse'], scope: 'read', backends: ['node', 'sites'], description: '遍历认知图谱子图', schema: { ...scopeFields, viewer: str, start: str, hops: int, maxBytes: int }, required: ['start'] },
  { canonical: 'memory.record', aliases: ['memory_record'], scope: 'write', backends: ['node', 'sites'], description: '记录实体/关系/情景', schema: { ...scopeFields, kind: str, data: obj, ...idem }, required: ['kind', 'data', 'idempotencyKey'] },
  { canonical: 'memory.revise', aliases: ['memory_revise'], scope: 'write', backends: ['node', 'sites'], description: '修订记忆', schema: { ...scopeFields, kind: str, id: str, patch: obj, expectedRevision: int, ...idem }, required: ['kind', 'id', 'patch', 'expectedRevision', 'idempotencyKey'] },
  { canonical: 'event.receipt', aliases: ['event_receipt'], scope: 'read', backends: ['node', 'sites'], description: '按索引查询事务回执', schema: { ...scopeFields, lookup: str, maxBytes: int }, required: ['campaignId', 'worldlineId', 'lookup'] },
  { canonical: 'runtime.execute', aliases: ['runtime_execute'], scope: 'write', backends: ['node', 'sites'], description: '执行确定性检定', schema: { ...scopeFields, skill: { type: 'number' }, difficulty: { type: 'number' }, ...idem }, required: ['skill', 'difficulty', 'idempotencyKey'] },
  { canonical: 'save.checkpoint', aliases: ['save_checkpoint'], scope: 'write', backends: ['node', 'sites'], description: '创建 checkpoint', schema: { ...scopeFields, label: str, ...idem }, required: ['label', 'idempotencyKey'] },
  { canonical: 'archive.import', aliases: ['archive_import'], scope: 'admin', backends: ['sites'], description: '重新导入 V3 完整归档', schema: { format: str, sha256: str, document: obj, ...idem }, required: ['format', 'sha256', 'document', 'idempotencyKey'] },
  { canonical: 'save.restore', aliases: ['save_restore'], scope: 'admin', backends: ['node', 'sites'], description: '恢复 checkpoint', schema: { ...scopeFields, checkpointId: str, ...idem }, required: ['checkpointId', 'idempotencyKey'] },
  { canonical: 'memory.summarize', aliases: ['memory_summarize'], scope: 'write', backends: ['node', 'sites'], description: '提交结构化章节摘要', schema: { ...scopeFields, instanceId: str, keyCausality: { type: 'array' }, characterChanges: { type: 'array' }, resourceChanges: { type: 'array' }, unresolved: { type: 'array' }, decisions: { type: 'array' }, sourceEventIds: { type: 'array' }, ...idem } },
  { canonical: 'memory.layers', aliases: ['memory_layers'], scope: 'read', backends: ['node', 'sites'], description: '读取或重建分层记忆索引', schema: { ...scopeFields, apply: { type: 'boolean' }, tiers: { type: 'array' }, maxBytes: int } },
  { canonical: 'todo.status', aliases: ['todo_status'], scope: 'write', backends: ['node', 'sites'], description: '迁移待办状态', schema: { ...scopeFields, id: str, status: str, ...idem } },
  { canonical: 'event.commit', aliases: ['event_commit'], scope: 'write', backends: ['sites'], description: '生产事件原子提交', schema: { ...scopeFields, eventId: str, expectedRevision: int, statePatch: obj, episodes: { type: 'array' }, entities: { type: 'array' }, relations: { type: 'array' }, pendingEvents: { type: 'array' }, runtimeReceipt: { type: ['object', 'null'] }, ...idem }, required: ['campaignId', 'worldlineId', 'eventId', 'expectedRevision', 'idempotencyKey'] }
];

const byName = new Map<string, RegistryTool>();
for (const tool of MCP_REGISTRY) for (const name of [tool.canonical, ...tool.aliases]) byName.set(name, tool);

export function registryTool(name: string): RegistryTool | undefined {
  return byName.get(name) ?? byName.get(normalizeToolName(name));
}
export function registryFor(backend: 'node' | 'sites'): RegistryTool[] {
  return MCP_REGISTRY.filter(t => t.backends.includes(backend));
}
export function registryScope(name: string, args: Record<string, any> = {}): ToolScope | null {
  const tool = registryTool(name);
  if (!tool) return null;
  if (tool.canonical === 'memory.layers' && args.apply === true) return 'write';
  if (tool.canonical === 'memory.recall' && args.includeL3 === true) return 'admin';
  return tool.scope;
}
export function validateRegistryArgs(name: string, args: Record<string, any>): Result<Record<string, any>> {
  const tool = registryTool(name);
  if (!tool) return fail('unknown_tool', `工具 ${name} 未注册`);
  const errors = validateSchema(args ?? {}, { type: 'object', properties: tool.schema, required: tool.required ?? [], additionalProperties: true });
  return errors.length ? fail('invalid_arguments', '参数校验失败', errors) : ok(args ?? {});
}
