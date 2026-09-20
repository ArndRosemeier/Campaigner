import Dexie, { type Table } from 'dexie';

import type {
  AnyArtifact,
  ArtifactRevision,
  Battle,
  Campaign,
  ChunkEmbedding,
  CreatureImage,
  IdeaBoard,
  Module,
  MobPortraitCacheEntry,
  ModuleDocumentVersion,
  Persona,
  PersonaRun,
  RuleChunk,
  Rulebook,
  Settings,
  StoredImage,
  StoredPdf,
} from '@/domain';
import type { Id } from '@/domain';
import { DECLARED_DB_VERSION, purgeLegacyCampaignData } from '@/db/cleanCut';

/**
 * The single Dexie database (01-DATA-MODEL §Dexie schema). All IndexedDB
 * access goes through `/src/db` — components never touch this directly.
 *
 * ONE VERSION, ONCE. The pre-cut chain (versions 1…30, each with its own
 * `.upgrade()` body) was ABOLISHED by the owner's one-time clean-cut amnesty
 * (docs/17 row 278): *"since this app is still in test phase, losing data FOR
 * NOW is no big deal ... i would rather like to abolish any migration code to
 * get to a clean base."* The database NAME (`campaigner`) is kept, and ONE
 * `version(31)` — ABOVE the last stored version, 30 — carries the v30 store
 * block and a single `.upgrade()` body that calls `purgeLegacyCampaignData`.
 *
 * THE VERSION NUMBER IS LOAD-BEARING. Dexie runs only declared versions
 * `>= oldVersion` (`dexie.js:3815`), so declaring `version(1)` against a stored
 * 30 makes `versToRun` EMPTY (`:3816-3818`) and the VersionError fallback
 * (`:4599-4604`) opens the stored database with NO upgrade: the app compiles,
 * opens, looks perfectly healthy, and purges NOTHING. Do not lower it.
 *
 * THE PURGE IS ATOMIC. The body runs inside the IndexedDB `versionchange`
 * transaction, so a throw rolls the whole thing back — the stored version stays
 * where it was, every row survives, and a reload is a clean retry. There is
 * deliberately NO `try`/`catch` around it (see `db/cleanCut.ts`).
 *
 * COMPATIBILITY DISCIPLINE RESUMES HERE: this amnesty is ONE-TIME. The next
 * schema change owes a real `version(32)` with its own `.upgrade()` body.
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
  modules!: Table<Module, Id>;
  battles!: Table<Battle, Id>;
  pdfFiles!: Table<StoredPdf, Id>;
  mobPortraits!: Table<MobPortraitCacheEntry, Id>;
  moduleVersions!: Table<ModuleDocumentVersion, Id>;
  creatureImages!: Table<CreatureImage, Id>;
  ideaBoards!: Table<IdeaBoard, Id>;
  settings!: Table<Settings, string>;

  constructor() {
    super('campaigner');
    this.version(DECLARED_DB_VERSION)
      .stores({
        campaigns: 'id, name',
        artifacts:
          'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
        revisions: 'id, artifactId, [artifactId+revision]',
        images: 'id, campaignId',
        rulebooks: 'id, system, status',
        chunks: 'id, bookId, chunkType, contentHash',
        embeddings: 'contentHash',
        personas: 'id, &slug',
        runs: 'id, campaignId, personaId, status, updatedAt',
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, moduleId, encounterArtifactId',
        pdfFiles: 'id, &bookId',
        mobPortraits: 'id, &creatureKey',
        moduleVersions: 'id, moduleId, createdAt',
        creatureImages: 'id, campaignId, [campaignId+creatureKey]',
        ideaBoards: 'id, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const report = await purgeLegacyCampaignData({ tx });
        // The upgrade runs before React exists and cannot toast, so the report
        // is written into the ONE settings row AppShell reads once (an existing
        // workspace always has one; a fresh install runs no upgrade body at
        // all). The write rides the SAME versionchange transaction, so a failure
        // here aborts the purge with it rather than committing a silent one.
        const settings = tx.table('settings');
        const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
        if (existing === undefined) {
          throw new Error(
            'clean cut: this workspace has campaign data to purge but no settings row to report it in — refusing to purge silently',
          );
        }
        await settings.put({
          ...existing,
          id: 'settings',
          cleanCut: report,
        });
      });
  }
}

/** The app-wide database instance. */
export const db = new CampaignerDB();
