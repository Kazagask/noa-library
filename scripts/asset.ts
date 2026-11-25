import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import { AssetStore } from '../packages/assets/asset-store.ts';
import { readJson, parseYaml, writeJsonAtomic, type Result } from '../packages/core/util.ts';

const ROOT = process.env.NOA_ROOT ? resolve(process.env.NOA_ROOT) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const store = new AssetStore(ROOT);
const args = process.argv.slice(2);
const value = (flag: string, fallback = ''): string => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const list = (flag: string): string[] => value(flag).split(',').filter(Boolean);
function out(v: unknown): void { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); }
function pathValue(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

async function main(): Promise<void> {
  const cmd = args[0] ?? 'search';
  let result: Result | Record<string, unknown>;
  switch (cmd) {
    case 'upload': {
      const file = resolve(value('--file'));
      result = await store.upload({
        bytes: readFileSync(file), mediaType: value('--media-type', 'application/octet-stream'),
        filename: value('--filename') || file.split(/[\\/]/).pop() || 'asset',
        source: value('--source', file), kind: (value('--kind', 'original') as any),
        declaredSha256: value('--sha') || undefined, campaignId: value('--campaign') || undefined,
        personaId: value('--persona') || undefined, tags: list('--tags'), adapter: value('--adapter') || undefined
      });
      break;
    }
    case 'import-embedded': {
      const archive = readJson(resolve(value('--archive')));
      const node = pathValue(archive, value('--path'));
      if (!node?.data) { out({ ok: false, code: 'embedded_asset_missing', message: '路径未找到 data 字段' }); process.exitCode = 1; return; }
      const bytes = Buffer.from(String(node.data), node.encoding === 'base64' ? 'base64' : 'utf8');
      result = await store.upload({
        bytes, mediaType: String(node.media_type ?? 'application/octet-stream'),
        filename: String(node.filename ?? 'asset'), source: value('--source', value('--archive')),
        kind: 'original', declaredSha256: String(node.sha256 ?? ''), tags: list('--tags'),
        personaId: value('--persona') || undefined, adapter: value('--adapter') || undefined
      });
      if (result.ok && value('--node')) {
        const linked = store.link((result as any).data.assetId, value('--node'), value('--predicate', '证据'), list('--known-by'), value('--note'));
        result = { ok: linked.ok, data: { ...(result as any).data, link: (linked as any).data, code: (linked as any).code } } as Result;
      }
      break;
    }
    case 'resolve': result = await store.resolve(value('--id'), value('--viewer', 'gm')); break;
    case 'search': result = store.search({ query: value('--query'), nodeId: value('--node') || undefined, type: value('--type') || undefined, tags: list('--tags'), limit: Number(value('--limit', '20')) }); break;
    case 'link': result = store.link(value('--id'), value('--node'), value('--predicate', '关联'), list('--known-by'), value('--note')); break;
    case 'revise': result = store.revise(value('--id'), JSON.parse(value('--patch', '{}'))); break;
    case 'gc': result = await store.gc({ dryRun: !args.includes('--apply') }); break;
    default: result = { ok: false, code: 'unknown_command', message: 'upload|import-embedded|resolve|search|link|revise|gc' };
  }
  out(result);
  if ((result as any).ok === false) process.exitCode = 1;
}

main().catch(err => { out({ ok: false, code: 'internal_error', message: String(err?.message ?? err) }); process.exitCode = 1; });
