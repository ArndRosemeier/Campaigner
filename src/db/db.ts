import Dexie, { type Table } from 'dexie';

import type {
  Artifact,
  ArtifactRevision,
  Campaign,
  ChunkEmbedding,
  Persona,
  PersonaRun,
  RuleChunk,
  Rulebook,
  Settings,
  StoredImage,
} from '@/domain';
import type { Id } from '@/domain';

/**
 * The single Dexie database (01-DATA-MODEL §Dexie schema). All IndexedDB
 * access goes through `/src/db` — components never touch this directly.
 *
 * Version 2 (07-MILESTONE-3 M3-A): new `images` table; artifacts gain
 * `imageIds`/`coverImageId`; runs gain `targetArtifactId`. Existing rows get
 * defaults in the upgrade function — existing version blocks are never
 * mutated.
 */
export class CampaignerDB extends Dexie {
  campaigns!: Table<Campaign, Id>;
  artifacts!: Table<Artifact, Id>;
  revisions!: Table<ArtifactRevision, Id>;
  images!: Table<StoredImage, Id>;
  rulebooks!: Table<Rulebook, Id>;
  chunks!: Table<RuleChunk, Id>;
  embeddings!: Table<ChunkEmbedding, string>;
  personas!: Table<Persona, Id>;
  runs!: Table<PersonaRun, Id>;
  settings!: Table<Settings, string>;

  constructor() {
    super('campaigner');
    this.version(1).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt',
      revisions: 'id, artifactId, [artifactId+revision]',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      settings: 'id',
    });
    this.version(2)
      .stores({
        campaigns: 'id, name',
        artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt',
        revisions: 'id, artifactId, [artifactId+revision]',
        images: 'id, campaignId',
        rulebooks: 'id, system, status',
        chunks: 'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas: 'id, &slug',
        runs: 'id, campaignId, personaId, status, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.toCollection().modify((artifact: Record<string, unknown>) => {
          if (artifact.imageIds === undefined) artifact.imageIds = [];
          if (artifact.coverImageId === undefined) artifact.coverImageId = null;
        });
        const runs = tx.table('runs');
        await runs.toCollection().modify((run: Record<string, unknown>) => {
          if (run.targetArtifactId === undefined) run.targetArtifactId = null;
        });
      });
  }
}

/** The app-wide database instance. */
export const db = new CampaignerDB();
