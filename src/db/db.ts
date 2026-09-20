import Dexie, { type Table } from 'dexie';

import type {
  AnyArtifact,
  ArtifactRevision,
  Battle,
  Campaign,
  ChunkEmbedding,
  CreatureImage,
  CreatureKeyFoldDropped,
  IdeaBoard,
  CreatureKeyFoldReport,
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
import {
  foldCreatureKey,
  LEGACY_COMPLEX_BUDGET_NOTE,
  normalizeEncounterShapeData,
} from '@/domain';
import { repairCreatureCitations } from '@/db/creatureRepair';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import { repairMobCopies } from '@/db/mobCopyRepair';

/** Separator between the scope (a campaign id) and the folded key in the v22
 * upgrade's grouping map; a UUID and a JSON key can never contain it. */
const CREATURE_FOLD_SCOPE_SEPARATOR = '\u0000';

/** How many rows the v22 fold re-keyed and merged, accumulated per table. */
interface CreatureKeyFoldTally {
  folded: number;
  merged: number;
  dropped: CreatureKeyFoldDropped[];
}

/**
 * Group creature rows by their FOLDED key, scoped (a no-op scope for the
 * globally unique `mobPortraits`, the campaign id for `creatureImages`), so the
 * v22 upgrade can see a creature that exists under BOTH Unicode compositions.
 * A row whose `creatureKey` is not a string is corrupt and throws (AGENTS rule
 * 1): the unique/composite index means such a row cannot have been written by
 * the app.
 */
function groupCreatureRowsByFoldedKey<TRow extends { id: string; creatureKey: string }>(
  tableLabel: string,
  rows: TRow[],
  scopeOf: (row: TRow) => string,
): Map<string, TRow[]> {
  const groups = new Map<string, TRow[]>();
  for (const row of rows) {
    const stored = row.creatureKey as unknown;
    if (typeof stored !== 'string' || stored === '') {
      throw new Error(
        `creature key fold: a ${tableLabel} row has no creatureKey (id ${row.id})`,
      );
    }
    const mapKey = `${scopeOf(row)}${CREATURE_FOLD_SCOPE_SEPARATOR}${foldCreatureKey(stored)}`;
    const group = groups.get(mapKey);
    if (group === undefined) groups.set(mapKey, [row]);
    else group.push(row);
  }
  return groups;
}

/**
 * Pick the row a merged slot keeps: the NEWER `updatedAt` wins; on a tie the row
 * ALREADY stored under the folded (composed) key wins. Both are deterministic —
 * the pre-fold read path answered a dual-composition key by arbitrary UUID
 * order (`creatureImages`), which is the defect this fixes rather than a
 * preference (docs/17 row 168).
 */
function newerCreatureRow<TRow extends { creatureKey: string; updatedAt: number }>(
  left: TRow,
  right: TRow,
  foldedKey: string,
): TRow {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  const leftCanonical = left.creatureKey === foldedKey;
  const rightCanonical = right.creatureKey === foldedKey;
  if (leftCanonical !== rightCanonical) return leftCanonical ? left : right;
  return left;
}

/**
 * Re-key one creature table's groups to their folded keys, merging any
 * dual-composition duplicate. Losers are removed BEFORE the winner is written
 * so a `&creatureKey` UNIQUE index is never asked to hold two rows at once.
 */
async function foldCreatureRowGroups<
  TRow extends { id: string; creatureKey: string; imageId: string; updatedAt: number },
>(
  tableLabel: 'mobPortraits' | 'creatureImages',
  groups: Map<string, TRow[]>,
  write: (row: TRow) => Promise<unknown>,
  remove: (id: string) => Promise<unknown>,
  tally: CreatureKeyFoldTally,
): Promise<void> {
  for (const [mapKey, group] of groups) {
    const foldedKey = mapKey.slice(mapKey.indexOf(CREATURE_FOLD_SCOPE_SEPARATOR) + 1);
    const first = group[0];
    if (first === undefined) continue;
    let winner = first;
    for (const row of group) winner = newerCreatureRow(winner, row, foldedKey);
    for (const row of group) {
      if (row === winner) continue;
      await remove(row.id);
      tally.merged += 1;
      tally.dropped.push({
        table: tableLabel,
        creatureKey: row.creatureKey,
        imageId: row.imageId,
      });
    }
    if (winner.creatureKey !== foldedKey) {
      await write({ ...winner, creatureKey: foldedKey });
      tally.folded += 1;
    }
  }
}

/** A `creatureKey`-carrying value inside a `battles` row (a token or a frozen
 * seed fighter), read from RAW storage — the stored row may predate the field,
 * so `creatureKey` is genuinely optional here. */
interface StoredCreatureKeyCarrier extends Record<string, unknown> {
  creatureKey?: string | undefined;
}

/** A `battles` row AS STORED. TypeScript's `Battle` describes the CURRENT
 * parsed shape; `stage` (M5-D) and `seedFighters` (M5-C) are present on every
 * row the app wrote after those arcs, but a row written before them carries
 * neither in IndexedDB — so the v22 walk reads the raw shape through this. */
interface StoredBattleRow extends Record<string, unknown> {
  board?: StoredBattleBoard | null;
  seedFighters?: StoredCreatureKeyCarrier[];
}

interface StoredBattleBoard extends Record<string, unknown> {
  tokens?: StoredCreatureKeyCarrier[];
  stage?: (Record<string, unknown> & { tokens?: StoredCreatureKeyCarrier[] }) | null;
}

/** Fold every `creatureKey` in a carrier list, returning the SAME references
 * for carriers that did not change. `chunk:`/`artifact:` keys fold to
 * themselves, so a battle whose keys are all ids is not rewritten. */
function foldCreatureKeyCarriers<T extends { creatureKey?: string | undefined }>(
  carriers: T[],
): { carriers: T[]; folded: number } {
  let folded = 0;
  const next = carriers.map((carrier) => {
    if (carrier.creatureKey === undefined) return carrier;
    const key = foldCreatureKey(carrier.creatureKey);
    if (key === carrier.creatureKey) return carrier;
    folded += 1;
    return { ...carrier, creatureKey: key };
  });
  return { carriers: next, folded };
}

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
 *
 * Version 13 (08-MODULE-DESIGNER M4-B): modules gain the opt-in
 * `includePriorModules: false` continuity flag.
 *
 * Version 14 (source-viewers): new `pdfFiles` table — the ORIGINAL PDF
 * bytes of a PDF-origin book are retained at ingest (one row per book,
 * `&bookId` unique) so the in-app viewer renders them without the file;
 * no migration (the table starts empty; pre-retention books simply have
 * no row — the viewer's loud absent state).
 *
 * Version 15 (docs/11 D10 dungeon preset): encounter artifacts gain
 * `preset: 'standard'`, runs gain `encounterPreset: null`, settings gain
 * `encounterPreset: 'standard'` (additive backfills, M5-C pattern).
 *
 * Version 17 (docs/11 D11/D12 site shape + per-room challenge): encounter
 * artifacts gain `siteShape` (derived from the layout via
 * `normalizeEncounterShapeData`), complex layouts gain `path`, and legacy
 * multi-room complexes gain the under-budget note on `budgetAdvisory`.
 *
 * Version 19 (simple undo, docs/17 ledger row 63): new `moduleVersions`
 * table — durable whole-module-document snapshots taken before every AI
 * change (docs/18 §2.3). Additive store, no migration: the table starts
 * empty and pre-v19 databases carry no undo history.
 *
 * Version 21 (docs/17 row 108): the `deliverables` table is DROPPED. The
 * module IS the PDF's document model, so the outline table (M3-D) has no
 * reader left; the upgrade counts the rows it removed into
 * `settings.deliverablesRemoved`, which `AppShell` reports once — a table
 * drop is never silent.
 *
 * Version 22 (docs/17 row 168): the persisted creature identity is FOLDED onto
 * the comparable form (NFC + trim + case-fold). No store or index changes —
 * the version bump exists only to run the upgrade, which re-keys `mobPortraits`
 * and `creatureImages` rows and the `creatureKey`s inside `battles` rows
 * (board tokens, the saved stage snapshot's tokens and frozen `seedFighters`),
 * merges a creature stored under both compositions by the newer `updatedAt`,
 * and writes the counts into `settings.creatureKeyFold` for `AppShell`.
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

    // Opt-in cross-module continuity (08-MODULE-DESIGNER M4-B): modules gain
    // `includePriorModules: false` — pre-v13 rows never opted in.
    this.version(13)
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
        const modules = tx.table('modules');
        await modules.toCollection().modify((module: Record<string, unknown>) => {
          if (module.includePriorModules === undefined) module.includePriorModules = false;
        });
      });

    // Source-viewers arc: retain the ORIGINAL PDF bytes at ingest (one row
    // per book via the unique `&bookId` index). Empty start — no upgrade;
    // pre-retention books have no row (the viewer's loud absent state).
    this.version(14).stores({
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
      pdfFiles: 'id, &bookId',
      settings: 'id',
    });

    // Dungeon preset (docs/11 D10): encounter artifacts gain `preset:
    // 'standard'`, runs gain `encounterPreset: null`, settings gain
    // `encounterPreset: 'standard'` — additive defaults only, same backfill
    // pattern as the M5-C `mapImageId`.
    this.version(15)
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
        pdfFiles: 'id, &bookId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const artifacts = tx.table('artifacts');
        await artifacts.toCollection().modify((artifact: Record<string, unknown>) => {
          if (artifact.kind === 'encounter' && artifact.data !== undefined && artifact.data !== null) {
            const data = artifact.data as Record<string, unknown>;
            if (data.preset === undefined) data.preset = 'standard';
          }
        });
        const runs = tx.table('runs');
        await runs.toCollection().modify((run: Record<string, unknown>) => {
          if (run.encounterPreset === undefined) run.encounterPreset = null;
        });
        const settings = tx.table('settings');
        await settings.toCollection().modify((setting: Record<string, unknown>) => {
          if (setting.encounterPreset === undefined) setting.encounterPreset = 'standard';
        });
      });

    // Uniqueness for the "one live battle per module" invariant (M6-E): the
    // `moduleId` index becomes UNIQUE (`&moduleId`) — a REAL schema change,
    // hence the version bump (index rebuild), unlike the additive-default
    // bumps around it. ensureBattle's read-then-create window could
    // materialize two live battles for one module under concurrent seeds;
    // the index makes the second put fail loudly (ConstraintError) and the
    // repo converge on the winner's row. No upgrade function: v11 cleared
    // every battle row and rows created since always carry a moduleId, so
    // no duplicate can exist to violate the new index — the rebuild itself
    // is the migration (golden test in tests/db/migration.test.ts).
    this.version(16).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      settings: 'id',
    });

    // Encounter site shape + per-room challenge backfill (docs/11 D11/D12):
    // encounter artifacts gain `siteShape` — derived from the layout exactly
    // as parse-on-read derives it (`normalizeEncounterShapeData`, ONE shared
    // derivation): layout null ⇒ 'single' (uploaded maps behave byte-
    // identical); rooms.length <= 1 ⇒ 'single' (corridors cleared — a
    // one-room arena has none); rooms.length > 1 ⇒ 'complex' with `path`
    // backfilled as the current room-array order, spawn room first when
    // derivable. The backfill exists so the STORED rows agree with what every
    // parse materializes (the battle surface reads `layout.path` and
    // `siteShape` directly) — it complements, never duplicates, the parse
    // boundary. Legacy multi-room complexes also gain the under-budget
    // migration note on `budgetAdvisory` (their rooms carry no per-room
    // challenge targets until the battlemap is regenerated). Additive data
    // only — no index changes, hence no store-shape change.
    this.version(17)
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
        battles: 'id, campaignId, &moduleId',
        pdfFiles: 'id, &bookId',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        await tx.table('artifacts').where('kind').equals('encounter').modify(
          (artifact: { data?: Record<string, unknown> | null }) => {
            if (artifact.data === undefined || artifact.data === null) return;
            const declaredShape = artifact.data.siteShape;
            const normalized = normalizeEncounterShapeData(artifact.data);
            if (declaredShape === undefined && normalized.siteShape === 'complex') {
              normalized.budgetAdvisory = LEGACY_COMPLEX_BUDGET_NOTE;
            }
            if (normalized.budgetAdvisory === undefined) normalized.budgetAdvisory = '';
            artifact.data = { ...normalized };
          },
        );
      });

    // Global mob portrait cache (docs/11 D5 amendment, slice A): new
    // `mobPortraits` table (`id, &chunkId`) mapping a cited stat-block
    // chunkId to its ONE canonical shared-blob portrait imageId. Additive
    // store, NO upgrade function — the table starts empty and existing
    // per-campaign covers are grandfathered (no backfill).
    this.version(18).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &chunkId',
      settings: 'id',
    });

    // Durable module document versions (owner-directed simple undo, docs/17
    // ledger row 63): new `moduleVersions` table (`id, moduleId, createdAt`)
    // holding the WHOLE module parts document byte-exact as it was BEFORE
    // each AI change. Additive store, NO upgrade function — the table starts
    // EMPTY and the upgrade path is the index rebuild itself (the v14/v18
    // precedent for a brand-new table): no existing row is touched, and a
    // pre-v19 database simply has no undo history to carry over (the first
    // AI change after the upgrade starts the stack). `tests/db/migration.test.ts`
    // pins the golden v18 → v19 open (rows preserved, new table empty).
    this.version(19).stores({
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
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &chunkId',
      moduleVersions: 'id, moduleId, createdAt',
      settings: 'id',
    });

    // Core-mob arc (owner-ratified; docs/11 D5 amendment, docs/17 row 106): a
    // bestiary creature is a LIBRARY CITATION, never an artifact, so the table
    // that held a row for one stops being keyed on it and the table that holds
    // what a creature NEEDS appears:
    //
    // - `mobPortraits` keeps its user-visible behaviour and is RE-KEYED from
    //   `&chunkId` to `&creatureKey` (`domain/creature`'s identity: a library
    //   creature's chunk, or an invented mob's content hash). Existing rows are
    //   re-keyed in the upgrade, so generated art survives; a creature with no
    //   artifact at all can now have a canonical portrait.
    // - `creatureImages` is NEW: the per-campaign PRESENTATION row for a
    //   creature that is cited but not owned (an encounter's generic zombie, a
    //   battle token, a prose mention) — one row per (campaign, identity),
    //   holding this campaign's own image blob.
    //
    // The upgrade ALSO runs the ONE loud, idempotent citation repair
    // (`db/creatureRepair`, docs/11 D7): every `npc-ref` whose target carried
    // the retired `data.monsterChunkId` marker is rewritten to the `rulebook`
    // citation of that identity (the marker WAS the identity — lossless), the
    // marked rows are deleted as cache (their covers carried onto the campaign's
    // presentation row first, so no portrait dies with them), and the counts —
    // plus anything the repair could NOT convert, BY NAME — land in settings for
    // the app to show once.
    this.version(20)
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
        battles: 'id, campaignId, &moduleId',
        pdfFiles: 'id, &bookId',
        mobPortraits: 'id, &creatureKey',
        moduleVersions: 'id, moduleId, createdAt',
        creatureImages: 'id, campaignId, [campaignId+creatureKey]',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        // 1. Re-key the portrait slots: an old row keyed by a chunkId becomes
        //    the same creature's IDENTITY key (`domain/creature`'s ONE
        //    spelling), so every generated portrait survives the arc.
        const portraits = tx.table('mobPortraits');
        const rows = (await portraits.toArray()) as Record<string, unknown>[];
        for (const row of rows) {
          const chunkId = row.chunkId;
          if (typeof chunkId !== 'string' || chunkId === '') continue;
          await portraits.delete(row.id);
          // The old key field is dropped, not carried: the schema no longer
          // has it and the identity is the only key a slot answers to.
          const next: Record<string, unknown> = { ...row, creatureKey: `chunk:${chunkId}` };
          delete next.chunkId;
          await portraits.put(next);
        }
        // 2. The citation repair (docs/11 D7) — the incident's own medicine.
        await repairCreatureCitations({ tx });
      });

    // **The deliverables table is GONE** (owner decision, docs/17 row 108:
    // "no need to have 'deliverables' at all, just export decisions if
    // needed"). The module IS the document, so the outline model that stood
    // between a module and its PDF — its own table, its own domain shape, its
    // own editor page — is deleted rather than kept in sync with the module
    // forever.
    //
    // The rows cannot follow the concept: they hold a user-curated OUTLINE no
    // longer has a reader, and keeping the table keeps the concept. So the
    // upgrade DROPS it and COUNTS what it dropped. The count is written to
    // settings and read ONCE by the app shell (`AppShell` —
    // `retiredSessionNotesRemoved`'s precedent) because an upgrade body runs
    // inside Dexie, before React exists, and therefore cannot toast:
    // `deliverablesRemoved` is the owner's account of what the migration
    // deleted. A silent table drop is exactly the silent-loss shape AGENTS
    // rule 1 forbids — this is the loud form.
    this.version(21)
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
        deliverables: null,
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, &moduleId',
        pdfFiles: 'id, &bookId',
        mobPortraits: 'id, &creatureKey',
        moduleVersions: 'id, moduleId, createdAt',
        creatureImages: 'id, campaignId, [campaignId+creatureKey]',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const removed = await tx.table('deliverables').count();
        const settings = tx.table('settings');
        const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
        await settings.put({
          ...(existing ?? {}),
          id: 'settings',
          deliverablesRemoved: removed,
        });
      });

    // **The persisted creature identity is FOLDED** (owner-ratified, docs/17
    // row 168). `contentCreatureKey` keyed a creature by
    // `name.trim().toLowerCase()`, so a Mac-authored (NFD) and a precomposed
    // (NFC) spelling of one name minted DIFFERENT keys — and those STRINGS are
    // an existing identity: a UNIQUE `mobPortraits.creatureKey`, a
    // `creatureImages` composite index, and every battle token. Two portrait
    // slots for one creature, and "one creature, one look" (docs/11 D6) broken
    // silently. The mint folds now (`comparableName`); this upgrade migrates the
    // bytes already stored.
    //
    // NO STORE OR INDEX CHANGES: this version exists ONLY to run the upgrade.
    //
    // The walk, and why each half is here rather than on the read path: a lookup
    // derives the key from a name at read time, so no read-side reconciliation
    // can bridge two compositions once the bytes disagree.
    // 1. `mobPortraits` — UNIQUE `&creatureKey` (delete-then-put when the key
    //    changes; a dual-composition duplicate merges by newer `updatedAt`);
    // 2. `creatureImages` — the per-campaign presentation rows (same merge);
    // 3. `battles` — every `creatureKey` a battle row carries: its board tokens,
    //    the SAVED STAGE SNAPSHOT's tokens (Reset restores those onto the board)
    //    and its frozen `seedFighters` rows (the spawn path dedupes by this key,
    //    so a legacy spelling would seed a duplicate fighter). The brief named
    //    the tokens; the other two carriers hold the SAME identity and are
    //    folded with them so the row cannot disagree with itself.
    // `chunk:` and `artifact:` keys are ids, not names — `foldCreatureKey`
    // returns them byte-identical.
    //
    // Counts and merges are written into settings once (the v21 `deliverables`
    // pattern); a key that cannot be parsed throws out of the upgrade rather
    // than being kept silently.
    this.version(22)
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
        deliverables: null,
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, &moduleId',
        pdfFiles: 'id, &bookId',
        mobPortraits: 'id, &creatureKey',
        moduleVersions: 'id, moduleId, createdAt',
        creatureImages: 'id, campaignId, [campaignId+creatureKey]',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const portraitTally: CreatureKeyFoldTally = { folded: 0, merged: 0, dropped: [] };
        const portraits = tx.table<MobPortraitCacheEntry, Id>('mobPortraits');
        const portraitRows = await portraits.toArray();
        await foldCreatureRowGroups(
          'mobPortraits',
          groupCreatureRowsByFoldedKey('mobPortraits', portraitRows, () => ''),
          (row) => portraits.put(row),
          (id) => portraits.delete(id),
          portraitTally,
        );

        const imageTally: CreatureKeyFoldTally = { folded: 0, merged: 0, dropped: [] };
        const creatureImages = tx.table<CreatureImage, Id>('creatureImages');
        const imageRows = await creatureImages.toArray();
        await foldCreatureRowGroups(
          'creatureImages',
          groupCreatureRowsByFoldedKey('creatureImages', imageRows, (row) => row.campaignId),
          (row) => creatureImages.put(row),
          (id) => creatureImages.delete(id),
          imageTally,
        );

        let battleTokensFolded = 0;
        let seedFightersFolded = 0;
        const battles = tx.table<Battle, Id>('battles');
        const storedBattles = (await battles.toArray()) as unknown as StoredBattleRow[];
        for (const stored of storedBattles) {
          const board = stored.board;
          if (board === undefined || board === null) continue;
          const originalTokens = board.tokens ?? [];
          const tokens = foldCreatureKeyCarriers(originalTokens);
          const stage = board.stage ?? null;
          const stageTokens = stage === null ? null : foldCreatureKeyCarriers(stage.tokens ?? []);
          const originalSeedFighters = stored.seedFighters ?? [];
          const seedFighters = foldCreatureKeyCarriers(originalSeedFighters);
          const folded = tokens.folded + (stageTokens?.folded ?? 0) + seedFighters.folded;
          // A battle whose keys are all ids (`chunk:`) or already composed is
          // left byte-identical — the migration touches only what it folds.
          if (folded === 0) continue;
          battleTokensFolded += tokens.folded + (stageTokens?.folded ?? 0);
          seedFightersFolded += seedFighters.folded;
          await battles.put({
            ...stored,
            board: {
              ...board,
              ...(Array.isArray(board.tokens) ? { tokens: tokens.carriers } : {}),
              ...(stageTokens === null ? {} : { stage: { ...stage, tokens: stageTokens.carriers } }),
            },
            ...(Array.isArray(stored.seedFighters) ? { seedFighters: seedFighters.carriers } : {}),
          } as unknown as Battle);
        }

        const report: CreatureKeyFoldReport = {
          mobPortraitKeysFolded: portraitTally.folded,
          creatureImageKeysFolded: imageTally.folded,
          battleTokenKeysFolded: battleTokensFolded,
          seedFighterKeysFolded: seedFightersFolded,
          mergedRows: portraitTally.merged + imageTally.merged,
          dropped: [...portraitTally.dropped, ...imageTally.dropped],
        };
        const hasWork =
          report.mobPortraitKeysFolded > 0 ||
          report.creatureImageKeysFolded > 0 ||
          report.battleTokenKeysFolded > 0 ||
          report.seedFighterKeysFolded > 0 ||
          report.mergedRows > 0;
        const settings = tx.table('settings');
        const existing = (await settings.get('settings')) as Record<string, unknown> | undefined;
        await settings.put({
          ...(existing ?? {}),
          id: 'settings',
          // An upgrade that folded nothing reports nothing: `null` is the
          // shell's "no toast" state, exactly like an unset field on a fresh
          // install (a fresh database never runs an upgrade body at all).
          creatureKeyFold: hasWork ? report : null,
        });
      });
    // Version 23 (Idea Board): ONE app-level plain-text writing surface
    // (`docs/21-IDEA-BOARD.md`). Additive — a database written before this
    // version simply has no board row, and `ideaBoardRepo.getIdeaBoard`
    // creates the single row on first open. No upgrade body: there is
    // nothing to convert.
    this.version(23).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: null,
      modules: 'id, campaignId, updatedAt',
      battles: 'id, campaignId, &moduleId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &creatureKey',
      moduleVersions: 'id, moduleId, createdAt',
      creatureImages: 'id, campaignId, [campaignId+creatureKey]',
      ideaBoards: 'id, updatedAt',
      settings: 'id',
    });
    // Version 24 (the mob simplification, docs/17 row 248): a mob's library
    // CITATION becomes an authored COPY of the chunk's stats, with the origin
    // label stamped and the `chunk:` portrait identity preserved as an opaque
    // token. The store shape is unchanged — this is a data conversion only —
    // and the whole thing is ONE transaction calling the seam that takes it
    // (`db/mobCopyRepair.repairMobCopies`), exactly like the v20 citation
    // repair above. It converts what resolves and KEEPS the failing pointer,
    // named in the settings report the shell reads once; the startup retry
    // (`db/mobCopyRetry`) heals those rows when the missing pack is installed.
    this.version(24)
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
        deliverables: null,
        modules: 'id, campaignId, updatedAt',
        battles: 'id, campaignId, &moduleId',
        pdfFiles: 'id, &bookId',
        mobPortraits: 'id, &creatureKey',
        moduleVersions: 'id, moduleId, createdAt',
        creatureImages: 'id, campaignId, [campaignId+creatureKey]',
        ideaBoards: 'id, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        await repairMobCopies({ tx, reason: 'upgrade' });
      });
    // Version 25 (docs/17 row 254): a battle belongs to its ENCOUNTER, not to
    // its module. The v16 `&moduleId` UNIQUE index is DROPPED (a module now
    // owns one board PER encounter, and the unique module key would refuse the
    // second encounter's board), `moduleId` stays as a plain index (`Back to
    // module` and `deleteBattlesByModule` still need it) and
    // `encounterArtifactId` becomes an index — the identity every read
    // resolves by (`getBattleByEncounter`). No upgrade body: ADDING a
    // non-unique index and DROPPING a unique one are both safe over existing
    // rows, so the index rebuild itself is the migration. The get-or-create
    // race is now arbitrated by an IndexedDB transaction, not by the index
    // (`ensureBattleForEncounter`) — a unique `&encounterArtifactId` would
    // ABORT this upgrade on any database where the same campaign-scoped
    // encounter was seeded into two modules, which is exactly the row shape the
    // index rebuild must survive rather than refuse.
    this.version(25).stores({
      campaigns: 'id, name',
      artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
      revisions: 'id, artifactId, [artifactId+revision]',
      images: 'id, campaignId',
      rulebooks: 'id, system, status',
      chunks: 'id, bookId, chunkType, contentHash',
      embeddings: 'contentHash',
      personas: 'id, &slug',
      runs: 'id, campaignId, personaId, status, updatedAt',
      deliverables: null,
      modules: 'id, campaignId, updatedAt',
      battles: 'id, campaignId, moduleId, encounterArtifactId',
      pdfFiles: 'id, &bookId',
      mobPortraits: 'id, &creatureKey',
      moduleVersions: 'id, moduleId, createdAt',
      creatureImages: 'id, campaignId, [campaignId+creatureKey]',
      ideaBoards: 'id, updatedAt',
      settings: 'id',
    });
    // Version 26 (docs/17 row 257): family E of the owner's rule — *"Core items
    // should always ever only be copied"* — the last reference family. A
    // campaign's references to a GLOBAL LIBRARY artifact (a roster `npc-ref`
    // target, an artifact `links[].targetId`) become references to a
    // CAMPAIGN-SCOPED COPY with a fresh id, CLONED role-preserving images and a
    // STORED origin id (`copiedFromArtifactId`), so the reference — and the
    // campaign export that carries it — no longer depends on the shared library.
    // The LIBRARY ROW SURVIVES: the library is shared, and moving a row out of
    // it would strand every other campaign pointing at the same entry, which is
    // why `moveScope`/`adoptIntoCampaign` are deliberately NOT extended here.
    //
    // The store shape is UNCHANGED (the origin field is an additive optional
    // artifact field, not an index) — this is a data conversion only, and the
    // whole thing is ONE transaction calling the seam that takes it
    // (`db/libraryAdopt.adoptLibraryArtifacts`), exactly like the v20 citation
    // repair and the v24 mob copy above. The copy and the repoint land in the
    // SAME transaction, so a reference is never left without its target. A
    // library row that is GONE leaves its reference untouched (the existing
    // loud missing arm stays in charge), and is named in the settings report
    // the shell reads once; the startup retry (`db/libraryAdoptRetry`) heals
    // those when the row appears later.
    this.version(26)
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
        deliverables: null,
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
        await adoptLibraryArtifacts({ tx, reason: 'upgrade' });
      });
    // Version 27 (docs/17 row 259): the LAST family-E holder — a BATTLE's
    // tokens. v26 already ran on the owner's install, so the battle rows need
    // their own version to be backfilled rather than an edited v26 body (a
    // landed upgrade body never re-runs). `battle.board.tokens[].artifactId`
    // and its stage snapshot (`battle.board.stage.tokens`) cite an artifact
    // exactly as a roster row does, and a token still pointing at the LIBRARY
    // degrades SILENTLY when that row is re-ingested or deleted: the card
    // resolves through the any-scope getter, so it shows nothing with no named
    // reason. This body calls the SAME seam (`adoptLibraryArtifacts`) in the
    // SAME transaction as the copy, so there is no second mechanism; a token
    // that can be answered by nothing is named in the report rather than
    // dropped. The store shape is UNCHANGED — this is a data conversion.
    this.version(27)
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
        deliverables: null,
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
        await adoptLibraryArtifacts({ tx, reason: 'upgrade' });
      });
    // Version 28 (docs/17 row 263): the DELIBERATE exception's loud half. A
    // battle is KEYED by its seeding encounter (`battle.encounterArtifactId`)
    // and that id is deliberately NOT repointed — re-pointing it would change
    // the battle's identity and split the board — but a gone row must not stay
    // silent, so the SAME seam now NAMES it in `settings.libraryAdopt.unresolved`
    // beside the dangling tokens. v27 already ran on the owner's install and a
    // landed upgrade body never re-runs, so naming it required this version
    // rather than an edited v27 body (exactly the row-259 reasoning one arm
    // over). The store shape is UNCHANGED — this is a data conversion, and the
    // seam is idempotent, so a workspace with nothing to say writes nothing.
    this.version(28)
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
        deliverables: null,
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
        await adoptLibraryArtifacts({ tx, reason: 'upgrade' });
      });
  }
}

/** The app-wide database instance. */
export const db = new CampaignerDB();
