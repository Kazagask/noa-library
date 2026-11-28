/** T3/T4 local smoke: independent stdio MCP client, no direct handler calls. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { sha256 } from '../core/shared.ts';

class MCPClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private waiting = new Map<number, (value: any) => void>();
  private rl: any;
  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ['packages/local/stdio.ts'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line: string) => { try { const message = JSON.parse(line); if (message.id && this.waiting.has(message.id)) { this.waiting.get(message.id)!(message); this.waiting.delete(message.id); } } catch {} });
    this.child.stderr.on('data', chunk => process.stderr.write(String(chunk)));
    this.child.on('exit', code => { for (const [id, resolve] of this.waiting) { this.waiting.delete(id); resolve({ error: { code: 'child_exit', message: `child exited ${code}` } }); } });
  }
  request(method: string, params: any = {}) {
    const id = ++this.nextId;
    return new Promise<any>((resolve, reject) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(`MCP timeout ${method}`)); } }, 30000).unref?.();
    });
  }
  async call(name: string, args: any = {}) {
    const message = await this.request('tools/call', { name, arguments: args });
    if (message.error) return { ok: false, code: 'jsonrpc_error', message: message.error.message };
    return JSON.parse(message.result.content[0].text);
  }
  close() { this.child.stdin.end(); this.child.kill(); }
}

const POST_AT = '2026-01-01T00:00:00.000Z';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const rawHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stripDomain = (value: any): any => {
  if (Array.isArray(value)) return value.map(stripDomain);
  if (!value || typeof value !== 'object') return value;
  const out: any = {};
  for (const key of Object.keys(value).sort()) {
    if (['revision', 'updatedAt', 'memoryRevision', 'activatedAt'].includes(key)) continue;
    out[key] = stripDomain(value[key]);
  }
  return out;
};

async function archive(client: MCPClient) {
  const header = await client.call('archive_export', { pageBytes: 12000 });
  const chunks: Buffer[] = [];
  for (let page = 0; page < header.data.pages; page++) {
    const part = await client.call('archive_export', { pageBytes: 12000, page, archiveId: header.data.archiveId });
    if (!part.ok) return { ok: false, header, failure: part };
    const bytes = Buffer.from(part.data.base64, 'base64');
    const expected = Math.min(header.data.pageBytes, header.data.bytes - page * header.data.pageBytes);
    if (part.data.page !== page || bytes.length !== expected || rawHash(bytes) !== part.data.pageHash) return { ok: false, header, failure: { page, expected, actual: bytes.length } };
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const parsed = JSON.parse(bytes.toString('utf8'));
  return { ok: bytes.length === header.data.bytes && sha256(parsed) === header.data.sha256, header, bytes, archive: parsed };
}

export async function runSmoke(opts: { dbPath: string }) {
  const checks: { name: string; ok: boolean; detail?: any }[] = [];
  const check = (name: string, ok: boolean, detail?: any) => checks.push({ name, ok, detail });
  const env = { NOA_DB_PATH: opts.dbPath };
  let client = new MCPClient(env);
  try {
    const init = await client.request('initialize', {});
    check('initialize', init.result?.serverInfo?.name === 'noa-library', init);
    const list = await client.request('tools/list', {});
    check('tools/list', Array.isArray(list.result?.tools) && list.result.tools.length >= 10, { count: list.result?.tools?.length });
    const boot = await client.call('session_bootstrap', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('bootstrap', boot.ok === true, boot);

    // Deterministic Chinese recall fixture: entity attribute + structured episode source.
    const entities = [
      { id: 'entity.qa-xiaoyan', type: 'person', name: '萧炎', attributes: { title: '九星斗圣' }, knownBy: ['*'] },
      { id: 'entity.qa-xiaoyan-shadow', type: 'person', name: '萧炎分身', attributes: { title: '九星斗圣' }, knownBy: ['*'] },
      { id: 'entity.qa-secret', type: 'person', name: '萧炎密档', attributes: { title: '九星斗圣' }, knownBy: ['gm'] }
    ];
    for (const data of entities) {
      const result = await client.call('memory_record', { campaignId: 'demo', worldlineId: 'wl-main', kind: 'entity', data, idempotencyKey: `SMOKE-MEM-${data.id}` });
      check(`memory_record ${data.id}`, result.ok === true, result);
    }
    const summaries = [];
    for (let i = 0; i < 3; i++) {
      const result = await client.call('memory_summarize', { campaignId: 'demo', worldlineId: 'wl-main', instanceId: `chinese-${i}`, keyCausality: ['九星斗圣', `萧炎事件${i}`], characterChanges: ['萧炎'], resourceChanges: [], unresolved: [], decisions: [], sourceEventIds: [`ep-qa-${i}`], idempotencyKey: `SMOKE-SUM-${i}` });
      summaries.push(result);
      check(`summary ${i}`, result.ok === true && String(result.data.id).startsWith('ep-summary-'), result);
    }
    const recallEntity = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '萧炎', limit: 10 });
    check('recall entity id/content', recallEntity.ok === true && recallEntity.data.hits.some((h: any) => h.id === 'entity.qa-xiaoyan' && h.title === '萧炎'), recallEntity);
    const recallSource = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '九星斗圣', limit: 1 });
    check('recall episode source', recallSource.ok === true && recallSource.data.hits.some((h: any) => h.meta?.sourceEventId === 'ep-qa-0' && h.text.includes('九星斗圣')), recallSource);
    const pageOne = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '九星斗圣', limit: 1, cursor: 0 });
    const pageTwo = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '九星斗圣', limit: 1, cursor: 1 });
    check('recall pagination', pageOne.data.hits.length === 1 && pageTwo.data.hits.length === 1 && pageOne.data.hits[0].id !== pageTwo.data.hits[0].id && pageOne.data.nextCursor === 1, { pageOne: pageOne.data, pageTwo: pageTwo.data });
    const hidden = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'person.other', query: '萧炎密档', limit: 10 });
    check('recall visibility', hidden.ok === true && hidden.data.hits.length === 0, hidden);
    const visible = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '萧炎密档', limit: 10 });
    check('recall GM visibility', visible.ok === true && visible.data.hits.some((h: any) => h.id === 'entity.qa-secret'), visible);
    const traverse = await client.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 2 });
    check('traverse', traverse.ok === true && traverse.data.nodes.length > 1, { nodes: traverse.data?.nodes?.length });
    const before = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    const revision = before.data.state.revision;
    const cp = await client.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: 'SMOKE-CP', label: 'smoke' });
    check('checkpoint', cp.ok === true && Boolean(cp.data.receipt?.checkpointId), cp);
    const boundedRaw = await client.request('tools/call', { name: 'state_read', arguments: { campaignId: 'demo', worldlineId: 'wl-main', fields: ['clock'], maxBytes: 400 } });
    const boundedText = boundedRaw.result.content[0].text;
    const boundedData = JSON.parse(boundedText).data;
    check('maxBytes actual MCP', Buffer.byteLength(JSON.stringify(boundedData), 'utf8') <= 400, { bytes: Buffer.byteLength(JSON.stringify(boundedData), 'utf8'), boundedText });
    const commit = await client.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-EVENT', expectedRevision: revision, idempotencyKey: 'SMOKE-EVENT-K', statePatch: { flags: { smoke: true } }, pendingEvents: [{ id: 'todo.smoke', status: 'open', action: 'verify' }] });
    check('event_commit', commit.ok === true, commit);
    const roll = await client.call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 5, difficulty: 3, expectedRevision: commit.data.revision, idempotencyKey: 'SMOKE-RNG' });
    const afterRoll = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('runtime_execute', roll.ok === true && roll.data.roll.seed === before.data.state.rng.seed && afterRoll.data.state.rng.cursor === (before.data.state.rng.cursor + 1), { roll, cursor: afterRoll.data.state.rng.cursor });
    const receipt = await client.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'SMOKE-EVENT' });
    check('event_receipt', receipt.ok === true && receipt.data.receipt?.eventId === 'SMOKE-EVENT', receipt);
    const duplicate = await client.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-EVENT', expectedRevision: revision, idempotencyKey: 'SMOKE-EVENT-K', statePatch: { flags: { smoke: true } }, pendingEvents: [{ id: 'todo.smoke', status: 'open', action: 'verify' }] });
    check('idempotent replay', duplicate.ok === true && duplicate.data?.receipt?.duplicate === true, duplicate);
    const rollReplay = await client.call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 5, difficulty: 3, expectedRevision: commit.data.revision, idempotencyKey: 'SMOKE-RNG' });
    check('rng replay no consume', rollReplay.ok === true && (rollReplay.data?.duplicate === true || rollReplay.data?.receipt?.duplicate === true), rollReplay);
    client.close(); await wait(150);
    client = new MCPClient(env);
    await client.request('initialize', {});
    const recover = await client.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('restart recover', recover.ok === true && recover.data.stateRevision >= commit.data.revision, recover);
    const restore = await client.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: cp.data.receipt.checkpointId, idempotencyKey: 'SMOKE-RESTORE' });
    check('checkpoint restore', restore.ok === true, restore);
    const restored = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('business restore', sha256(stripDomain(restored.data.state)) === sha256(stripDomain(before.data.state)), {});
    const sourceArchive = await archive(client);
    check('archive pages', sourceArchive.ok === true, { pages: sourceArchive.header?.data?.pages, failure: sourceArchive.failure });
    check('archive integrity', sourceArchive.header?.data?.integrity?.valid === true, sourceArchive.header?.data?.integrity);
    const sourceDomain = stripDomain(sourceArchive.archive.document);
    client.close(); await wait(150);
    const importedPath = `${opts.dbPath}.imported`;
    client = new MCPClient({ NOA_DB_PATH: importedPath, NOA_LOCAL_SEED: '0' });
    await client.request('initialize', {});
    const imported = await client.call('archive_import', { ...sourceArchive.archive, sha256: sourceArchive.header.data.sha256, idempotencyKey: 'SMOKE-IMPORT' });
    check('archive import', imported.ok === true, imported);
    const importedRead = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('imported state', sha256(stripDomain(importedRead.data.state)) === sha256(stripDomain(before.data.state)), {});
    const importedRecall = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '九星斗圣', limit: 10 });
    check('imported memory', importedRecall.ok === true && importedRecall.data.hits.some((h: any) => h.meta?.sourceEventId === 'ep-qa-0'), importedRecall);
    const importedTraverse = await client.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 2 });
    check('imported graph', importedTraverse.ok === true && importedTraverse.data.nodes.length === traverse.data.nodes.length, importedTraverse);
    const importedPersona = await client.call('persona_load', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('imported persona', importedPersona.ok === true, importedPersona);
    const importedArchive = await archive(client);
    check('imported archive domains', importedArchive.ok === true && sha256(stripDomain(importedArchive.archive.document)) === sha256(sourceDomain), {});
    const recovery = await client.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    const postRng = await client.call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 6, difficulty: 2, expectedRevision: importedRead.data.state.revision, idempotencyKey: 'POST-IMPORT-RNG' });
    const afterPostRng = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('post-import rng', postRng.ok === true && afterPostRng.data.state.rng.cursor === (recovery.data.rngCursor + 1), { postRng, cursor: afterPostRng.data.state.rng.cursor });
    const postEvent = await client.call('event_commit', {
      campaignId: 'demo', worldlineId: 'wl-main', eventId: 'POST-IMPORT-EVENT', expectedRevision: postRng.data.revision, idempotencyKey: 'POST-IMPORT-EVENT-K',
      statePatch: { flags: { afterImport: true } },
      entities: [{ id: 'entity.post-import', type: 'person', name: '导入后角色', worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], aliases: [], attributes: {}, createdAt: POST_AT, updatedAt: POST_AT }],
      relations: [{ id: 'rel-post-import', subject: 'person.player', predicate: 'knows', object: 'entity.post-import', worldlineId: 'wl-main', knownBy: ['*'], description: 'imported relation', sourceEventId: 'POST-IMPORT-EVENT', validFrom: POST_AT, validUntil: null, recordedAt: POST_AT, scope: 'world', confidence: 1, epistemic: 'fact', holder: null, status: 'active', revision: 1, supersedes: null }],
      episodes: [{ id: 'ep-post-import', at: POST_AT, turn: 1, title: '导入后继续', summary: '萧炎 九星斗圣', worldlineId: 'wl-main', entities: ['entity.post-import'], relationIds: ['rel-post-import'], knownBy: ['*'], sourceEventId: 'POST-IMPORT-EVENT', path: 'episode/post-import.md', tags: ['smoke'], confidence: 1 }]
    });
    check('post-import cross-module event', postEvent.ok === true, postEvent);
    const postReceipt = await client.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'POST-IMPORT-EVENT' });
    check('post-import receipt', postReceipt.ok === true && postReceipt.data.receipt?.eventId === 'POST-IMPORT-EVENT', postReceipt);
    const postReplay = await client.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'POST-IMPORT-EVENT', expectedRevision: postRng.data.revision, idempotencyKey: 'POST-IMPORT-EVENT-K', statePatch: { flags: { afterImport: true } }, entities: [{ id: 'entity.post-import', type: 'person', name: '导入后角色', worldlineId: 'wl-main', scope: 'world', knownBy: ['*'], aliases: [], attributes: {}, createdAt: POST_AT, updatedAt: POST_AT }], relations: [{ id: 'rel-post-import', subject: 'person.player', predicate: 'knows', object: 'entity.post-import', worldlineId: 'wl-main', knownBy: ['*'], description: 'imported relation', sourceEventId: 'POST-IMPORT-EVENT', validFrom: POST_AT, validUntil: null, recordedAt: POST_AT, scope: 'world', confidence: 1, epistemic: 'fact', holder: null, status: 'active', revision: 1, supersedes: null }], episodes: [{ id: 'ep-post-import', at: POST_AT, turn: 1, title: '导入后继续', summary: '萧炎 九星斗圣', worldlineId: 'wl-main', entities: ['entity.post-import'], relationIds: ['rel-post-import'], knownBy: ['*'], sourceEventId: 'POST-IMPORT-EVENT', path: 'episode/post-import.md', tags: ['smoke'], confidence: 1 }] });
    check('post-import replay', postReplay.ok === true && postReplay.data?.receipt?.duplicate === true, postReplay);
    client.close(); rmSync(importedPath, { force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(opts.dbPath + suffix, { force: true });
  } catch (error: any) {
    check('transport', false, String(error?.stack ?? error));
  } finally { try { client.close(); } catch {} }
  return { ok: checks.every(c => c.ok), checks };
}
