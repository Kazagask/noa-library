#!/usr/bin/env node
/**
 * 生成 V2.2.4 容量验收合成夹具（不含正式数据）。
 * 用法：node scripts/generate-scale-fixtures.mjs --scales=1,5,10 [--out=backups/synthetic]
 * 每个夹具包含放大的 working/checkpoint 负载与事件/回执/记忆计数，供 Sites 隔离 D1 导入。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialVault } from '../apps/sites/src/vault.js';

const root = resolve(process.cwd());
const outDir = resolve(root, process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? 'backups/synthetic');
const scales = (process.argv.find(a => a.startsWith('--scales='))?.slice(9) ?? '1').split(',').map(Number).filter(n => n > 0);
mkdirSync(outDir, { recursive: true });
for (const scale of scales) {
  const doc = initialVault();
  const line = doc.campaigns.demo.lines['wl-main'];
  const baseEpisodes = Array.isArray(line.episodes) ? line.episodes : [];
  line.episodes = Array.from({ length: 486 * scale }, (_, i) => ({
    ...baseEpisodes[i % baseEpisodes.length],
    id: `ep-scale-${scale}-${i}`,
    title: `合成情景 ${i}`,
    sourceEventId: `evt-scale-${scale}-${i}`,
    summary: `合成容量负载 ${i} ${'x'.repeat(200)}`
  }));
  line.entities = Array.from({ length: 20 * scale }, (_, i) => ({
    ...(line.entities[0] ?? {}), id: `entity.scale-${scale}-${i}`, name: `实体 ${i}`, type: 'generic'
  }));
  line.relations = Array.from({ length: 48 * scale }, (_, i) => ({
    ...(line.relations[0] ?? {}), id: `rel-scale-${scale}-${i}`,
    subject: `entity.scale-${scale}-${i % (20 * scale)}`,
    object: `entity.scale-${scale}-${(i + 1) % (20 * scale)}`
  }));
  line.working.largePayload = 'p'.repeat(3_100_000 + (scale - 1) * 1_000_000);
  line.working.pendingEvents = Array.from({ length: 245 * scale }, (_, i) => ({ id: `todo.scale-${scale}-${i}`, status: 'open', action: `action-${i}` }));
  line.state.revision = 1365;
  doc.events = Array.from({ length: 1992 * scale }, (_, i) => ({ id: `evt-scale-${scale}-${i}`, campaignId: 'demo', worldlineId: 'wl-main', at: new Date(1700000000000 + i * 1000).toISOString(), op: 'synthetic' }));
  doc.receipts = Object.fromEntries(Array.from({ length: 1372 * scale }, (_, i) => [`demo:wl-main:synth-${scale}-${i}`, { fingerprint: `f-${i}`, receipt: { id: `req-synth-${scale}-${i}`, op: 'event_commit', status: 'applied', campaignId: 'demo', worldlineId: 'wl-main', idempotencyKey: `synth-${scale}-${i}`, appliedRevision: 1, hash: 'synthetic' } }]));
  const file = resolve(outDir, `v224-${scale}x.json`);
  writeFileSync(file, JSON.stringify({ format: 'noa-sites-v2', document: doc }));
  console.log(JSON.stringify({ scale, file, bytes: Buffer.byteLength(JSON.stringify(doc), 'utf8'), episodes: line.episodes.length, events: doc.events.length, receipts: Object.keys(doc.receipts).length }));
}
