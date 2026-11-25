import { join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readText, readJson, readJsonl, parseYaml, validateSchema, ok, fail } from '../packages/core/util.ts';
import { FsStore } from '../packages/library/fs-store.ts';
import { buildColdStart } from '../packages/library/coldstart.ts';
import * as ops from '../packages/library/operations.ts';
import * as indices from '../packages/library/indices.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function str(a: Record<string, string | boolean>, key: string, fallback = ''): string {
  const value = a[key];
  return typeof value === 'string' ? value : fallback;
}

function defaultCampaignId(): string {
  const root = parseYaml(readText(join(ROOT, 'manifest.yaml')));
  return root.campaigns?.find((c: any) => c.status === 'active')?.id ?? root.campaigns?.[0]?.id ?? 'demo';
}

function baseInput(a: Record<string, string | boolean>) {
  return {
    campaignId: str(a, 'campaign') || defaultCampaignId(),
    worldlineId: str(a, 'worldline', 'wl-main'),
    viewer: str(a, 'viewer', 'person.player'),
    actor: str(a, 'actor', 'person.player'),
    at: a.at ? str(a, 'at') : undefined
  };
}

function complexInput(a: Record<string, string | boolean>): Record<string, any> {
  if (a.json && typeof a.json === 'string') return JSON.parse(a.json);
  if (a.input && typeof a.input === 'string') return JSON.parse(readText(resolve(a.input)));
  return {};
}

function verify(): { ok: boolean; errors: string[]; checked: number } {
  const errors: string[] = [];
  let checked = 0;
  const check = (condition: unknown, message: string) => { checked++; if (!condition) errors.push(message); };
  try {
    const root = parseYaml(readText(join(ROOT, 'manifest.yaml')));
    for (const key of ['entrypoints', 'persona', 'protocols', 'schemas', 'worlds', 'campaigns', 'loadingPolicy', 'toolsets']) {
      check(root[key], `manifest.yaml 缺少 ${key}`);
    }
    for (const path of [root.entrypoints.agentInstructions, root.entrypoints.bootstrap, root.entrypoints.coldStart, root.entrypoints.persona, ...Object.values(root.protocols ?? {})]) {
      check(existsSync(join(ROOT, String(path))), `缺少入口文件 ${String(path)}`);
    }
    const schemas: Record<string, any> = {};
    for (const [name, path] of Object.entries(root.schemas ?? {})) {
      try { schemas[name] = readJson(join(ROOT, String(path))); check(true, ''); }
      catch (e: any) { check(false, `Schema 无法加载 ${name}: ${e.message}`); }
    }
    for (const world of root.worlds as any[]) {
      const worldPath = join(ROOT, world.path);
      check(existsSync(worldPath), `缺少 world ${world.path}`);
      if (existsSync(worldPath)) {
        const wm = parseYaml(readText(worldPath));
        check(wm.id === world.id, `world ${world.id} id 不一致`);
        for (const layer of Object.values(wm.sourceLayers ?? {}) as any[]) {
          for (const file of layer.files ?? []) check(existsSync(join(ROOT, 'worlds', world.id, String(file).split('#')[0])), `缺少知识文件 ${file}`);
        }
      }
    }
    for (const entry of root.campaigns as any[]) {
      const dir = join(ROOT, 'campaigns', entry.id);
      const m = parseYaml(readText(join(dir, 'manifest.yaml')));
      check(validateSchema(m, schemas.manifest).length === 0, `campaign ${entry.id} manifest 校验失败`);
      check(m.worldId === entry.worldId && m.worldlineId === entry.worldlineId, `campaign ${entry.id} 索引不一致`);
      const statePath = join(dir, m.paths.state);
      const state = readJson(statePath);
      const stateErrors = validateSchema(state, schemas.state);
      check(stateErrors.length === 0, `state 校验失败: ${stateErrors.join('; ')}`);
      const entities = readJsonl(join(dir, m.paths.entities));
      const relations = readJsonl(join(dir, m.paths.relations));
      const episodes = readJsonl(join(dir, m.paths.episodesIndex));
      entities.forEach((e, i) => check(validateSchema(e, schemas.entity).length === 0, `entities[${i}] 校验失败`));
      relations.forEach((r, i) => check(validateSchema(r, schemas.relation).length === 0, `relations[${i}] 校验失败`));
      episodes.forEach((e, i) => check(validateSchema(e, schemas.episode).length === 0, `episodes[${i}] 校验失败`));
      const ids = new Set(entities.map((e: any) => e.id));
      const epIds = new Set(episodes.map((e: any) => e.id));
      for (const r of relations as any[]) {
        check(ids.has(r.subject), `关系 ${r.id} subject 不存在: ${r.subject}`);
        check(ids.has(r.object), `关系 ${r.id} object 不存在: ${r.object}`);
        if (r.sourceEventId && !epIds.has(r.sourceEventId)) check(episodes.some((e: any) => e.id === r.sourceEventId), `关系 ${r.id} sourceEventId 不存在`);
      }
      for (const ep of episodes as any[]) {
        check(existsSync(join(dir, m.paths.episodesDir, ep.path)), `情景原文缺失 ${ep.path}`);
        for (const id of ep.entities) check(ids.has(id), `情景 ${ep.id} 实体不存在 ${id}`);
        for (const id of ep.relationIds) check((relations as any[]).some(r => r.id === id), `情景 ${ep.id} 关系不存在 ${id}`);
      }
      for (const anchor of m.timeIndex ?? []) check(epIds.has(anchor.episodeId), `时间锚 ${anchor.episodeId} 不存在`);
    }
  } catch (err: any) {
    errors.push(`校验过程异常: ${err.message}`);
  }
  return { ok: errors.length === 0, errors, checked };
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'verify';
  const a = args();
  let result: unknown;
  switch (cmd) {
    case 'verify': result = verify(); break;
    case 'coldstart': {
      const b = baseInput(a);
      result = buildColdStart(store, {
        ...b,
        maxChars: a['max-chars'] ? Number(str(a, 'max-chars')) : (a.budget ? Number(str(a, 'budget')) : undefined),
        stage: a.stage ? Number(str(a, 'stage')) as 1 | 2 | 3 : undefined,
        mode: str(a, 'mode') as any || undefined
      });
      break;
    }
    case 'recall': result = ops.recall(store, { ...baseInput(a), query: str(a, 'query'), asOf: a.asof ? str(a, 'asof') : undefined, limit: a.limit ? Number(str(a, 'limit')) : undefined, includeBeliefs: a.beliefs === true }); break;
    case 'traverse': result = ops.traverse(store, { ...baseInput(a), start: str(a, 'start', 'person.player'), hops: a.hops ? Number(str(a, 'hops')) : 2 }); break;
    case 'search': result = ops.librarySearch(store, { campaignId: str(a, 'campaign', 'demo'), query: str(a, 'query') }); break;
    case 'state': result = ops.readState(store, { campaignId: str(a, 'campaign', 'demo'), worldlineId: str(a, 'worldline', 'wl-main') }); break;
    case 'commit': result = ops.commitState(store, { ...baseInput(a), expectedRevision: Number(str(a, 'revision')), changes: complexInput(a), idempotencyKey: str(a, 'key', 'cli-commit'), resolution: str(a, 'resolution') as any, reason: str(a, 'reason') }); break;
    case 'record': {
      const input = complexInput(a);
      result = ops.recordMemory(store, { ...baseInput(a), kind: str(a, 'kind', 'relation') as any, data: input, idempotencyKey: str(a, 'key', 'cli-record') });
      break;
    }
    case 'revise': {
      const input = complexInput(a);
      result = ops.reviseMemory(store, { ...baseInput(a), kind: str(a, 'kind', 'relation') as any, id: str(a, 'id'), expectedRevision: Number(str(a, 'revision')), patch: input, idempotencyKey: str(a, 'key', 'cli-revise') });
      break;
    }
    case 'roll': result = ops.executeRoll(store, { ...baseInput(a), skill: Number(str(a, 'skill', '2')), difficulty: Number(str(a, 'difficulty', '2')), idempotencyKey: str(a, 'key', 'cli-roll') }); break;
    case 'consolidate': result = ops.consolidate(store, { ...baseInput(a), idempotencyKey: str(a, 'key', 'cli-consolidate') }); break;
    case 'checkpoint': result = ops.checkpoint(store, { campaignId: str(a, 'campaign', 'demo'), worldlineId: str(a, 'worldline', 'wl-main'), label: str(a, 'label', 'manual'), id: a.id ? str(a, 'id') : undefined }); break;
    case 'restore': result = ops.restore(store, { ...baseInput(a), checkpointId: str(a, 'checkpoint'), idempotencyKey: str(a, 'key', 'cli-restore') }); break;
    case 'fork': result = ops.forkWorldline(store, { ...baseInput(a), to: str(a, 'to'), idempotencyKey: str(a, 'key', 'cli-fork') }); break;
    case 'close': result = ops.closeSession(store, { ...baseInput(a), idempotencyKey: str(a, 'key', 'cli-close') }); break;
    case 'export': {
      const bundle = ops.exportBundle(store, { campaignId: str(a, 'campaign', 'demo') });
      if (a.out && typeof a.out === 'string' && bundle.ok) {
        const path = resolve(a.out);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path, JSON.stringify(bundle.data, null, 2));
        result = ok({ out: path, bytes: JSON.stringify(bundle.data).length });
      } else result = bundle;
      break;
    }
    case 'import': result = ops.importBundle(store, { bundle: JSON.parse(readText(resolve(str(a, 'file')))) }); break;
    case 'index': result = indices.buildIndices(store, str(a, 'campaign', 'demo'), { pageThreshold: a.threshold ? Number(str(a, 'threshold')) : undefined }); break;
    case 'index-status': result = indices.indexFresh(store, str(a, 'campaign', 'demo')); break;
    case 'entity': result = indices.lookupEntity(store, {
      campaignId: str(a, 'campaign', 'demo'), worldlineId: str(a, 'worldline', 'wl-main'),
      viewer: str(a, 'viewer', 'person.player'), id: a.id ? str(a, 'id') : undefined,
      name: a.name ? str(a, 'name') : undefined, alias: a.alias ? str(a, 'alias') : undefined,
      maxPages: a.pages ? Number(str(a, 'pages')) : undefined
    }); break;
    case 'recent': result = indices.recentIndex(store, str(a, 'campaign', 'demo'), str(a, 'worldline', 'wl-main'), str(a, 'viewer', 'person.player')); break;
    case 'unresolved': result = indices.unresolvedIndex(store, str(a, 'campaign', 'demo'), str(a, 'worldline', 'wl-main'), str(a, 'viewer', 'person.player')); break;
    case 'commitments': result = indices.commitmentsIndex(store, str(a, 'campaign', 'demo'), str(a, 'worldline', 'wl-main'), str(a, 'viewer', 'person.player')); break;
    default: result = fail('unknown_command', `未知命令: ${cmd}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (cmd === 'verify' && !(result as any).ok) process.exitCode = 1;
  if ((result as any)?.ok === false) process.exitCode = 1;
}

main().catch(err => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
