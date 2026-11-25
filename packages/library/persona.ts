import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import {
  readJson, readJsonl, readText, writeJsonAtomic, writeJsonl, appendJsonl,
  parseYaml, sha256, newId, isObject, ok, fail, type Result
} from '../core/util.ts';
import type { SnapshotRepo } from './store.ts';

export const PERSONA_NAMESPACE = 'noa/persona-relationship';
export const PERSONA_WORLDLINE = 'wl-noa-persistent';
const JSONL_KINDS = new Set(['examples', 'history', 'relations', 'entities']);
const PART_KINDS = new Set(['preferences', 'voice', 'boundaries', 'relationship']);

function personaDir(repo: SnapshotRepo): string { return join(repo.root, 'personas', 'noa'); }
function importsDir(repo: SnapshotRepo): string { return join(personaDir(repo), 'imports'); }

export function loadPersona(repo: SnapshotRepo): Result {
  const dir = personaDir(repo);
  const manifestPath = join(dir, 'manifest.yaml');
  if (!existsSync(manifestPath)) return fail('persona_not_found', '缺少 personas/noa/manifest.yaml');
  const manifest = parseYaml(readText(manifestPath));
  const parts: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(manifest.parts ?? {})) {
    if (name === 'history' || name === 'examples' || name === 'graph' || name === 'entities' || name === 'imports') continue;
    const path = join(dir, String(file));
    parts[name] = existsSync(path) ? parseYaml(readText(path)) : {};
  }
  const memory = {
    entities: readJsonl(join(dir, 'memory', 'entities.jsonl')),
    relations: readJsonl(join(dir, 'memory', 'relations.jsonl')),
    episodes: readJsonl(join(dir, 'memory', 'episodes.jsonl')),
    examples: readJsonl(join(dir, 'memory', 'examples.jsonl'))
  };
  const additions: Record<string, unknown[]> = {};
  const imp = importsDir(repo);
  if (existsSync(imp)) for (const file of readdirSync(imp).filter(f => f.endsWith('.jsonl') && !f.startsWith('audit') && !f.startsWith('processed'))) {
    additions[file.replace(/\.jsonl$/, '')] = readJsonl(join(imp, file));
  }
  const hash = sha256({ manifest: { ...manifest, hash: '' }, parts, memory, additions });
  return ok({
    id: manifest.id, version: manifest.version, status: manifest.status,
    namespace: manifest.namespace, persistentAcrossWorldlines: manifest.persistentAcrossWorldlines,
    parts, memory, additions, pending: manifest.pending ?? [], hash,
    source: 'personas/noa/manifest.yaml'
  });
}

export interface PersonaImportInput {
  kind: 'examples' | 'history' | 'relations' | 'entities' | 'preferences' | 'voice' | 'boundaries' | 'relationship';
  records: unknown[];
  source: string;
  idempotencyKey: string;
  apply?: boolean;
  at?: string;
}

/** 人格增量导入：不重写人格主文件；候选记忆默认 status=candidate，不自动升格为事实。 */
export function importPersona(repo: SnapshotRepo, input: PersonaImportInput): Result {
  const known = JSONL_KINDS.has(input.kind) || PART_KINDS.has(input.kind);
  if (!known) return fail('unsupported_kind', `不支持的人格分片 ${input.kind}`);
  if (!Array.isArray(input.records)) return fail('invalid_records', 'records 必须是数组');
  if (!input.source || !input.idempotencyKey) return fail('missing_source', 'source 与 idempotencyKey 必填');
  const dir = personaDir(repo);
  const imp = importsDir(repo);
  const processedPath = join(imp, 'processed.json');
  const processed = existsSync(processedPath) ? readJson(processedPath) as Record<string, unknown> : {};
  if (processed[input.idempotencyKey]) {
    return ok({ duplicate: true, kind: input.kind, idempotencyKey: input.idempotencyKey, previous: processed[input.idempotencyKey] });
  }
  const apply = input.apply === true;
  const at = input.at ?? new Date().toISOString();
  const prepared = input.records.map((raw, index) => {
    if (!isObject(raw)) return { index, error: 'record 不是对象' };
    const row: Record<string, unknown> = { ...raw };
    if (JSONL_KINDS.has(input.kind)) {
      row.id = row.id ?? newId(input.kind === 'relations' ? 'rel' : input.kind === 'entities' ? 'person' : 'ep', `${input.source}:${input.idempotencyKey}:${index}`);
      row.scope = PERSONA_NAMESPACE;
      row.worldlineId = PERSONA_WORLDLINE;
      row.source = input.source;
      row.importedAt = at;
      row.status = row.confirmed === true ? 'confirmed' : 'candidate';
      if (input.kind === 'entities' && !row.type) row.type = 'concept';
      if (input.kind === 'entities' && !row.name) row.name = String(row.id);
      if (input.kind === 'history' && !row.at) row.at = at;
    } else {
      row.source = input.source;
      row.importedAt = at;
    }
    return { index, row };
  });
  const errors = prepared.filter(p => p.error);
  if (errors.length) return fail('invalid_records', '存在非法记录', { errors });
  const rows = prepared.map(p => p.row);
  if (!apply) {
    return ok({ dryRun: true, kind: input.kind, count: rows.length, sample: rows.slice(0, 2), note: '未写入人格档案；加 --apply 生效。' });
  }

  const manifestPath = join(dir, 'manifest.yaml');
  const manifest = parseYaml(readText(manifestPath));
  if (JSONL_KINDS.has(input.kind)) {
    const file = input.kind === 'history' ? 'episodes.jsonl' : input.kind === 'examples' ? 'examples.jsonl' : `${input.kind}.jsonl`;
    const path = join(dir, 'memory', file);
    const existing = readJsonl(path) as Record<string, unknown>[];
    const seen = new Set(existing.map(r => r.id));
    const additions = rows.filter(r => !seen.has(r.id));
    existing.push(...additions);
    writeJsonl(path, existing);
  } else {
    const path = join(imp, `${input.kind}.jsonl`);
    writeJsonl(path, [...readJsonl(path), ...rows]);
  }
  manifest.version = Number(manifest.version ?? 1) + 1;
  manifest.updatedAt = at;
  writeJsonAtomic(manifestPath, manifest);
  processed[input.idempotencyKey] = { kind: input.kind, count: rows.length, at };
  writeJsonAtomic(processedPath, processed);
  appendJsonl(join(imp, 'audit.jsonl'), {
    id: newId('persona-import'), at, kind: input.kind, idempotencyKey: input.idempotencyKey,
    source: input.source, count: rows.length, version: manifest.version
  });
  const profile = loadPersona(repo);
  return ok({
    dryRun: false, kind: input.kind, count: rows.length, version: manifest.version,
    hash: profile.ok ? profile.data.hash : null
  });
}
