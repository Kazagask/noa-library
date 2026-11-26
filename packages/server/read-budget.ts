import { stableStringify, ok, fail, type Result } from '../core/shared.ts';

export const READ_BUDGETS = {
  bootstrap: 8 * 1024,
  persona: 8 * 1024,
  business: 16 * 1024,
  audit: 64 * 1024,
  archive: 0 // 独立备份用途，不参与常规 GM 工作流
} as const;

export interface BudgetOptions {
  maxBytes: number;
  maxItems?: number;
  cursor?: number;
  authoritative?: boolean;
  label?: string;
}

const byteLength = (value: unknown): number => Buffer.byteLength(stableStringify(value), 'utf8');

/**
 * 服务端硬预算。列表以摘要+引用+游标截断；权威状态超限直接拒绝，禁止静默截断。
 */
export function enforceBudget(result: Result<any>, opts: BudgetOptions): Result<any> {
  if (!result.ok) return result;
  const data = result.data;
  const listKey = Array.isArray(data) ? 'items' : ['items', 'episodes', 'relations', 'entities', 'events', 'receipts', 'todos'].find(k => Array.isArray(data?.[k]));
  if (listKey && opts.maxItems !== undefined) {
    const list = Array.isArray(data) ? data : data[listKey] as any[];
    const offset = Math.max(0, Number(opts.cursor ?? 0));
    const page = list.slice(offset, offset + opts.maxItems);
    const truncated = offset + page.length < list.length;
    const paged = Array.isArray(data)
      ? { items: page, total: list.length, offset, truncated, nextCursor: truncated ? offset + page.length : null }
      : { ...data, [listKey]: page, total: list.length, offset, truncated, nextCursor: truncated ? offset + page.length : null };
    const bytes = byteLength(paged);
    if (bytes > opts.maxBytes) {
      if (opts.authoritative) return fail('state_budget_exceeded', '权威状态超出响应预算，未返回截断结果', { maxBytes: opts.maxBytes, bytes, usePaths: true });
      return ok({
        budget: { maxBytes: opts.maxBytes, bytes, truncated: true, reason: 'byte-budget' },
        summary: { total: list.length, returned: page.length, layer: data?.layer ?? null },
        refs: page.slice(0, 8).map((r: any) => r?.id ?? r?.eventId ?? r?.receiptId ?? String(r).slice(0, 64)),
        nextCursor: truncated ? offset + page.length : null,
        label: opts.label ?? 'read'
      });
    }
    return ok({ ...paged, budget: { maxBytes: opts.maxBytes, bytes, truncated, label: opts.label ?? 'read' } });
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
