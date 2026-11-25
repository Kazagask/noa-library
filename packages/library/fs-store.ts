import { join, basename } from 'node:path';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import {
  readJson, readJsonl, readText, writeJsonAtomic, writeJsonl, appendJsonl,
  ensureDir, parseYaml, type Result
} from '../core/util.ts';
import type { CampaignManifest, Entity, Episode, Relation } from './domain.ts';
import type { Checkpoint, Snapshot, SnapshotRepo } from './store.ts';

/** P0：GitHub 文件仓库实现。base 世界线用 JSON/JSONL 分片，分叉世界线用单文件快照。 */
export class FsStore implements SnapshotRepo {
  readonly root: string;
  constructor(root: string = process.cwd()) { this.root = root; }

  private dir(campaignId: string): string { return join(this.root, 'campaigns', campaignId); }
  private manifestPath(campaignId: string): string { return join(this.dir(campaignId), 'manifest.yaml'); }

  private manifest(campaignId: string): CampaignManifest {
    const path = this.manifestPath(campaignId);
    if (!existsSync(path)) throw new Error(`campaign ${campaignId} 不存在：缺少 ${path}`);
    return parseYaml(readText(path)) as CampaignManifest;
  }

  private isBase(worldlineId: string, manifest: CampaignManifest): boolean {
    return worldlineId === manifest.worldlineId;
  }

  private worldlinePath(campaignId: string, worldlineId: string): string {
    return join(this.dir(campaignId), 'worldlines', `${worldlineId}.json`);
  }

  private eventPath(campaignId: string, worldlineId: string, manifest: CampaignManifest): string {
    const base = join(this.dir(campaignId), manifest.paths.events);
    return this.isBase(worldlineId, manifest)
      ? base
      : join(this.dir(campaignId), 'state', `events.${worldlineId}.jsonl`);
  }

  private idemPath(): string { return join(this.root, '.state', 'idempotency.json'); }
  private checkpointDir(campaignId: string): string { return join(this.dir(campaignId), 'checkpoints'); }

  read(campaignId: string, worldlineId: string): Snapshot {
    const manifest = this.manifest(campaignId);
    if (!this.isBase(worldlineId, manifest)) {
      const path = this.worldlinePath(campaignId, worldlineId);
      if (!existsSync(path)) throw new Error(`世界线 ${worldlineId} 不存在`);
      const data = readJson(path);
      return { manifest, state: data.state, entities: data.entities, relations: data.relations, episodes: data.episodes, working: data.working };
    }
    const d = this.dir(campaignId);
    return {
      manifest,
      state: readJson(join(d, manifest.paths.state)),
      entities: readJsonl<Entity>(join(d, manifest.paths.entities)),
      relations: readJsonl<Relation>(join(d, manifest.paths.relations)),
      episodes: readJsonl<Episode>(join(d, manifest.paths.episodesIndex)),
      working: readJson(join(d, manifest.paths.working))
    };
  }

  write(campaignId: string, worldlineId: string, snapshot: Snapshot): void {
    const manifest = this.manifest(campaignId);
    const d = this.dir(campaignId);
    ensureDir(d);
    if (this.isBase(worldlineId, manifest)) {
      writeJsonAtomic(join(d, manifest.paths.state), snapshot.state);
      writeJsonl(join(d, manifest.paths.entities), snapshot.entities);
      writeJsonl(join(d, manifest.paths.relations), snapshot.relations);
      writeJsonl(join(d, manifest.paths.episodesIndex), snapshot.episodes);
      writeJsonAtomic(join(d, manifest.paths.working), snapshot.working);
    } else {
      writeJsonAtomic(this.worldlinePath(campaignId, worldlineId), {
        state: snapshot.state, entities: snapshot.entities, relations: snapshot.relations,
        episodes: snapshot.episodes, working: snapshot.working,
        worldlineId, forkedFrom: manifest.worldlineId
      });
    }
  }

  writeManifest(campaignId: string, manifest: CampaignManifest): void {
    writeJsonAtomic(this.manifestPath(campaignId), manifest);
  }

  appendEvent(campaignId: string, event: Record<string, unknown>): void {
    const manifest = this.manifest(campaignId);
    appendJsonl(this.eventPath(campaignId, String(event.worldlineId), manifest), event);
  }

  events(campaignId: string, worldlineId: string): Record<string, unknown>[] {
    const manifest = this.manifest(campaignId);
    return readJsonl(this.eventPath(campaignId, worldlineId, manifest));
  }

  getOperation(key: string): Record<string, unknown> | null {
    const path = this.idemPath();
    if (!existsSync(path)) return null;
    return (readJson(path) as Record<string, Record<string, unknown>>)[key] ?? null;
  }

  putOperation(key: string, result: Record<string, unknown>): void {
    const path = this.idemPath();
    const all = existsSync(path) ? readJson(path) as Record<string, unknown> : {};
    all[key] = result;
    writeJsonAtomic(path, all);
  }

  saveCheckpoint(campaignId: string, checkpoint: Checkpoint): void {
    ensureDir(this.checkpointDir(campaignId));
    writeJsonAtomic(join(this.checkpointDir(campaignId), `${checkpoint.id}.json`), checkpoint);
  }

  loadCheckpoint(campaignId: string, checkpointId: string): Checkpoint | null {
    const path = join(this.checkpointDir(campaignId), `${checkpointId}.json`);
    return existsSync(path) ? readJson(path) as Checkpoint : null;
  }

  listCheckpoints(campaignId: string): Checkpoint[] {
    const dir = this.checkpointDir(campaignId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readJson(join(dir, f)) as Checkpoint);
  }

  listCampaigns(): { id: string; worldlineId: string; title: string }[] {
    const dir = join(this.root, 'campaigns');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name, 'manifest.yaml');
      if (!existsSync(path)) return [];
      const m = parseYaml(readText(path)) as CampaignManifest;
      return [{ id: m.id, worldlineId: m.worldlineId, title: m.title }];
    });
  }

  listWorldlines(campaignId: string): string[] {
    const manifest = this.manifest(campaignId);
    const dir = join(this.dir(campaignId), 'worldlines');
    const forks = existsSync(dir)
      ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => basename(f, '.json'))
      : [];
    return [manifest.worldlineId, ...forks.filter(w => w !== manifest.worldlineId)];
  }

  createWorldline(campaignId: string, from: string, to: string, snapshot: Snapshot): void {
    void from;
    writeJsonAtomic(this.worldlinePath(campaignId, to), {
      state: snapshot.state, entities: snapshot.entities, relations: snapshot.relations,
      episodes: snapshot.episodes, working: snapshot.working, worldlineId: to
    });
  }
}
