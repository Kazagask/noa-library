import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  readJson, readText, parseYaml, writeJsonAtomic, sha256, ok, fail, type Result
} from '../core/util.ts';
import {
  entityVisible, episodeVisible, relationVisible, knownByAllows, timeValid,
  type Entity, type Episode, type Relation, type ViewContext
} from './domain.ts';
import type { SnapshotRepo, Snapshot } from './store.ts';

export interface IndexMeta {
  schemaVersion: 1;
  campaignId: string;
  generatedAt: string;
  sourceRevision: number;
  memoryRevision: number;
  worldlines: string[];
  entityCount: number;
  relationCount: number;
  episodeCount: number;
  pageThreshold: number;
  hash: string;
}
interface SafeRelation {
  id: string; subject: string; predicate: string; object: string; worldlineId: string;
  validFrom: string; validUntil: string | null; epistemic: 'fact' | 'belief'; holder: string | null;
  confidence: number; knownBy: string[]; scope: string; sourceEventId: string;
  status: string; revision: number; text: string;
}
interface SafeEpisode {
  id: string; at: string; turn: number; title: string; summary: string; excerpt: string;
  worldlineId: string; entities: string[]; relationIds: string[]; knownBy: string[];
  tags: string[]; path: string;
}

function safeFileName(id: string): string {
  if (id.includes('..') || id.includes('/') || id.includes('\\') || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    return `e-${sha256(id).slice(0, 16)}`;
  }
  return id;
}

function safeRelation(r: Relation): SafeRelation {
  const publicFact = r.epistemic === 'fact' && knownByAllows(r.knownBy, '*');
  return {
    id: r.id, subject: r.subject, predicate: r.predicate, object: r.object, worldlineId: r.worldlineId,
    validFrom: r.validFrom, validUntil: r.validUntil, epistemic: r.epistemic, holder: r.holder,
    confidence: r.confidence, knownBy: r.knownBy, scope: r.scope, sourceEventId: r.sourceEventId,
    status: r.status, revision: r.revision, text: publicFact ? r.description : '[restricted]'
  };
}

function safeEpisode(e: Episode, relations: Relation[]): SafeEpisode {
  const open = knownByAllows(e.knownBy, '*');
  return {
    id: e.id, at: e.at, turn: e.turn, title: e.title,
    summary: open ? e.summary : '[restricted]',
    excerpt: open ? (e.excerpt ?? '') : '[restricted]',
    worldlineId: e.worldlineId, entities: e.entities,
    relationIds: open ? e.relationIds.filter(id => {
      const rel = relations.find(r => r.id === id);
      return rel ? rel.epistemic === 'fact' && knownByAllows(rel.knownBy, '*') : false;
    }) : [],
    knownBy: e.knownBy, tags: e.tags, path: open ? e.path : '[restricted]'
  };
}

function indexPath(root: string, campaignId: string): string {
  return join(root, 'campaigns', campaignId, 'memory', 'index');
}

export function buildIndices(repo: SnapshotRepo, campaignId: string, opts: { at?: string; pageThreshold?: number } = {}): Result {
  const worldlines = repo.listWorldlines(campaignId);
  if (!worldlines.length) return fail('campaign_not_found', `campaign ${campaignId} 不存在`);
  const threshold = opts.pageThreshold ?? 50;
  const at = opts.at ?? new Date().toISOString();
  const base = indexPath(repo.root, campaignId);
  const byEntityDir = join(repo.root, 'campaigns', campaignId, 'memory', 'by-entity');
  const entityMap: Record<string, { id: string; type: string; name: string; worldlines: string[] }> = {};
  const aliasMap: Record<string, { id: string; worldlineId: string; name: string }[]> = {};
  const recent: Record<string, SafeEpisode[]> = {};
  const unresolved: Record<string, { quests: unknown[]; relations: SafeRelation[] }> = {};
  const commitments: Record<string, SafeRelation[]> = {};
  const worldlineMeta: Record<string, unknown>[] = [];
  const COMMITMENT_PREDICATES = new Set(['承诺', '约定', '誓约', '长期目标', '计划']);
  const UNRESOLVED_PREDICATES = new Set(['待办', '未完成', '跟进']);
  let totalE = 0, totalR = 0, totalEp = 0;

  for (const wl of worldlines) {
    let snap: Snapshot;
    try { snap = repo.read(campaignId, wl); }
    catch { continue; }
    totalE += snap.entities.length; totalR += snap.relations.length; totalEp += snap.episodes.length;
    worldlineMeta.push({
      worldlineId: wl, revision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0,
      forkedFrom: snap.working.forkedFrom ?? null,
      entityCount: snap.entities.length, relationCount: snap.relations.length, episodeCount: snap.episodes.length
    });
    recent[wl] = [...snap.episodes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(e => safeEpisode(e, snap.relations));
    unresolved[wl] = {
      quests: (snap.state.quests ?? []).filter((q: any) => q.status !== 'done' && q.status !== 'completed'),
      relations: snap.relations.filter(r => r.status === 'active' && UNRESOLVED_PREDICATES.has(r.predicate)).map(safeRelation)
    };
    commitments[wl] = snap.relations.filter(r =>
      r.status === 'active' && COMMITMENT_PREDICATES.has(r.predicate) && (r.validUntil === null || r.validUntil > at)
    ).map(safeRelation);

    const grouped = new Map<string, { entity: Entity; relations: SafeRelation[]; episodes: SafeEpisode[] }>();
    for (const entity of snap.entities) {
      grouped.set(entity.id, { entity, relations: [], episodes: [] });
      if (!entityMap[entity.id]) entityMap[entity.id] = { id: entity.id, type: entity.type, name: entity.name, worldlines: [] };
      if (!entityMap[entity.id].worldlines.includes(wl)) entityMap[entity.id].worldlines.push(wl);
      for (const label of [entity.name, ...(entity.aliases ?? [])]) {
        const key = label.trim().toLowerCase();
        if (!key) continue;
        aliasMap[key] = aliasMap[key] ?? [];
        if (!aliasMap[key].some(a => a.id === entity.id && a.worldlineId === wl)) aliasMap[key].push({ id: entity.id, worldlineId: wl, name: entity.name });
      }
    }
    for (const rel of snap.relations) {
      for (const id of [rel.subject, rel.object]) {
        const group = grouped.get(id);
        if (group) group.relations.push(safeRelation(rel));
      }
    }
    for (const ep of snap.episodes) {
      for (const id of ep.entities) {
        const group = grouped.get(id);
        if (group) group.episodes.push(safeEpisode(ep, snap.relations));
      }
    }

    for (const [entityId, group] of grouped) {
      const fileName = safeFileName(entityId);
      const view: Record<string, unknown> = {
        entityId,
        worldlines: {} as Record<string, unknown>
      };
      const wls = view.worldlines as Record<string, unknown>;
      if (group.relations.length <= threshold && group.episodes.length <= threshold) {
        wls[wl] = { entity: group.entity, relations: group.relations, episodes: group.episodes, paginated: false };
      } else {
        const pages: { relations: SafeRelation[]; episodes: SafeEpisode[] }[] = [];
        for (let i = 0; i < Math.max(group.relations.length, group.episodes.length); i += threshold) {
          pages.push({ relations: group.relations.slice(i, i + threshold), episodes: group.episodes.slice(i, i + threshold) });
        }
        pages.forEach((page, i) => {
          writeJsonAtomic(join(byEntityDir, `${fileName}.${wl}.page-${i + 1}.json`), {
            entityId, worldlineId: wl, page: i + 1, totalPages: pages.length, ...page
          });
        });
        wls[wl] = {
          entity: group.entity, relationCount: group.relations.length, episodeCount: group.episodes.length,
          paginated: true, totalPages: pages.length
        };
      }
      writeJsonAtomic(join(byEntityDir, `${fileName}.json`), view);
    }
  }

  const baseSnap = repo.read(campaignId, worldlines[0]);
  const meta: IndexMeta = {
    schemaVersion: 1, campaignId, generatedAt: at,
    sourceRevision: baseSnap.state.revision,
    memoryRevision: baseSnap.working.memoryRevision ?? 0,
    worldlines, entityCount: totalE, relationCount: totalR, episodeCount: totalEp,
    pageThreshold: threshold, hash: ''
  };
  meta.hash = sha256(meta);
  writeJsonAtomic(join(base, 'meta.json'), meta);
  writeJsonAtomic(join(base, 'entities.json'), entityMap);
  writeJsonAtomic(join(base, 'aliases.json'), aliasMap);
  writeJsonAtomic(join(base, 'recent.json'), recent);
  writeJsonAtomic(join(base, 'unresolved.json'), unresolved);
  writeJsonAtomic(join(base, 'commitments.json'), commitments);
  writeJsonAtomic(join(base, 'worldlines.json'), worldlineMeta);
  return ok({ ...meta, path: 'memory/index' });
}

export function indexFresh(repo: SnapshotRepo, campaignId: string): Result {
  const metaPath = join(indexPath(repo.root, campaignId), 'meta.json');
  if (!existsSync(metaPath)) return ok({ fresh: false, reason: 'index_missing' });
  const meta = readJson(metaPath) as IndexMeta;
  const dir = join(repo.root, 'campaigns', campaignId);
  const manifest = parseYaml(readText(join(dir, 'manifest.yaml')));
  let state: any = null, working: any = null;
  try {
    state = readJson(join(dir, manifest.paths.state));
    working = readJson(join(dir, manifest.paths.working));
  } catch { return ok({ fresh: false, reason: 'source_missing' }); }
  const currentRevision = state.revision;
  const currentMemoryRevision = working.memoryRevision ?? 0;
  const fresh = meta.sourceRevision === currentRevision && meta.memoryRevision === currentMemoryRevision;
  return ok({
    fresh, meta, current: { revision: currentRevision, memoryRevision: currentMemoryRevision },
    rebuild: fresh ? undefined : `node scripts/cli.ts index --campaign ${campaignId}`
  });
}

export interface EntityLookupInput {
  campaignId: string; worldlineId: string; viewer: string;
  id?: string; name?: string; alias?: string; asOf?: string; includeBeliefs?: boolean;
  maxPages?: number;
}

export function lookupEntity(repo: SnapshotRepo, input: EntityLookupInput): Result {
  const fresh = indexFresh(repo, input.campaignId);
  if (!fresh.ok) return fresh;
  if (!(fresh.data as any).fresh) return fail('index_stale', '物化索引与权威数据不同版本', fresh.data);
  const base = indexPath(repo.root, input.campaignId);
  const aliases = readJson(join(base, 'aliases.json')) as Record<string, { id: string; worldlineId: string; name: string }[]>;
  const key = (input.id ?? input.name ?? input.alias ?? '').toLowerCase();
  let entityId = input.id ?? '';
  if (!entityId && key) entityId = (aliases[key] ?? []).find(a => a.worldlineId === input.worldlineId)?.id ?? '';
  if (!entityId) return fail('entity_not_found', '索引中未找到实体', { query: key });
  const fileName = safeFileName(entityId);
  const viewPath = join(repo.root, 'campaigns', input.campaignId, 'memory', 'by-entity', `${fileName}.json`);
  if (!existsSync(viewPath)) return fail('entity_not_found', `实体视图不存在: ${fileName}`);
  const view = readJson(viewPath);
  const wl = (view.worldlines ?? {})[input.worldlineId];
  if (!wl) return fail('worldline_not_found', `实体 ${entityId} 在 ${input.worldlineId} 不存在`);
  const ctx: ViewContext = {
    viewer: input.viewer, worldlineId: input.worldlineId,
    asOf: input.asOf ?? '9999-12-31T23:59:59.999Z', includeBeliefs: input.includeBeliefs === true
  };
  let relations: SafeRelation[] = wl.relations ?? [];
  let episodes: SafeEpisode[] = wl.episodes ?? [];
  let pagesRead = 0;
  if (wl.paginated) {
    relations = []; episodes = [];
    for (let p = 1; p <= Math.min(Number(wl.totalPages) || 0, input.maxPages ?? 4); p++) {
      const pagePath = join(repo.root, 'campaigns', input.campaignId, 'memory', 'by-entity', `${fileName}.${input.worldlineId}.page-${p}.json`);
      if (!existsSync(pagePath)) break;
      const page = readJson(pagePath);
      relations.push(...(page.relations ?? []));
      episodes.push(...(page.episodes ?? []));
      pagesRead++;
    }
  }
  const visibleRelations = relations.filter(r => relationVisible(r as unknown as Relation, ctx));
  const visibleEpisodes = episodes.filter(e => episodeVisible(e as unknown as Episode, ctx));
  return ok({
    entity: wl.entity, worldlineId: input.worldlineId,
    relations: visibleRelations, episodes: visibleEpisodes,
    pagesRead, totalPages: wl.paginated ? wl.totalPages : 1,
    truncated: wl.paginated && pagesRead < wl.totalPages,
    source: `memory/by-entity/${fileName}.json`
  });
}

export function recentIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string, viewer: string, limit = 10): Result {
  const fresh = indexFresh(repo, campaignId);
  if (!fresh.ok) return fresh;
  if (!(fresh.data as any).fresh) return fail('index_stale', '索引已过期', fresh.data);
  const all = readJson(join(indexPath(repo.root, campaignId), 'recent.json')) as Record<string, SafeEpisode[]>;
  const list = (all[worldlineId] ?? []).filter(e => episodeVisible(e as unknown as Episode, {
    viewer, worldlineId, asOf: '9999-12-31T23:59:59.999Z', includeBeliefs: false
  })).slice(0, limit);
  return ok({ episodes: list, source: 'memory/index/recent.json' });
}

export function unresolvedIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string, viewer: string): Result {
  const fresh = indexFresh(repo, campaignId);
  if (!fresh.ok) return fresh;
  if (!(fresh.data as any).fresh) return fail('index_stale', '索引已过期', fresh.data);
  const all = readJson(join(indexPath(repo.root, campaignId), 'unresolved.json')) as Record<string, { quests: unknown[]; relations: SafeRelation[] }>;
  const value = all[worldlineId] ?? { quests: [], relations: [] };
  const ctx: ViewContext = { viewer, worldlineId, asOf: '9999-12-31T23:59:59.999Z', includeBeliefs: false };
  return ok({
    quests: value.quests,
    relations: value.relations.filter(r => relationVisible(r as unknown as Relation, ctx)),
    source: 'memory/index/unresolved.json'
  });
}

export function commitmentsIndex(repo: SnapshotRepo, campaignId: string, worldlineId: string, viewer: string): Result {
  const fresh = indexFresh(repo, campaignId);
  if (!fresh.ok) return fresh;
  if (!(fresh.data as any).fresh) return fail('index_stale', '索引已过期', fresh.data);
  const all = readJson(join(indexPath(repo.root, campaignId), 'commitments.json')) as Record<string, SafeRelation[]>;
  const ctx: ViewContext = { viewer, worldlineId, asOf: '9999-12-31T23:59:59.999Z', includeBeliefs: false };
  return ok({
    commitments: (all[worldlineId] ?? []).filter(r => relationVisible(r as unknown as Relation, ctx)),
    source: 'memory/index/commitments.json'
  });
}
