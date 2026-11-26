import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SnapshotRepo } from '../library/store.ts';
import { dispatchTool } from './dispatch.ts';
import { handleJsonRpc, logicalToolName } from './mcp-tools.ts';
import { registryScope } from '../core/mcp-registry.ts';

export const TOOL_SCOPES: Record<string, 'read' | 'write' | 'admin'> = {
  'session.bootstrap': 'read', 'session.close': 'write', 'persona.load': 'read',
  'library.search': 'read', 'memory.recall': 'read', 'memory.traverse': 'read',
  'memory.record': 'write', 'memory.revise': 'write', 'memory.consolidate': 'write',
  'state.read': 'read', 'state.commit': 'write', 'runtime.execute': 'write',
  'save.checkpoint': 'write', 'save.restore': 'admin', 'worldline.fork': 'admin',
  'asset.register': 'write', 'asset.upload': 'write', 'asset.resolve': 'read',
  'asset.search': 'read', 'asset.link': 'write', 'asset.revise': 'write', 'asset.gc': 'admin',
  'session.recover': 'read', 'memory.summarize': 'write', 'memory.layers': 'read',
  'todo.status': 'write', 'event.receipt': 'read', 'ops.metrics': 'read'
};

/** 未知工具默认拒绝；memory.layers 的重建操作需要 write。 */
export function requiredScope(tool: string, args: Record<string, any> = {}): 'read' | 'write' | 'admin' | null {
  return registryScope(tool, args) ?? TOOL_SCOPES[tool] ?? null;
}
function allowed(scopes: string[], required: 'read' | 'write' | 'admin' | null): boolean {
  return Boolean(required && (scopes.includes(required) || scopes.includes('admin')));
}

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
    send(res, 200, { ok: true, data: { service: 'noa-memory-server', version: '0.3.0', mcp: '/mcp' } });
    return;
  }
  if (path === '/mcp') {
    if (req.method !== 'POST') { send(res, 405, { ok: false, code: 'method_not_allowed', message: '/mcp 只接受 POST' }); return; }
    const mcpAuth = authenticate(req.headers.authorization, tokens);
    if (!mcpAuth.ok) { send(res, 401, { ok: false, code: 'unauthorized', message: mcpAuth.reason }); return; }
    let rawMcp = '';
    for await (const chunk of req) {
      rawMcp += chunk.toString();
      if (rawMcp.length > 1_048_576) { send(res, 413, { ok: false, code: 'payload_too_large', message: '请求体超过 1MB' }); return; }
    }
    let msg: any;
    try { msg = rawMcp ? JSON.parse(rawMcp) : {}; }
    catch { send(res, 400, { ok: false, code: 'invalid_json', message: '请求体不是合法 JSON' }); return; }
    const requested = msg.method === 'tools/call'
      ? logicalToolName(String(msg.params?.name ?? ''))
      : undefined;
    if (requested) {
      const required = requiredScope(requested, msg.params?.arguments ?? {});
      if (!allowed(mcpAuth.scopes, required)) {
        send(res, 403, { ok: false, code: 'forbidden', message: required ? `工具 ${requested} 需要 ${required} 权限` : `未知工具 ${requested}` });
        return;
      }
    } else if (!mcpAuth.scopes.some(s => ['read', 'write', 'admin'].includes(s))) {
      send(res, 403, { ok: false, code: 'forbidden', message: 'MCP 需要有效 scope' });
      return;
    }
    const response = await handleJsonRpc(store, msg);
    if (!response) { res.writeHead(202); res.end(); return; }
    send(res, 200, response);
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
  const result = await dispatchTool(store, tool, body);
  send(res, result.ok ? 200 : 400, result);
}
