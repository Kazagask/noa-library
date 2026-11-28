#!/usr/bin/env node
/**
 * Sites 真实隔离 D1 复测（V2.2.3）。
 * 强制显式 QA scope 与隔离确认，不含默认 Campaign，不读取正式凭据、不写生产。
 *
 * 必填 env：
 *   NOA_QA_MCP_URL
 *   NOA_QA_OWNER
 *   NOA_QA_CAMPAIGN
 *   NOA_QA_WORLDLINE
 *   NOA_QA_ISOLATION_TOKEN   由 Sites 提供的隔离 QA 确认令牌（例如 QA-ISOLATED-...）
 */
import { createHash } from 'node:crypto';

const url = process.env.NOA_QA_MCP_URL;
const owner = process.env.NOA_QA_OWNER;
const campaignId = process.env.NOA_QA_CAMPAIGN;
const worldlineId = process.env.NOA_QA_WORLDLINE;
const isolationToken = process.env.NOA_QA_ISOLATION_TOKEN;
const header = process.env.NOA_QA_HEADER ?? 'oai-authenticated-user-id';
if (!url || !owner || !campaignId || !worldlineId || !isolationToken) {
  console.error('拒绝执行：必须显式提供 NOA_QA_MCP_URL / NOA_QA_OWNER / NOA_QA_CAMPAIGN / NOA_QA_WORLDLINE / NOA_QA_ISOLATION_TOKEN；没有默认 Campaign。');
  process.exit(2);
}
if (!/^QA[-_A-Za-z0-9]*$/i.test(campaignId) && process.env.NOA_QA_ALLOW_NON_QA_CAMPAIGN !== 'YES') {
  console.error('拒绝写入：NOA_QA_CAMPAIGN 不像隔离 QA（需 QA 前缀；如确为隔离库请设置 NOA_QA_ALLOW_NON_QA_CAMPAIGN=YES）。');
  process.exit(2);
}
let id = 0;
const call = async (name, args = {}, method = 'tools/call') => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [header]: owner }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: method === 'tools/call' ? { name, arguments: args } : {} }) });
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
  return json.result?.content ? JSON.parse(json.result.content[0].text) : json;
};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const stable = value => { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === 'object') { const out = {}; for (const k of Object.keys(value).sort()) out[k] = stable(value[k]); return out; } return value; };
const checks = [];
const check = (name, ok, detail = {}) => { checks.push({ ...detail, name, ok }); if (!ok) console.error(`FAIL ${name}`, detail); };
const stamp = Date.now();

try {
  // 先确认目标环境与目标 scope 存在；不把默认活动存档当作 QA。
  const statsBefore = await call('vault_stats');
  const campaigns = await call('campaign_list');
  const target = (campaigns.data?.campaigns ?? []).find(c => c.id === campaignId);
  check('QA target campaign exists', Boolean(target), { campaignId, campaigns: campaigns.data?.campaigns });
  check('QA target worldline exists', Boolean(target?.worldlines?.includes(worldlineId)), { worldlineId, worldlines: target?.worldlines });
  check('QA isolation token accepted', isolationToken.startsWith('QA-ISOLATED-') || process.env.NOA_QA_ALLOW_NON_QA_CAMPAIGN === 'YES', { tokenPrefix: isolationToken.slice(0, 16) });
  const v2Before = hash(statsBefore.data?.v2 ?? statsBefore.data ?? {});

  const list = await call('tools/list', {}, 'tools/list');
  const names = (list.result?.tools ?? []).map(t => t.name);
  check('tools/list protocol', ['session_bootstrap', 'memory_recall', 'state_read', 'event_commit', 'runtime_execute', 'session_recover', 'save_checkpoint', 'save_restore', 'event_receipt', 'archive_export', 'memory_record', 'memory_revise', 'memory_summarize', 'todo_status', 'runtime_init'].every(n => names.includes(n)), { names });

  const boot = await call('session_bootstrap', { campaignId, worldlineId, viewer: 'gm' });
  check('bootstrap explicit scope', boot.ok === true && boot.data.campaignId === campaignId && boot.data.worldlineId === worldlineId, boot);
  const beforeState = await call('state_read', { campaignId, worldlineId });
  const beforeBusiness = stable({ ...beforeState.data.state, revision: undefined, updatedAt: undefined });
  const revision = Number(beforeState.data.state.revision);
  const recall = await call('memory_recall', { campaignId, worldlineId, viewer: 'gm', query: '记忆', limit: 20 });
  check('recall protocol', recall.ok === true && Array.isArray(recall.data.hits), { hits: recall.data.hits?.length });
  check('recall stable identity de-duplicated', new Set((recall.data.hits ?? []).map(h => `${h.kind}:${h.id}:${h.meta?.sourceEventId ?? ''}:${h.meta?.holder ?? ''}`)).size === recall.data.hits?.length, {});
  const clock = await call('state_read', { campaignId, worldlineId, section: 'clock' });
  check('state_read clock exact', clock.ok === true && clock.data.section === 'clock' && clock.data.state === undefined && Boolean(clock.data.clock), {});

  const cp = await call('save_checkpoint', { campaignId, worldlineId, label: `qa-${stamp}`, idempotencyKey: `QA-CP-${stamp}` });
  check('checkpoint receipt', cp.ok === true && cp.data.receipt?.checkpointId === cp.data.checkpointId, cp);
  const checkpointId = cp.data.receipt?.checkpointId ?? cp.data.checkpointId;

  const eventId = `QA-EVENT-${stamp}`;
  const commit = await call('event_commit', { campaignId, worldlineId, eventId, expectedRevision: revision, idempotencyKey: `${eventId}-K`, statePatch: { flags: { qaReplay: stamp } } });
  check('event_commit after checkpoint', commit.ok === true, commit);
  const changed = await call('state_read', { campaignId, worldlineId });
  check('state changed before restore', canonical(changed.data.state.flags ?? {}) !== canonical(beforeState.data.state.flags ?? {}), {});
  const roll = await call('runtime_execute', { campaignId, worldlineId, skill: 5, difficulty: 3, expectedRevision: commit.data.revision, idempotencyKey: `${eventId}-ROLL` });
  check('runtime_execute', roll.ok === true, roll);
  const receipt = await call('event_receipt', { campaignId, worldlineId, lookup: eventId });
  check('event receipt', receipt.ok === true && receipt.data.receipt?.eventId === eventId, {});
  const recover = await call('session_recover', { campaignId, worldlineId });
  check('session_recover', recover.ok === true && recover.data.stateRevision >= roll.data.revision, recover);
  const restore = await call('save_restore', { campaignId, worldlineId, checkpointId, idempotencyKey: `QA-RESTORE-${stamp}` });
  check('save_restore by receipt ID', restore.ok === true && restore.data.checkpointId === checkpointId, restore);
  const afterState = await call('state_read', { campaignId, worldlineId });
  check('restore deep business state', canonical(stable({ ...afterState.data.state, revision: undefined, updatedAt: undefined })) === canonical(beforeBusiness), {});
  const restoreReplay = await call('save_restore', { campaignId, worldlineId, checkpointId, idempotencyKey: `QA-RESTORE-${stamp}` });
  check('restore idempotent', restoreReplay.data?.duplicate === true, restoreReplay);

  // 治理适配器：必须走 V3 或返回业务语义错误，不得返回 v3_governance_not_adapted。
  const memory = await call('memory_record', { campaignId, worldlineId, kind: 'entity', data: { id: `entity.qa-${stamp}`, type: 'generic', name: 'QA probe' }, idempotencyKey: `QA-MR-${stamp}` });
  check('memory_record adapted', memory.ok === true, memory);
  const revised = await call('memory_revise', { campaignId, worldlineId, kind: 'entity', id: `entity.qa-${stamp}`, patch: { name: 'QA probe revised' }, expectedRevision: 0, idempotencyKey: `QA-MREV-${stamp}` });
  check('memory_revise adapted', revised.ok === true, revised);
  const summary = await call('memory_summarize', { campaignId, worldlineId, instanceId: `qa-${stamp}`, keyCausality: ['qa'], characterChanges: [], resourceChanges: [], unresolved: [], decisions: [], sourceEventIds: [], idempotencyKey: `QA-SUM-${stamp}` });
  check('memory_summarize adapted', summary.ok === true, summary);
  const todoSeed = await call('event_commit', { campaignId, worldlineId, eventId: `QA-TODO-${stamp}`, expectedRevision: afterState.data.state.revision, idempotencyKey: `QA-TODO-${stamp}`, pendingEvents: [{ id: `todo.qa-${stamp}`, status: 'open', action: 'qa' }] });
  check('todo seed', todoSeed.ok === true, todoSeed);
  const todo = await call('todo_status', { campaignId, worldlineId, id: `todo.qa-${stamp}`, status: 'closed', idempotencyKey: `QA-TODO-STATUS-${stamp}` });
  check('todo_status adapted', todo.ok === true, todo);
  const init = await call('runtime_init', { campaignId, worldlineId, expectedRevision: todoSeed.data.revision, idempotencyKey: `QA-INIT-${stamp}` });
  check('runtime_init adapted semantics', init.ok === true || init.code === 'rng_already_initialized', init);
  const blocked = await call('campaign_import', { campaignId, worldlineId, sources: {}, dryRun: true });
  check('legacy governance explicitly blocked', blocked.code === 'v3_governance_not_adapted', blocked);

  const archiveHeader = await call('archive_export', { pageBytes: 12000 });
  check('archive header', archiveHeader.ok === true && archiveHeader.data.done === false && Number.isInteger(archiveHeader.data.pages), archiveHeader);
  const chunks = [];
  for (let page = 0; page < archiveHeader.data.pages; page++) {
    const part = await call('archive_export', { pageBytes: 12000, page, archiveId: archiveHeader.data.archiveId });
    check(`archive page ${page}`, part.ok === true && part.data.pageHash && typeof part.data.done === 'boolean', { page });
    chunks.push(Buffer.from(part.data.base64, 'base64'));
    if (part.data.done) check('archive done marker', part.data.nextCursor === null, part.data);
  }
  const full = Buffer.concat(chunks);
  check('archive bytes', full.length === archiveHeader.data.bytes, { actual: full.length, expected: archiveHeader.data.bytes });
  let parsed;
  try { parsed = JSON.parse(full.toString('utf8')); } catch { parsed = null; }
  check('archive JSON and full hash', Boolean(parsed) && hash(parsed) === archiveHeader.data.sha256, { hash: parsed ? hash(parsed) : null });

  const statsAfter = await call('vault_stats');
  const v2After = hash(statsAfter.data?.v2 ?? statsAfter.data ?? {});
  check('V2 statistics signature unchanged', v2Before === v2After, { v2Before, v2After });
} catch (error) {
  check('transport', false, { error: String(error?.message ?? error) });
}
const report = { release: '2.2.3-authority-closure', target: { campaignId, worldlineId }, isolated: true, checks, verdict: checks.every(c => c.ok) ? 'PASS' : 'NO-GO' };
console.log(JSON.stringify(report, null, 2));
process.exit(report.verdict === 'PASS' ? 0 : 1);
