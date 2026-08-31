import { z } from 'zod';
import { strToU8, unzipSync, zipSync } from 'fflate';

import type { Artifact, ArtifactRevision, Campaign, Id } from '@/domain';
import { artifactSchema, artifactRevisionSchema, campaignSchema, storedImageSchema } from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { db } from '@/db/db';

/**
 * Export/import (06-MILESTONES M2; images M3-A): JSON for a single artifact,
 * a selection, or a whole campaign; a zip bundle for multi-file exports.
 * Images (M3-A) ride the zip as binary files `images/<id>.<ext>` referenced
 * by id in the JSON; plain JSON export omits the binaries entirely. Imports
 * are zod-validated and re-id'd so they can never collide with existing rows
 * (image ids are kept — artifacts reference them by id).
 */

export const EXPORT_FORMAT_VERSION = 1;

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
  version: 1;
  exportedAt: number;
  campaign: Campaign | null;
  artifacts: (Artifact & { revisions: ArtifactRevision[] })[];
  /** Present when the export was built with image support (M3-A). */
  images?: ExportedImage[];
}

export function buildExport(
  campaign: Campaign | null,
  artifactsWithRevisions: (Artifact & { revisions: ArtifactRevision[] })[],
): CampaignExport {
  return {
    format: 'campaigner-export',
    version: 1,
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

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  const all = await db.artifacts.where('campaignId').equals(campaignId).toArray();
  const selected =
    artifactIds === undefined ? all : all.filter((artifact) => artifactIds.includes(artifact.id));
  const withRevisions = await Promise.all(
    selected.map(async (artifact) => ({
      ...artifact,
      revisions: await listRevisions(artifact.id),
    })),
  );
  const exported = buildExport(campaign, withRevisions);
  if (opts.images !== true) return exported;

  // Every image referenced by the exported artifacts — including revision
  // snapshots (07-MILESTONE-3 M3-A §Export).
  const referencedIds = new Set<Id>();
  for (const artifact of withRevisions) {
    for (const id of artifact.imageIds) referencedIds.add(id);
    if (artifact.coverImageId !== null) referencedIds.add(artifact.coverImageId);
    for (const revision of artifact.revisions) {
      const snapshot = revision.snapshot as { imageIds?: Id[]; coverImageId?: Id | null } | null;
      for (const id of snapshot?.imageIds ?? []) referencedIds.add(id);
      if (snapshot?.coverImageId != null) referencedIds.add(snapshot.coverImageId);
    }
  }
  const rows = await db.images.bulkGet([...referencedIds]);
  exported.images = rows
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .map((row) => ({
      id: row.id,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      prompt: row.prompt,
      model: row.model,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      dataBase64: base64FromBytes(row.bytes),
    }));
  return exported;
}

export function exportFileName(exported: CampaignExport): string {
  const base = exported.campaign?.name ?? 'artifacts';
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `${slug || 'export'}-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`;
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

/**
 * Imports an export as a NEW campaign (existing data is never merged or
 * overwritten): fresh ids for the campaign and every artifact/revision;
 * image ids are kept so artifact `imageIds`/`coverImageId` references stay
 * valid (M3-A). `files` carries zip image binaries keyed by archive path.
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
  await db.campaigns.add(campaign);

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

  let created = 0;
  for (const exported of parsed.artifacts) {
    const artifactId = crypto.randomUUID();
    const { revisions, ...artifactFields } = exported;
    const artifact = artifactSchema.parse({
      ...artifactFields,
      id: artifactId,
      campaignId: newCampaignId,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db.artifacts.add(artifact);
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
  version: z.literal(1),
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
