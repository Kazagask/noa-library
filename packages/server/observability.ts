import { ok } from '../core/shared.ts';

export interface ToolMetric {
  tool: string; calls: number; failures: number; idempotentHits: number;
  bytes: number; maxBytes: number; durationMs: number; truncations: number;
}
const metrics = new Map<string, ToolMetric>();

export function recordMetric(tool: string, input: {
  bytes: number; durationMs: number; ok: boolean; idempotentHit?: boolean; truncated?: boolean;
}): void {
  const m = metrics.get(tool) ?? { tool, calls: 0, failures: 0, idempotentHits: 0, bytes: 0, maxBytes: 0, durationMs: 0, truncations: 0 };
  m.calls++;
  if (!input.ok) m.failures++;
  if (input.idempotentHit) m.idempotentHits++;
  m.bytes += input.bytes;
  m.maxBytes = Math.max(m.maxBytes, input.bytes);
  m.durationMs += input.durationMs;
  if (input.truncated) m.truncations++;
  metrics.set(tool, m);
}

export function metricsSnapshot(): { tools: ToolMetric[]; totals: Record<string, number> } {
  const tools = [...metrics.values()];
  return {
    tools,
    totals: {
      calls: tools.reduce((m, t) => m + t.calls, 0),
      failures: tools.reduce((m, t) => m + t.failures, 0),
      idempotentHits: tools.reduce((m, t) => m + t.idempotentHits, 0),
      bytes: tools.reduce((m, t) => m + t.bytes, 0),
      truncations: tools.reduce((m, t) => m + t.truncations, 0)
    }
  };
}

export function resetMetrics(): void { metrics.clear(); }
export function metricsTool(): ReturnType<typeof ok> { return ok(metricsSnapshot()); }
