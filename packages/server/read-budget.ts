import { stableStringify, ok, fail, type Result } from '../core/shared.ts';

export const READ_BUDGETS = {
  bootstrap: 8 * 1024,
  persona: 8 * 1024,
  business: 16 * 1024,
  audit: 64 * 1024,
  archive: 0
} as const;

/** MCP content/text 包裹层的保守开销；预算算的是最终线上响应。 */
export const MCP_ENVELOPE_RESERVE = 1024;

export interface BudgetOptions {
  maxBytes: number;
  maxItems?: number;
  cursor?: number;
  authoritative?: boolean;
  label?: string;
}

const byteLength = (value: unknown): number => Buffer.byteLength(stableStringify(value), 'utf8');

/** 调用者只能缩小预算，绝不能扩大服务端硬上限。 */
export function clampBudget(server: BudgetOptions, requested: Partial<BudgetOptions> = {}): BudgetOptions {
  const requestedBytes = Number(requested.maxBytes);
  const maxBytes = Number.isFinite(requestedBytes) && requestedBytes > 0
    ? Math.min(server.maxBytes, Math.floor(requestedBytes)) - MCP_ENVELOPE_RESERVE
    : server.maxBytes - MCP_ENVELOPE_RESERVE;
  const requestedItems = Number(requested.maxItems);
  const maxItems = Number.isFinite(requestedItems) && requestedItems > 0
    ? Math.min(server.maxItems ?? 50, Math.floor(requestedItems))
    : server.maxItems;
  return { ...server, maxBytes: Math.max(1, maxBytes), maxItems, cursor: Number.isFinite(Number(requested.cursor)) ? Number(requested.cursor) : server.cursor ?? 0 };
}

function pageFor(list: any[], offset: number, size: number) {
  return list.slice(offset, offset + size);
}
function pagedResult(data: any, listKey: string | null, list: any[], page: any[], offset: number, bytes: number, maxBytes: number, truncated: boolean): any {
  const envelope = {
    total: list.length, offset, returned: page.length,
    truncated, nextCursor: truncated ? offset + page.length : null,
    budget: { maxBytes, bytes, truncated, label: 'read' }
  };
  if (listKey === null) return { items: page, ...envelope };
  return { ...data, [listKey]: page, ...envelope };
}

/**
 * 服务端硬预算。列表逐页收缩到能装下为止，并保证 nextCursor 能继续读完整结果。
 * 权威状态超限直接拒绝，禁止静默截断。
 */
export function enforceBudget(result: Result<any>, opts: BudgetOptions): Result<any> {
  if (!result.ok) return result;
  const data = result.data;
  const listKey = Array.isArray(data) ? null : (['items', 'hits', 'results', 'episodes', 'relations', 'entities', 'events', 'receipts', 'todos'].find(k => Array.isArray(data?.[k])) ?? null);
  const list = Array.isArray(data) ? data : listKey ? data[listKey] as any[] : null;

  if (list && opts.maxItems !== undefined) {
    const offset = Math.max(0, Number(opts.cursor ?? 0));
    let size = Math.max(1, Math.min(opts.maxItems, list.length - offset));
    let page = pageFor(list, offset, size);
    let paged = pagedResult(data, listKey, list, page, offset, 0, opts.maxBytes, offset + size < list.length);
    let bytes = byteLength(paged);
    while (bytes > opts.maxBytes && page.length > 1) {
      size--;
      page = pageFor(list, offset, size);
      paged = pagedResult(data, listKey, list, page, offset, 0, opts.maxBytes, offset + size < list.length);
      bytes = byteLength(paged);
    }
    if (bytes <= opts.maxBytes) {
      paged.budget.bytes = bytes;
      paged.budget.label = opts.label ?? 'read';
      return ok(paged);
    }
    if (opts.authoritative) return fail('state_budget_exceeded', '权威状态超出响应预算，未返回截断结果', { maxBytes: opts.maxBytes, bytes, usePaths: true });
    // 单条对象仍过大：只返回引用，并把游标推进一条，保证可继续遍历。
    const one = page[0];
    return ok({
      budget: { maxBytes: opts.maxBytes, bytes, truncated: true, reason: 'single-item-too-large', label: opts.label ?? 'read' },
      summary: { total: list.length, returned: 0, layer: data?.layer ?? null },
      refs: [one?.id ?? one?.eventId ?? String(one).slice(0, 64)].filter(Boolean),
      nextCursor: offset + 1 < list.length ? offset + 1 : null
    });
  }

  const bytes = byteLength(data);
  if (bytes <= opts.maxBytes) return ok({ ...data, budget: { maxBytes: opts.maxBytes, bytes, truncated: false, label: opts.label ?? 'read' } });
  if (opts.authoritative) return fail('state_budget_exceeded', '权威状态超出响应预算，未返回截断结果', { maxBytes: opts.maxBytes, bytes, usePaths: true });
  return ok({
    budget: { maxBytes: opts.maxBytes, bytes, truncated: true, reason: 'byte-budget', label: opts.label ?? 'read' },
    summary: { keys: Object.keys(data ?? {}), layer: data?.layer ?? null },
    refs: Array.isArray(data?.sources) ? data.sources.slice(0, 16) : [],
    nextCursor: null
  });
}

export function budgetFor(tool: string): BudgetOptions {
  if (tool === 'session.bootstrap') return { maxBytes: READ_BUDGETS.bootstrap, maxItems: 20, authoritative: false, label: tool };
  if (tool === 'persona.load') return { maxBytes: READ_BUDGETS.persona, maxItems: 20, label: tool };
  if (tool === 'state.read') return { maxBytes: READ_BUDGETS.business, maxItems: 50, authoritative: true, label: tool };
  if (tool === 'memory.recall' || tool === 'memory.traverse') return { maxBytes: READ_BUDGETS.business, maxItems: 50, label: tool };
  if (tool === 'event.receipt') return { maxBytes: READ_BUDGETS.business, maxItems: 20, label: tool };
  if (tool === 'archive.export') return { maxBytes: READ_BUDGETS.archive, label: tool };
  return { maxBytes: READ_BUDGETS.business, maxItems: 50, label: tool };
}
