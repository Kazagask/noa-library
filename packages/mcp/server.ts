import { createInterface } from 'node:readline';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from '../core/util.ts';
import { SqliteStore } from '../server/sqlite-store.ts';
import { handleJsonRpc } from '../server/mcp-tools.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dbPath = process.env.NOA_DB_PATH ?? join(ROOT, 'deploy', 'data', 'noa.sqlite');
ensureDir(dirname(dbPath));
const store = new SqliteStore(ROOT, dbPath);
if (!store.listCampaigns().length) store.seedFromFiles('demo');

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); }
  catch { replyError(null, -32700, 'JSON 解析失败'); return; }
  const response = handleJsonRpc(store, msg);
  if (!response) return;
  if ('error' in response) replyError(response.id, response.error.code, response.error.message);
  else reply(response.id, response.result);
});
rl.on('close', () => store.close());
process.stderr.write('NOA MCP adapter 已就绪（stdio；Streamable HTTP 见 /mcp）\n');
