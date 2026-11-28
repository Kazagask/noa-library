#!/usr/bin/env node
/** Local quality gate: tests, MCP smoke, build, boundary check, report. */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, args) => { const started = Date.now(); try { const output = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); return { ok: true, output, ms: Date.now() - started }; } catch (error) { return { ok: false, output: String(error.stdout ?? '') + String(error.stderr ?? ''), ms: Date.now() - started, code: error.status ?? 1 }; } };
const tests = run(process.execPath, ['--test', 'tests/*.test.ts']);
const smoke = run(process.execPath, ['packages/local/cli.ts', 'test:smoke']);
const build = run(process.execPath, ['scripts/build-check.mjs']);
const boundary = run(process.execPath, ['scripts/boundary-check.mjs']);
const pass = (tests.output.match(/# pass (\d+)/) ?? [])[1] ?? '0';
const fail = (tests.output.match(/# fail (\d+)/) ?? [])[1] ?? '?';
let smokeJson = null; try { smokeJson = JSON.parse(smoke.output.slice(smoke.output.indexOf('{'))); } catch {}
const checks = { tests: tests.ok, smoke: smoke.ok && smokeJson?.ok === true, build: build.ok, boundary: boundary.ok };
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), release: '2.2.4-storage-reliability', environment: { node: process.version, platform: process.platform, adapter: 'LocalD1(node:sqlite); production=Cloudflare D1' }, checks, tests: { pass: Number(pass), fail: Number(fail), ms: tests.ms }, smoke: { ok: smokeJson?.ok === true, checks: smokeJson?.checks ?? [], ms: smoke.ms }, build: { ok: build.ok, ms: build.ms }, boundary: { ok: boundary.ok, ms: boundary.ms }, commands: ['node --test tests/*.test.ts', 'node packages/local/cli.ts test:smoke', 'node scripts/build-check.mjs', 'node scripts/boundary-check.mjs'], logs: { tests: tests.output.slice(-4000), smoke: smoke.output.slice(-4000), build: build.output.slice(-2000), boundary: boundary.output.slice(-2000) } };
mkdirSync(resolve(root, 'reports'), { recursive: true });
writeFileSync(resolve(root, 'reports/local-gate.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, tests: report.tests, smoke: report.smoke.ok, report: 'reports/local-gate.json' }));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
