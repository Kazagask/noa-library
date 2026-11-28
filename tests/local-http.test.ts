import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServer } from '../packages/local/http.ts';

test('local HTTP MCP 可发现并调用真实工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noa-local-http-'));
  const { server, host } = await createLocalServer({ dbPath: join(dir, 'local.sqlite') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-dev-token' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_bootstrap', arguments: { campaignId: 'demo', worldlineId: 'wl-main' } } }) });
    const json: any = await response.json();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(json.result.content[0].text).ok, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); host.close(); rmSync(dir, { recursive: true, force: true }); }
});
