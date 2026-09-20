import { z } from 'zod';
import { strToU8, unzipSync } from 'fflate';

import type {
  Artifact,
  ArtifactRevision,
  Battle,
  Campaign,
  Id,
  Module,
  PersonaRun,
} from '@/domain';
import {
  analyzeDependencies,
  artifactSchema,
  artifactRevisionSchema,
  battleSchema,
  campaignSchema,
  collectDependencies,
  citedChunkIdsFor,
  creatureImageSchema,
  exportDependenciesSchema,
  exportMissingImageSchema,
  foldCreatureKey,
  moduleDocumentPlanSchema,
  moduleSchema,
  personaRunSchema,
  readStoredDocumentPlan,
  storedImageSchema,
  type DependencyAnalysis,
  type CreatureImage,
  type DocumentPlanSection,
  type EncounterArtifactData,
  type ExportCitation,
  type ExportDependencies,
  type ExportMissingImage,
  type ModuleDocumentPlan,
  type StoredDocumentPlan,
} from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { adoptLibraryArtifacts } from '@/db/libraryAdopt';
import { bytesFromBase64 } from '@/lib/base64';
import { fileSlug } from '@/lib/fileSlug';
import { zodIssuesOf } from '@/lib/zodErrorSummary';
import { StreamingZip } from '@/lib/zipStream';
import { db } from '@/db/db';

/**
 * Export/import (06-MILESTONES M2; images M3-A; v2 tables + dependency
 * manifest M3-E): JSON for a single artifact, a selection, or a whole
 * campaign; a zip bundle for multi-file exports. Images (M3-A) ride the zip
 * as binary files `images/<id>.<ext>` referenced by id in the JSON; plain
 * JSON export lists the image metadata refs with `dataBase64: null` and
 * carries the blobs only with `images: true`. Imports are zod-validated and
 * re-id'd so they can never collide with existing rows (image ids are kept
 * so artifact `imageIds`/`coverImageId` references stay valid; module,
 * battle and run ids are remapped with their artifact references rewritten to
 * the new ids).
 *
 * RETIRED TABLES (docs/17 row 108): a file written before the deliverables
 * concept was deleted may still carry rows for the `deliverables` table. The
 * table is gone and there is nowhere to put them, so an import SKIPS them —
 * and reports the count through `ImportResult.retiredRows`, because silently
 * discarding rows an owner's file still holds is exactly the loss AGENTS rule
 * 1 forbids. Nothing crashes on the extra key.
 */

export const EXPORT_FORMAT_VERSION = 2;

/** An image in an export bundle: metadata + optional inline base64 payload. */
export interface ExportedImage {
  id: Id;
  mimeType: string;
  width: number;
  height: number;
  prompt: string;
  model: string;
  source: 'generated' | 'uploaded';
  createdAt: number;
  updatedAt: number;
  /** Inline payload — set for JSON exports; zip images carry binary files. */
  dataBase64: string | null;
}

/** One exportable bundle shape covering single/selection/whole-campaign. */
export interface CampaignExport {
  format: 'campaigner-export';
  version: 1 | 2;
  exportedAt: number;
  campaign: Campaign | null;
  artifacts: (Artifact & { revisions: ArtifactRevision[] })[];
  /** Present when the export was built with image support (M3-A). */
  images?: ExportedImage[];
  /** Whole-campaign tables (M3-E, v2): absent on v1 files and single exports. */
  modules?: Module[];
  battles?: Battle[];
  runs?: PersonaRun[];
  /**
   * Per-campaign PRESENTATION rows for cited creatures (docs/11 D5 amendment):
   * the campaign's own portrait for a bestiary creature it mentions but does
   * not own. Campaign state, so it travels with the campaign — without it a
   * restored campaign would render initials for every cited mob while the
   * library still held the creature. The library rows and the shared canonical
   * slots never travel (they are the workspace's, not a campaign's).
   */
  creatureImages?: CreatureImage[];
  /** Dependency manifest (M3-E, v2): rulebook citations + library gaps. */
  dependencies?: ExportDependencies;
  /** Referenced image ids whose blob is gone (M3-E): the loud note. */
  missingImages?: ExportMissingImage[];
}

export function buildExport(
  campaign: Campaign | null,
  artifactsWithRevisions: (Artifact & { revisions: ArtifactRevision[] })[],
): CampaignExport {
  return {
    format: 'campaigner-export',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: Date.now(),
    campaign,
    artifacts: artifactsWithRevisions,
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** File extension for a stored mime type (zip image files). */
export function imageFileExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
  };
  return map[mimeType] ?? 'bin';
}

/** Everything needed to export one campaign (or a subset) in one pass. */
export async function buildCampaignExport(
  campaignId: Id,
  artifactIds?: readonly Id[],
  opts: { images?: boolean } = {},
): Promise<CampaignExport> {
  const rawCampaign = await db.campaigns.get(campaignId);
  // Parsed (not raw): legacy rows materialize current defaults (e.g.
  // `coverImageId`) so the export carries them explicitly.
  const campaign = rawCampaign === undefined ? null : campaignSchema.parse(rawCampaign);
  const all = (await db.artifacts.where('campaignId').equals(campaignId).toArray()).filter(
    (row): row is Artifact => row.campaignId !== null,
  );
  const selected =
    artifactIds === undefined ? all : all.filter((artifact) => artifactIds.includes(artifact.id));
  const withRevisions = await Promise.all(
    selected.map(async (artifact) => ({
      ...artifact,
      revisions: await listRevisions(artifact.id),
    })),
  );
  const exported = buildExport(campaign, withRevisions);

  // Whole-campaign tables ride every campaign export (M3-E) — including
  // selection exports, whose artifact subset may dangle a battle token; the
  // manifest and the re-id map keep that honest.
  // Rows are schema-parsed (the battle/run parse-normalize precedent) so
  // legacy rows materialize current defaults — including the dropped
  // encounter `verify` step healing on run rows.
  const [modules, battles, runs, creatureImageRows] = await Promise.all([
    db.modules
      .where('campaignId')
      .equals(campaignId)
      .toArray()
      .then((rows) => rows.map((row) => moduleSchema.parse(row))),
    db.battles
      .where('campaignId')
      .equals(campaignId)
      .toArray()
      .then((rows) => rows.map((row) => battleSchema.parse(row))),
    db.runs
      .where('campaignId')
      .equals(campaignId)
      .toArray()
      .then((rows) => rows.map((row) => personaRunSchema.parse(row))),
    db.creatureImages
      .where('campaignId')
      .equals(campaignId)
      .toArray()
      .then((rows) => rows.map((row) => creatureImageSchema.parse(row))),
  ]);
  exported.modules = modules;
  exported.battles = battles;
  exported.runs = runs;
  exported.creatureImages = creatureImageRows;

  // Dependency manifest (M3-E): chunk→book joins for rulebook citations,
  // advisories for run pins, unmet entries for library npc-refs. The pure
  // `collectDependencies` builder takes injected maps (the
  // `resolveMonsterEntry`/`MonsterLookups` precedent); every Dexie read
  // happens here, in bulk. WHICH chunks to read is asked of the builder's own
  // module (`domain/exportDependencies.citedChunkIdsFor`), so this read cannot
  // fall behind a citation arm the builder knows about (docs/17 row 271).
  const citedChunkIds = citedChunkIdsFor(withRevisions, runs);
  const npcRefIds = new Set<Id>();
  for (const artifact of withRevisions) {
    if (artifact.kind !== 'encounter') continue;
    for (const entry of artifact.data.monsters) {
      if (entry.source.type === 'npc-ref') npcRefIds.add(entry.source.artifactId);
    }
  }
  const [chunkRows, npcRows] = await Promise.all([
    db.chunks.bulkGet(citedChunkIds),
    db.artifacts.bulkGet([...npcRefIds]),
  ]);
  const chunksById = new Map(
    chunkRows.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => [row.id, row] as const),
  );
  const citedBookIds = new Set<Id>();
  for (const chunk of chunksById.values()) citedBookIds.add(chunk.bookId);
  const [bookRows, bookChunkRows] = await Promise.all([
    db.rulebooks.bulkGet([...citedBookIds]),
    citedBookIds.size === 0
      ? Promise.resolve([])
      : db.chunks.where('bookId').anyOf([...citedBookIds]).toArray(),
  ]);
  const booksById = new Map(
    bookRows.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => [row.id, row] as const),
  );
  const chunkCountsByBookId = new Map<Id, number>();
  for (const bookId of citedBookIds) chunkCountsByBookId.set(bookId, 0);
  for (const chunk of bookChunkRows) {
    chunkCountsByBookId.set(chunk.bookId, (chunkCountsByBookId.get(chunk.bookId) ?? 0) + 1);
  }
  const artifactsById = new Map(
    npcRows.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => [row.id, row] as const),
  );
  exported.dependencies = collectDependencies(withRevisions, runs, {
    chunksById,
    booksById,
    artifactsById,
    chunkCountsByBookId,
  });

  // Every image referenced by the export — artifact galleries and covers
  // (including revision snapshots, 07-MILESTONE-3 M3-A §Export), encounter
  // battlemaps (`mapImageId`) and module covers. Plain JSON
  // lists the metadata refs with `dataBase64: null`; `images: true` fills
  // the inline payloads (the zip then swaps them for binary files).
  //
  // A referenced id with NO image row is never silently dropped (the old
  // sweep filtered it away): it lands on `missingImages` with every
  // referrer named — the loud missing-binary note import (slice B) reports.
  const referencedBy = new Map<Id, string[]>();
  const noteRef = (id: Id | null | undefined, by: string): void => {
    if (id === null || id === undefined) return;
    const list = referencedBy.get(id);
    if (list === undefined) referencedBy.set(id, [by]);
    else list.push(by);
  };
  for (const artifact of withRevisions) {
    for (const id of artifact.imageIds) noteRef(id, `artifact:${artifact.id}`);
    noteRef(artifact.coverImageId, `artifact:${artifact.id}:cover`);
    if (artifact.kind === 'encounter') {
      noteRef(artifact.data.mapImageId, `artifact:${artifact.id}:map`);
    }
    for (const revision of artifact.revisions) {
      const snapshot = revision.snapshot as { imageIds?: Id[]; coverImageId?: Id | null } | null;
      for (const id of snapshot?.imageIds ?? []) noteRef(id, `revision:${revision.id}`);
      if (snapshot?.coverImageId != null) noteRef(snapshot.coverImageId, `revision:${revision.id}:cover`);
    }
  }
  // Module/campaign cover slots (cover-generation arc): the blobs are image
  // rows owned by the campaign, referenced from outside the artifact tables
  // — without these pins a JSON export would list the slot but drop the
  // binary (the loud missingImages note instead names the loser).
  for (const module of modules) {
    noteRef(module.coverImageId, `module:${module.id}:cover`);
  }
  if (campaign !== null) {
    noteRef(campaign.coverImageId, `campaign:${campaign.id}:cover`);
  }
  // Creature presentation rows (docs/11 D5 amendment): the row's document
  // cover is the ONLY reference to its blob — no artifact points at it — so
  // without this pin a JSON export would carry the row and drop its binary.
  for (const row of creatureImageRows) {
    noteRef(row.imageId, `creature:${row.creatureKey}`);
  }
  const imageRows = await db.images.bulkGet([...referencedBy.keys()]);
  const foundRows = imageRows.filter((row): row is NonNullable<typeof row> => row !== undefined);
  const foundIds = new Set(foundRows.map((row) => row.id));
  const missingImages: ExportMissingImage[] = [...referencedBy.entries()]
    .filter(([id]) => !foundIds.has(id))
    .map(([id, refs]) => ({ id, referencedBy: refs }));
  if (missingImages.length > 0) exported.missingImages = missingImages;
  exported.images = foundRows.map((row) => ({
    id: row.id,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    prompt: row.prompt,
    model: row.model,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dataBase64: opts.images === true ? base64FromBytes(row.bytes) : null,
  }));
  return exported;
}

export function exportFileName(exported: CampaignExport): string {
  // The one slug seam (lib/fileSlug); a symbol-only campaign name falls back
  // to 'artifact' — still a valid file stem, and the word the three other
  // artifact-shaped callers use.
  const base = exported.campaign?.name ?? 'artifacts';
  return `${fileSlug(base, 'artifact')}-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`;
}

/**
 * Pre-build save name for the native picker: the save destination must be
 * acquired inside the click handler BEFORE the (slow) export build, so the
 * name is derived from the campaign name + today rather than from the built
 * payload's `exportedAt` (same shape as `exportFileName`, same day in
 * practice). The single source for every export save name.
 */
export function exportSuggestedName(campaignName: string, format: 'json' | 'zip'): string {
  return `${fileSlug(campaignName, 'artifact')}-${new Date(Date.now()).toISOString().slice(0, 10)}.${format}`;
}

/**
 * Multi-file zip bundle: one JSON per artifact + a manifest + image files.
 *
 * ASYNCHRONOUS and chunked since docs/17 row 276 — the campaign export was the
 * last caller of the synchronous `zipSync`, the same defect row 265 cured for
 * the whole-database backup. Every entry goes into the ONE streaming-zip seam
 * (`lib/zipStream.StreamingZip`) and its bytes are pushed in bounded slices with
 * a macrotask yield between them, so a large campaign no longer deflates its
 * whole payload on the main thread. The FILE is unchanged — the same entry
 * names, the same JSON, the same compression level — so `importZip` accepts it
 * exactly as before. A failure rejects and the half-written stream is
 * terminated: never a partial archive (AGENTS rule 1).
 */
export async function buildZip(exported: CampaignExport): Promise<Uint8Array> {
  // Zip images are carried as binary files next to the JSON; the JSON keeps
  // only their metadata (dataBase64: null) — no double storage (M3-A).
  const withImageRefs: CampaignExport =
    exported.images === undefined
      ? exported
      : {
          ...exported,
          images: exported.images.map((image) => ({ ...image, dataBase64: null })),
        };
  const files: Record<string, Uint8Array> = {
    'campaigner-export.json': strToU8(JSON.stringify(withImageRefs, null, 2)),
  };
  for (const artifact of exported.artifacts) {
    files[`artifacts/${artifact.kind}/${fileSlug(artifact.name, 'artifact')}-${artifact.id.slice(0, 8)}.json`] =
      strToU8(JSON.stringify(artifact, null, 2));
  }
  for (const image of exported.images ?? []) {
    if (image.dataBase64 === null) continue;
    files[`images/${image.id}.${imageFileExtension(image.mimeType)}`] =
      bytesFromBase64(image.dataBase64);
  }
  const zip = new StreamingZip();
  try {
    for (const [name, bytes] of Object.entries(files)) {
      await zip.pushBytes(zip.add(name), bytes, true);
    }
    zip.end();
  } catch (error) {
    zip.terminate();
    throw error;
  }
  return zip.bytes();
}

// --- Import -----------------------------------------------------------------

/**
 * Tables a file may still carry that THIS build no longer has (docs/17 row
 * 108). `deliverables` held the M3-D outline model, deleted with the concept:
 * the module IS the PDF's document now. A file written before the deletion
 * still contains its rows, and there is nowhere to put them — so the import
 * SKIPS them and reports the count (`ImportResult.retiredRows`), which the
 * picker toasts. Never a crash on the extra key, never a silent discard.
 */
export const RETIRED_EXPORT_TABLES: readonly string[] = ['deliverables'];

/** Row counts of retired tables a raw exported file still carries (0 rows or
 * an absent key ⇒ no entry). */
export function retiredTableRows(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const table of RETIRED_EXPORT_TABLES) {
    const rows = source[table];
    if (Array.isArray(rows) && rows.length > 0) counts[table] = rows.length;
  }
  return counts;
}

/**
 * The ONE sentence a retired-table skip becomes, so the campaign picker and
 * the backup restore report it in the same words (AGENTS rule 2). `null` when
 * there is nothing to report.
 */
export function formatRetiredTableRows(counts: Readonly<Record<string, number>>): string | null {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  const parts = entries.map(
    ([table, count]) =>
      `${String(count)} row${count === 1 ? '' : 's'} from the retired "${table}" table`,
  );
  return `Skipped ${parts.join(' and ')} — that table is gone (a module PDF is generated from the module itself now), so those rows had nowhere to land. Everything else imported.`;
}

/**
 * The ONE sentence a version-drift import becomes (docs/17 row 261), so the
 * campaign picker reports it in the same words the retired-table skip uses
 * (AGENTS rule 2). `null` when there is no drift to report — an empty count is
 * never announced. A drift does NOT block the import (the same creature is
 * here under another version of the book), but it may never go silent: the
 * counts land in this sentence, the reason is named, and the residual state
 * (the citation resolves as `missing ref`) is stated rather than hidden.
 */
export function formatDriftedCitations(count: number): string | null {
  if (count <= 0) return null;
  const plural = count === 1 ? '' : 's';
  return `Imported ${String(count)} stat block citation${plural} from a DIFFERENT version of a book than the one installed here — that version's text is not in this library, so ${count === 1 ? 'that encounter lands' : 'those encounters land'} as 'missing ref' until the matching version is installed. Everything else imported.`;
}

export interface ImportResult {
  campaignId: Id;
  createdArtifacts: number;
  /**
   * Retired-row tolerance (M2 import rules): how many retired/version-drift
   * rows `parseExportTolerant` skipped to land this import (session artifacts
   * with their revision snapshots, session-anchored pre-v11 battles). Zero on
   * current-shape exports. The picker surfaces a loud toast naming
   * `skippedNames` whenever this is nonzero — skips are never silent.
   */
  skippedRetired: number;
  /** Names of the skipped retired artifacts (battles carry no names). */
  skippedNames: string[];
  /**
   * Rows of RETIRED TABLES the file still carried and this import skipped
   * (`retiredTableRows`), by table name. Loud, never silent: the picker toasts
   * `formatRetiredTableRows` whenever this is non-empty.
   */
  retiredRows: Record<string, number>;
  /**
   * Statblock citations that resolved to `version-drift` (docs/17 row 261):
   * the same creature under a DIFFERENT version of the same book. The import
   * PROCEEDED over them (a drift is not `missing`, so it does not abort), and
   * because it proceeded the count is reported HERE and the picker toasts
   * `formatDriftedCitations` — an unblocking that said nothing would be the
   * silent fallback AGENTS rule 1 forbids. Zero on a clean or fully-missing
   * import.
   */
  driftedCitations: number;
}

/** Dependency policy for `importExport`/`importZip` (07-MILESTONE-3 M3-E
 *  slice B, owner-confirmed): `abort` (default) refuses an import whose
 *  statblock citations are MISSING or whose NPC refs have no local
 *  counterpart — before the transaction opens, so there is nothing to roll
 *  back; `import-anyway` lands the encounters as-is, where they resolve to the
 *  existing `missing ref` markers until the content is installed. A
 *  `version-drift` citation is neither: it imports under the default policy
 *  and is reported (`formatDriftedCitations`, docs/17 row 261). */
export type DependencyPolicy = 'abort' | 'import-anyway';

export interface ImportOptions {
  dependencyPolicy?: DependencyPolicy;
}

/**
 * Thrown (before the import transaction opens) when the default
 * abort-policy refuses an import with unmet dependencies. Carries the full
 * `DependencyAnalysis` so the picker can render the dep-summary dialog
 * instead of a bare toast. Never thrown for `import-anyway` imports.
 *
 * The message itself reads as STEPS (not a paragraph) because it also
 * surfaces in non-dialog contexts (any `importExport`/`importZip` caller
 * outside the picker): 1. the Rules install surface naming the MISSING
 * book titles from the blocking citations' L1 identity (the same titles
 * the dialog lists — never invented), 2. retry, or the import-anyway
 * consequence. A `version-drift` citation is EXCLUDED from that install list
 * (docs/17 row 261): that book is already here, under another version, so
 * naming it as something to install would send the user after content they
 * already have.
 */
export class MissingDependenciesError extends Error {
  readonly analysis: DependencyAnalysis;

  constructor(analysis: DependencyAnalysis) {
    const blocking = analysis.blockingCitations;
    const unmet = analysis.unmetLibraryRefs.length;
    const parts: string[] = [];
    if (blocking > 0) {
      parts.push(
        `${String(blocking)} statblock ${blocking === 1 ? 'citation has' : 'citations have'} no matching content in this library`,
      );
    }
    if (unmet > 0) {
      parts.push(
        `${String(unmet)} NPC ${unmet === 1 ? 'reference points' : 'references point'} outside the export`,
      );
    }
    const titles = [
      ...new Set(
        analysis.citations
          .filter((entry) => entry.verdict === 'missing')
          .map((entry) => entry.citation.bookTitle)
          .filter((title): title is string => title !== undefined),
      ),
    ];
    const install =
      titles.length > 0 ? ` and install: ${titles.join(', ')}` : ' the listed book(s)';
    super(
      `Import needs rulebook content missing from this library (${parts.join('; ')}). ` +
        `1. In Rules, choose “Import bestiary pack” (or re-import the rulebook PDF)${install}. ` +
        `2. Import this file again. ` +
        `Or import anyway — the encounters land with 'missing ref' markers until the content is installed.`,
    );
    this.name = 'MissingDependenciesError';
    this.analysis = analysis;
  }
}

/**
 * Mitigation for import-failure toasts that carry no mitigation of their
 * own. Zod-shaped failures pass through untouched (the toast seam
 * humanizes them AND appends the version-skew mitigation) and
 * `MissingDependenciesError` passes through untouched (its message is
 * already steps, and the picker shows the dialog instead of a toast) —
 * every other import failure gets the version-skew mitigation appended so
 * no import toast ever states just a cause.
 */
export function withImportMitigation(error: unknown): Error {
  if (zodIssuesOf(error) !== null) return error as Error;
  if (error instanceof MissingDependenciesError) return error;
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `${cause} Update this instance (or the exporting one) to the same version, re-export, and try again.`,
  );
}

/** Zod-validates a parsed export payload at the boundary (loud, never lenient). */
export function parseExport(raw: unknown): z.infer<typeof exportSchema> {
  return exportSchema.parse(raw);
}

/** Splits a zip bundle into its manifest payload + image binaries (M3-A). */
export function parseZipExport(zipBytes: Uint8Array): {
  manifest: unknown;
  files: Record<string, Uint8Array>;
} {
  const unzipped = unzipSync(zipBytes);
  const manifestEntry = Object.entries(unzipped).find(
    ([path]) => path === 'campaigner-export.json' || path.endsWith('/campaigner-export.json'),
  );
  if (manifestEntry === undefined) {
    throw new Error('Not a Campaigner zip export (manifest missing)');
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1])) as unknown;
  const { 'campaigner-export.json': _manifest, ...rest } = unzipped;
  void _manifest;
  return { manifest, files: rest };
}

/**
 * Reads a manifest against the LOCAL library (no writes): L0 probes go
 * through the `contentHash` index (`getChunksByContentHash` one id at a
 * time would N-query — `anyOf` does it in one); the L1 pool is every chunk
 * of every title+system-matched book; the L2 pool is every chunk of every
 * same-system book (the fuzzy advisory needs creature names, which no
 * index carries). Pure verdicts come from `analyzeDependencies`.
 */
export async function checkImportDependencies(
  manifest: ExportDependencies | undefined,
): Promise<DependencyAnalysis> {
  if (manifest === undefined) {
    return analyzeDependencies(undefined, { chunksByHash: new Map(), books: [] });
  }
  const hashes = [...new Set(
    [...manifest.citations, ...manifest.pinnedChunks]
      .map((entry) => entry.contentHash)
      .filter((hash): hash is string => hash !== undefined),
  )];
  const systems = new Set(
    [...manifest.citations, ...manifest.books]
      .map((entry) => entry.system)
      .filter((system): system is NonNullable<typeof system> => system !== undefined),
  );
  const [hashChunks, books] = await Promise.all([
    hashes.length === 0
      ? Promise.resolve([])
      : db.chunks.where('contentHash').anyOf(hashes).toArray(),
    db.rulebooks.toArray(),
  ]);
  // The L1 books (title+system match) are a subset of the same-system pool
  // by construction — one query covers both pools.
  const poolBookIds = new Set(
    books.filter((book) => systems.has(book.system)).map((book) => book.id),
  );
  const poolChunks =
    poolBookIds.size === 0
      ? []
      : await db.chunks.where('bookId').anyOf([...poolBookIds]).toArray();
  const chunksByHash = new Map<string, (typeof hashChunks)[number][]>();
  for (const chunk of [...hashChunks, ...poolChunks]) {
    const list = chunksByHash.get(chunk.contentHash);
    if (list === undefined) chunksByHash.set(chunk.contentHash, [chunk]);
    else list.push(chunk);
  }
  return analyzeDependencies(manifest, { chunksByHash, books });
}

/**
 * Content-identity healing (chunk-hash-fallback arc; the book half added by
 * docs/17 row 155): citations born before stamping carry no hash and no book,
 * but the v2 manifest does. Stamp the manifest's hash, its creature name and
 * its book title onto matching entries — matched by exporting artifact id +
 * cited chunkId — so OLD exports resolve byte-identical installs through the
 * hash fallback too, AND name the pack they came from when one is missing
 * here. Each field heals INDEPENDENTLY and only when the entry lacks it: an
 * entry that already carries a hash still gains a missing book title, which is
 * what makes this the ONE healing seam rather than a second one.
 *
 * The manifest's own `bookTitle` is present only when the book RESOLVED at
 * export time (it is L1 logical identity, `exportCitationSchema`), so a
 * citation whose book was already gone at export heals nothing here and stays
 * the honest "no pack recorded" — never a guessed one.
 * Entries with no manifest match (v1 files carry no manifest at all) land
 * unchanged and keep resolving by uuid, exactly as before.
 */
function healRulebookSources(
  exportedArtifactId: Id,
  data: EncounterArtifactData,
  manifestByCite: ReadonlyMap<string, ExportCitation>,
): EncounterArtifactData {
  return {
    ...data,
    monsters: data.monsters.map((entry) => {
      if (entry.source.type !== 'rulebook') return entry;
      const citation = manifestByCite.get(`${exportedArtifactId}::${entry.source.chunkId}`);
      if (citation === undefined) return entry;
      const hash = entry.source.contentHash === undefined ? citation.contentHash : undefined;
      const creature =
        entry.source.creatureName === undefined ? citation.creatureName : undefined;
      const book = entry.source.bookTitle === undefined ? citation.bookTitle : undefined;
      if (hash === undefined && creature === undefined && book === undefined) return entry;
      return {
        ...entry,
        source: {
          ...entry.source,
          ...(hash === undefined ? {} : { contentHash: hash }),
          ...(creature === undefined ? {} : { creatureName: creature }),
          ...(book === undefined ? {} : { bookTitle: book }),
        },
      };
    }),
  };
}

// --- The ONE id-remap pass over a loaded campaign (docs/17 row 256) ----------

/**
 * A MISS IS TOLERANT, AND THE INTEGRATED GATE IS WHY (docs/17 row 256, corrected
 * after its first landing).
 *
 * This pass first shipped a STRICT arm for the two fields that exist only to
 * name a row inside the loaded campaign (`links[].targetId`, a plan's
 * `source`/`companion`): a target in no table at all REFUSED the whole import
 * (`DanglingImportReferenceError`, thrown inside the transaction). The
 * dispatcher's integrated run REFUTED that arm with two independent failures,
 * and both are the reason it is gone:
 *
 * - `tests/features/module-plan-dialog.test.tsx` — a plan may name a companion
 *   the file does not carry, because a SELECTION export is documented to carry
 *   only a subset of its campaign (`buildCampaignExport`), so the strict arm
 *   refused a legitimate round-trip that had always worked.
 * - `tests/features/campaign-tree-plan-control.test.tsx` — the
 *   exactly-one-plan-writer pin caught the second writer this file became,
 *   which is the pin doing its job (its declaration is amended to name the
 *   import as a PASSTHROUGH writer of a restored row, not an authoring seam).
 *
 * THE RULE THAT REPLACED IT: remap when the file carries the row, adopt when it
 * is a shared library row, and otherwise KEEP THE ID EXACTLY AS IT IS, for the
 * arm that already owns that field's loud surface to name (the editor's
 * dangling link row, the plan's own issue reporting, the `missing ref` badge).
 * A whole-import REFUSAL stays the DEPENDENCY MANIFEST's documented policy
 * (`MissingDependenciesError` + `import-anyway`), which is the one place the
 * owner has a choice — never a silent side effect of the id-remap pass, and
 * never a dead id silently substituted for a live one.
 */

/**
 * THE ONE id-remap pass over a loaded campaign (docs/17 row 256). Every
 * id-bearing field of every row the import writes goes through `artifact` /
 * `module` here, so a second per-field mechanism cannot be born beside it
 * (AGENTS rule 4).
 *
 * THREE OUTCOMES PER ID, and the difference between them is the whole fix:
 *
 * 1. IN THE IMPORT ⇒ the file's own fresh id (`artifactIds`/`moduleIds`). This
 *    is what makes `links[].targetId` and a module's `documentPlan` point at
 *    the imported copies instead of the exporting database's ids.
 * 2. A LIBRARY ROW ⇒ the id is KEPT and registered on `pendingLibraryIds`,
 *    because a reference to a global library artifact is a save/load
 *    DEPENDENCY and the owner's rule is that core rows are only ever COPIED
 *    (docs/17 row 257). `importExport` then hands the pending ids to the ONE
 *    adoption seam (`db/libraryAdopt.adoptLibraryArtifacts`) in the same call,
 *    which copies the row into the campaign and repoints the reference to the
 *    copy. Nothing about the reference survives as a library pointer.
 * 3. A ROW THIS WORKSPACE ALREADY HOLDS (another campaign's artifact) ⇒ kept
 *    as it is. A SELECTION export is documented to carry only a subset of its
 *    campaign (`buildCampaignExport`), so a reference to a row outside the
 *    file is legitimate and must not become an error.
 *
 * AND HOW A MISS LANDS — ONE rule, after the strict arm was refuted by the
 * integrated gate (see the correction note above): the id is KEPT EXACTLY as
 * the file wrote it and the arm that already owns that field's loud surface
 * names it (the editor's dangling link row, the plan's issue reporting, the
 * `missing ref` badge, the adoption seam's `danglingBattleEncounter`). Never a
 * silent substitution, never a guess, and never a whole-import refusal born
 * inside the id-remap pass — that refusal is the dependency manifest's own
 * documented policy, where the owner has a choice.
 *
 * IMAGE IDS ARE DELIBERATELY NOT REMAPPED, and this comment is the reason so
 * the next reader does not "fix" them: images are inserted with their own `id`
 * preserved (`importExport`'s image loop), so a stored `coverImageId`,
 * `imageIds`, `data.mapImageId`, `board.mapImageId` or a plan section's
 * `images` entry is already valid in the importing database. Only a LIBRARY
 * IMAGE id is a dependency, and that half belongs to the adoption seam's image
 * pass (docs/17 row 270) — not here.
 *
 * The class exists rather than a bag of closures because `importExport`'s
 * transaction body is already long: the answers live in ONE object so the next
 * id-bearing field added to a row goes through it instead of growing a fourth
 * `artifactIds.get(id) ?? id` fallback (the defect this row removes).
 */
class ImportIdRemap {
  private readonly artifactIds: ReadonlyMap<Id, Id>;
  private readonly moduleIds: ReadonlyMap<Id, Id>;
  private readonly globalIds: ReadonlySet<Id>;
  private readonly knownIds: ReadonlySet<Id>;
  readonly pendingLibraryIds = new Set<Id>();

  constructor(options: {
    artifactIds: ReadonlyMap<Id, Id>;
    moduleIds: ReadonlyMap<Id, Id>;
    globalIds: ReadonlySet<Id>;
    knownIds: ReadonlySet<Id>;
  }) {
    this.artifactIds = options.artifactIds;
    this.moduleIds = options.moduleIds;
    this.globalIds = options.globalIds;
    this.knownIds = options.knownIds;
  }

  /** The fresh artifact id, the KEPT library id (registered as pending for
   * adoption), the id of a row this workspace already holds — or the id
   * EXACTLY as the file wrote it, for the arm that owns that field's loud
   * surface to name (never a silent substitution, never a guess, and never a
   * whole-import refusal: see the correction note above). */
  reference(id: Id): Id {
    return this.resolve(id) ?? id;
  }

  /** The fresh module id, or a named refusal — never a silent `null`. */
  module(id: Id, from: string, field: string): Id {
    const fresh = this.moduleIds.get(id);
    if (fresh !== undefined) return fresh;
    // The module arm keeps its own long-standing sentence (an existing pin
    // asserts its words): a module-owned row whose module is absent is the
    // documented v2 break, told apart from the v1 rescue by the file version.
    throw new Error(
      `Import references the module ${id} of ${from}, which is outside the export` +
        (field === '' ? '' : ` (${field})`),
    );
  }

  /** A nullable tolerant-arm artifact reference. */
  referenceOrNull(id: Id | null): Id | null {
    return id === null ? null : this.reference(id);
  }

  /** A nullable module reference. */
  moduleOrNull(id: Id | null, from: string, field: string): Id | null {
    return id === null ? null : this.module(id, from, field);
  }

  private resolve(id: Id): Id | undefined {
    const fresh = this.artifactIds.get(id);
    if (fresh !== undefined) return fresh;
    if (this.globalIds.has(id)) {
      this.pendingLibraryIds.add(id);
      return id;
    }
    if (this.knownIds.has(id)) return id;
    return undefined;
  }
}

/**
 * The shared classification every id-bearing field feeds, from ONE bulk read of
 * every id an exported row names that the file itself does not carry:
 *
 * - `globals` — the SHARED LIBRARY rows (`campaignId === null`, the ONLY global
 *   marker, `db/libraryAdopt`'s own rule). A reference to one is a save/load
 *   DEPENDENCY, so the remap keeps the id and hands it to the adoption seam.
 * - `known` — ids that resolve to SOME artifact row here (a library row, or a
 *   row of another campaign). They stay as they are: a SELECTION export is
 *   documented to carry only a subset of its campaign, so a reference to a row
 *   outside the file is legitimate, not a dangling relation.
 *
 * An id in NEITHER set is the genuinely gone target (docs/17 row 268's rule):
 * nothing in the file, nothing in the library, nothing anywhere in this
 * workspace — and THAT is what refuses the import by name instead of being
 * silently kept.
 */
async function classifyExternalIds(
  candidateIds: Iterable<Id>,
): Promise<{ globals: Set<Id>; known: Set<Id> }> {
  const ids = [...new Set(candidateIds)];
  const globals = new Set<Id>();
  const known = new Set<Id>();
  if (ids.length === 0) return { globals, known };
  const rows = await db.artifacts.bulkGet(ids);
  for (const row of rows) {
    if (row === undefined) continue;
    known.add(row.id);
    if (row.campaignId === null) globals.add(row.id);
  }
  return { globals, known };
}

/** Remap a plan section's artifact references through the ONE pass; parts and
 * IMAGE ids are untouched (a `planIndex` is identity, an image id is preserved
 * on import). */
function remapPlanSection(section: DocumentPlanSection, plan: ImportIdRemap): DocumentPlanSection {
  return {
    ...section,
    source:
      section.source.type === 'part'
        ? section.source
        : {
            type: section.source.type,
            artifactId:
              section.source.type === 'artifact'
                ? plan.reference(section.source.artifactId)
                : plan.reference(section.source.artifactId),
          },
    companion:
      section.companion === null || section.companion === undefined
        ? section.companion
        : { artifactId: plan.reference(section.companion.artifactId) },
  };
}

/**
 * The sections of a module's stored plan when it is a VALID plan, else `[]` —
 * the candidate-id read that feeds the shared-library classification, so an
 * absent or corrupt plan contributes nothing and is left exactly as it is.
 */
function validPlanSections(stored: unknown): readonly DocumentPlanSection[] {
  const read: StoredDocumentPlan = readStoredDocumentPlan(stored);
  return read.status === 'valid' ? read.plan.sections : [];
}

/**
 * Remap what a module's `data.documentPlan` names, or answer `null` when the
 * stored value is absent or NOT a valid plan (nothing to remap — the value
 * rides through verbatim, because a corrupt plan is the PDF's documented loud
 * failure and `readStoredDocumentPlan` remains its ONE reader, domain/
 * documentPlan's stated contract).
 *
 * The read side and the write side share ONE verdict: `readStoredDocumentPlan`
 * produces the `StoredDocumentPlan` this switches on, so the import can never
 * disagree with the renderer about what a valid plan is.
 */
function remapStoredDocumentPlan(stored: unknown, plan: ImportIdRemap): unknown {
  if (stored === null || stored === undefined) return null;
  const read: StoredDocumentPlan = readStoredDocumentPlan(stored);
  if (read.status !== 'valid') return null;
  const remapped: ModuleDocumentPlan = moduleDocumentPlanSchema.parse({
    ...read.plan,
    sections: read.plan.sections.map((section) => remapPlanSection(section, plan)),
  });
  return remapped;
}

/**
 * Imports an export as a NEW campaign (existing data is never merged or
 * overwritten): fresh ids for the campaign, every module/artifact/revision/
 * battle/run; image ids are kept so artifact
 * `imageIds`/`coverImageId` references stay valid (M3-A). `files` carries
 * zip image binaries keyed by archive path.
 *
 * Reference rewriting (M3-E): artifact `moduleId`s follow the module re-id
 * map; battle tokens/`encounterArtifactId` and run
 * result/target artifacts follow the artifact
 * re-id map, falling back to the original id when the target was outside a
 * selection export. Retired tables (see the module doc) are skipped with a
 * reported count. The dependency manifest and `missingImages` are metadata
 * only (no tables) — validated, not imported.
 *
 * An artifact whose module is NOT in the export is decided BY VERSION, never
 * by an any-case fallback: a v1 file (pre-M3-E, whose `modules` table never
 * traveled) demotes to campaign level — the documented legacy rescue
 * (07-MILESTONE-3 M3-E), and the ONE exception, pinned by test; any other
 * version THROWS loudly, exactly like the battle path below for the identical
 * breakage. Silently demoting there would MOVE a module's artifact out of its
 * module (a scope change only the explicit `moveScope` family may make) and
 * hide a corrupt or hand-edited export behind a plausible-looking row.
 *
 * Dependency enforcement (M3-E slice B; the drift split is docs/17 row 261):
 * the manifest is checked against the local library FIRST
 * (`checkImportDependencies` — Dexie reads only) and a MISSING statblock
 * citation or an unmet NPC ref throws `MissingDependenciesError` BEFORE the
 * transaction opens (nothing to roll back). A `version-drift` citation does
 * NOT abort: the same creature is here under a different version of the same
 * book, and blocking on it refused exactly the cross-machine import the
 * verdict exists to describe. The analysis is computed under every policy
 * (an `import-anyway` file may drift too) and its `driftedCitations` count
 * rides `ImportResult`, which the picker toasts — unblocking without saying
 * so would be the silent fallback AGENTS rule 1 forbids. Rulebook chunkIds
 * are KEPT as-is either way, so encounters that land without their content
 * (including a drifted citation, which has no local id or hash) resolve to
 * the existing `missing ref` markers — truthful, never invented. Pre-stamp
 * entries additionally heal their content identity from the manifest
 * (`healRulebookSources`): a later byte-identical install clears those markers
 * through the hash fallback. Skipped retired rows never trip this check: their
 * citations leave with them (`parseExportTolerant` filters the manifest).
 *
 * Retired-row tolerance (M2 import rules): legacy exports carrying retired
 * `session` artifacts or session-anchored pre-v11 battles (or live rows that
 * fail ONLY on version-drift grounds) import the surviving rows and report
 * `{ skippedRetired, skippedNames }` — the picker toasts the count loudly.
 * Genuinely corrupt rows abort via the original aggregated ZodError.
 *
 * The whole import is ONE rw transaction over the eight touched tables (the
 * same contract as backup.ts's restore, array form past Dexie's five-table
 * variadic cap): a failure mid-import rolls back everything instead of
 * stranding a half-imported campaign that the picker would offer forever
 * after.
 */
export async function importExport(
  raw: unknown,
  files: Record<string, Uint8Array> = {},
  options: ImportOptions = {},
): Promise<ImportResult> {
  // Read BEFORE parsing: the tolerant shell strips unknown keys, so the
  // retired tables have to be counted off the RAW file (docs/17 row 108).
  const retiredRows = retiredTableRows(raw);
  const { export: parsed, skippedRetired, skippedNames } = parseExportTolerant(raw);

  // Dependency enforcement (M3-E slice B; amended by docs/17 row 261): the
  // manifest is read against the local library BEFORE the tx opens. Only a
  // `missing` citation or an unmet NPC ref aborts — a `version-drift` is the
  // same creature under another version of the same book, so it must not stop
  // the cross-machine import it describes. The analysis is therefore computed
  // under EVERY policy (an `import-anyway` file may drift too), and its drift
  // count rides the result so a successful import still SAYS SO.
  const analysis = await checkImportDependencies(parsed.dependencies);
  if (!analysis.clean && options.dependencyPolicy !== 'import-anyway') {
    throw new MissingDependenciesError(analysis);
  }
  const driftedCitations = analysis.driftedCitations;

  const stamp = Date.now();
  const newCampaignId = crypto.randomUUID();

  // Content-identity healing (chunk-hash-fallback arc; books since docs/17
  // row 155): the v2 manifest carries per-citation contentHash, creatureName
  // and bookTitle — index EVERY citation by exporting artifact + cited chunk
  // so pre-stamp entries heal on the way in. A citation with no hash is still
  // indexed: it may be the only record of which book the entry came from, and
  // each field heals independently.
  const manifestByCite = new Map<string, ExportCitation>(
    (parsed.dependencies?.citations ?? []).map(
      (citation) => [`${citation.artifactId}::${citation.citedChunkId}`, citation] as const,
    ),
  );

  const campaign =
    parsed.campaign === null
      ? {
          id: newCampaignId,
          name: 'Imported campaign',
          system: 'generic-d20' as const,
          description: '',
          coverImageId: null,
          createdAt: stamp,
          updatedAt: stamp,
        }
      : campaignSchema.parse({
          ...parsed.campaign,
          id: newCampaignId,
          createdAt: stamp,
          updatedAt: stamp,
        });

  let created = 0;
  // THE ONE REMAP TABLE IS BUILT BEFORE THE TRANSACTION OPENS (docs/17 row
  // 256): modules are written FIRST (their ids anchor artifact `moduleId`s),
  // but a module's own `documentPlan` names ARTIFACT ids — so the artifact
  // re-id map has to exist before the first module write, not after the
  // artifact loop like the scattered `artifactIds.get(...)` fallbacks assumed.
  // The ids are minted here, outside the transaction, so a rolled-back import
  // simply discards them.
  const artifactIds = new Map<Id, Id>(
    parsed.artifacts.map((artifact) => [artifact.id, crypto.randomUUID()] as const),
  );
  const moduleIds = new Map<Id, Id>(
    (parsed.modules ?? []).map((module) => [module.id, crypto.randomUUID()] as const),
  );
  // Every id an exported row names that the file itself does not carry — the
  // candidate set for the shared-library classification below.
  const externalCandidateIds = new Set<Id>();
  for (const artifact of parsed.artifacts) {
    for (const link of artifact.links) externalCandidateIds.add(link.targetId);
  }
  for (const module of parsed.modules ?? []) {
    for (const section of validPlanSections(module.documentPlan)) {
      if (section.source.type !== 'part') externalCandidateIds.add(section.source.artifactId);
      if (section.companion !== null && section.companion !== undefined) {
        externalCandidateIds.add(section.companion.artifactId);
      }
    }
  }
  for (const battle of parsed.battles ?? []) {
    if (battle.encounterArtifactId !== null) externalCandidateIds.add(battle.encounterArtifactId);
    if (battle.reseed !== null) externalCandidateIds.add(battle.reseed.encounterArtifactId);
  }
  for (const run of parsed.runs ?? []) {
    if (run.resultArtifactId !== null) externalCandidateIds.add(run.resultArtifactId);
    if (run.targetArtifactId !== null) externalCandidateIds.add(run.targetArtifactId);
    for (const id of run.contextArtifactIds ?? []) externalCandidateIds.add(id);
  }
  const { globals: globalIds, known: knownIds } = await classifyExternalIds(externalCandidateIds);
  const remap = new ImportIdRemap({ artifactIds, moduleIds, globalIds, knownIds });

  await db.transaction(
    'rw',
    [
      db.campaigns,
      db.images,
      db.artifacts,
      db.revisions,
      db.modules,
      db.battles,
      db.runs,
      db.creatureImages,
    ],
    async () => {
      await db.campaigns.add(campaign);

      // Modules first: their re-id map anchors artifact `moduleId`s below, and
      // their `documentPlan` names artifacts through the SAME remap pass.
      for (const exported of parsed.modules ?? []) {
        const moduleId = moduleIds.get(exported.id);
        if (moduleId === undefined) throw new Error(`Import lost the re-id for module ${exported.id}`);
        const plan = remapStoredDocumentPlan(exported.documentPlan, remap);
        await db.modules.add(
          moduleSchema.parse({
            ...exported,
            ...(plan === null ? {} : { documentPlan: plan }),
            id: moduleId,
            campaignId: newCampaignId,
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

      // Restore images first so artifact references resolve on first read (M3-A).
      for (const image of parsed.images ?? []) {
        const bytes =
          image.dataBase64 !== null
            ? bytesFromBase64(image.dataBase64)
            : files[`images/${image.id}.${imageFileExtension(image.mimeType)}`];
        if (bytes === undefined) continue; // plain JSON without binaries: refs stay, blobs are gone
        await db.images.put(
          storedImageSchema.parse({
            id: image.id,
            createdAt: image.createdAt,
            updatedAt: image.updatedAt,
            campaignId: newCampaignId,
            bytes,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            prompt: image.prompt,
            model: image.model,
            source: image.source,
          }),
        );
      }

      // Cited creatures' presentation rows (docs/11 D5 amendment): a fresh id
      // per row (ids are workspace-local), the campaign re-anchored, and the
      // creature KEY folded through the SAME migration seam the v22 Dexie
      // upgrade uses (docs/17 row 168). A pre-migration export spells the key
      // with the OLD mint (`name.trim().toLowerCase()`, no NFC), so importing
      // it verbatim would reintroduce legacy bytes into a folded database and
      // split one creature across two slots again.
      for (const exported of parsed.creatureImages ?? []) {
        await db.creatureImages.add(
          creatureImageSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            creatureKey: foldCreatureKey(exported.creatureKey),
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

      for (const exported of parsed.artifacts) {
        const artifactId = artifactIds.get(exported.id);
        if (artifactId === undefined) {
          throw new Error(`Import lost the re-id for artifact ${exported.id}`);
        }
        const { revisions, ...artifactFields } = exported;
        // A module-owned artifact whose module is NOT in the export is a
        // BREAK, not a scope preference — the two cases are told apart by the
        // file's own version (v1 predates modules entirely; every v2 export
        // carries the campaign's modules, `buildCampaignExport`).
        const exportedModuleId = artifactFields.moduleId;
        let remappedModuleId: Id | null = null;
        if (exportedModuleId !== null) {
          if (parsed.version === 1) {
            // v1 ONLY: a pre-M3-E file whose artifacts were module-owned on
            // the source side but whose `modules` table never traveled
            // demotes to campaign level — the documented legacy rescue
            // (07-MILESTONE-3 M3-E), kept and tested as the one exception.
            remappedModuleId = moduleIds.get(exportedModuleId) ?? null;
          } else {
            remappedModuleId = remap.module(
              exportedModuleId,
              `artifact "${artifactFields.name}"`,
              '',
            );
          }
        }
        await db.artifacts.add(
          artifactSchema.parse({
            ...artifactFields,
            // THE ONE REMAP PASS, on the field the export wrote VERBATIM
            // (docs/17 row 256): every relation follows the artifact re-id map
            // like a battle token or a run target already did, and a target
            // that is a SHARED LIBRARY row is kept and adopted after the
            // transaction. Before this, every relation in an imported campaign
            // dangled.
            links: artifactFields.links.map((link) => ({
              ...link,
              // A miss keeps the file's own id and the editor's dangling-link
              // row names it (docs/17 row 256, corrected after the integrated
              // gate refuted the strict arm).
              targetId: remap.reference(link.targetId),
            })),
            ...(artifactFields.kind === 'encounter'
              ? { data: healRulebookSources(exported.id, artifactFields.data, manifestByCite) }
              : {}),
            id: artifactId,
            campaignId: newCampaignId,
            moduleId: remappedModuleId,
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
        created += 1;
        for (const revision of revisions) {
          await db.revisions.add(
            artifactRevisionSchema.parse({
              ...revision,
              id: crypto.randomUUID(),
              artifactId,
              createdAt: stamp,
              updatedAt: stamp,
            }),
          );
        }
      }

      for (const exported of parsed.battles ?? []) {
        const moduleId = remap.module(exported.moduleId, 'a battle', 'its module');
        await db.battles.add(
          battleSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            moduleId,
            encounterArtifactId: remap.referenceOrNull(exported.encounterArtifactId),
            reseed:
              exported.reseed === null
                ? null
                : {
                    ...exported.reseed,
                    encounterArtifactId: remap.reference(exported.reseed.encounterArtifactId),
                  },
            board: {
              ...exported.board,
              // Every creature key a battle row carries is folded through the
              // v22 migration seam (docs/17 row 168): board tokens, the saved
              // stage snapshot's tokens (Reset restores them onto the board)
              // and the frozen `seedFighters` the spawn path dedupes by. A
              // pre-migration export spells them with the old mint; importing
              // it verbatim would put unfolded bytes back into a folded DB.
              tokens: exported.board.tokens.map((token) => ({
                ...token,
                artifactId: remap.referenceOrNull(token.artifactId),
                ...(token.creatureKey === undefined
                  ? {}
                  : { creatureKey: foldCreatureKey(token.creatureKey) }),
              })),
              stage:
                exported.board.stage === null
                  ? null
                  : {
                      ...exported.board.stage,
                      tokens: exported.board.stage.tokens.map((token) => ({
                        ...token,
                        artifactId: remap.referenceOrNull(token.artifactId),
                        ...(token.creatureKey === undefined
                          ? {}
                          : { creatureKey: foldCreatureKey(token.creatureKey) }),
                      })),
                    },
            },
            // A DERIVED npc-ref freezes its seed row under the ARTIFACT id
            // (`domain/battle.seedFighters[].id`), and the repo's stats lookup
            // keys on it — so the seed row moves with the token that cites it
            // through the SAME pass (a rulebook/inline fighter's id is a
            // synthetic handle the map does not hold, and stays exactly as it
            // was).
            seedFighters: exported.seedFighters.map((fighter) => ({
              ...fighter,
              id: remap.reference(fighter.id),
              ...(fighter.creatureKey === undefined
                ? {}
                : { creatureKey: foldCreatureKey(fighter.creatureKey) }),
            })),
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

      for (const exported of parsed.runs ?? []) {
        const from = `the run ${exported.id}`;
        await db.runs.add(
          personaRunSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            resultArtifactId: remap.referenceOrNull(exported.resultArtifactId),
            targetArtifactId: remap.referenceOrNull(exported.targetArtifactId),
            placementModuleId: remap.moduleOrNull(
              exported.placementModuleId,
              from,
              'its placement module',
            ),
            contextArtifactIds:
              exported.contextArtifactIds === null
                ? null
                : exported.contextArtifactIds.map((id) => remap.reference(id)),
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

    },
  );
  // THE LIBRARY HALF, THROUGH THE ONE ADOPTION SEAM (docs/17 rows 256/268):
  // a reference that named a SHARED LIBRARY row is kept by the remap pass as a
  // pending id and handed to `adoptLibraryArtifacts` here — AFTER the
  // transaction, because adoption copies the library row into a campaign that
  // must already exist. The seam copies each row (cloned images, stored
  // origin) and REWRITES the reference to the campaign's copy in the same
  // transaction; a gone library row is left exactly as it is and NAMED in the
  // report, which is also the startup retry's worklist. Without this call an
  // imported campaign would keep a library pointer — the save/load dependency
  // the owner forbade — and no Dexie version would ever re-key it.
  if (remap.pendingLibraryIds.size > 0) {
    await db.transaction(
      'rw',
      [db.artifacts, db.revisions, db.images, db.campaigns, db.settings, db.battles],
      (tx) =>
        adoptLibraryArtifacts({
          tx,
          reason: 'write',
          pendingRefs: { campaignId: newCampaignId, ids: [...remap.pendingLibraryIds] },
        }),
    );
  }
  return {
    campaignId: newCampaignId,
    createdArtifacts: created,
    skippedRetired,
    skippedNames,
    retiredRows,
    driftedCitations,
  };
}

/**
 * Imports a zip bundle: extracts the manifest JSON and the `images/*`
 * binaries, then defers to `importExport` (M3-A). The dependency policy
 * rides through (default abort on unmet deps).
 */
export async function importZip(
  zipBytes: Uint8Array,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { manifest, files } = parseZipExport(zipBytes);
  return importExport(manifest, files, options);
}

const artifactWithRevisionsSchema = artifactSchema.and(
  z.object({
    revisions: z.array(artifactRevisionSchema),
  }),
);

const exportSchema = z.object({
  format: z.literal('campaigner-export'),
  /** v1 files predate the M3-E tables/manifest; every new field is optional. */
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.number(),
  campaign: campaignSchema.nullable(),
  artifacts: z.array(artifactWithRevisionsSchema),
  /** Image bundle (M3-A); absent or empty in older/plain exports. */
  images: z.array(
    z.object({
      id: z.uuid(),
      mimeType: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      prompt: z.string(),
      model: z.string(),
      source: z.enum(['generated', 'uploaded']),
      createdAt: z.number(),
      updatedAt: z.number(),
      dataBase64: z.string().nullable(),
    }),
  ).optional(),
  /** Whole-campaign tables (M3-E, v2): absent on v1 files. */
  modules: z.array(moduleSchema).optional(),
  battles: z.array(battleSchema).optional(),
  runs: z.array(personaRunSchema).optional(),
  /** Cited creatures' per-campaign presentation rows (docs/11 D5 amendment):
   * campaign state, so a v20+ file carries them and a v1/v2 file simply has
   * none (a restore then shows initials until each portrait is generated). */
  creatureImages: z.array(creatureImageSchema).optional(),
  /** Dependency manifest (M3-E, v2): validated metadata, not imported. */
  dependencies: exportDependenciesSchema.optional(),
  /** Loud missing-binary note (M3-E, v2). */
  missingImages: z.array(exportMissingImageSchema).optional(),
});

/** Downloads a blob via a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

// --- Retired-row tolerance (06-MILESTONES M2 import rules) --------------------
//
// Owner-observed: an export written by an older build (which still knew the
// retired `session` artifact kind and session-anchored battles) fails a fresh
// import with one aggregated ZodError — `buildCampaignExport` reads raw Dexie
// rows with no kind filter, and `parseExport`'s schemas no longer accept the
// removed discriminator. Same-code rows cannot exist at home (repo reads parse
// on the source side), so every tolerance case below is version skew by
// construction.
//
// Policy (mirrors the v11 upgrade precedent, db.ts — sessions + their
// revisions deleted, battles cleared): unparseable RETIRED-kind rows are
// SKIPPED-WITH-COUNT, never silent and never abort-the-world; genuinely
// CORRUPT rows of live kinds still abort loudly via the original aggregated
// error. The retired-vs-corrupt discriminator is exact and schema-driven:
//
// - RETIRED (skip): top-level `kind === 'session'` — the ONLY value the kind
//   enum ever dropped (the complete historic enumeration lives in
//   `normalizeLegacyProducesKind`, domain/persona.ts). The artifact's revision
//   snapshots ride with it. Pre-v11 battle rows (a string `sessionId`, no
//   valid `moduleId`) — v11 cleared battles because live state cannot be
//   truthfully re-anchored from retired sessions.
// - DRIFT (skip): a live-kind entry that fails ONLY on version-drift grounds —
//   (a) `custom` issues at `data` (the three encounter siteShape invariants)
//   or `data.layout` (stale generated geometry: spawn-room count,
//   overlap/bounds, corridors, entrances) — the only custom validators in the
//   artifact union — or (b) `invalid_type`/`invalid_value` issues whose raw
//   value is explicit `null` on a defaulted field (pre-default writers stored
//   null where current schemas carry `.default(...)`), VERIFIED by re-parsing
//   a probe with those nulls removed and stale layouts neutralized. Anything
//   else failing in the probe (empty name, bad roster, dangling types) means
//   the row is corrupt, not drifted.
// - CORRUPT (abort): everything else — the original aggregated ZodError
//   throws unchanged, so no silent fallback laundering is possible.
//
// Skipped rows' dependency citations leave with them: the returned manifest
// drops citations/unmet-refs pointing at skipped artifact ids, so the
// slice-B abort-by-default check never fires on content that is not landing.

export interface TolerantExport {
  export: z.infer<typeof exportSchema>;
  /** Count of skipped retired/drift rows (session artifacts + pre-v11 battles). */
  skippedRetired: number;
  /** Names of the skipped retired artifacts (battles carry no names). */
  skippedNames: string[];
  /** Original ids of the skipped artifacts (re-id map + dep filtering). */
  skippedArtifactIds: Id[];
}

/**
 * Tolerant import boundary: strict `exportSchema` first (current-shape files
 * parse value-identical, zero skips); on failure, per-row classification that
 * skips retired/drift rows with a count and rethrows the ORIGINAL aggregated
 * error for genuinely corrupt rows. The reassembled export is strict-parsed
 * before return, so downstream code keeps the same zod guarantee.
 */
export function parseExportTolerant(raw: unknown): TolerantExport {
  const direct = exportSchema.safeParse(raw);
  if (direct.success) {
    return { export: direct.data, skippedRetired: 0, skippedNames: [], skippedArtifactIds: [] };
  }
  const originalError = direct.error;
  const shell = tolerantShellSchema.safeParse(raw);
  if (!shell.success) {
    // Not even the shell parses (bad format marker, corrupt tables outside
    // artifacts/battles) — the original error is the loud surface.
    throw originalError;
  }

  const keptArtifacts: z.infer<typeof artifactWithRevisionsSchema>[] = [];
  const skippedNames: string[] = [];
  const skippedArtifactIds: Id[] = [];
  let skippedRetired = 0;
  for (const row of shell.data.artifacts) {
    const parsed = artifactWithRevisionsSchema.safeParse(row);
    if (parsed.success) {
      keptArtifacts.push(parsed.data);
      continue;
    }
    const verdict = classifySkippedArtifact(row, parsed.error);
    if (verdict === null) throw originalError;
    skippedRetired += 1;
    skippedNames.push(verdict.name);
    skippedArtifactIds.push(verdict.id);
  }

  const keptBattles: z.infer<typeof battleSchema>[] = [];
  for (const row of shell.data.battles ?? []) {
    const parsed = battleSchema.safeParse(row);
    if (parsed.success) {
      keptBattles.push(parsed.data);
      continue;
    }
    if (!isRetiredBattleRow(row)) throw originalError;
    skippedRetired += 1;
  }

  const reassembled = {
    ...shell.data,
    artifacts: keptArtifacts,
    battles: shell.data.battles === undefined ? undefined : keptBattles,
    dependencies:
      shell.data.dependencies === undefined || skippedArtifactIds.length === 0
        ? shell.data.dependencies
        : {
            ...shell.data.dependencies,
            citations: shell.data.dependencies.citations.filter(
              (citation) => !skippedArtifactIds.includes(citation.artifactId),
            ),
            unmetLibraryRefs: shell.data.dependencies.unmetLibraryRefs.filter(
              (ref) => !skippedArtifactIds.includes(ref.artifactId),
            ),
          },
  };
  // Final strict parse: the tolerance stage can only REMOVE rows, never widen
  // the schema — downstream keeps the exact `exportSchema` guarantee.
  return {
    export: exportSchema.parse(reassembled),
    skippedRetired,
    skippedNames,
    skippedArtifactIds,
  };
}

/** The export shell with artifacts/battles held as unknown for per-row triage. */
const tolerantShellSchema = z.object({
  format: z.literal('campaigner-export'),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.number(),
  campaign: campaignSchema.nullable(),
  artifacts: z.array(z.unknown()),
  images: z
    .array(
      z.object({
        id: z.uuid(),
        mimeType: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        prompt: z.string(),
        model: z.string(),
        source: z.enum(['generated', 'uploaded']),
        createdAt: z.number(),
        updatedAt: z.number(),
        dataBase64: z.string().nullable(),
      }),
    )
    .optional(),
  modules: z.array(moduleSchema).optional(),
  battles: z.array(z.unknown()).optional(),
  runs: z.array(personaRunSchema).optional(),
  /** Cited creatures' per-campaign presentation rows (docs/11 D5 amendment):
   * campaign state, so a v20+ file carries them and a v1/v2 file simply has
   * none (a restore then shows initials until each portrait is generated). */
  creatureImages: z.array(creatureImageSchema).optional(),
  dependencies: exportDependenciesSchema.optional(),
  missingImages: z.array(exportMissingImageSchema).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pre-v11 battle shape: session-anchored, no module — un-re-anchorable (v11). */
function isRetiredBattleRow(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return typeof row.sessionId === 'string' && typeof row.moduleId !== 'string';
}

interface SkippedArtifact {
  id: Id;
  name: string;
}

/**
 * Classifies a failed artifact entry: retired/drift skip descriptor, or null
 * for genuinely corrupt rows (the caller rethrows the original error).
 */
function classifySkippedArtifact(row: unknown, error: z.ZodError): SkippedArtifact | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === 'string' ? row.id : '(unknown id)';
  const name = typeof row.name === 'string' && row.name !== '' ? row.name : '(unnamed)';
  // Retired: the only kind the enum ever dropped (v11 deleted these rows).
  // Any other bad kind ('map', null, …) is corruption, caught by the issue
  // loop below — 'session' is the complete historic enumeration.
  if (row.kind === 'session') return { id, name };
  // Drift probe below: every issue must be layout/shape-custom or an
  // explicit null, and the neutralized probe must parse clean.
  const issues = error.issues;
  if (issues.length === 0) return null;
  for (const issue of issues) {
    if (issue.code === 'custom' && isLayoutShapePath(issue.path)) continue;
    if (
      (issue.code === 'invalid_type' || issue.code === 'invalid_value') &&
      isExplicitNullAtPath(row, issue.path)
    ) {
      continue;
    }
    return null;
  }
  const probe = cloneJson(row);
  for (const issue of issues) {
    if (issue.code === 'custom') neutralizeLayoutAtPath(probe, issue.path);
    else deleteAtPath(probe, issue.path);
  }
  const reparsed = artifactWithRevisionsSchema.safeParse(probe);
  if (!reparsed.success) return null;
  return { id, name };
}

/**
 * Entry-relative custom-issue paths that are version drift: `data` (the three
 * encounter siteShape invariants) and `data.layout` (stale generated
 * geometry) — the only custom validators in the artifact union — including
 * inside revision snapshots (historical copies drift identically). Any other
 * custom path is corruption.
 */
function isLayoutShapePath(path: readonly PropertyKey[]): boolean {
  const stripped = stripSnapshotPrefix(path);
  if (stripped === null) return false;
  return (
    (stripped.length === 1 && stripped[0] === 'data') ||
    (stripped.length === 2 && stripped[0] === 'data' && stripped[1] === 'layout')
  );
}

/** Strips an optional `revisions[i].snapshot` prefix from an entry-relative path. */
function stripSnapshotPrefix(path: readonly PropertyKey[]): readonly PropertyKey[] | null {
  if (path[0] === 'data') return path;
  if (
    path.length >= 3 &&
    path[0] === 'revisions' &&
    typeof path[1] === 'number' &&
    path[2] === 'snapshot'
  ) {
    return path.slice(3);
  }
  return null;
}

/** True when the raw row holds an explicit null object-field at the path. */
function isExplicitNullAtPath(row: Record<string, unknown>, path: readonly PropertyKey[]): boolean {
  const parent = parentAtPath(row, path);
  const key = path[path.length - 1];
  if (parent === null || key === undefined) return false;
  // Array holes are corruption, not drift — only record fields qualify.
  if (Array.isArray(parent)) return false;
  return parent[key as string] === null;
}

function parentAtPath(
  root: unknown,
  path: readonly PropertyKey[],
): Record<string, unknown> | unknown[] | null {
  let node: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(node) && !Array.isArray(node)) return null;
    node = (node as Record<string | number, unknown>)[segment as string];
  }
  return isRecord(node) || Array.isArray(node) ? node : null;
}

function deleteAtPath(root: Record<string, unknown>, path: readonly PropertyKey[]): void {
  const parent = parentAtPath(root, path);
  const key = path[path.length - 1];
  if (parent === null || Array.isArray(parent) || key === undefined) return;
  Reflect.deleteProperty(parent, key);
}

/** Neutralizes the stale layout enclosing a custom-issue path (probe only). */
function neutralizeLayoutAtPath(root: Record<string, unknown>, path: readonly PropertyKey[]): void {
  const dataPath = layoutDataPath(path);
  if (dataPath === null) return;
  let node: unknown = root;
  for (const segment of dataPath) {
    if (!isRecord(node)) return;
    node = node[segment as string];
  }
  if (!isRecord(node)) return;
  node.layout = null;
  delete node.siteShape;
}

/** Resolves the enclosing `data` object path for a layout custom-issue path. */
function layoutDataPath(path: readonly PropertyKey[]): readonly PropertyKey[] | null {
  const stripped = stripSnapshotPrefix(path);
  if (stripped?.[0] !== 'data') return null;
  const prefixLength = path.length - stripped.length;
  return [...path.slice(0, prefixLength), 'data'];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
