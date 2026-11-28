/** Local NOA host: real Worker entry + local D1-compatible SQLite. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openLocalDb, type LocalD1 } from './d1-sqlite.ts';
import worker from '../../apps/sites/src/worker.js';
import { promoteVault } from '../../apps/sites/src/storage-v2.js';
import { promoteV3AndActivate, hasV3 } from '../../apps/sites/src/storage-v3.js';

export const LOCAL_OWNER = process.env.NOA_LOCAL_OWNER ?? 'local-owner';
export const LOCAL_TOKEN = process.env.NOA_LOCAL_TOKEN ?? 'local-dev-token';
const ROOT = resolve(import.meta.dirname, '../..');
const SITES = join(ROOT, 'apps/sites');

export interface LocalHost {
  db: LocalD1;
  owner: string;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  rpc(message: Record<string, unknown>): Promise<any>;
  close(): void;
}

export function seedDocument() {
  const seed = JSON.parse(readFileSync(join(SITES, 'src/seed.json'), 'utf8'));
  const snapshot = structuredClone(seed.snapshot);
  return {
    format: 'noa-sites-v2',
    active: { campaignId: snapshot.manifest.id, worldlineId: snapshot.manifest.worldlineId ?? 'wl-main' },
    persona: seed.persona ?? null,
    campaigns: { [snapshot.manifest.id]: { manifest: snapshot.manifest, lines: { [snapshot.manifest.worldlineId ?? 'wl-main']: snapshot } } },
    campaignPersonas: {},
    receipts: {},
    events: seed.events ?? [],
    checkpoints: {},
    operations: {}
  };
}

export async function openLocalHost(input: { dbPath?: string; owner?: string; seed?: boolean } = {}): Promise<LocalHost> {
  const dbPath = resolve(input.dbPath ?? process.env.NOA_DB_PATH ?? join(ROOT, 'deploy/data/local.sqlite'));
  const db = openLocalDb(dbPath, SITES);
  const owner = input.owner ?? LOCAL_OWNER;
  if ((input.seed ?? process.env.NOA_LOCAL_SEED !== '0') && !(await hasV3(db as any, owner))) {
    const document = seedDocument();
    await promoteVault(db as any, owner, { dryRun: false }, null, document);
    await promoteV3AndActivate(db as any, owner, document, { sourceVersion: 'local-seed', frozen: false });
  }
  const env = { DB: db, NOA_REPAIR_OWNER: owner, NOA_ALLOW_LEGACY_GOVERNANCE: '0' };
  const rpc = async (message: Record<string, unknown>) => {
    const req = new Request('http://local/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': owner }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) });
    const response = await worker.fetch(req, env as any, {} as any);
    if (response.status === 202) return null;
    return response.json();
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const json: any = await rpc({ method: 'tools/call', params: { name, arguments: args } });
    if (json.error) return { ok: false, code: 'jsonrpc_error', message: json.error.message };
    return JSON.parse(json.result.content[0].text);
  };
  return { db, owner, call, rpc, close: () => db.close() };
}
