import { z } from 'zod';
import { strToU8, unzipSync, zipSync } from 'fflate';

import type {
  Artifact,
  ArtifactRevision,
  Battle,
  Campaign,
  Deliverable,
  Id,
  Module,
  OutlineNode,
  PersonaRun,
} from '@/domain';
import {
  analyzeDependencies,
  artifactSchema,
  artifactRevisionSchema,
  battleSchema,
  campaignSchema,
  collectDependencies,
  deliverableSchema,
  exportDependenciesSchema,
  exportMissingImageSchema,
  moduleSchema,
  personaRunSchema,
  storedImageSchema,
  type DependencyAnalysis,
  type ExportDependencies,
  type ExportMissingImage,
} from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { bytesFromBase64 } from '@/lib/base64';
import { zodIssuesOf } from '@/lib/zodErrorSummary';
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
 * battle, run and deliverable ids are remapped with their artifact
 * references rewritten to the new ids).
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
  deliverables?: Deliverable[];
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
  const campaign = (await db.campaigns.get(campaignId)) ?? null;
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
  // selection exports, whose artifact subset may dangle a battle token or
  // deliverable node; the manifest and the re-id map keep that honest.
  // Rows are schema-parsed (the battle/run parse-normalize precedent) so
  // legacy rows materialize current defaults — including the dropped
  // encounter `verify` step healing on run rows.
  const [modules, battles, runs, deliverables] = await Promise.all([
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
    db.deliverables
      .where('campaignId')
      .equals(campaignId)
      .toArray()
      .then((rows) => rows.map((row) => deliverableSchema.parse(row))),
  ]);
  exported.modules = modules;
  exported.battles = battles;
  exported.runs = runs;
  exported.deliverables = deliverables;

  // Dependency manifest (M3-E): chunk→book joins for rulebook citations,
  // advisories for run pins, unmet entries for library npc-refs. The pure
  // `collectDependencies` builder takes injected maps (the
  // `resolveMonsterEntry`/`MonsterLookups` precedent); every Dexie read
  // happens here, in bulk.
  const citedChunkIds = new Set<Id>();
  const npcRefIds = new Set<Id>();
  for (const artifact of withRevisions) {
    if (artifact.kind !== 'encounter') continue;
    for (const entry of artifact.data.monsters) {
      if (entry.source.type === 'rulebook') citedChunkIds.add(entry.source.chunkId);
      else if (entry.source.type === 'npc-ref') npcRefIds.add(entry.source.artifactId);
    }
  }
  for (const run of runs) {
    for (const chunkId of run.pinnedChunkIds) citedChunkIds.add(chunkId);
  }
  const [chunkRows, npcRows] = await Promise.all([
    db.chunks.bulkGet([...citedChunkIds]),
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
  // battlemaps (`mapImageId`) and deliverable covers (M3-E). Plain JSON
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
  for (const deliverable of deliverables) {
    noteRef(deliverable.coverImageId, `deliverable:${deliverable.id}:cover`);
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
  // The same slug rule as zip entries (sanitize); a symbol-only campaign
  // name falls back to 'artifact' — still a valid file stem.
  const base = exported.campaign?.name ?? 'artifacts';
  return `${sanitize(base)}-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`;
}

/**
 * Pre-build save name for the native picker: the save destination must be
 * acquired inside the click handler BEFORE the (slow) export build, so the
 * name is derived from the campaign name + today rather than from the built
 * payload's `exportedAt` (same shape as `exportFileName`, same day in
 * practice). The single source for every export save name.
 */
export function exportSuggestedName(campaignName: string, format: 'json' | 'zip'): string {
  return `${sanitize(campaignName)}-${new Date(Date.now()).toISOString().slice(0, 10)}.${format}`;
}

/** Multi-file zip bundle: one JSON per artifact + a manifest + image files. */
export function buildZip(exported: CampaignExport): Uint8Array {
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
    files[`artifacts/${artifact.kind}/${sanitize(artifact.name)}-${artifact.id.slice(0, 8)}.json`] =
      strToU8(JSON.stringify(artifact, null, 2));
  }
  for (const image of exported.images ?? []) {
    if (image.dataBase64 === null) continue;
    files[`images/${image.id}.${imageFileExtension(image.mimeType)}`] =
      bytesFromBase64(image.dataBase64);
  }
  return zipSync(files, { level: 6 });
}

function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'artifact'
  );
}

// --- Import -----------------------------------------------------------------

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
}

/** Dependency policy for `importExport`/`importZip` (07-MILESTONE-3 M3-E
 *  slice B, owner-confirmed): `abort` (default) refuses an import whose
 *  statblock citations or NPC refs have no local counterpart — before the
 *  transaction opens, so there is nothing to roll back; `import-anyway`
 *  lands the encounters as-is, where they resolve to the existing
 *  `missing ref` markers until the content is installed. */
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
 * outside the picker): 1. the Rules install surface naming the missing
 * book titles from the blocking citations' L1 identity (the same titles
 * the dialog lists — never invented), 2. retry, or the import-anyway
 * consequence.
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
          .filter((entry) => entry.verdict !== 'present')
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
        `Or import anyway — the encounters land with ‘missing ref’ markers until the content is installed.`,
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

/** Rewrites a deliverable outline's artifact references to imported ids. */
function remapOutlineNodes(nodes: OutlineNode[], artifactIds: ReadonlyMap<Id, Id>): OutlineNode[] {
  return nodes.map((node) => {
    switch (node.type) {
      case 'artifact':
        return { ...node, artifactId: artifactIds.get(node.artifactId) ?? node.artifactId };
      case 'chapter':
      case 'part':
        return { ...node, children: remapOutlineNodes(node.children, artifactIds) };
      default:
        return node;
    }
  });
}

/**
 * Imports an export as a NEW campaign (existing data is never merged or
 * overwritten): fresh ids for the campaign, every module/artifact/revision/
 * battle/run/deliverable; image ids are kept so artifact
 * `imageIds`/`coverImageId` references stay valid (M3-A). `files` carries
 * zip image binaries keyed by archive path.
 *
 * Reference rewriting (M3-E): artifact `moduleId`s follow the module re-id
 * map (an artifact whose module is NOT in the export — a v1 file whose
 * modules were never exported — demotes to campaign level, documented in
 * 07-MILESTONE-3 M3-E); battle tokens/`encounterArtifactId`, run
 * result/target artifacts and deliverable outline nodes follow the artifact
 * re-id map, falling back to the original id when the target was outside a
 * selection export. The dependency manifest and `missingImages` are metadata
 * only (no tables) — validated, not imported.
 *
 * Dependency enforcement (M3-E slice B): unless `options.dependencyPolicy`
 * is `'import-anyway'`, the manifest is checked against the local library
 * FIRST (`checkImportDependencies` — Dexie reads only) and an unmet
 * statblock citation or unmet NPC ref throws `MissingDependenciesError`
 * BEFORE the transaction opens (nothing to roll back). Rulebook chunkIds
 * are KEPT as-is either way, so encounters that land without their content
 * resolve to the existing `missing ref` markers — truthful, never healed.
 * Skipped retired rows never trip this check: their citations leave with
 * them (`parseExportTolerant` filters the manifest).
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
  const { export: parsed, skippedRetired, skippedNames } = parseExportTolerant(raw);

  if (options.dependencyPolicy !== 'import-anyway') {
    const analysis = await checkImportDependencies(parsed.dependencies);
    if (!analysis.clean) throw new MissingDependenciesError(analysis);
  }

  const stamp = Date.now();
  const newCampaignId = crypto.randomUUID();

  const campaign =
    parsed.campaign === null
      ? {
          id: newCampaignId,
          name: 'Imported campaign',
          system: 'generic-d20' as const,
          description: '',
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
  await db.transaction(
    'rw',
    [db.campaigns, db.images, db.artifacts, db.revisions, db.modules, db.battles, db.runs, db.deliverables],
    async () => {
      await db.campaigns.add(campaign);

      // Modules first: their re-id map anchors artifact `moduleId`s below.
      const moduleIds = new Map<Id, Id>();
      for (const exported of parsed.modules ?? []) {
        const moduleId = crypto.randomUUID();
        moduleIds.set(exported.id, moduleId);
        await db.modules.add(
          moduleSchema.parse({
            ...exported,
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

      const artifactIds = new Map<Id, Id>();
      for (const exported of parsed.artifacts) {
        const artifactId = crypto.randomUUID();
        artifactIds.set(exported.id, artifactId);
        const { revisions, ...artifactFields } = exported;
        await db.artifacts.add(
          artifactSchema.parse({
            ...artifactFields,
            id: artifactId,
            campaignId: newCampaignId,
            moduleId:
              artifactFields.moduleId === null
                ? null
                : (moduleIds.get(artifactFields.moduleId) ?? null),
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
        const moduleId = moduleIds.get(exported.moduleId);
        if (moduleId === undefined) {
          throw new Error(
            `Import references a battle for module ${exported.moduleId} outside the export`,
          );
        }
        const remapTokenArtifact = (id: Id | null): Id | null =>
          id === null ? null : (artifactIds.get(id) ?? id);
        await db.battles.add(
          battleSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            moduleId,
            encounterArtifactId: remapTokenArtifact(exported.encounterArtifactId),
            reseed:
              exported.reseed === null
                ? null
                : {
                    ...exported.reseed,
                    encounterArtifactId:
                      artifactIds.get(exported.reseed.encounterArtifactId) ??
                      exported.reseed.encounterArtifactId,
                  },
            board: {
              ...exported.board,
              tokens: exported.board.tokens.map((token) => ({
                ...token,
                artifactId: remapTokenArtifact(token.artifactId),
              })),
              stage:
                exported.board.stage === null
                  ? null
                  : {
                      ...exported.board.stage,
                      tokens: exported.board.stage.tokens.map((token) => ({
                        ...token,
                        artifactId: remapTokenArtifact(token.artifactId),
                      })),
                    },
            },
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

      for (const exported of parsed.runs ?? []) {
        await db.runs.add(
          personaRunSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            resultArtifactId:
              exported.resultArtifactId === null
                ? null
                : (artifactIds.get(exported.resultArtifactId) ?? exported.resultArtifactId),
            targetArtifactId:
              exported.targetArtifactId === null
                ? null
                : (artifactIds.get(exported.targetArtifactId) ?? exported.targetArtifactId),
            placementModuleId:
              exported.placementModuleId === null
                ? null
                : (moduleIds.get(exported.placementModuleId) ?? null),
            contextArtifactIds:
              exported.contextArtifactIds === null
                ? null
                : exported.contextArtifactIds.map((id) => artifactIds.get(id) ?? id),
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }

      for (const exported of parsed.deliverables ?? []) {
        await db.deliverables.add(
          deliverableSchema.parse({
            ...exported,
            id: crypto.randomUUID(),
            campaignId: newCampaignId,
            outline: remapOutlineNodes(exported.outline, artifactIds),
            createdAt: stamp,
            updatedAt: stamp,
          }),
        );
      }
    },
  );
  return { campaignId: newCampaignId, createdArtifacts: created, skippedRetired, skippedNames };
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
  deliverables: z.array(deliverableSchema).optional(),
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
  deliverables: z.array(deliverableSchema).optional(),
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
