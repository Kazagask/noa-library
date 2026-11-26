/**
 * 平台无关的业务内核原语。Node、Worker/D1 可注入各自的 SHA-256 实现。
 * 生产 Sites 使用 @noble/hashes；Node 使用 node:crypto（见 initializeNodeHasher）。
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Result<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; code: string; message: string; details?: unknown };

let hasher: ((value: string) => string) | null = null;
export function setSharedHasher(fn: (value: string) => string): void { hasher = fn; }
export function hasSharedHasher(): boolean { return Boolean(hasher); }
export function sha256(value: unknown): string {
  if (!hasher) throw new Error('shared hasher 未初始化');
  return hasher(stableStringify(value));
}
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function ok<T>(data: T): Result<T> { return { ok: true, data }; }
export function fail(code: string, message: string, details?: unknown): Result<never> {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}
export function newId(prefix: string, key?: string): string {
  const crypto = (globalThis as any).crypto;
  const suffix = key
    ? sha256(key).slice(0, 12)
    : (typeof crypto?.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  return `${prefix}-${suffix}`;
}
