import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readText, sha256, writeJsonAtomic, listFiles } from '../packages/core/util.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const cmd = args[0] ?? 'check';
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).filter(Boolean).map(f => join(ROOT, f));
  } catch { return listFiles(ROOT).filter(f => !f.includes(`${join(ROOT, '.git')}`)); }
}

function privateCandidates(): string[] {
  return trackedFiles().filter(abs => {
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (rel.startsWith('campaigns/demo/') || rel.startsWith('tests/fixtures/')) return false;
    return rel.startsWith('campaigns/') || rel.startsWith('personas/noa/memory/') ||
      rel.startsWith('runtime/receipts/') || rel.startsWith('runtime/rejected/') ||
      rel.startsWith('vault/') || rel.endsWith('.env') || rel.endsWith('.token');
  });
}

function secretMarkers(file: string): string[] {
  let text = '';
  try { text = readText(file); } catch { return []; }
  const markers = ['ghp_', 'sk-', 'AIza', 'BEGIN PRIVATE KEY', 'NOA_API_TOKENS={"'];
  return markers.filter(m => text.includes(m) && !file.endsWith('.example'));
}

function out(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

if (cmd === 'check') {
  const files = trackedFiles();
  const risky = files.flatMap(f => secretMarkers(f).map(marker => ({ path: relative(ROOT, f), marker })));
  const candidates = privateCandidates().map(f => relative(ROOT, f));
  out({ ok: risky.length === 0, trackedFiles: files.length, secretMarkers: risky, privateDataCandidates: candidates, note: 'check 为只读扫描，不修改文件。' });
  if (risky.length) process.exitCode = 1;
} else if (cmd === 'plan' || cmd === 'apply') {
  const files = privateCandidates();
  const plan = files.map(f => ({ path: relative(ROOT, f).replace(/\\/g, '/'), hash: sha256(readText(f)) }));
  if (cmd === 'plan') { out({ dryRun: true, count: plan.length, files: plan }); }
  else {
    const vault = resolve(value('--vault'));
    if (!vault) { out({ ok: false, code: 'missing_vault', message: 'apply 需要 --vault <私有目录>' }); process.exitCode = 1; }
    else {
      let moved = 0;
      for (const item of plan) {
        const target = join(vault, item.path);
        mkdirSync(join(target, '..'), { recursive: true });
        copyFileSync(join(ROOT, item.path), target);
        moved++;
      }
      writeJsonAtomic(join(vault, 'vault-manifest.json'), { generatedAt: new Date().toISOString(), source: ROOT, files: plan });
      out({ ok: true, copied: moved, vault, note: '复制而非删除；请人工确认公开仓不再保留这些文件后再删除。' });
    }
  }
} else {
  out({ ok: false, code: 'unknown_command', message: '用法: check | plan | apply --vault <dir>' });
  process.exitCode = 1;
}
