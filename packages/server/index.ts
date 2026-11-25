import { createServer } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from '../core/util.ts';
import { SqliteStore } from './sqlite-store.ts';
import { handleRequest, type Tokens } from './api.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dbPath = process.env.NOA_DB_PATH ?? join(ROOT, 'deploy', 'data', 'noa.sqlite');
const host = process.env.NOA_HOST ?? '127.0.0.1';
const port = Number(process.env.NOA_PORT ?? 8787);

function parseTokens(): Tokens {
  const raw = process.env.NOA_API_TOKENS;
  if (!raw) return { 'dev-noa-token': ['read', 'write', 'admin'] };
  try { return JSON.parse(raw) as Tokens; }
  catch {
    process.stderr.write('NOA_API_TOKENS 不是合法 JSON，使用默认开发 token\n');
    return { 'dev-noa-token': ['read', 'write', 'admin'] };
  }
}

ensureDir(dirname(dbPath));
const store = new SqliteStore(ROOT, dbPath);
if (!store.listCampaigns().length) {
  const seed = process.env.NOA_SEED_CAMPAIGN ?? 'demo';
  store.seedFromFiles(seed);
  process.stderr.write(`已从仓库文件初始化 campaign: ${seed}\n`);
}
const tokens = parseTokens();

const server = createServer((req, res) => {
  handleRequest(store, req, res, tokens).catch(err => {
    const body = JSON.stringify({ ok: false, code: 'internal_error', message: String(err?.message ?? err) });
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  });
});

server.listen(port, host, () => {
  process.stderr.write(`NOA Memory Server 监听 http://${host}:${port}（默认 token: dev-noa-token，生产环境请覆盖 NOA_API_TOKENS）\n`);
});

function shutdown(): void {
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
