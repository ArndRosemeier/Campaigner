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

/**
 * Owner-facing classification of WHY a run failed (docs/05 run views). Set
 * at every site that marks a run failed (runEngine catch paths,
 * `failRunningRuns`); annotates the raw `errorMessage`, never replaces it.
 * Null on rows written before the field existed — the UI renders null as
 * 'unknown' guidance; no migration.
 */
export const failureKindSchema = z.enum([
  /** 429/5xx/timeout — the provider never delivered. Resuming makes sense. */
  'congestion',
  /** The model refused the content (moderation / `delta.refusal`). */
  'filter',
  /** The provider rejected the strict JSON-schema response_format. */
  'schema-rejected',
  /** The reply could not be parsed/validated into the contract. */
  'invalid-output',
  /** A programming error (StrictSchemaError, TypeError, …), not transient. */
  'bug',
  /** Cancelled by the user or interrupted by a page reload. */
  'cancelled',
  /** Nothing matched — raw message is the only honest surface. */
  'unknown',
]);

export type FailureKind = z.infer<typeof failureKindSchema>;

/** Badge text for the failure classification (docs/05 run views). */
export const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  congestion: 'Provider congestion or timeout',
  filter: 'Model refusal',
  'schema-rejected': 'Strict JSON contract rejected',
  'invalid-output': 'Unusable model reply',
  bug: 'Likely Campaigner bug',
  cancelled: 'Cancelled or interrupted',
  unknown: 'Unclassified failure',
};

/**
 * Owner-facing guidance per failure kind — one line next to the raw error in
 * the failed-run Details section. Pure data (test-pinned verbatim); the raw
 * message stays the error surface, this only tells the owner what the kind
 * means for recovery.
 */
export const FAILURE_KIND_GUIDANCE: Record<FailureKind, string> = {
  congestion: 'The provider was overloaded or timed out — resuming this run makes sense.',
  filter:
    'The model refused the content — resuming with the same model will refuse again; pick a different model or adjust the prompt.',
  'schema-rejected':
    'The model rejected the strict JSON contract — pick a model that supports structured outputs or turn Strict structured outputs off in Settings.',
  'invalid-output':
    'The reply could not be used even after validation — resuming may help once; if it repeats, it is a contract or model problem.',
  bug: 'This looks like a Campaigner bug, not a transient failure — resuming will fail the same way. Please report it.',
  cancelled: 'The run was cancelled or interrupted by a page reload.',
  unknown: 'No classification was possible — see the raw error below.',
};

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
  /**
   * Why the run failed (`failureKindSchema`), null for rows written before
   * the field existed (parse-on-read materializes the default — no Dexie
   * version) and for non-failed runs. Annotates `errorMessage`, never
   * replaces or truncates it; guidance copy in `FAILURE_KIND_GUIDANCE`.
   */
  failureKind: failureKindSchema.nullable().default(null),
});

export type PersonaRun = z.infer<typeof personaRunSchema>;

/** Post-create extras flags carried on the run row. */
export type RunExtras = NonNullable<PersonaRun['runExtras']>;
