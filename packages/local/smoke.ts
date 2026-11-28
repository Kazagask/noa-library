/** T3/T5 local smoke: independent stdio MCP client; no direct handler calls. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { sha256 } from '../core/shared.ts';

class MCPClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private waiting = new Map<number, (value: any) => void>();
  private rl = null as any;
  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, ['packages/local/stdio.ts'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', line => { try { const message = JSON.parse(line); if (message.id && this.waiting.has(message.id)) { this.waiting.get(message.id)!(message); this.waiting.delete(message.id); } } catch {} });
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

const business = (value: any) => { const out = { ...value }; delete out.revision; delete out.updatedAt; delete out.memoryRevision; return out; };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    const before = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    const revision = before.data.state.revision;
    const recall = await client.call('memory_recall', { campaignId: 'demo', worldlineId: 'wl-main', viewer: 'gm', query: '记忆' });
    check('recall', recall.ok === true && Array.isArray(recall.data.hits), { hits: recall.data?.hits?.length });
    const traverse = await client.call('memory_traverse', { campaignId: 'demo', worldlineId: 'wl-main', start: 'person.player', hops: 2 });
    check('traverse', traverse.ok === true && traverse.data.nodes.length > 1, { nodes: traverse.data?.nodes?.length });
    const cp = await client.call('save_checkpoint', { campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: 'SMOKE-CP', label: 'smoke' });
    check('checkpoint', cp.ok === true && Boolean(cp.data.receipt?.checkpointId), cp);
    const commit = await client.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-EVENT', expectedRevision: revision, idempotencyKey: 'SMOKE-EVENT-K', statePatch: { flags: { smoke: true } } });
    check('event_commit', commit.ok === true, commit);
    const roll = await client.call('runtime_execute', { campaignId: 'demo', worldlineId: 'wl-main', skill: 5, difficulty: 3, expectedRevision: commit.data.revision, idempotencyKey: 'SMOKE-RNG' });
    check('runtime_execute', roll.ok === true, roll);
    const receipt = await client.call('event_receipt', { campaignId: 'demo', worldlineId: 'wl-main', lookup: 'SMOKE-EVENT' });
    check('event_receipt', receipt.ok === true && receipt.data.receipt?.eventId === 'SMOKE-EVENT', receipt);
    const duplicate = await client.call('event_commit', { campaignId: 'demo', worldlineId: 'wl-main', eventId: 'SMOKE-EVENT', expectedRevision: revision, idempotencyKey: 'SMOKE-EVENT-K', statePatch: { flags: { smoke: true } } });
    check('idempotent replay', duplicate.ok === true && duplicate.data?.receipt?.duplicate === true, duplicate);
    client.close(); await wait(150);
    client = new MCPClient(env);
    await client.request('initialize', {});
    const recover = await client.call('session_recover', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('restart recover', recover.ok === true && recover.data.stateRevision >= commit.data.revision, recover);
    const restore = await client.call('save_restore', { campaignId: 'demo', worldlineId: 'wl-main', checkpointId: cp.data.receipt.checkpointId, idempotencyKey: 'SMOKE-RESTORE' });
    check('checkpoint restore', restore.ok === true, restore);
    const restored = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('business restore', sha256(business(restored.data.state)) === sha256(business(before.data.state)), {});
    const header = await client.call('archive_export', { pageBytes: 12000 });
    check('archive header', header.ok === true, header);
    const chunks = [];
    for (let page = 0; page < header.data.pages; page++) {
      const part = await client.call('archive_export', { pageBytes: 12000, page, archiveId: header.data.archiveId });
      if (!part.ok) { check(`archive page ${page}`, false, part); break; }
      chunks.push(Buffer.from(part.data.base64, 'base64'));
    }
    const bytes = Buffer.concat(chunks);
    const archive = JSON.parse(bytes.toString('utf8'));
    check('archive hash', bytes.length === header.data.bytes && sha256(archive) === header.data.sha256, { bytes: bytes.length });
    client.close(); await wait(150);
    const importedPath = `${opts.dbPath}.imported`;
    client = new MCPClient({ NOA_DB_PATH: importedPath, NOA_LOCAL_SEED: '0' });
    await client.request('initialize', {});
    const imported = await client.call('archive_import', { ...archive, sha256: header.data.sha256, idempotencyKey: 'SMOKE-IMPORT' });
    check('archive import', imported.ok === true, imported);
    const importedRead = await client.call('state_read', { campaignId: 'demo', worldlineId: 'wl-main' });
    check('imported business', sha256(business(importedRead.data.state)) === sha256(business(before.data.state)), {});
    client.close(); rmSync(importedPath, { force: true });
  } catch (error: any) {
    check('transport', false, String(error?.stack ?? error));
  } finally { try { client.close(); } catch {} }
  return { ok: checks.every(c => c.ok), checks };
}
