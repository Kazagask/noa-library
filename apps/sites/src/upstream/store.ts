import type { CampaignManifest, Entity, Episode, Relation } from './domain.ts';

export interface Snapshot {
  manifest: CampaignManifest;
  state: Record<string, any>;
  entities: Entity[];
  relations: Relation[];
  episodes: Episode[];
  working: Record<string, any>;
}

export interface Checkpoint {
  id: string;
  campaignId: string;
  worldlineId: string;
  label: string;
  createdAt: string;
  snapshot: Snapshot;
  stateHash: string;
  memoryHash: string;
}

export interface SnapshotRepo {
  readonly root: string;
  read(campaignId: string, worldlineId: string): Snapshot;
  write(campaignId: string, worldlineId: string, snapshot: Snapshot): void;
  writeManifest(campaignId: string, manifest: CampaignManifest): void;
  appendEvent(campaignId: string, event: Record<string, unknown>): void;
  events(campaignId: string, worldlineId: string): Record<string, unknown>[];
  getOperation(key: string): Record<string, unknown> | null;
  putOperation(key: string, result: Record<string, unknown>): void;
  saveCheckpoint(campaignId: string, checkpoint: Checkpoint): void;
  loadCheckpoint(campaignId: string, checkpointId: string): Checkpoint | null;
  listCheckpoints(campaignId: string): Checkpoint[];
  listCampaigns(): { id: string; worldlineId: string; title: string }[];
  listWorldlines(campaignId: string): string[];
  createWorldline(campaignId: string, from: string, to: string, snapshot: Snapshot): void;
}
