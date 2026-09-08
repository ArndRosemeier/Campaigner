import { z } from 'zod';

import type { AnyArtifact, Artifact, Id, PersonaRun, Rulebook, RuleChunk } from '@/domain';
import { chunkTypeSchema } from '@/domain/rulebook';
import { gameSystemSchema } from '@/domain/gameSystem';
import { rulebookOriginSchema } from '@/domain/rulebook';

/**
 * Campaign-export dependency manifest (07-MILESTONE-3 M3-E): everything an
 * export cites that is NOT carried inside it (rulebooks/chunks stay in the
 * source library by owner decision — the manifest replaces them), so a later
 * import can verify or re-fetch each dependency instead of silently resuming
 * without stats.
 *
 * Identity contract (L0/L1/L2 — full statement in 07-MILESTONE-3 M3-E):
 * - L0 content identity: `contentHash` (SHA-256 of the chunk text) —
 *   verifiable with no library at all.
 * - L1 logical identity: `(system, bookTitle, creatureName)` — resolves
 *   against an EQUIVALENT book (a re-ingest under a new row id still
 *   satisfies the citation).
 * - L2 row identity: `citedChunkId` (+ the source book row) — source-DB-only,
 *   carried for audit, never expected to match elsewhere.
 *
 * Every citation carries all three levels; the per-book rollup carries L1+L2
 * plus the pack provenance needed to re-fetch the same upstream source.
 */

/** One encounter roster entry citing a rulebook statblock chunk. */
export const exportCitationSchema = z.object({
  artifactId: z.uuid(),
  artifactName: z.string(),
  kind: z.string(),
  /** The roster entry's display name (what the GM called the monster). */
  monsterName: z.string(),
  /** L2 row identity: the chunk id in the SOURCE database. */
  citedChunkId: z.uuid(),
  /** The chunk's actual type at export time (expected 'statblock'). */
  chunkType: chunkTypeSchema,
  /** 'resolved' ⇔ chunk and book both found; otherwise the honest gap. */
  status: z.enum(['resolved', 'missing-chunk', 'missing-book']),
  /** L1 logical identity (present when the book resolved). */
  bookTitle: z.string().min(1).optional(),
  system: gameSystemSchema.optional(),
  /**
   * L1 creature identity: `chunk.headingPath[0]` trimmed, falling back to
   * the roster `monsterName` when the chunk carries no heading (the same
   * fallback `resolveMonsterEntry` uses for its pack origin label).
   */
  creatureName: z.string().optional(),
  /** L0 content identity (present when the chunk resolved). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 hex digest').optional(),
});

export type ExportCitation = z.infer<typeof exportCitationSchema>;

/** One library book cited (directly or via a run pin) by the export. */
export const exportBookDepSchema = z.object({
  /** L1 logical identity. */
  title: z.string().min(1),
  system: gameSystemSchema,
  origin: rulebookOriginSchema,
  /** Omitted when empty (pack books carry no meaningful filename). */
  filename: z.string().min(1).optional(),
  pageCount: z.number().int().nonnegative(),
  /**
   * The refetch-relevant pack subset (12-BESTIARY-PACKS §4): enough to
   * re-fetch the SAME upstream source elsewhere. Null for PDF books.
   */
  pack: z
    .object({
      sourceId: z.string().min(1),
      sourceRef: z.string().min(1).optional(),
      attemptedRefs: z.array(z.string().min(1)).optional(),
      entriesImported: z.number().int().nonnegative(),
      itemsImported: z.number().int().nonnegative().optional(),
      sectionsImported: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  /** Total chunks in the source library book (how much is NOT carried). */
  chunkCount: z.number().int().nonnegative(),
  /** The cited subset (citation + run-pin chunk ids, deduplicated). */
  citedChunkIds: z.array(z.uuid()),
});

export type ExportBookDep = z.infer<typeof exportBookDepSchema>;

/**
 * A run's `pinnedChunkIds` entry: ADVISORY, not a hard stat citation — pins
 * are grounding context, so a missing pin degrades the run history, never a
 * monster's stats. Carries the same three identity levels when resolvable.
 */
export const exportPinnedChunkSchema = z.object({
  runId: z.uuid(),
  chunkId: z.string(),
  status: z.enum(['resolved', 'missing-chunk', 'missing-book']),
  bookTitle: z.string().min(1).optional(),
  system: gameSystemSchema.optional(),
  creatureName: z.string().optional(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 hex digest').optional(),
});

export type ExportPinnedChunk = z.infer<typeof exportPinnedChunkSchema>;

/**
 * An encounter roster entry pointing at an NPC artifact the export does NOT
 * carry (the shared library is excluded by owner decision): a global
 * (library) NPC, a deleted NPC, or a campaign NPC outside a selection
 * export. Import (slice B) aborts on these by default — this slice only
 * writes them honestly.
 */
export const exportUnmetRefSchema = z.object({
  artifactId: z.uuid(),
  artifactName: z.string(),
  kind: z.string(),
  monsterName: z.string(),
  npcArtifactId: z.uuid(),
  /** The NPC's name when its row still exists (global / not-exported). */
  npcName: z.string().optional(),
  status: z.enum(['global', 'missing', 'not-exported']),
});

export type ExportUnmetRef = z.infer<typeof exportUnmetRefSchema>;

/** The full dependency manifest carried on a v2 campaign export. */
export const exportDependenciesSchema = z.object({
  citations: z.array(exportCitationSchema),
  books: z.array(exportBookDepSchema),
  pinnedChunks: z.array(exportPinnedChunkSchema),
  unmetLibraryRefs: z.array(exportUnmetRefSchema),
});

export type ExportDependencies = z.infer<typeof exportDependenciesSchema>;

/**
 * One image id referenced by the export whose blob is absent from the image
 * table (M3-E): the LOUD missing-binary note. The export never silently
 * drops the reference — the id stays in the `images` metadata (or here,
 * when the row itself is gone) with every referrer named, so import
 * (slice B) can report exactly which artifact/deliverable loses its image.
 */
export const exportMissingImageSchema = z.object({
  id: z.uuid(),
  referencedBy: z.array(z.string().min(1)),
});

export type ExportMissingImage = z.infer<typeof exportMissingImageSchema>;

/**
 * Library reads injected into `collectDependencies` — the
 * `resolveMonsterEntry`/`MonsterLookups` precedent (domain/encounterResolve):
 * the builder stays pure (no Dexie, sync, easily unit-tested with plain
 * maps) and `buildCampaignExport` (lib/exportImport) performs the bulk reads.
 */
export interface DependencyLibrary {
  chunksById: ReadonlyMap<Id, RuleChunk>;
  booksById: ReadonlyMap<Id, Rulebook>;
  /** Campaign AND global artifacts (npc-ref targets may live in the library). */
  artifactsById: ReadonlyMap<Id, AnyArtifact>;
  /** Total chunk count per cited book (how much of the book is NOT carried). */
  chunkCountsByBookId: ReadonlyMap<Id, number>;
}

/**
 * Builds the dependency manifest for an export: encounter
 * `source.type === 'rulebook'` entries join chunk → book; run
 * `pinnedChunkIds` become advisory entries; encounter `npc-ref` entries
 * pointing outside the exported set become unmet-library entries.
 *
 * Pure: no IO, no writes — every library fact arrives via `library`. Throws
 * loudly on an inconsistent library (a resolved book with no chunk count)
 * instead of writing a zero that would lie about the book's size.
 */
export function collectDependencies(
  artifacts: readonly Artifact[],
  runs: readonly PersonaRun[],
  library: DependencyLibrary,
): ExportDependencies {
  const citations: ExportCitation[] = [];
  const pinnedChunks: ExportPinnedChunk[] = [];
  const unmetLibraryRefs: ExportUnmetRef[] = [];
  /** bookId → cited chunk ids in first-cite order (deduplicated). */
  const citedByBook = new Map<Id, Id[]>();
  const exportedIds = new Set<Id>(artifacts.map((artifact) => artifact.id));

  const recordBookCite = (bookId: Id, chunkId: Id): void => {
    const cited = citedByBook.get(bookId);
    if (cited === undefined) {
      citedByBook.set(bookId, [chunkId]);
    } else if (!cited.includes(chunkId)) {
      cited.push(chunkId);
    }
  };

  const creatureNameOf = (chunk: RuleChunk, fallback: string): string => {
    const heading = chunk.headingPath[0]?.trim();
    return heading === undefined || heading === '' ? fallback : heading;
  };

  for (const artifact of artifacts) {
    if (artifact.kind !== 'encounter') continue;
    for (const entry of artifact.data.monsters) {
      if (entry.source.type === 'rulebook') {
        const chunk = library.chunksById.get(entry.source.chunkId);
        if (chunk === undefined) {
          citations.push({
            artifactId: artifact.id,
            artifactName: artifact.name,
            kind: artifact.kind,
            monsterName: entry.name,
            citedChunkId: entry.source.chunkId,
            chunkType: 'statblock',
            status: 'missing-chunk',
          });
          continue;
        }
        const book = library.booksById.get(chunk.bookId);
        if (book === undefined) {
          citations.push({
            artifactId: artifact.id,
            artifactName: artifact.name,
            kind: artifact.kind,
            monsterName: entry.name,
            citedChunkId: chunk.id,
            chunkType: chunk.chunkType,
            status: 'missing-book',
            contentHash: chunk.contentHash,
          });
          continue;
        }
        citations.push({
          artifactId: artifact.id,
          artifactName: artifact.name,
          kind: artifact.kind,
          monsterName: entry.name,
          citedChunkId: chunk.id,
          chunkType: chunk.chunkType,
          status: 'resolved',
          bookTitle: book.title,
          system: book.system,
          creatureName: creatureNameOf(chunk, entry.name),
          contentHash: chunk.contentHash,
        });
        recordBookCite(book.id, chunk.id);
      } else if (entry.source.type === 'npc-ref') {
        const target = library.artifactsById.get(entry.source.artifactId);
        if (target === undefined) {
          unmetLibraryRefs.push({
            artifactId: artifact.id,
            artifactName: artifact.name,
            kind: artifact.kind,
            monsterName: entry.name,
            npcArtifactId: entry.source.artifactId,
            status: 'missing',
          });
        } else if (target.campaignId === null) {
          unmetLibraryRefs.push({
            artifactId: artifact.id,
            artifactName: artifact.name,
            kind: artifact.kind,
            monsterName: entry.name,
            npcArtifactId: target.id,
            npcName: target.name,
            status: 'global',
          });
        } else if (!exportedIds.has(target.id)) {
          unmetLibraryRefs.push({
            artifactId: artifact.id,
            artifactName: artifact.name,
            kind: artifact.kind,
            monsterName: entry.name,
            npcArtifactId: target.id,
            npcName: target.name,
            status: 'not-exported',
          });
        }
        // A campaign NPC inside the export resumes fine — no manifest entry.
      }
    }
  }

  for (const run of runs) {
    for (const chunkId of run.pinnedChunkIds) {
      const chunk = library.chunksById.get(chunkId);
      if (chunk === undefined) {
        pinnedChunks.push({ runId: run.id, chunkId, status: 'missing-chunk' });
        continue;
      }
      const book = library.booksById.get(chunk.bookId);
      if (book === undefined) {
        pinnedChunks.push({
          runId: run.id,
          chunkId,
          status: 'missing-book',
          contentHash: chunk.contentHash,
        });
        continue;
      }
      const creature = chunk.headingPath[0]?.trim();
      pinnedChunks.push({
        runId: run.id,
        chunkId,
        status: 'resolved',
        bookTitle: book.title,
        system: book.system,
        // No roster name exists for a pin: omit creatureName when the chunk
        // carries no heading rather than writing an empty placeholder.
        ...(creature === undefined || creature === '' ? {} : { creatureName: creature }),
        contentHash: chunk.contentHash,
      });
      recordBookCite(book.id, chunk.id);
    }
  }

  const books: ExportBookDep[] = [...citedByBook.entries()].map(([bookId, citedChunkIds]) => {
    const book = library.booksById.get(bookId);
    if (book === undefined) {
      throw new Error(`collectDependencies: cited book ${bookId} missing from the library`);
    }
    const chunkCount = library.chunkCountsByBookId.get(bookId);
    if (chunkCount === undefined) {
      throw new Error(`collectDependencies: no chunk count for cited book ${bookId}`);
    }
    const pack = book.packMeta;
    return {
      title: book.title,
      system: book.system,
      origin: book.origin,
      ...(book.filename === '' ? {} : { filename: book.filename }),
      pageCount: book.pageCount,
      pack:
        pack === null
          ? null
          : {
              sourceId: pack.sourceId,
              ...(pack.sourceRef === undefined ? {} : { sourceRef: pack.sourceRef }),
              ...(pack.attemptedRefs === undefined ? {} : { attemptedRefs: pack.attemptedRefs }),
              entriesImported: pack.entriesImported,
              ...(pack.itemsImported === undefined ? {} : { itemsImported: pack.itemsImported }),
              ...(pack.sectionsImported === undefined
                ? {}
                : { sectionsImported: pack.sectionsImported }),
            },
      chunkCount,
      citedChunkIds,
    };
  });

  return { citations, books, pinnedChunks, unmetLibraryRefs };
}
