import { z } from 'zod';

import { anyArtifactSchema, type AnyArtifact } from '@/domain/artifact';
import { BaseEntitySchema, stampNewEntity } from '@/domain/entity';

export const revisionSourceSchema = z.enum(['user', 'persona']);

export type RevisionSource = z.infer<typeof revisionSourceSchema>;

/** Full snapshot per revision (01-DATA-MODEL §ArtifactRevision) — storage is cheap for text. */
export const artifactRevisionSchema = z.object({
  ...BaseEntitySchema.shape,
  artifactId: z.uuid(),
  /** 1-based; matches the artifact's `currentRevision` when written. */
  revision: z.number().int().positive(),
  /** Deep copy of the artifact at save time (any scope, M6-C). */
  snapshot: anyArtifactSchema,
  /** Who produced this revision. Additive `.default('user')`: revisions
   * written before the field existed were all user saves — parse-on-read
   * materializes it without a migration. */
  source: revisionSourceSchema.default('user'),
  /** PersonaRun that produced it, if source === 'persona'. Additive
   * `.default(null)` for the same pre-M3 rows. */
  runId: z.uuid().nullable().default(null),
});

export type ArtifactRevision = z.infer<typeof artifactRevisionSchema>;

/**
 * ONE revision snapshot row for a written artifact (docs/17 row 257).
 *
 * It lives in the DOMAIN, not in `db/artifactRepo`, because the row shape is
 * pure: `writeRevision` (the live writer) and the migration seam that writes
 * inside a `version(N).upgrade` transaction both need EXACTLY this row, and a
 * second copy of it in the migration would be a revision contract that can
 * drift from the one the app writes at runtime. The live `revisionRowFor`
 * delegates here; the tx-taking adoption seam calls it with the
 * transaction's own tables.
 */
export function artifactRevisionRow(
  valid: AnyArtifact,
  source: RevisionSource = 'user',
  runId: string | null = null,
): ArtifactRevision {
  return {
    ...stampNewEntity(valid.updatedAt),
    artifactId: valid.id,
    revision: valid.currentRevision,
    snapshot: structuredClone(valid),
    source,
    runId,
  };
}

/** Max revisions kept per artifact; the oldest are deleted beyond this. */
export const MAX_REVISIONS_PER_ARTIFACT = 50;
