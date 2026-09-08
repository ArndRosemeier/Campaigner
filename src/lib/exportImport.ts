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
  type ExportDependencies,
  type ExportMissingImage,
} from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { bytesFromBase64 } from '@/lib/base64';
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
 * only (no tables) — validated, not imported (slice B owns enforcement).
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
): Promise<ImportResult> {
  const parsed = exportSchema.parse(raw);
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
  return { campaignId: newCampaignId, createdArtifacts: created };
}

/**
 * Imports a zip bundle: extracts the manifest JSON and the `images/*`
 * binaries, then defers to `importExport` (M3-A).
 */
export async function importZip(zipBytes: Uint8Array): Promise<ImportResult> {
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
  return importExport(manifest, rest);
}

const exportSchema = z.object({
  format: z.literal('campaigner-export'),
  /** v1 files predate the M3-E tables/manifest; every new field is optional. */
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.number(),
  campaign: campaignSchema.nullable(),
  artifacts: z.array(
    artifactSchema.and(
      z.object({
        revisions: z.array(artifactRevisionSchema),
      }),
    ),
  ),
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
