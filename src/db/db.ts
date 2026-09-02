import Dexie, { type Table } from 'dexie';

import type {
  AnyArtifact,
  ArtifactRevision,
  Battle,
  Campaign,
  ChunkEmbedding,
  Deliverable,
  Module,
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
 *
 * Version 6 (08-MODULE-DESIGNER M4-A): new `modules` table; artifacts gain
 * `aliases: []`.
 *
 * Version 7 (08-MODULE-DESIGNER M4-C): modules gain `entityKinds: []`.
 *
 * Version 8 (fix-01): modules gain the name-normalization pass state.
 *
 * Version 9 (09-MILESTONE-5 M5-B): new `battles` table (one live battle per
 * session); encounter artifacts gain `mapImageId: null` and images gain
 * `role: 'artwork'` (M5-C backfills; the `pc` artifact kind needs no
 * migration).
 */
export class CampaignerDB extends Dexie {
  campaigns!: Table<Campaign, Id>;
  artifacts!: Table<AnyArtifact, Id>;
  revisions!: Table<ArtifactRevision, Id>;
  images!: Table<StoredImage, Id>;
  rulebooks!: Table<Rulebook, Id>;
  chunks!: Table<RuleChunk, Id>;
  embeddings!: Table<ChunkEmbedding, string>;
  personas!: Table<Persona, Id>;
  runs!: Table<PersonaRun, Id>;
  deliverables!: Table<Deliverable, Id>;
  modules!: Table<Module, Id>;
  battles!: Table<Battle, Id>;
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
        deliverables: 'id, campaignId',
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
    // M3-B (07-MILESTONE-3): encounter monster entries gain a `source`
    // discriminated union; pre-M3 rows become name-only ({ type: 'none' }).
    this.version(3)
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
        deliverables: 'id, campaignId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.where('kind').equals('encounter').modify((artifact: {
          data?: { monsters?: { source?: unknown }[] };
        }) => {
          for (const monster of artifact.data?.monsters ?? []) {
            if (monster.source === undefined) monster.source = { type: 'none' };
          }
        });
      });
    // M3-C (07-MILESTONE-3): session artifacts gain the play-mode scene
    // checklist and quick log; pre-M3-C rows get empty defaults.
    this.version(4)
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
        deliverables: 'id, campaignId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.where('kind').equals('session').modify((artifact: {
          data?: { scenes?: unknown; log?: unknown };
        }) => {
          artifact.data ??= {};
          if (artifact.data.scenes === undefined) artifact.data.scenes = [];
          if (artifact.data.log === undefined) artifact.data.log = '';
        });
      });
    // M3-D (07-MILESTONE-3): new deliverables table (module PDF outlines);
    // no data migration needed — the table starts empty.
    this.version(5)
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
        deliverables: 'id, campaignId',
        settings: 'id',
      });
    // M4-A (08-MODULE-DESIGNER): new `modules` table; artifacts gain the
    // `aliases` list (wiki-link alternate names) — existing rows default to [].
    this.version(6)
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
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.toCollection().modify((artifact: Record<string, unknown>) => {
          if (artifact.aliases === undefined) artifact.aliases = [];
        });
      });
    // M4-C (08-MODULE-DESIGNER): modules gain `entityKinds` (the entity types
    // the generator records for names it introduces) — pre-M4-C rows default
    // to [] (no heuristic is invented for them).
    this.version(7)
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
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const modules = tx.table('modules');
        await modules.toCollection().modify((module: Record<string, unknown>) => {
          if (module.entityKinds === undefined) module.entityKinds = [];
        });
      });
    // fix-01 (docs/fix-01-entity-name-normalization.md): modules gain the
    // name-normalization pass state — pre-fix rows have never been normalized
    // (false), carry no error and no pending rewrite proposals.
    this.version(8)
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
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const modules = tx.table('modules');
        await modules.toCollection().modify((module: Record<string, unknown>) => {
          if (module.entityNamesNormalized === undefined) module.entityNamesNormalized = false;
          if (module.entityNormalizationError === undefined) module.entityNormalizationError = '';
          if (module.entityRewriteProposals === undefined) module.entityRewriteProposals = null;
        });
      });
    // M5 (09-MILESTONE-5): new `battles` table (one live battle per session).
    // M5-C schema backfills: encounter artifacts gain `mapImageId: null`
    // (the designed battlemap) and images gain `role: 'artwork'` (map-role
    // images bypass the 1600px intake re-encode). The `pc` artifact kind
    // needs no migration.
    this.version(9)
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
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, sessionId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.toCollection().modify((artifact: Record<string, unknown>) => {
          if (artifact.kind === 'encounter' && artifact.data !== undefined && artifact.data !== null) {
            const data = artifact.data as Record<string, unknown>;
            if (data.mapImageId === undefined) data.mapImageId = null;
          }
        });
        const images = tx.table('images');
        await images.toCollection().modify((image: Record<string, unknown>) => {
          if (image.role === undefined) image.role = 'artwork';
        });
      });

    // M6-A (10-MILESTONE-6): artifacts gain the ownership fields —
    // `moduleId` (set ⇔ owned by that module) alongside the existing
    // `campaignId`. Scope is derived from the pair; global artifacts
    // (campaignId null) arrive in M6-C and simply drop out of the
    // campaignId indexes. The upgrade backfills `moduleId: null` — no
    // existing row is module- or global-scoped.
    this.version(10)
      .stores({
        campaigns: 'id, name',
        artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
        revisions: 'id, artifactId, [artifactId+revision]',
        images: 'id, campaignId',
        rulebooks: 'id, system, status',
        chunks: 'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas: 'id, &slug',
        runs: 'id, campaignId, personaId, status, updatedAt',
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, sessionId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.toCollection().modify((artifact: Record<string, unknown>) => {
          if (artifact.moduleId === undefined) artifact.moduleId = null;
        });
      });

    // M6-E (10-MILESTONE-6): the module reader becomes the only play view.
    // Live battles cannot be truthfully re-anchored from retired session
    // artifacts, so v11 clears them. Session notes are retired and their
    // removal count is persisted for a one-time user-visible notice.
    this.version(11)
      .stores({
        campaigns: 'id, name',
        artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
        revisions: 'id, artifactId, [artifactId+revision]',
        images: 'id, campaignId',
        rulebooks: 'id, system, status',
        chunks: 'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas: 'id, &slug',
        runs: 'id, campaignId, personaId, status, updatedAt',
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, moduleId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        await tx.table('battles').clear();
        const artifacts = tx.table('artifacts');
        const sessions = (await artifacts.where('kind').equals('session').toArray()) as {
          id: Id;
        }[];
        const sessionIds = sessions.map((session) => session.id);
        if (sessionIds.length > 0) {
          await tx.table('revisions').where('artifactId').anyOf(sessionIds).delete();
          await artifacts
            .toCollection()
            .modify((artifact: { links?: { targetId: Id; relation: string }[] }) => {
              if (artifact.links === undefined) return;
              artifact.links = artifact.links.filter((link) => !sessionIds.includes(link.targetId));
            });
          await artifacts.bulkDelete(sessionIds);
        }
        const settings = tx.table('settings');
        const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
        await settings.put({
          ...(existing ?? {}),
          id: 'settings',
          retiredSessionNotesRemoved: sessionIds.length,
        });
      });

    // Encounter generator B (11-ENCOUNTER-GENERATOR): additive authored
    // layout data plus the battle board's layout-cell dimensions.
    this.version(12)
      .stores({
        campaigns: 'id, name',
        artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
        revisions: 'id, artifactId, [artifactId+revision]',
        images: 'id, campaignId',
        rulebooks: 'id, system, status',
        chunks: 'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas: 'id, &slug',
        runs: 'id, campaignId, personaId, status, updatedAt',
        deliverables: 'id, campaignId',
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, moduleId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        await tx.table('artifacts').where('kind').equals('encounter').modify(
          (artifact: { data?: Record<string, unknown> }) => {
            artifact.data ??= {};
            if (artifact.data.layout === undefined) artifact.data.layout = null;
          },
        );
        await tx.table('battles').toCollection().modify(
          (battle: { board?: Record<string, unknown> }) => {
            battle.board ??= {};
            if (battle.board.mapLayout === undefined) battle.board.mapLayout = null;
          },
        );
      });
  }
}

/** The app-wide database instance. */
export const db = new CampaignerDB();
