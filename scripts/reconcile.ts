import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsStore } from '../packages/library/fs-store.ts';
import { reconcileDeltas, loadAuthority } from '../packages/library/reconciliation.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);
const args = process.argv.slice(2);
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const result = args[0] === 'authority' ? loadAuthority(store) : reconcileDeltas(store, {
  campaignId: value('--campaign'), deltaDir: value('--deltas'), apply: args.includes('--apply'), at: value('--at') || undefined
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
