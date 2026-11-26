import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readJson } from '../core/util.ts';
import type { SnapshotRepo } from './store.ts';
import type { ChapterSummary } from './lifecycle.ts';

export function summariesPath(repo: SnapshotRepo, campaignId: string): string {
  return join(repo.root, 'campaigns', campaignId, 'memory', 'governance', 'summaries.json');
}
export function readSummaries(repo: SnapshotRepo, campaignId: string): Record<string, ChapterSummary> {
  const path = summariesPath(repo, campaignId);
  return existsSync(path) ? readJson(path) : {};
}
