import { z } from 'zod';
import { strToU8, zipSync } from 'fflate';

import type { Artifact, ArtifactRevision, Campaign, Id } from '@/domain';
import { artifactSchema, artifactRevisionSchema, campaignSchema } from '@/domain';
import { listRevisions } from '@/db/artifactRepo';
import { db } from '@/db/db';

/**
 * Export/import (06-MILESTONES M2): JSON for a single artifact, a selection,
 * or a whole campaign; a zip bundle for multi-file exports. Imports are
 * zod-validated and re-id'd so they can never collide with existing rows.
 */

export const EXPORT_FORMAT_VERSION = 1;

/** One exportable bundle shape covering single/selection/whole-campaign. */
export interface CampaignExport {
  format: 'campaigner-export';
  version: 1;
  exportedAt: number;
  campaign: Campaign | null;
  artifacts: (Artifact & { revisions: ArtifactRevision[] })[];
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

/** Everything needed to export one campaign (or a subset) in one pass. */
export async function buildCampaignExport(
  campaignId: Id,
  artifactIds?: readonly Id[],
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
  return buildExport(campaign, withRevisions);
}

export function exportFileName(exported: CampaignExport): string {
  const base = exported.campaign?.name ?? 'artifacts';
  const slug = base
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `${slug || 'export'}-${new Date(exported.exportedAt).toISOString().slice(0, 10)}.json`;
}

/** Multi-file zip bundle: one JSON per artifact + a manifest. */
export function buildZip(exported: CampaignExport): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'campaigner-export.json': strToU8(JSON.stringify(exported, null, 2)),
  };
  for (const artifact of exported.artifacts) {
    files[`artifacts/${artifact.kind}/${sanitize(artifact.name)}-${artifact.id.slice(0, 8)}.json`] =
      strToU8(JSON.stringify(artifact, null, 2));
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
 * overwritten): fresh ids for the campaign and every artifact/revision,
 * zod-validated throughout.
 */
export async function importExport(raw: unknown): Promise<ImportResult> {
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
