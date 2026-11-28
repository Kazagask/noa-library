/** NOA local CLI: db:init, dev:local, archive:import/export, test:smoke. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openLocalHost } from './host.ts';
import { createLocalServer } from './http.ts';
import { runSmoke } from './smoke.ts';

const root = resolve(import.meta.dirname, '../..');
const dbPath = resolve(process.env.NOA_DB_PATH ?? `${root}/deploy/data/local.sqlite`);
const [command, ...rest] = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : fallback;
};
const usage = () => { console.error('用法: node packages/local/cli.ts <db:init|dev:local|archive:import|archive:export|test:smoke> [--out file] [--file file]'); process.exit(2); };

try {
  if (command === 'db:init') {
    mkdirSync(dirname(dbPath), { recursive: true });
    const host = await openLocalHost({ dbPath });
    console.log(JSON.stringify({ ok: true, dbPath, owner: host.owner }));
    host.close();
  } else if (command === 'dev:local') {
    const port = Number(arg('port', process.env.NOA_PORT ?? '8787'));
    const { server } = await createLocalServer({ dbPath, port });
    server.listen(port, '127.0.0.1', () => console.log(`NOA local MCP http://127.0.0.1:${port}/mcp`));
  } else if (command === 'archive:export') {
    const out = resolve(arg('out', 'local-archive.json')!);
    const host = await openLocalHost({ dbPath });
    const header = await host.call('archive_export', { pageBytes: 48000 });
    if (!header.ok) throw new Error(JSON.stringify(header));
    const chunks = [];
    for (let page = 0; page < header.data.pages; page++) {
      const part = await host.call('archive_export', { pageBytes: 48000, page, archiveId: header.data.archiveId });
      if (!part.ok) throw new Error(JSON.stringify(part));
      chunks.push(Buffer.from(part.data.base64, 'base64'));
    }
    const text = Buffer.concat(chunks);
    writeFileSync(out, text);
    console.log(JSON.stringify({ ok: true, out, bytes: text.length, sha256: header.data.sha256, archiveId: header.data.archiveId }));
    host.close();
  } else if (command === 'archive:import') {
    const file = resolve(arg('file', 'local-archive.json')!);
    const archive = JSON.parse(readFileSync(file, 'utf8'));
    const host = await openLocalHost({ dbPath: process.env.NOA_IMPORT_DB ?? `${root}/deploy/data/imported.sqlite`, seed: false });
    const result = await host.call('archive_import', { ...archive, sha256: archive.sha256 ?? undefined });
    console.log(JSON.stringify(result));
    host.close();
  } else if (command === 'test:smoke') {
    const result = await runSmoke({ dbPath: `${root}/deploy/data/smoke-${Date.now()}.sqlite` });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } else usage();
} catch (error: any) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
