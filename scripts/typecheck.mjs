#!/usr/bin/env node
/** Focused type check for NOA-INFRA host/test surface; reports pre-existing baseline errors separately. */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
let output = '';
try { output = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.typecheck.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (error) { output = String(error.stdout ?? '') + String(error.stderr ?? ''); }
const lines = output.split(/\r?\n/).filter(Boolean);
const local = lines.filter(line => /^(packages\/local|tests\/local-|tests\/storage|tests\/save481|tests\/miniflare)/.test(line));
const report = { ok: local.length === 0, localErrors: local, baselineErrors: lines.filter(line => !local.includes(line) && /error TS/.test(line)), allLines: lines.length };
mkdirSync(resolve(root, 'reports'), { recursive: true });
writeFileSync(resolve(root, 'reports/local-typecheck.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, localErrors: local.length, baselineErrors: report.baselineErrors.length, report: 'reports/local-typecheck.json' }));
process.exit(report.ok ? 0 : 1);
