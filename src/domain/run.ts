import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { encounterMapAspectSchema } from '@/domain/encounterMap/schema';

export const autonomySchema = z.enum(['manual', 'review', 'auto']);

export type Autonomy = z.infer<typeof autonomySchema>;

export const runStatusSchema = z.enum([
  'running',
  'awaiting_user',
  'needs_review',
  'completed',
  'cancelled',
  'failed',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runStepStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'approved',
  'rejected',
  'skipped',
]);

export type RunStepStatus = z.infer<typeof runStepStatusSchema>;

/** One pipeline step ('retrieve' | 'draft' | 'statblock' | 'finalize'). */
export const runStepSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  status: runStepStatusSchema,
  /** JSON-serializable step input. */
  input: z.unknown(),
  /** JSON-serializable step output. */
  output: z.unknown(),
  /** User's edited version of the output, if any. */
  userEdit: z.unknown().nullable(),
});

export type RunStep = z.infer<typeof runStepSchema>;

export const personaRunSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  personaId: z.uuid(),
  autonomy: autonomySchema,
  status: runStatusSchema,
  /** The user's task description. */
  userBrief: z.string(),
  /** User-pinned rule chunks. */
  pinnedChunkIds: z.array(z.string()),
  /** Embedded array (runs are small). */
  steps: z.array(runStepSchema),
  resultArtifactId: z.uuid().nullable(),
  /**
   * The artifact a run operates on: review personas check it (M2), image
   * personas decorate it (M3-A). Null for generate personas.
   */
  targetArtifactId: z.uuid().nullable(),
  /** Encounter generator option, null for every other persona mode. */
  encounterMapAspect: encounterMapAspectSchema.nullable().default(null),
  errorMessage: z.string(),
});

export type PersonaRun = z.infer<typeof personaRunSchema>;
