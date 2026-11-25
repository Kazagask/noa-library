import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'noa-mcp-'));
const child = spawn(process.execPath, ['packages/mcp/server.ts'], {
  cwd: ROOT, env: { ...process.env, NOA_DB_PATH: join(dir, 'test.sqlite'), NODE_NO_WARNINGS: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); });

const pending = new Map<number, (value: any) => void>();
let buffer = '';
let nextId = 1;
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolvePending = pending.get(msg.id);
    if (resolvePending) { pending.delete(msg.id); resolvePending(msg); }
  }
});

function send(method: string, params?: any): Promise<any> {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise(resolve => pending.set(id, resolve));
}

async function main(): Promise<void> {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  if (init.result?.serverInfo?.name !== 'noa-library') throw new Error(`initialize 失败: ${JSON.stringify(init)}`);
  const list = await send('tools/list', {});
  const names: string[] = list.result?.tools?.map((t: any) => t.name) ?? [];
  if (names.length !== 15 || !names.includes('state_commit')) throw new Error(`工具列表异常: ${names.join(',')}`);
  const call = await send('tools/call', { name: 'memory_recall', arguments: { query: '钥匙', viewer: 'person.player' } });
  const payload = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
  if (!payload.ok || !payload.data.hits.length) throw new Error(`tools/call 失败: ${JSON.stringify(call)}`);
  const bad = await send('tools/call', { name: 'no_such_tool', arguments: {} });
  if (!bad.error) throw new Error('未知工具未被拒绝');
  process.stdout.write(`${JSON.stringify({ ok: true, tools: names.length, hits: payload.data.hits.length, init: init.result.protocolVersion })}\n`);
}

main().catch(err => {
  process.stderr.write(`${err.stack ?? err}\n${stderr}\n`);
  process.exitCode = 1;
}).finally(async () => {
  child.stdin.end();
  child.kill();
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 1500);
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 文件锁可能短暂存在 */ }
});
