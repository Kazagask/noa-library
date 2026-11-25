import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SnapshotRepo } from '../library/store.ts';
import { dispatchTool } from './dispatch.ts';

export const TOOL_SCOPES: Record<string, 'read' | 'write' | 'admin'> = {
  'session.bootstrap': 'read', 'session.close': 'write', 'persona.load': 'read',
  'library.search': 'read', 'memory.recall': 'read', 'memory.traverse': 'read',
  'memory.record': 'write', 'memory.revise': 'write', 'memory.consolidate': 'write',
  'state.read': 'read', 'state.commit': 'write', 'runtime.execute': 'write',
  'save.checkpoint': 'write', 'save.restore': 'admin', 'worldline.fork': 'admin'
};

export type Tokens = Record<string, string[]>;

export function authenticate(header: string | undefined, tokens: Tokens): { ok: boolean; scopes: string[]; reason?: string } {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return { ok: false, scopes: [], reason: '缺少 Bearer token' };
  const scopes = tokens[match[1]];
  if (!scopes) return { ok: false, scopes: [], reason: 'token 无效' };
  return { ok: true, scopes };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

export async function handleRequest(store: SnapshotRepo, req: IncomingMessage, res: ServerResponse, tokens: Tokens): Promise<void> {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/health' && req.method === 'GET') {
    send(res, 200, { ok: true, data: { service: 'noa-memory-server', version: '0.2.0' } });
    return;
  }
  const tool = Object.keys(TOOL_SCOPES).find(name => path === `/${name}`);
  if (!tool || req.method !== 'POST') {
    send(res, 404, { ok: false, code: 'not_found', message: '未知工具或方法' });
    return;
  }
  const auth = authenticate(req.headers.authorization, tokens);
  if (!auth.ok) { send(res, 401, { ok: false, code: 'unauthorized', message: auth.reason }); return; }
  const scope = TOOL_SCOPES[tool];
  if (!auth.scopes.includes(scope) && !auth.scopes.includes('admin')) {
    send(res, 403, { ok: false, code: 'forbidden', message: `工具 ${tool} 需要 ${scope} 权限` });
    return;
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 1_048_576) { send(res, 413, { ok: false, code: 'payload_too_large', message: '请求体超过 1MB' }); return; }
  }
  let body: Record<string, any> = {};
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { send(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' }); return; }
  const result = dispatchTool(store, tool, body);
  send(res, result.ok ? 200 : 400, result);
}
