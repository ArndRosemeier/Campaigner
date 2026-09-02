import { z } from 'zod';

import { anyArtifactSchema } from '@/domain/artifact';
import { BaseEntitySchema } from '@/domain/entity';

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
  /** Who produced this revision. */
  source: revisionSourceSchema,
  /** PersonaRun that produced it, if source === 'persona'. */
  runId: z.uuid().nullable(),
});

export type ArtifactRevision = z.infer<typeof artifactRevisionSchema>;

/** Max revisions kept per artifact; the oldest are deleted beyond this. */
export const MAX_REVISIONS_PER_ARTIFACT = 50;
