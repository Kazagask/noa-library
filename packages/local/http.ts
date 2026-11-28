/** Local HTTP MCP host. Same Worker JSON-RPC handler as production. */
import { createServer } from 'node:http';
import { openLocalHost, LOCAL_TOKEN, type LocalHost } from './host.ts';

export async function createLocalServer(input: { dbPath?: string; owner?: string; port?: number } = {}) {
  const host = await openLocalHost(input);
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'noa-local-host', owner: host.owner })); return;
    }
    if (url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${LOCAL_TOKEN}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) { res.writeHead(413); res.end(); return; } }
    let message: any;
    try { message = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_json' })); return; }
    const result = await host.rpc(message);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  });
  return { host, server, close: () => new Promise<void>((resolve, reject) => server.close(() => { host.close(); resolve(); })).catch(reject), port: input.port ?? 8787 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.NOA_PORT ?? 8787);
  createLocalServer({ port }).then(({ server }) => server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`NOA local MCP http://127.0.0.1:${port}/mcp (Bearer ${LOCAL_TOKEN})\n`);
  })).catch(error => { console.error(error); process.exit(1); });
}
