#!/usr/bin/env node
/** V2.2.4 持久化对象容量审计：基于备份文档，按对象统计 UTF-8 字节，标出 D1 2MB 单行风险。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const input = process.argv.find(a => a.startsWith('--input='))?.slice(8) ?? 'backups/R1365/noa-library-backup.json';
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'reports/v224-capacity-audit.json';
const doc = JSON.parse(readFileSync(resolve(root, input), 'utf8')).document;
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const rows = [];
const add = (kind, scope, id, value) => rows.push({ kind, scope, id, bytes: bytes(value) });
for (const [campaignId, campaign] of Object.entries(doc.campaigns ?? {})) for (const [worldlineId, snap] of Object.entries(campaign.lines ?? {})) {
  add('state', `${campaignId}/${worldlineId}`, 'state', snap.state);
  add('working', `${campaignId}/${worldlineId}`, 'working', snap.working);
  add('manifest', `${campaignId}/${worldlineId}`, 'manifest', snap.manifest);
  for (const kind of ['entities', 'relations', 'episodes']) for (const row of snap[kind] ?? []) add(kind.slice(0, -1), `${campaignId}/${worldlineId}`, row.id, row);
}
for (const [key, value] of Object.entries(doc.checkpoints ?? {})) add('checkpoint', key.split(':')[0], key, value.snapshot ?? value);
for (const value of Object.values(doc.receipts ?? {})) add('receipt', 'owner', value.receipt?.id ?? 'receipt', value);
for (const event of doc.events ?? []) add('event', `${event.campaignId}/${event.worldlineId}`, event.id ?? event.eventId, event);
const sorted = rows.sort((a, b) => b.bytes - a.bytes);
const over1m = sorted.filter(r => r.bytes >= 1_000_000);
const over2m = sorted.filter(r => r.bytes >= 2_000_000);
const byKind = {};
for (const row of rows) {
  const bucket = byKind[row.kind] ??= { count: 0, bytes: 0, maxBytes: 0, maxId: null };
  bucket.count++; bucket.bytes += row.bytes;
  if (row.bytes > bucket.maxBytes) { bucket.maxBytes = row.bytes; bucket.maxId = row.id; }
}
const report = {
  input, thresholdBytes: 2_000_000, hardLimit: 'Cloudflare D1 2,000,000 bytes per string/BLOB/row',
  summary: { objects: rows.length, over1m: over1m.length, over2m: over2m.length, maxBytes: sorted[0]?.bytes ?? 0 },
  byKind, top20: sorted.slice(0, 20), over1m, over2m,
  note: 'checkpoint 已改为 chunk 表；state/working/单条记忆/回执仍按 2MB 硬限审计。'
};
writeFileSync(resolve(root, out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
