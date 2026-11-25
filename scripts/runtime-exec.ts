import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, parseYaml } from '../packages/core/util.ts';
import {
  runtimeStatus, submitRequest, executeRequest, executeAll, readReceipt
} from '../packages/runtime/github-native.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const [cmd, ...rest] = process.argv.slice(2);
const arg = (key: string, fallback = ''): string => {
  const i = rest.indexOf(`--${key}`);
  return i >= 0 ? (rest[i + 1] ?? fallback) : fallback;
};

function out(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function defaultCampaign(): string {
  const manifest = parseYaml(readText(join(ROOT, 'manifest.yaml')));
  return manifest.campaigns?.find((c: any) => c.status === 'active')?.id ?? manifest.campaigns?.[0]?.id ?? 'demo';
}

function main(): void {
  switch (cmd) {
    case 'status':
      out(runtimeStatus(ROOT, arg('campaign') || defaultCampaign(), arg('worldline', 'wl-main')));
      break;
    case 'submit':
      out(submitRequest(ROOT, JSON.parse(readText(resolve(arg('file'))))));
      break;
    case 'execute':
      out(executeRequest(ROOT, JSON.parse(readText(resolve(arg('file')))), { baseCommitSha: arg('base-sha') || undefined }));
      break;
    case 'all':
      out(executeAll(ROOT, { baseCommitSha: arg('base-sha') || undefined }));
      break;
    case 'receipt':
      out(readReceipt(ROOT, arg('id')));
      break;
    default:
      out({ ok: false, code: 'unknown_command', message: '用法: status | submit --file | execute --file | all | receipt --id' });
      process.exitCode = 1;
  }
}

main();
