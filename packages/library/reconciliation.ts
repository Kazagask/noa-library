import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readJson, readText, parseYaml, writeJsonAtomic, sha256, isObject, ok, fail, type Result } from '../core/util.ts';
import type { SnapshotRepo } from './store.ts';

export interface AuthorityStatus {
  source: string; sitesCampaignId: string; vaultCampaignId: string; worldlineId: string;
  stateRevision: number; memoryRevision: number; observedAt: string; contentHash?: string;
}
export interface CampaignMapping {
  sitesId: string; vaultId: string; worldlineId: string; note?: string;
}

function configPath(repo: SnapshotRepo): string { return join(repo.root, 'config', 'campaign-map.yaml'); }

let liveAuthority: AuthorityStatus | null = null;

/** 配置文件只保存 ID 映射；版本必须来自实时权威源。 */
export function loadAuthority(repo: SnapshotRepo): Result<{ mappings: CampaignMapping[]; authority: AuthorityStatus | null }> {
  if (!existsSync(configPath(repo))) return ok({ mappings: [], authority: null });
  const config = parseYaml(readText(configPath(repo)));
  const mappings: CampaignMapping[] = (config.campaigns ?? []).map((c: any) => ({
    sitesId: String(c.sitesId), vaultId: String(c.vaultId), worldlineId: String(c.worldlineId ?? 'wl-main'), note: c.note
  }));
  return ok({ mappings, authority: liveAuthority });
}

/** 由实时查询或可信注入设置；旧静态观察值不得作为覆盖依据。 */
export function setLiveAuthority(status: AuthorityStatus | null): void { liveAuthority = status; }

/** 导入前调用；无法确认在线版本时 fail-closed。 */
export async function refreshAuthority(repo: SnapshotRepo): Promise<Result> {
  const url = process.env.NOA_AUTHORITY_URL;
  if (!url) { setLiveAuthority(null); return fail('authority_unavailable', '未配置 NOA_AUTHORITY_URL，拒绝导入映射存档'); }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(process.env.NOA_AUTHORITY_TOKEN ? { Authorization: `Bearer ${process.env.NOA_AUTHORITY_TOKEN}` } : {})
      }
    });
    if (!res.ok) { setLiveAuthority(null); return fail('authority_unavailable', `权威源返回 ${res.status}`); }
    const d: any = await res.json();
    if (!Number.isFinite(Number(d.stateRevision)) || !Number.isFinite(Number(d.memoryRevision))) {
      setLiveAuthority(null);
      return fail('authority_invalid', '权威源响应缺少有效修订号');
    }
    const status: AuthorityStatus = {
      source: String(d.source ?? 'sites'), sitesCampaignId: String(d.campaignId ?? d.sitesCampaignId ?? ''),
      vaultCampaignId: String(d.vaultCampaignId ?? ''), worldlineId: String(d.worldlineId ?? 'wl-main'),
      stateRevision: Number(d.stateRevision), memoryRevision: Number(d.memoryRevision),
      observedAt: String(d.observedAt ?? new Date().toISOString()), contentHash: d.contentHash ? String(d.contentHash) : undefined
    };
    setLiveAuthority(status);
    return ok(status);
  } catch (err) {
    setLiveAuthority(null);
    return fail('authority_unavailable', `权威源不可达: ${String(err?.message ?? err)}`);
  }
}

/** 任何旧迁移包或备份都必须先通过这里，不能覆盖在线新存档。 */
export function assertNotStale(repo: SnapshotRepo, input: { campaignId: string; stateRevision: number; memoryRevision: number }): Result {
  const cfg = loadAuthority(repo);
  if (!cfg.ok) return cfg;
  const { mappings, authority } = cfg.data;
  if (!authority) {
    const mapped = mappings.some(m => m.vaultId === input.campaignId);
    return mapped ? fail('authority_unavailable', '映射存档缺少实时权威状态，fail-closed') : ok({ guarded: false, reason: 'no-authority-config' });
  }
  const mapped = mappings.find(m => m.vaultId === input.campaignId);
  if (!mapped || mapped.sitesId !== authority.sitesCampaignId) return ok({ guarded: false, reason: 'not-mapped' });
  const stateStale = input.stateRevision < authority.stateRevision;
  const memoryStale = input.memoryRevision < authority.memoryRevision;
  if (stateStale || memoryStale) {
    return fail('authority_stale', '入站修订号落后于在线权威源，拒绝覆盖', {
      incoming: { stateRevision: input.stateRevision, memoryRevision: input.memoryRevision },
      authority: { stateRevision: authority.stateRevision, memoryRevision: authority.memoryRevision }
    });
  }
  return ok({ guarded: true, authority });
}

function deepMerge(target: any, patch: any): any {
  if (Array.isArray(patch)) return patch.slice();
  if (!isObject(patch)) return patch;
  const result: any = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) result[k] = isObject(v) || Array.isArray(v) ? deepMerge(result[k], v) : v;
  return result;
}

/** 按父链和事件 ID 幂等合并增量；只产出提案，不修改正式 state/memory。 */
export function reconcileDeltas(repo: SnapshotRepo, input: { campaignId: string; deltaDir: string; apply?: boolean; at?: string }): Result {
  const cfg = loadAuthority(repo);
  if (!cfg.ok) return cfg;
  const dir = join(repo.root, input.deltaDir);
  if (!existsSync(dir)) return fail('delta_dir_missing', `增量目录不存在: ${input.deltaDir}`);
  const deltas = readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => readJson(join(dir, f)));
  if (!deltas.length) return fail('no_deltas', '没有可合并的增量');
  const byId = new Map(deltas.map(d => [String(d.id), d]));
  const roots = deltas.filter(d => !d.parent?.id || !byId.has(String(d.parent.id)));
  if (roots.length !== 1) return fail('ambiguous_parent', '无法唯一确定增量链根', { roots: roots.map(d => d.id) });
  const chain: any[] = [];
  let cursor = roots[0];
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor.id)) return fail('cyclic_parent', '增量父链成环', { id: cursor.id });
    visited.add(cursor.id);
    chain.push(cursor);
    const child = deltas.find(d => String(d.parent?.id ?? '') === String(cursor.id));
    cursor = child;
  }
  if (visited.size !== deltas.length) return fail('broken_parent_chain', '存在无法串入父链的增量', { chained: visited.size, total: deltas.length });

  const snap = repo.read(input.campaignId, 'wl-main');
  const seen = new Set<string>();
  const applied: string[] = [];
  const skipped: string[] = [];
  const proposal = structuredClone(snap.state);
  let episodeCount = 0, relationCount = 0;
  for (const delta of chain) {
    const eventId = String(delta.event?.id ?? delta.id);
    if (seen.has(eventId)) { skipped.push(eventId); continue; }
    seen.add(eventId);
    proposal.extension = deepMerge(proposal.extension ?? {}, { world: delta.state_delta ?? {} });
    episodeCount += Array.isArray(delta.episodes) ? delta.episodes.length : 0;
    relationCount += Array.isArray(delta.knowledge_graph?.relations) ? delta.knowledge_graph.relations.length : 0;
    applied.push(eventId);
  }
  const authorityCheck = assertNotStale(repo, { campaignId: input.campaignId, stateRevision: snap.state.revision, memoryRevision: snap.working.memoryRevision ?? 0 });
  const report = {
    schemaVersion: 1, generatedAt: input.at ?? new Date().toISOString(),
    campaignId: input.campaignId, deltaCount: chain.length, applied, skipped,
    proposal: {
      episodes: episodeCount, relations: relationCount,
      cash_g: proposal.extension?.world?.economy?.cash_g ?? null,
      sourceStateRevision: snap.state.revision
    },
    authorityCheck: authorityCheck.ok ? authorityCheck.data : { code: authorityCheck.code, details: authorityCheck.details },
    behindAuthority: !authorityCheck.ok,
    note: '提案不写回正式 state/memory；在线权威源修订号更高时必须人工对账。'
  };
  if (input.apply) {
    const out = join(repo.root, 'campaigns', input.campaignId, 'reconciliation');
    writeJsonAtomic(join(out, 'report.json'), report);
    writeJsonAtomic(join(out, 'idempotency.json'), { keys: [...seen], hash: sha256([...seen]) });
  }
  return ok(report);
}
