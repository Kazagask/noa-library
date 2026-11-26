import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setSharedHasher } from './shared.ts';

// Node 宿主为平台无关内核注入稳定 SHA-256；Worker 侧可覆盖为 @noble 实现。
setSharedHasher(value => createHash('sha256').update(value).digest('hex'));

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
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function newId(prefix: string, key?: string): string {
  const suffix = key ? sha256(key).slice(0, 12) : randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

export function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function isObject(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/* ------------------------------ YAML 子集解析 ------------------------------ */

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitInline(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function unquote(text: string): string {
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text) as string;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

export function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === '') return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return unquote(t);
  if (t.startsWith('[') && t.endsWith(']')) return splitInline(t.slice(1, -1)).map(parseScalar);
  if (t.startsWith('{') && t.endsWith('}')) {
    const obj: Record<string, unknown> = {};
    for (const part of splitInline(t.slice(1, -1))) {
      const m = part.match(/^([^:]+):\s*(.*)$/);
      if (m) obj[unquote(m[1].trim())] = parseScalar(m[2]);
    }
    return obj;
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

export function parseYaml(text: string): any {
  // JSON 是 YAML 1.2 的子集：writeJsonAtomic 写出的 manifest 可直接解析。
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const tokens: { indent: number; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const indent = /^ */.exec(raw)![0].length;
    const body = stripComment(raw.slice(indent)).trimEnd();
    if (!body || body === '---' || body === '...') continue;
    tokens.push({ indent, text: body });
  }
  if (!tokens.length) return null;
  let pos = 0;

  function isSeqLine(text: string): boolean { return text === '-' || text.startsWith('- '); }

  function parseBlock(indent: number): any {
    if (pos >= tokens.length) return null;
    if (isSeqLine(tokens[pos].text)) {
      const arr: unknown[] = [];
      while (pos < tokens.length && tokens[pos].indent === indent && isSeqLine(tokens[pos].text)) {
        const content = tokens[pos].text.slice(1).trim();
        pos++;
        if (!content) {
          arr.push(pos < tokens.length && tokens[pos].indent > indent ? parseBlock(tokens[pos].indent) : null);
        } else {
          const m = content.match(/^([^:]+):\s*(.*)$/);
          if (m && !content.startsWith('[') && !content.startsWith('{')) {
            const obj: Record<string, unknown> = {};
            const key = unquote(m[1].trim());
            const val = m[2].trim();
            obj[key] = val ? parseScalar(val) : (pos < tokens.length && tokens[pos].indent > indent ? parseBlock(tokens[pos].indent) : null);
            if (pos < tokens.length && tokens[pos].indent > indent) {
              const rest = parseBlock(tokens[pos].indent);
              if (isObject(rest)) Object.assign(obj, rest);
            }
            arr.push(obj);
          } else arr.push(parseScalar(content));
        }
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (pos < tokens.length && tokens[pos].indent === indent && !isSeqLine(tokens[pos].text)) {
      const m = tokens[pos].text.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new Error(`YAML 解析失败（行 ${pos + 1}）: ${tokens[pos].text}`);
      const key = unquote(m[1].trim());
      const val = m[2].trim();
      pos++;
      obj[key] = val ? parseScalar(val) : (pos < tokens.length && tokens[pos].indent > indent ? parseBlock(tokens[pos].indent) : null);
    }
    return obj;
  }
  return parseBlock(tokens[0].indent);
}

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

/* ---------------------------------- 文件 IO ---------------------------------- */

export function readText(path: string): string { return readFileSync(path, 'utf8'); }
export function readJson<T = any>(path: string): T { return JSON.parse(readText(path)) as T; }
export function readJsonl<T = any>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readText(path).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as T);
}
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${stableStringify(value)}\n`, 'utf8');
  try { renameSync(tmp, path); }
  catch (err: any) {
    if (existsSync(path)) rmSync(path);
    renameSync(tmp, path);
    void err;
  }
}
export function writeJsonl(path: string, rows: unknown[]): void {
  writeText(path, rows.map(r => stableStringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${stableStringify(row)}\n`, 'utf8');
}
export function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }
export function copyDir(from: string, to: string): void { cpSync(from, to, { recursive: true }); }
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
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
  const rng = mulberry32(seed);
  for (let i = 0; i < cursor; i++) rng();
  const value = Math.floor(rng() * 100) + 1;
  const threshold = Math.max(5, Math.min(95, 50 + (skill - difficulty) * 10));
  return {
    rollId: newId('roll', `${seed}:${cursor}:${skill}:${difficulty}`),
    skill, difficulty, seed, cursor, value, threshold,
    success: value <= threshold,
    algorithm: 'mulberry32'
  };
}
