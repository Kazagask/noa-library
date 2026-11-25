import { join, basename, extname, relative } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  sha256, readJson, readText, parseYaml, stableStringify, writeJsonAtomic, writeJsonl,
  writeText, newId, isObject, ok, fail, type Result
} from '../core/util.ts';
import { validateSchema } from '../core/util.ts';
import { listFiles } from '../core/util.ts';
import type { CampaignManifest, Entity, Episode, Relation } from './domain.ts';
import type { SnapshotRepo } from './store.ts';

export interface MigrationOptions {
  inputPaths: string[]; campaignId?: string; apply?: boolean; at?: string;
}
interface SourceFile { path: string; text: string; hash: string }
interface Candidate { kind: 'state' | 'entity' | 'relation' | 'episode'; data: any; source: string }

const ALLOWED_EXT = new Set(['.json', '.jsonl', '.md', '.markdown', '.txt', '.yaml', '.yml']);

function collectFiles(paths: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const files = statSync(p).isDirectory() ? listFiles(p).filter(f => ALLOWED_EXT.has(extname(f))) : [p];
    for (const file of files) {
      const text = readText(file);
      out.push({ path: file, text, hash: sha256(text) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function headingToEpisodes(file: SourceFile): Candidate[] {
  const lines = file.text.split(/\r?\n/);
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^#{1,3}\s+(.+)$/.exec(line);
    if (m) { current = { title: m[1].trim(), body: [] }; sections.push(current); }
    else if (current) current.body.push(line);
  }
  if (!sections.length && file.text.trim()) sections.push({ title: basename(file.path), body: [file.text] });
  return sections.filter(s => s.body.join('\n').trim()).map((s, i) => {
    const body = s.body.join('\n').trim();
    const atMatch = body.match(/\d{4}-\d{2}-\d{2}T?[^\s]*/)?.[0] ?? s.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    const id = newId('ep', `${file.hash}:${i}`);
    return {
      kind: 'episode' as const,
      source: `${file.path}#${s.title}`,
      data: {
        id, at: atMatch ?? '', turn: 0, title: s.title,
        summary: body.slice(0, 300), excerpt: body.slice(0, 500),
        worldlineId: 'wl-main', entities: [], relationIds: [], knownBy: ['*'],
        path: `${id}.md`, tags: ['migrated'], confidence: 0.5,
        status: 'candidate', _fullText: body
      }
    };
  });
}

function extractCandidates(file: SourceFile): Candidate[] {
  const ext = extname(file.path).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return headingToEpisodes(file);
  let parsed: any;
  try { parsed = ext === '.yaml' || ext === '.yml' ? parseYaml(file.text) : JSON.parse(file.text); }
  catch { return headingToEpisodes(file); }
  const candidates: Candidate[] = [];
  const push = (kind: Candidate['kind'], data: any) => {
    if (isObject(data)) candidates.push({ kind, data, source: file.path });
  };
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.state) push('state', item.state);
    if (item.kind === 'state' || 'schemaVersion' in item && 'rng' in item) push('state', item);
    for (const e of (item.entities as any[]) ?? []) push('entity', e);
    for (const c of (item.characters as any[]) ?? []) push('entity', c);
    for (const r of (item.relations as any[]) ?? []) push('relation', r);
    for (const ep of (item.episodes as any[]) ?? (item.events as any[]) ?? (item.timeline as any[]) ?? []) push('episode', ep);
    if (item.kind === 'entity') push('entity', item);
    if (item.kind === 'relation') push('relation', item);
    if (item.kind === 'episode') push('episode', item);
  }
  return candidates;
}

function minimalState(campaignId: string, worldId: string, at: string, candidate: any, unmapped: string[]): Record<string, any> {
  const base: Record<string, any> = {
    schemaVersion: 1,
    docId: `state-${campaignId}`,
    worldId,
    worldlineId: 'wl-main',
    revision: Number(candidate?.revision ?? 0),
    updatedAt: at,
    rng: {
      algorithm: 'mulberry32',
      seed: Number(candidate?.rng?.seed ?? 1),
      cursor: Number(candidate?.rng?.cursor ?? 0)
    },
    clock: {
      turn: Number(candidate?.clock?.turn ?? 0),
      date: String(candidate?.clock?.date ?? at.slice(0, 10)),
      period: candidate?.clock?.period ?? 'day'
    },
    actors: candidate?.actors ?? {},
    inventory: candidate?.inventory ?? [],
    resources: candidate?.resources ?? {},
    quests: candidate?.quests ?? [],
    flags: candidate?.flags ?? {}
  };
  const allowed = new Set([...Object.keys(base), 'extension']);
  const extension = { ...(isObject(candidate?.extension) ? candidate.extension : {}) };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate ?? {})) {
    if (!allowed.has(key)) { extra[key] = value; unmapped.push(key); }
  }
  if (Object.keys(extra).length) extension.unmapped = extra;
  base.extension = extension;
  return base;
}

function normalizeEntity(raw: any, source: string): Entity {
  return {
    id: String(raw.id ?? newId('person', `${source}:${raw.name ?? ''}`)),
    type: raw.type ?? 'person', name: String(raw.name ?? raw.id ?? '未命名'),
    aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
    worldlineId: 'wl-main', scope: raw.scope ?? 'world',
    knownBy: Array.isArray(raw.knownBy) ? raw.knownBy : ['*'],
    attributes: isObject(raw.attributes) ? raw.attributes : {},
    createdAt: raw.createdAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    ...(raw.confirmed === true ? {} : { status: 'candidate', source })
  } as Entity;
}

function normalizeRelation(raw: any, source: string): Relation {
  return {
    id: String(raw.id ?? newId('rel', `${source}:${raw.subject}:${raw.predicate}:${raw.object}`)),
    subject: String(raw.subject ?? ''), predicate: String(raw.predicate ?? '关联'), object: String(raw.object ?? ''),
    description: String(raw.description ?? ''), worldlineId: 'wl-main',
    validFrom: String(raw.validFrom ?? '1970-01-01T00:00:00.000Z'), validUntil: raw.validUntil ?? null,
    recordedAt: raw.recordedAt ?? new Date().toISOString(), scope: raw.scope ?? 'world',
    knownBy: Array.isArray(raw.knownBy) ? raw.knownBy : ['*'], confidence: Number(raw.confidence ?? 0.5),
    sourceEventId: String(raw.sourceEventId ?? 'migration'), epistemic: raw.epistemic === 'belief' ? 'belief' : 'fact',
    holder: raw.holder ?? null, status: 'active', revision: Number(raw.revision ?? 1),
    ...(raw.confirmed === true ? {} : { candidate: true, source })
  } as Relation;
}

function normalizeEpisode(raw: any, source: string): { episode: Episode; fullText?: string } {
  const id = String(raw.id ?? newId('ep', `${source}:${raw.title ?? ''}`));
  const episode: Episode = {
    id, at: String(raw.at ?? ''), turn: Number(raw.turn ?? 0), title: String(raw.title ?? '未命名经历'),
    summary: String(raw.summary ?? ''), excerpt: String(raw.excerpt ?? ''), worldlineId: 'wl-main',
    entities: Array.isArray(raw.entities) ? raw.entities : [],
    relationIds: Array.isArray(raw.relationIds) ? raw.relationIds : [],
    knownBy: Array.isArray(raw.knownBy) ? raw.knownBy : ['*'],
    sourceEventId: raw.sourceEventId ?? id, path: `${id}.md`,
    tags: Array.isArray(raw.tags) ? raw.tags : ['migrated'],
    confidence: Number(raw.confidence ?? 0.5),
    ...(raw.confirmed === true ? {} : { status: 'candidate', source })
  } as Episode;
  return { episode, fullText: typeof raw._fullText === 'string' ? raw._fullText : undefined };
}

/** 通用历史迁移：dry-run 默认开启，repeat 幂等，绝不覆盖已有正式存档。 */
export function migrateHistory(repo: SnapshotRepo, opts: MigrationOptions): Result {
  const files = collectFiles(opts.inputPaths);
  if (!files.length) return fail('no_input', '没有可读取的输入文件');
  const inputHash = sha256(files.map(f => ({ path: f.path, hash: f.hash })));
  const campaignId = (opts.campaignId ?? `${basename(opts.inputPaths[0]).replace(/[^a-zA-Z0-9_-]/g, '')}-import`) || 'history-import';
  const campaignDir = join(repo.root, 'campaigns', campaignId);
  const migrationDir = join(campaignDir, 'migration');
  const markerPath = join(migrationDir, 'import.json');
  if (existsSync(markerPath)) {
    const marker = readJson(markerPath);
    if (marker.inputHash === inputHash) return ok({ duplicate: true, campaignId, inputHash, status: marker.status });
    return fail('already_imported', '目标 campaign 已由不同输入导入，拒绝覆盖', { campaignId, existing: marker.inputHash });
  }
  if (existsSync(join(campaignDir, 'manifest.yaml'))) return fail('target_exists', '目标 campaign 已存在，不覆盖正式存档', { campaignId });

  const at = opts.at ?? new Date().toISOString();
  const candidates = files.flatMap(extractCandidates);
  const conflicts: { kind: string; id: string; reason: string }[] = [];
  const states = candidates.filter(c => c.kind === 'state');
  states.sort((a, b) => Number(b.data.revision ?? 0) - Number(a.data.revision ?? 0));
  if (states.length > 1) conflicts.push({ kind: 'state', id: 'state', reason: `多个存档快照，采用 revision=${states[0].data.revision ?? 0} 的最新有效存档` });
  const unmappedFields: string[] = [];
  const state = minimalState(campaignId, states[0]?.data?.worldId ?? 'imported', at, states[0]?.data ?? {}, unmappedFields);
  const stateErrors = validateSchema(state, JSON.parse(readText(join(repo.root, 'schemas', 'state.schema.json'))));
  if (stateErrors.length) conflicts.push({ kind: 'state', id: 'state', reason: `生成的 state 未通过校验: ${stateErrors.join(';')}` });

  const seenE = new Map<string, Entity>();
  const seenR = new Map<string, Relation>();
  const seenEp = new Map<string, Episode>();
  const fullTexts: Record<string, string> = {};
  for (const c of candidates) {
    if (c.kind === 'entity') {
      const row = normalizeEntity(c.data, c.source);
      if (seenE.has(row.id) && stableStringify(seenE.get(row.id)) !== stableStringify(row)) conflicts.push({ kind: 'entity', id: row.id, reason: '重复实体内容不一致，保留首次记录' });
      else seenE.set(row.id, row);
    } else if (c.kind === 'relation') {
      const row = normalizeRelation(c.data, c.source);
      if (seenR.has(row.id) && stableStringify(seenR.get(row.id)) !== stableStringify(row)) conflicts.push({ kind: 'relation', id: row.id, reason: '重复关系内容不一致，保留首次记录' });
      else seenR.set(row.id, row);
    } else if (c.kind === 'episode') {
      const { episode, fullText } = normalizeEpisode(c.data, c.source);
      if (seenEp.has(episode.id) && stableStringify(seenEp.get(episode.id)) !== stableStringify(episode)) conflicts.push({ kind: 'episode', id: episode.id, reason: '重复情景内容不一致，保留首次记录' });
      else { seenEp.set(episode.id, episode); if (fullText) fullTexts[episode.id] = fullText; }
    }
  }

  const report = {
    schemaVersion: 1, dryRun: opts.apply !== true, campaignId, generatedAt: at,
    inputHash, sources: files.map(f => ({ path: relative(repo.root, f.path) || f.path, hash: f.hash })),
    counts: { sources: files.length, candidates: candidates.length, states: states.length, entities: seenE.size, relations: seenR.size, episodes: seenEp.size },
    conflicts, unmappedFields,
    note: '候选记忆默认 status=candidate；推测不自动升格为事实。未知字段写入 state.extension.unmapped。'
  };
  if (opts.apply !== true) return ok(report);

  const manifest: CampaignManifest = {
    manifestVersion: 1, id: campaignId,
    title: String(states[0]?.data?.title ?? `${campaignId} 导入存档`),
    worldId: String(state.worldId), worldlineId: 'wl-main', status: 'imported',
    paths: {
      state: 'state/latest.json', events: 'state/events.jsonl',
      entities: 'memory/entities.jsonl', relations: 'memory/relations.jsonl',
      episodesIndex: 'memory/episodes/index.jsonl', episodesDir: 'memory/episodes',
      journals: 'journals', checkpoints: 'checkpoints', working: 'working.json'
    },
    timeIndex: [...seenEp.values()].filter(e => e.at).sort((a, b) => a.at.localeCompare(b.at)).slice(-50).map(e => ({ at: e.at, episodeId: e.id })),
    consistencyRules: []
  };
  const working = {
    workingVersion: 1, sessionId: `sess-${campaignId}`, campaignId, worldlineId: 'wl-main',
    scene: '', recentTurns: [], pendingTasks: [], durable: false, memoryRevision: 0
  };
  repo.writeManifest(campaignId, manifest);
  repo.write(campaignId, 'wl-main', {
    manifest, state, entities: [...seenE.values()], relations: [...seenR.values()],
    episodes: [...seenEp.values()], working
  });
  for (const [id, text] of Object.entries(fullTexts)) {
    writeText(join(campaignDir, manifest.paths.episodesDir, `${id}.md`), `# ${seenEp.get(id)?.title ?? id}\n\n- 来源：migration\n\n${text}\n`);
  }
  writeJsonl(join(migrationDir, 'sources.jsonl'), report.sources);
  writeJsonl(join(migrationDir, 'candidates.jsonl'), candidates.map(c => ({ kind: c.kind, source: c.source, data: c.data })));
  writeJsonAtomic(markerPath, { inputHash, campaignId, status: 'applied', appliedAt: at });
  writeJsonAtomic(join(migrationDir, 'report.json'), { ...report, dryRun: false, status: 'applied' });
  return ok({ ...report, dryRun: false, status: 'applied', path: `campaigns/${campaignId}` });
}
