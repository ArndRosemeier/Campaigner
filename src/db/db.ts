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
} from '@/domain';
import type { Id } from '@/domain';

/**
 * The single Dexie database (01-DATA-MODEL §Dexie schema). All IndexedDB
 * access goes through `/src/db` — components never touch this directly.
 */
export class CampaignerDB extends Dexie {
  campaigns!: Table<Campaign, Id>;
  artifacts!: Table<Artifact, Id>;
  revisions!: Table<ArtifactRevision, Id>;
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
  }
}

/** The app-wide database instance. */
export const db = new CampaignerDB();
