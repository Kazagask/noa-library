import { join, dirname, extname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, readJsonl, writeJsonAtomic, writeJsonl, appendJsonl, newId, ok, fail, type Result } from '../core/util.ts';

export interface AssetRecord {
  assetId: string; sha256: string; mediaType: string; kind: 'original' | 'derivative' | 'thumbnail' | 'other';
  filename: string; bytes: number; source: string; campaignId?: string; personaId?: string;
  storage: { adapter: string; key: string }; access: 'private'; integrity: { verifiedAt: string; matchesDeclared: boolean };
  links: { nodeId: string; predicate: string; knownBy: string[]; note?: string }[];
  tags: string[]; createdAt: string; version: number; status: 'active' | 'superseded';
}
export interface AssetAdapter {
  name: string;
  put(sha256: string, bytes: Buffer, extension: string): Promise<{ key: string }>;
  get(key: string): Promise<Buffer>;
  resolve(key: string): Promise<{ uri: string }>;
  remove(key: string): Promise<void>;
}

export class FsAssetAdapter implements AssetAdapter {
  name = 'filesystem';
  private root: string;
  constructor(root: string) { this.root = root; }
  private path(key: string): string { return join(this.root, 'assets', 'objects', key); }
  async put(sha256: string, bytes: Buffer, extension: string): Promise<{ key: string }> {
    const key = join(sha256.slice(0, 2), `${sha256}${extension}`);
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes);
    return { key: key.replace(/\\/g, '/') };
  }
  async get(key: string): Promise<Buffer> { return readFileSync(this.path(key)); }
  async resolve(key: string): Promise<{ uri: string }> { return { uri: `assets/objects/${key}` }; }
  async remove(key: string): Promise<void> { const p = this.path(key); if (existsSync(p)) unlinkSync(p); }
}

/** GitHub Contents 适配器：仅传输二进制，不在普通工具响应中回传内容。 */
export class GitHubAssetAdapter implements AssetAdapter {
  name = 'github';
  private owner: string; private repo: string; private token: string; private branch: string;
  constructor(owner: string, repo: string, token: string, branch = 'main') { this.owner = owner; this.repo = repo; this.token = token; this.branch = branch; }
  private api(path: string): string { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`; }
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  async put(sha256: string, bytes: Buffer, extension: string): Promise<{ key: string }> {
    const key = `assets/objects/${sha256.slice(0, 2)}/${sha256}${extension}`;
    const res = await fetch(this.api(key), {
      method: 'PUT', headers: this.headers(),
      body: JSON.stringify({ message: `asset: ${sha256.slice(0, 12)}`, content: bytes.toString('base64'), branch: this.branch })
    });
    if (!res.ok) throw new Error(`GitHub asset put failed: ${res.status}`);
    return { key };
  }
  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.api(key), { headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub asset get failed: ${res.status}`);
    const d: any = await res.json();
    return Buffer.from(d.content, 'base64');
  }
  async resolve(key: string): Promise<{ uri: string }> { return { uri: `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${key}` }; }
  async remove(key: string): Promise<void> {
    const res = await fetch(this.api(key), { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new Error(`GitHub asset remove failed: ${res.status}`);
  }
}

/** 通用对象存储适配器：使用可配置 HTTP 端点，不绑定任何厂商 SDK。 */
export class ObjectStorageAdapter implements AssetAdapter {
  name = 'object-storage';
  private endpoints: { put: string; get: string; resolve: string; remove?: string }; private token: string;
  constructor(endpoints: { put: string; get: string; resolve: string; remove?: string }, token = '') { this.endpoints = endpoints; this.token = token; }
  private headers(): Record<string, string> { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  private url(template: string, key: string, sha256: string): string {
    return template.replace('{key}', encodeURIComponent(key)).replace('{sha256}', sha256);
  }
  async put(sha256: string, bytes: Buffer, extension: string): Promise<{ key: string }> {
    const key = `${sha256.slice(0, 2)}/${sha256}${extension}`;
    const res = await fetch(this.url(this.endpoints.put, key, sha256), { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!res.ok) throw new Error(`object put failed: ${res.status}`);
    return { key };
  }
  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.url(this.endpoints.get, key, ''), { headers: this.headers() });
    if (!res.ok) throw new Error(`object get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async resolve(key: string): Promise<{ uri: string }> { return { uri: this.url(this.endpoints.resolve, key, '') }; }
  async remove(key: string): Promise<void> {
    if (!this.endpoints.remove) throw new Error('remove endpoint 未配置');
    const res = await fetch(this.url(this.endpoints.remove, key, ''), { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new Error(`object remove failed: ${res.status}`);
  }
}

export function makeAdapters(root: string): Record<string, AssetAdapter> {
  const adapters: Record<string, AssetAdapter> = { filesystem: new FsAssetAdapter(root) };
  const owner = process.env.NOA_ASSET_GITHUB_OWNER, repo = process.env.NOA_ASSET_GITHUB_REPO, token = process.env.NOA_ASSET_GITHUB_TOKEN;
  if (owner && repo && token) adapters.github = new GitHubAssetAdapter(owner, repo, token);
  const put = process.env.NOA_ASSET_PUT_URL, get = process.env.NOA_ASSET_GET_URL, resolve = process.env.NOA_ASSET_RESOLVE_URL;
  if (put && get && resolve) adapters['object-storage'] = new ObjectStorageAdapter({ put, get, resolve, remove: process.env.NOA_ASSET_DELETE_URL }, process.env.NOA_ASSET_TOKEN);
  return adapters;
}

export class AssetStore {
  private root: string;
  private indexPath: string;
  private linksPath: string;
  private adapters: Record<string, AssetAdapter>;
  constructor(root: string, adapters?: Record<string, AssetAdapter>) {
    this.root = root;
    this.indexPath = join(root, 'assets', 'index');
    this.linksPath = join(root, 'assets', 'links.jsonl');
    this.adapters = adapters ?? makeAdapters(root);
  }
  private recordPath(assetId: string): string { return join(this.indexPath, `${assetId}.json`); }
  private list(): AssetRecord[] {
    if (!existsSync(this.indexPath)) return [];
    return readdirSync(this.indexPath).filter(f => f.endsWith('.json')).map(f => readJson(join(this.indexPath, f)) as AssetRecord);
  }

  async upload(input: { bytes: Buffer; mediaType: string; filename: string; source: string; kind?: AssetRecord['kind']; declaredSha256?: string; campaignId?: string; personaId?: string; tags?: string[]; adapter?: string }): Promise<Result> {
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    if (input.declaredSha256 && digest !== input.declaredSha256.toLowerCase()) {
      return fail('integrity_mismatch', 'SHA-256 与声明不一致', { computed: digest, declared: input.declaredSha256 });
    }
    const existing = this.list().find(r => r.sha256 === digest && r.status === 'active');
    if (existing) return ok({ assetId: existing.assetId, deduplicated: true, integrity: existing.integrity });
    const adapter = this.adapters[input.adapter ?? 'filesystem'];
    if (!adapter) return fail('adapter_unavailable', `未配置资产适配器 ${input.adapter ?? 'filesystem'}`);
    const extension = extname(input.filename) || '';
    const stored = await adapter.put(digest, input.bytes, extension);
    const record: AssetRecord = {
      assetId: newId('asset', digest), sha256: digest, mediaType: input.mediaType,
      kind: input.kind ?? 'original', filename: input.filename, bytes: input.bytes.length,
      source: input.source, campaignId: input.campaignId, personaId: input.personaId,
      storage: { adapter: adapter.name, key: stored.key }, access: 'private',
      integrity: { verifiedAt: new Date().toISOString(), matchesDeclared: Boolean(input.declaredSha256) },
      links: [], tags: input.tags ?? [], createdAt: new Date().toISOString(), version: 1, status: 'active'
    };
    writeJsonAtomic(this.recordPath(record.assetId), record);
    return ok({ assetId: record.assetId, deduplicated: false, sha256: digest, integrity: record.integrity });
  }

  register(input: Omit<AssetRecord, 'assetId' | 'createdAt' | 'version' | 'status' | 'links'> & { assetId?: string }): Result {
    const record: AssetRecord = {
      ...input, assetId: input.assetId ?? newId('asset', input.sha256),
      links: [], createdAt: new Date().toISOString(), version: 1, status: 'active'
    } as AssetRecord;
    writeJsonAtomic(this.recordPath(record.assetId), record);
    return ok({ assetId: record.assetId });
  }

  retrieve(assetId: string): AssetRecord | null {
    const path = this.recordPath(assetId);
    return existsSync(path) ? readJson(path) as AssetRecord : null;
  }

  async resolve(assetId: string, viewer: string): Promise<Result> {
    const record = this.retrieve(assetId);
    if (!record) return fail('asset_not_found', `资产 ${assetId} 不存在`);
    const visible = record.links.length === 0 || record.links.some(l => l.knownBy.includes('*') || l.knownBy.includes(viewer));
    if (!visible) return fail('forbidden', '查看者无权解析该资产');
    const adapter = this.adapters[record.storage.adapter];
    if (!adapter) return fail('adapter_unavailable', `适配器 ${record.storage.adapter} 未配置`);
    const resolved = await adapter.resolve(record.storage.key);
    return ok({ assetId, uri: resolved.uri, mediaType: record.mediaType, sha256: record.sha256, note: '仅返回地址/键，不返回 Base64 内容' });
  }

  search(input: { query?: string; nodeId?: string; type?: string; tags?: string[]; limit?: number }): Result {
    const q = (input.query ?? '').toLowerCase();
    const hits = this.list().filter(r => {
      if (input.type && r.mediaType !== input.type && r.kind !== input.type) return false;
      if (input.tags?.length && !input.tags.every(t => r.tags.includes(t))) return false;
      if (input.nodeId && !r.links.some(l => l.nodeId === input.nodeId)) return false;
      return !q || [r.filename, r.source, r.sha256, ...r.tags, ...r.links.map(l => l.nodeId)].join(' ').toLowerCase().includes(q);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok({ assets: hits.slice(0, input.limit ?? 20).map(r => ({ ...r, links: r.links.length })), total: hits.length });
  }

  link(assetId: string, nodeId: string, predicate: string, knownBy: string[], note?: string): Result {
    const record = this.retrieve(assetId);
    if (!record) return fail('asset_not_found', `资产 ${assetId} 不存在`);
    if (record.links.some(l => l.nodeId === nodeId && l.predicate === predicate)) return ok({ assetId, deduplicated: true });
    record.links.push({ nodeId, predicate, knownBy, note });
    record.version += 1;
    writeJsonAtomic(this.recordPath(assetId), record);
    appendJsonl(this.linksPath, { at: new Date().toISOString(), assetId, nodeId, predicate, knownBy });
    return ok({ assetId, nodeId, deduplicated: false, version: record.version });
  }

  revise(assetId: string, patch: Partial<AssetRecord>): Result {
    const record = this.retrieve(assetId);
    if (!record) return fail('asset_not_found', `资产 ${assetId} 不存在`);
    const allowed = ['filename', 'tags', 'kind', 'source', 'links'];
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) return fail('invalid_patch', `不允许修改 ${key}`);
    Object.assign(record, patch, { version: record.version + 1 });
    writeJsonAtomic(this.recordPath(assetId), record);
    return ok({ assetId, version: record.version });
  }

  async gc(input: { dryRun?: boolean; referencedNodeIds?: string[] } = {}): Promise<Result> {
    const rows = this.list();
    const referenced = new Set(input.referencedNodeIds ?? []);
    for (const campaign of existsSync(join(this.root, 'campaigns')) ? readdirSync(join(this.root, 'campaigns')) : []) {
      const dir = join(this.root, 'campaigns', campaign);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of ['memory/entities.jsonl', 'memory/relations.jsonl', 'memory/episodes/index.jsonl']) {
        for (const row of readJsonl(join(dir, file))) {
          const text = JSON.stringify(row);
          for (const r of rows) if (text.includes(r.assetId) || text.includes(r.sha256)) referenced.add(r.assetId);
        }
      }
    }
    const orphaned = rows.filter(r => !referenced.has(r.assetId) && r.links.length === 0);
    if (input.dryRun !== false) return ok({ dryRun: true, orphaned: orphaned.map(r => r.assetId), total: rows.length });
    const removed: string[] = [];
    for (const r of orphaned) {
      const adapter = this.adapters[r.storage.adapter];
      if (adapter) await adapter.remove(r.storage.key).catch(() => undefined);
      const path = this.recordPath(r.assetId);
      if (existsSync(path)) unlinkSync(path);
      removed.push(r.assetId);
    }
    return ok({ dryRun: false, removed, total: rows.length });
  }
}
