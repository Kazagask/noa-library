import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsStore } from '../packages/library/fs-store.ts';
import { migrateHistory } from '../packages/library/migration.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);
const args = process.argv.slice(2);
const values = (flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) { out.push(resolve(args[++i])); }
  return out;
};
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

const result = migrateHistory(store, {
  inputPaths: values('--input'),
  campaignId: value('--campaign') || undefined,
  apply: args.includes('--apply')
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
