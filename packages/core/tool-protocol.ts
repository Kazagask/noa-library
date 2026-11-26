/**
 * 统一 MCP 工具协议：main 的点分名与 Sites 生产 snake_case 名共用一套规范化入口。
 * 生产专属工具保留原名，避免把不存在的实现伪装成共享内核能力。
 */
export const SHARED_TOOLS = [
  'session.bootstrap', 'session.close', 'persona.load', 'library.search',
  'memory.recall', 'memory.traverse', 'memory.record', 'memory.revise',
  'memory.consolidate', 'state.read', 'state.commit', 'runtime.execute',
  'save.checkpoint', 'save.restore', 'worldline.fork',
  'asset.register', 'asset.upload', 'asset.resolve', 'asset.search',
  'asset.link', 'asset.revise', 'asset.gc'
] as const;

export const PRODUCTION_ONLY_TOOLS = [
  'vault_stats', 'vault_compact', 'vault_migrate', 'qa_create', 'archive_export',
  'campaign_list', 'campaign_import', 'event_commit', 'event_receipt',
  'runtime_init', 'state_read_section'
] as const;

export const PROTOCOL_VERSIONS = ['2024-11-05', '2026-07-28'] as const;

const ALIASES: Record<string, string> = Object.fromEntries(
  SHARED_TOOLS.map(name => {
    const snake = name.replace(/\./g, '_');
    return [snake, name];
  })
);

/** 输入任意协议版本工具名，返回统一点分名；未知生产工具保持原名。 */
export function normalizeToolName(name: string): string {
  return ALIASES[name] ?? name;
}
export function isSharedTool(name: string): boolean {
  return (SHARED_TOOLS as readonly string[]).includes(normalizeToolName(name));
}
export function isProductionOnlyTool(name: string): boolean {
  return (PRODUCTION_ONLY_TOOLS as readonly string[]).includes(name);
}
export function canonicalToolList(): string[] {
  return [...SHARED_TOOLS, ...PRODUCTION_ONLY_TOOLS];
}
