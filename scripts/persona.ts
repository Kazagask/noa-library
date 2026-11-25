import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsStore } from '../packages/library/fs-store.ts';
import { loadPersona, importPersona, type PersonaImportInput } from '../packages/library/persona.ts';
import { readJson, readText } from '../packages/core/util.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new FsStore(ROOT);
const [cmd, ...rest] = process.argv.slice(2);
const arg = (key: string, fallback = ''): string => {
  const i = rest.indexOf(`--${key}`);
  return i >= 0 ? (rest[i + 1] ?? fallback) : fallback;
};

function out(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function main(): void {
  switch (cmd) {
    case 'show': out(loadPersona(store)); break;
    case 'import': {
      const file = resolve(arg('file'));
      const raw = readText(file);
      const records = file.endsWith('.jsonl')
        ? raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        : readJson(file);
      const input: PersonaImportInput = {
        kind: arg('kind') as PersonaImportInput['kind'],
        records: Array.isArray(records) ? records : [records],
        source: arg('source', file),
        idempotencyKey: arg('key'),
        apply: rest.includes('--apply')
      };
      out(importPersona(store, input));
      break;
    }
    default:
      out({ ok: false, code: 'unknown_command', message: '用法: show | import --kind --file --key --source [--apply]' });
      process.exitCode = 1;
  }
}

main();
