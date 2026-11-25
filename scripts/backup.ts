import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { FsStore } from '../packages/library/fs-store.ts';
import { exportFull, exportIncremental, verify, diff, importEnvelope } from '../packages/backup/sync.ts';
import { readJson, writeJsonAtomic } from '../packages/core/util.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);
const args = process.argv.slice(2);
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

function save(result: any): void {
  const out = value('--out');
  if (out && result.ok) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeJsonAtomic(resolve(out), result.data); process.stdout.write(`${JSON.stringify({ ok: true, out })}\n`); }
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function main(): void {
  const cmd = args[0] ?? 'export-full';
  const campaignId = value('--campaign');
  const parent = value('--parent-file') ? readJson(resolve(value('--parent-file'))) : undefined;
  if (cmd === 'export-full') save(exportFull(store, campaignId, { authorityEpoch: Number(value('--epoch', '0')) || undefined }));
  else if (cmd === 'export-inc') save(exportIncremental(store, campaignId, {
    stateRevision: Number(value('--state-revision', '0')), memoryRevision: Number(value('--memory-revision', '0')),
    seq: Number(value('--seq', '0'))
  }, { authorityEpoch: Number(value('--epoch', '0')) || undefined, parent }));
  else if (cmd === 'verify') save(verify(readJson(resolve(value('--file')))));
  else if (cmd === 'diff') save(diff(readJson(resolve(value('--a'))), readJson(resolve(value('--b')))));
  else if (cmd === 'import') save(importEnvelope(store, readJson(resolve(value('--file'))), {
    expectedAuthorityEpoch: Number(value('--epoch', '0')) || undefined, parent
  }));
  else save({ ok: false, code: 'unknown_command', message: 'export-full|export-inc|verify|diff|import' });
}

main();
