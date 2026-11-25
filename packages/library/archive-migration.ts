import { join } from 'node:path';
import {
  readJson, readText, writeJsonAtomic, writeJsonl, appendJsonl,
  parseYaml, stableStringify, sha256, newId, isObject, ok, fail, type Result
} from '../core/util.ts';
import { validateSchema } from '../core/util.ts';
import type { CampaignManifest } from './domain.ts';
import type { SnapshotRepo } from './store.ts';

export type MigrationMode = 'dry-run' | 'validate' | 'apply' | 'verify';
export interface ArchiveMigrationOptions {
  campaignArchivePath: string;
  personaArchivePath?: string;
  originalArchivePath?: string;
  campaignId: string;
  mode: MigrationMode;
  at?: string;
  authorityEpoch?: number;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported';
}
function hash(value: unknown): string { return sha256(value); }
function asString(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }

function protectedParts(campaign: any, persona: any, original: any) {
  return {
    infiniteEvolution: campaign?.character?.hexes?.infinite_evolution ?? null,
    skillPoints: campaign?.character?.hexes?.skill_points ?? null,
    trainingLedger: campaign?.cultivation?.pending_realm_training_ledger ?? null,
    rewardFlags: persona?.reward_flags ?? campaign?.noa?.reward_flags ?? null,
    unresolved: campaign?.unresolved ?? original?.unresolved ?? null,
    evidence: campaign?.meta?.evidence ?? original?.meta?.evidence ?? null,
    worldAuthorization: persona?.world_access ?? campaign?.noa?.world_access ?? null
  };
}

function entityId(name: string): string { return `person-${sha256(name).slice(0, 12)}`; }

function buildRelations(campaign: any, characterId: string, protectedHashes: Record<string, string>, at: string): any[] {
  const relations: any[] = [];
  const validFrom = asString(campaign?.meta?.export_date, at);
  const add = (subject: string, predicate: string, object: string, description: string, confidence: number, knownBy: string[], epistemic = 'fact', holder: string | null = null) => {
    relations.push({
      id: newId('rel', `${subject}:${predicate}:${object}:${description}`),
      subject, predicate, object, description, worldlineId: 'wl-main',
      validFrom, validUntil: null, recordedAt: at, scope: 'world', knownBy,
      confidence, sourceEventId: 'migration-archive', epistemic, holder,
      status: 'active', revision: 1, supersedes: null,
      sourceConfidence: confidence, protected: predicate === '保护校验'
    });
  };
  for (const r of campaign?.relationships ?? []) {
    if (!isObject(r)) continue;
    const name = asString((r as any).name || (r as any).target || (r as any).subject);
    if (!name) continue;
    const target = entityId(name);
    const description = typeof (r as any).relationship === 'string' ? (r as any).relationship : stableStringify((r as any).relationship ?? {});
    add(characterId, '人物关系', target, description, (r as any).source ? 0.85 : 0.7, ['*']);
    for (const b of (r as any).bonds ?? []) {
      if (!isObject(b)) continue;
      add(characterId, '羁绊', target, `${asString((b as any).name)}：${asString((b as any).status)}`, 0.8, ['*']);
    }
  }
  for (const c of campaign?.contracts ?? []) {
    if (!isObject(c)) continue;
    const id = asString((c as any).id, newId('contract'));
    add(characterId, '契约', `contract-${sha256(id).slice(0, 12)}`,
      `契约 ${id}：${asString((c as any).current_status)}；条款 ${stableStringify((c as any).historical_terms ?? {})}`, 0.8, ['*']);
  }
  for (const u of campaign?.unresolved ?? []) {
    if (!isObject(u)) continue;
    add(characterId, '待核实', `unresolved-${sha256(asString((u as any).field)).slice(0, 12)}`,
      `${asString((u as any).field)}：${asString((u as any).issue)}`, 0.3, ['gm']);
  }
  add(characterId, '保护校验', `protected-${protectedHashes.infiniteEvolution?.slice(0, 12)}`,
    '无限进化 Lv.2、技能点收支、已结算修炼收益按原样保留，不重复结算。', 1, ['gm']);
  return relations;
}

function buildEpisodes(campaign: any, at: string): any[] {
  const recordedAt = asString(campaign?.meta?.export_date, at);
  const episodes: any[] = [];
  for (const e of campaign?.timeline?.events ?? []) {
    if (!isObject(e)) continue;
    const id = newId('ep', `${asString((e as any).save_id)}:${asString((e as any).title)}`);
    episodes.push({
      id, at: recordedAt, turn: 0,
      title: asString((e as any).title, '历史补录事件'),
      summary: `历史补录（非逐条核验）：${asString((e as any).details).slice(0, 400)}`,
      excerpt: asString((e as any).source).slice(0, 200),
      worldlineId: 'wl-main', entities: [], relationIds: [], knownBy: ['*'],
      sourceEventId: id, path: `${id}.md`, tags: ['archive', 'historical-backfill'],
      confidence: (e as any).source ? 0.7 : 0.5
    });
  }
  return episodes;
}

function buildState(campaign: any, campaignId: string, at: string, protectedHashes: Record<string, string>, sourceHash: string) {
  const sections = ['character', 'cultivation', 'skills', 'inventory', 'research', 'economy', 'properties',
    'relationships', 'contracts', 'chat_group', 'timeline', 'gm_rules', 'unresolved', 'import_prompt', 'noa_ref'];
  const world: Record<string, unknown> = {};
  for (const key of sections) if (key in (campaign ?? {})) world[key] = campaign[key];
  const character = campaign?.character ?? {};
  const record = asString(campaign?.meta?.export_date, at);
  return {
    schemaVersion: 1,
    docId: `state-${campaignId}`,
    worldId: slug(asString(campaign?.meta?.world, 'imported')),
    worldlineId: 'wl-main',
    revision: Number(campaign?.meta?.revision ?? 0) || 0,
    updatedAt: at,
    rng: { algorithm: 'mulberry32', seed: 0, cursor: 0 },
    clock: { turn: 0, date: record.slice(0, 10) || at.slice(0, 10), period: 'day' },
    actors: { [asString(character.id, 'person.player')]: { name: asString(character.name), realm: asString(character.realm?.stage) } },
    inventory: [],
    resources: { hp: character.resources?.hp?.current ?? null, mp: character.resources?.mp?.current ?? null },
    quests: [],
    flags: { imported: true, synthetic: false },
    extension: {
      world,
      rngPolicy: '档案未提供可验证 RNG；seed/cursor=0 是占位，不推定历史随机过程。',
      timePolicy: '不推进游戏时间；历史补录时间不视为逐条核验的游戏时间。',
      sourceHash,
      protectedHashes
    }
  };
}

function buildManifest(campaign: any, campaignId: string): CampaignManifest {
  return {
    manifestVersion: 1, id: campaignId,
    title: `正式迁移存档 ${asString(campaign?.meta?.save_id, campaignId)}`,
    worldId: slug(asString(campaign?.meta?.world, 'imported')),
    worldlineId: 'wl-main', status: 'imported',
    paths: {
      state: 'state/latest.json', events: 'state/events.jsonl',
      entities: 'memory/entities.jsonl', relations: 'memory/relations.jsonl',
      episodesIndex: 'memory/episodes/index.jsonl', episodesDir: 'memory/episodes',
      journals: 'journals', checkpoints: 'checkpoints', working: 'working.json'
    },
    timeIndex: [], consistencyRules: []
  };
}

function validateInputs(campaign: any, persona: any | undefined, original: any | undefined): string[] {
  const errors: string[] = [];
  if (!isObject(campaign)) errors.push('campaign archive 不是对象');
  else {
    if (!campaign.meta?.save_id) errors.push('campaign.meta.save_id 缺失');
    if (!Array.isArray(campaign.timeline?.events)) errors.push('campaign.timeline.events 缺失');
    if (!Array.isArray(campaign.relationships)) errors.push('campaign.relationships 缺失');
    if (!campaign.character?.hexes?.infinite_evolution) errors.push('无限进化记录缺失，拒绝迁移（不得补造）');
    if (!Array.isArray(campaign.character.hexes.skill_points?.historical_transactions)) errors.push('技能点历史收支缺失');
    if (!Array.isArray(campaign.cultivation?.pending_realm_training_ledger)) errors.push('已结算修炼收益流水缺失');
    if (!Array.isArray(campaign.unresolved) || campaign.unresolved.length !== 18) errors.push('18 项待核实问题数量不符');
  }
  if (persona && !persona.id) errors.push('persona.id 缺失');
  if (original && !original.meta?.evidence) errors.push('original archive 证据段缺失');
  return errors;
}

/** 通用正式档案迁移：不写公开仓，不补造数值，不推进时间。 */
export function migrateArchive(repo: SnapshotRepo, opts: ArchiveMigrationOptions): Result {
  if (!['dry-run', 'validate', 'apply', 'verify'].includes(opts.mode)) return fail('invalid_mode', 'mode 必须是 dry-run|validate|apply|verify');
  const campaign = readJson(opts.campaignArchivePath);
  const persona = opts.personaArchivePath ? readJson(opts.personaArchivePath) : undefined;
  const original = opts.originalArchivePath ? readJson(opts.originalArchivePath) : undefined;
  const errors = validateInputs(campaign, persona, original);
  if (errors.length) return fail('validation_failed', '正式档案校验失败', { errors });

  const at = opts.at ?? new Date().toISOString();
  const protectedSource = protectedParts(campaign, persona, original);
  const protectedHashes = Object.fromEntries(Object.entries(protectedSource).map(([k, v]) => [k, hash(v)]));
  const sourceHash = hash({ campaign, persona, original });
  const characterId = asString(campaign.character?.id, 'person.player');
  const entities = [
    { id: characterId, type: 'person', name: asString(campaign.character?.name, '玩家'), aliases: [], worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], attributes: { realm: campaign.character?.realm?.stage ?? null }, createdAt: at, updatedAt: at },
    ...[...new Set((campaign.relationships ?? []).map((r: any) => asString(r?.name || r?.target || r?.subject)).filter(Boolean))].map(name => ({
      id: entityId(name), type: 'person', name, aliases: [], worldlineId: 'wl-main', scope: 'world',
      knownBy: ['*'], attributes: {}, createdAt: at, updatedAt: at
    }))
  ];
  const relations = buildRelations(campaign, characterId, protectedHashes, at);
  const episodes = buildEpisodes(campaign, at);
  const state = buildState(campaign, opts.campaignId, at, protectedHashes, sourceHash);
  const schemaErrors = validateSchema(state, readJson(join(repo.root, 'schemas', 'state.schema.json')));
  if (schemaErrors.length) return fail('validation_failed', '生成的权威状态未通过 Schema', { errors: schemaErrors });

  const report = {
    schemaVersion: 1, mode: opts.mode, campaignId: opts.campaignId, generatedAt: at,
    saveId: asString(campaign.meta?.save_id), sourceHash, protectedHashes,
    counts: {
      entities: entities.length, relations: relations.length, episodes: episodes.length,
      unresolved: (campaign.unresolved ?? []).length, timelineEvents: (campaign.timeline?.events ?? []).length,
      skills: (campaign.skills ?? []).length, contracts: (campaign.contracts ?? []).length
    },
    evidence: campaign.meta?.evidence ?? original?.meta?.evidence ?? null,
    unresolved: campaign.unresolved ?? [],
    worldAuthorizationScope: 'campaign-only',
    notes: [
      '历史补录不是逐条核验的原始日志；未知值不自动填充。',
      '无限进化 Lv.2、技能点收支、已结算修炼收益仅按原样保留并校验哈希，不重新计算。',
      '世界专属入境授权不写入人格命名空间。',
      '档案未提供可验证 RNG，不虚构历史随机过程。'
    ]
  };

  if (opts.mode === 'validate') return ok({ ...report, valid: true, applied: false });
  if (opts.mode === 'dry-run') return ok({ ...report, dryRun: true, applied: false, sample: { state: { docId: state.docId, revision: state.revision }, relationCount: relations.length } });

  const dir = join(repo.root, 'campaigns', opts.campaignId);
  if (opts.mode === 'verify') {
    const targetState = readJson(join(dir, 'state', 'latest.json'));
    const targetReport = readJson(join(dir, 'migration', 'report.json'));
    const mismatches = Object.entries(protectedHashes).filter(([k, v]) => targetReport.protectedHashes?.[k] !== v).map(([k]) => k);
    const stateOk = targetState.extension?.sourceHash === sourceHash && targetState.extension?.protectedHashes?.infiniteEvolution === protectedHashes.infiniteEvolution;
    if (mismatches.length || !stateOk) return fail('verify_failed', '迁移校验不一致', { mismatches, stateOk });
    return ok({ verified: true, campaignId: opts.campaignId, protectedHashes, sourceHash });
  }

  const manifest = buildManifest(campaign, opts.campaignId);
  const working = { workingVersion: 1, sessionId: `sess-${opts.campaignId}`, campaignId: opts.campaignId, worldlineId: 'wl-main', scene: '', recentTurns: [], pendingTasks: [], durable: false, memoryRevision: 0 };
  repo.writeManifest(opts.campaignId, manifest);
  repo.write(opts.campaignId, 'wl-main', { manifest, state, entities: entities as any, relations, episodes, working });
  const migrationDir = join(dir, 'migration');
  writeJsonAtomic(join(migrationDir, 'report.json'), { ...report, applied: true });
  writeJsonAtomic(join(migrationDir, 'evidence.json'), report.evidence);
  writeJsonAtomic(join(migrationDir, 'unresolved.json'), report.unresolved);
  writeJsonAtomic(join(migrationDir, 'world-access.json'), protectedSource.worldAuthorization);
  writeJsonAtomic(join(migrationDir, 'original-campaign.json'), campaign);
  appendJsonl(join(dir, 'state', 'events.jsonl'), { id: newId('evt'), worldlineId: 'wl-main', revision: state.revision, at, actor: 'system', op: 'archive.migrate', idempotencyKey: sourceHash.slice(0, 16), sourceHash });

  if (persona) {
    const personaDir = join(repo.root, 'personas', 'noa');
    writeJsonAtomic(join(personaDir, 'archive-profile.json'), persona);
    const personaEntities = [{ id: 'person.noa', type: 'person', name: asString(persona.name, '诺娅'), aliases: persona.english_name ? [persona.english_name] : [], worldlineId: 'wl-noa-persistent', scope: 'noa/persona-relationship', knownBy: ['*'], attributes: { identity: persona.identity, grade: persona.grade, layer: persona.layer, realm: persona.realm, groupRole: persona.group_role, source: persona.source }, createdAt: at, updatedAt: at }];
    const personaRelations = (persona.bonds ?? []).map((b: any) => ({
      id: newId('rel', `persona:${asString(b.name)}`), subject: 'person.noa', predicate: '羁绊', object: `person.player`,
      description: `${asString(b.name)}｜${asString(b.grade)}｜${asString(b.status)}｜${asString(b.description)}`,
      worldlineId: 'wl-noa-persistent', validFrom: at, validUntil: null, recordedAt: at,
      scope: 'noa/persona-relationship', knownBy: ['person.noa', 'person.player'], confidence: 0.9,
      sourceEventId: asString(b.source_save_id, 'migration-persona'), epistemic: 'fact', holder: null,
      status: 'active', revision: 1, supersedes: null
    }));
    const personaEpisodes = (persona.bonds ?? []).filter((b: any) => /重逢|reunion/i.test(asString(b.name))).map((b: any) => ({
      id: newId('ep', `persona:${asString(b.name)}`), at, turn: 0, title: asString(b.name),
      summary: `人格档案迁移：${asString(b.name)}（${asString(b.grade)}）`, worldlineId: 'wl-noa-persistent',
      entities: ['person.noa', 'person.player'], relationIds: [], knownBy: ['person.noa', 'person.player'],
      path: '', tags: ['persona', 'archive'], confidence: 0.9, source: 'persona archive'
    }));
    writeJsonl(join(personaDir, 'memory', 'entities.jsonl'), personaEntities);
    writeJsonl(join(personaDir, 'memory', 'relations.jsonl'), personaRelations);
    writeJsonl(join(personaDir, 'memory', 'episodes.jsonl'), personaEpisodes);
    const personaManifestPath = join(personaDir, 'manifest.yaml');
    const pm = parseYaml(readText(personaManifestPath));
    pm.version = Number(pm.version ?? 1) + 1;
    pm.updatedAt = at;
    pm.parts = { ...(pm.parts ?? {}), archive: 'archive-profile.json' };
    pm.status = '正式档案已迁入；待核实项保留';
    writeJsonAtomic(personaManifestPath, pm);
  }
  return ok({ ...report, applied: true, path: `campaigns/${opts.campaignId}` });
}

/** Sites 兼容的 v2 bundle：只含引用与哈希，不嵌入 Base64。 */
export function buildSitesBundle(repo: SnapshotRepo, campaignId: string, opts: { authorityEpoch?: number; checkpointId?: string | null; assetRefs?: string[] } = {}): Result {
  const snap = repo.read(campaignId, 'wl-main');
  const reportPath = join(repo.root, 'campaigns', campaignId, 'migration', 'report.json');
  const report = readJson(reportPath);
  const core = {
    campaignId, worldlineId: 'wl-main', stateRevision: snap.state.revision,
    memoryRevision: snap.working.memoryRevision ?? 0, schemaVersion: snap.state.schemaVersion,
    checkpointId: opts.checkpointId ?? null, parentHash: report.sourceHash ?? null,
    authorityEpoch: opts.authorityEpoch ?? 1,
    assetRefs: opts.assetRefs ?? []
  };
  const bundle = {
    format: 'noa-bundle', version: 2, generatedAt: new Date().toISOString(),
    ...core, contentHash: '', manifest: snap.manifest, state: snap.state,
    entities: snap.entities, relations: snap.relations, episodes: snap.episodes,
    persona: { namespace: 'noa/persona-relationship', ref: 'personas/noa/manifest.yaml', hash: hash(readText(join(repo.root, 'personas', 'noa', 'manifest.yaml'))) },
    migration: { report, evidenceRef: `campaigns/${campaignId}/migration/evidence.json`, unresolvedRef: `campaigns/${campaignId}/migration/unresolved.json` }
  };
  bundle.contentHash = hash({ ...core, state: bundle.state, entities: bundle.entities, relations: bundle.relations, episodes: bundle.episodes });
  return ok(bundle);
}
