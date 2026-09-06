import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { encounterMapAspectSchema, encounterPresetSchema } from '@/domain/encounterMap/schema';

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
  /**
   * Encounter generator option (docs/11 D10): the Dungeon preset — which
   * grid tier the layout generates on. Persisted so pause/resume/retry
   * reconstructs the input exactly (like `encounterMapAspect`); null for
   * runs started before the field existed and for every other persona mode.
   */
  encounterPreset: encounterPresetSchema.nullable().default(null),
  /**
   * Module placement chosen in the creation dialog for a NEWLY created
   * artifact (null = campaign level / unset). One-off per run, never a
   * remembered preference; ignored by in-place fills (placement of an
   * existing artifact changes only via the editor's explicit scope moves).
   */
  placementModuleId: z.uuid().nullable().default(null),
  /**
   * Post-create extras ticked in the creation dialog, persisted so
   * pause/resume/retry reconstructs the input exactly (like
   * `encounterMapAspect`). Null for runs started before the field existed.
   */
  runExtras: z
    .object({
      image: z.boolean(),
      statBlock: z.boolean(),
      mobPortraits: z.boolean(),
      /**
       * REMOVED as an offer (D10 amendment arc): battlemaps for freshly
       * created encounters run automatically via the unattended map queue
       * (post-run-extras). The flag stays OPTIONAL purely for old-row
       * parsing — pre-amendment run rows carry `battlemap: false/true`;
       * new runs never set it.
       */
      battlemap: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  /**
   * Module post-pass mode ("one candidate, no user checkpoints"). Persisted
   * so resumeRun reconstructs the mode exactly (F8): a paused unattended
   * Cartographer run resumed from the Runs tab must re-run WITHOUT user
   * checkpoints, never as a checkpointed interactive run. Null for runs
   * started before the field existed and for every interactive run.
   */
  unattended: z.boolean().nullable().default(null),
  /**
   * Writers'-room chain grounding (06-MILESTONES M2): artifacts from
   * earlier chain steps, injected into the draft prompt as context.
   * Persisted so reload + resume keeps the chain grounding (F8) — without
   * it a resumed chain-step run silently drafted without its siblings.
   * Null for runs started before the field existed and for non-chain runs.
   */
  contextArtifactIds: z.array(z.string()).nullable().default(null),
  errorMessage: z.string(),
});

export type PersonaRun = z.infer<typeof personaRunSchema>;

/** Post-create extras flags carried on the run row. */
export type RunExtras = NonNullable<PersonaRun['runExtras']>;
