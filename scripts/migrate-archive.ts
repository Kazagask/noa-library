import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { FsStore } from '../packages/library/fs-store.ts';
import { migrateArchive, buildSitesBundle, type MigrationMode } from '../packages/library/archive-migration.ts';
import { writeJsonAtomic } from '../packages/core/util.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);
const args = process.argv.slice(2);
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

function main(): void {
  const cmd = args[0] ?? 'migrate';
  if (cmd === 'bundle') {
    const out = resolve(value('--out'));
    const result = buildSitesBundle(store, value('--campaign'), {
      authorityEpoch: Number(value('--epoch', '1')),
      assetRefs: value('--assets').split(',').filter(Boolean)
    });
    if (result.ok && out) { mkdirSync(dirname(out), { recursive: true }); writeJsonAtomic(out, result.data); }
    process.stdout.write(`${JSON.stringify(result.ok && out ? { ok: true, out, format: 'noa-bundle', version: 2 } : result, null, 2)}\n`);
    return;
  }
  const result = migrateArchive(store, {
    campaignArchivePath: resolve(value('--campaign-archive')),
    personaArchivePath: value('--persona-archive') ? resolve(value('--persona-archive')) : undefined,
    originalArchivePath: value('--original-archive') ? resolve(value('--original-archive')) : undefined,
    campaignId: value('--campaign'),
    mode: value('--mode', 'dry-run') as MigrationMode,
    at: value('--at') || undefined,
    authorityEpoch: Number(value('--epoch', '1'))
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main();
