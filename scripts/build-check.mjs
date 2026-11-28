#!/usr/bin/env node
/** Dependency-free production-entry build check: syntax/import graph + source manifest. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
try {
  await import('../apps/sites/src/worker.js');
  const manifest = JSON.parse(execFileSync(process.execPath, ['scripts/source-manifest.mjs', '--out=reports/source-manifest.json'], { cwd: root, encoding: 'utf8' }).trim());
  console.log(JSON.stringify({ ok: true, entry: 'apps/sites/src/worker.js', files: manifest.files, sha256: manifest.rootSha256 }));
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}
