#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const files = ['packages/local/host.ts','packages/local/http.ts','packages/local/stdio.ts','packages/local/cli.ts'];
const forbidden = [/apps\/sites\/test\//, /packages\/server\//];
for (const file of files) {
  const text = readFileSync(resolve(root, file), 'utf8');
  for (const pattern of forbidden) if (pattern.test(text)) { console.error(`boundary violation: ${file} imports ${pattern}`); process.exit(1); }
}
console.log(JSON.stringify({ ok: true, checked: files.length }));
