import { sha256 as digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Result<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; code: string; message: string; details?: unknown };

export function ok<T extends Record<string, unknown>>(data: T): Result<T> { return { ok: true, data }; }
export function fail(code: string, message: string, details?: unknown): Result<never> { return { ok: false, code, message, details }; }

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256(value: unknown): string {
  return bytesToHex(digest(new TextEncoder().encode(stableStringify(value))));
}

export function newId(prefix: string, key?: string): string {
  const suffix = key ? sha256(key).slice(0, 12) : crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

export function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function isObject(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/* ----------------------------- JSON Schema 子集校验 ----------------------------- */

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

export function validateSchema(instance: unknown, schema: any, path = '$'): string[] {
  const errors: string[] = [];
  if (!isObject(schema)) return errors;
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = jsonType(instance);
    const matched = types.includes(actual) || (types.includes('integer') && actual === 'number' && Number.isInteger(instance));
    if (!matched) { errors.push(`${path}: 期望 ${types.join('|')}，实际 ${actual}`); return errors; }
  }
  if ('const' in schema && stableStringify(instance) !== stableStringify(schema.const)) errors.push(`${path}: 必须等于 ${stableStringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => stableStringify(e) === stableStringify(instance))) errors.push(`${path}: 不在允许的枚举中`);
  if (typeof instance === 'string' && schema.pattern && !new RegExp(schema.pattern as string).test(instance)) errors.push(`${path}: 格式不匹配 ${schema.pattern}`);
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) errors.push(`${path}: 小于最小值 ${schema.minimum}`);
    if (schema.maximum !== undefined && instance > schema.maximum) errors.push(`${path}: 大于最大值 ${schema.maximum}`);
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) errors.push(`${path}: 元素数量不足 ${schema.minItems}`);
    if (isObject(schema.items)) instance.forEach((item, i) => errors.push(...validateSchema(item, schema.items, `${path}[${i}]`)));
  }
  if (isObject(instance)) {
    for (const key of schema.required ?? []) if (!(key in instance)) errors.push(`${path}.${key}: 缺少必填字段`);
    for (const [key, value] of Object.entries(instance)) {
      if (isObject(schema.properties) && key in schema.properties) errors.push(...validateSchema(value, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: 不允许的字段`);
    }
  }
  return errors;
}

/* ------------------------------- 确定性运行时 ------------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RollResult {
  rollId: string;
  skill: number;
  difficulty: number;
  seed: number;
  cursor: number;
  value: number;
  threshold: number;
  success: boolean;
  algorithm: 'mulberry32';
}

/** 确定性检定：相同 seed+cursor 永远得到相同结果，结果由运行时记录而非 LLM 编造。 */
export function deterministicRoll(input: { skill: number; difficulty: number; seed: number; cursor: number }): RollResult {
  const { skill, difficulty, seed, cursor } = input;
  const rng = mulberry32((seed + Math.imul(cursor, 0x6D2B79F5)) >>> 0);
  
  const value = Math.floor(rng() * 100) + 1;
  const threshold = Math.max(5, Math.min(95, 50 + (skill - difficulty) * 10));
  return {
    rollId: newId('roll', `${seed}:${cursor}:${skill}:${difficulty}`),
    skill, difficulty, seed, cursor, value, threshold,
    success: value <= threshold,
    algorithm: 'mulberry32'
  };
}
