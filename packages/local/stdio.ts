/** Local MCP stdio host. One JSON-RPC message per line, same Worker handler as production. */
import { createInterface } from 'node:readline';
import { openLocalHost } from './host.ts';

const host = await openLocalHost({ dbPath: process.env.NOA_DB_PATH });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const message = JSON.parse(line);
    const result = await host.rpc(message);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error: any) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message ?? error) } }) + '\n');
  }
}
host.close();
