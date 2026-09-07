import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { artifactKindSchema, type ArtifactKind } from '@/domain/artifact';
import { reasoningEffortSchema } from '@/domain/settings';

/**
 * Legacy `producesKind` normalization — the git-proven removed-value map.
 *
 * `producesKind` was always `artifactKindSchema`; the ARTIFACT_KINDS union
 * across the repo's entire history is
 * {npc, location, faction, note} (T2 3279ea7)
 *   + {encounter, plotarc, session} (M2 cd8e751)
 *   + {pc} (M5-A 27b2ecb)
 *   − {session} (M6-E a670751),
 * so 'session' is the ONLY value the current enum ever dropped. It rode the
 * built-in Session Chronicler (`session-chronicler`, added b18e33a, removed
 * with the kind in a670751): the v11 migration deleted session ARTIFACTS but
 * never touched persona rows, personas are global and `seedBuiltInPersonas`
 * skips existing slugs — so a pre-M6-E DB keeps that row with
 * `producesKind: 'session'` forever, and the parse-on-read boundary
 * (caa40b0) turned it into a ZodError on every workspace render (owner
 * crash report).
 *
 * Mapping: 'session' → 'note'. The session kind has no successor kind (M6-E
 * moved play to modules); 'note' is what persona-authored free-text
 * reports/plans produce today (review personas and Plot Architect produce
 * 'note' at HEAD), so the retired chronicler parses as a note-producing
 * generate persona.
 *
 * NOT a catch-all (AGENTS rule 1): any value outside the current enum ∪ this
 * table — e.g. the never-valid 'map'/'story', or null, which no write path
 * ever produced (the field was a required enum T2→M3-A, then `.optional()`
 * for image personas) — still fails loudly at the boundary. The table is the
 * complete historic enumeration; when a future arc removes an artifact kind
 * again, add the removed value HERE with its provenance.
 */
const LEGACY_PRODUCES_KIND: Readonly<Record<string, ArtifactKind>> = {
  session: 'note',
};

/**
 * Rewrites a raw row's known-legacy `producesKind` to its current equivalent
 * before schema parsing (ONE normalization shared by every personaSchema
 * boundary: repo reads/updates, backup-restore healing on the next read).
 * Current-enum values and absent values pass through untouched.
 */
export function normalizeLegacyProducesKind<T extends { producesKind?: unknown }>(row: T): T {
  const kind = row.producesKind;
  if (typeof kind !== 'string') return row;
  // noUncheckedIndexedAccess: the lookup is undefined for current-enum (and
  // unknown) values — exactly the rows that must pass through or fail loudly.
  const mapped: ArtifactKind | undefined = LEGACY_PRODUCES_KIND[kind];
  if (mapped === undefined) return row;
  return { ...row, producesKind: mapped };
}

/**
 * Post-create extras the creation dialog can offer for a freshly created
 * artifact: the dialog derives the offered checkboxes from the CHOSEN
 * persona — a declared `postCreateExtras` field on the persona wins;
 * personas without one fall back to `derivePostCreateExtras`
 * (src/llm/personas/extras.ts) computed from `mode`/`producesKind`.
 */
/**
 * The extras a persona may declare. `'battlemap'` remains in the enum ONLY
 * for old-row parsing (pre-amendment personas may still declare it) — it is
 * no longer offered or derived anywhere: battlemaps for freshly created
 * encounters run automatically via the unattended map queue (D10 amendment
 * arc, src/llm/personas/extras.ts).
 */
export const POST_CREATE_EXTRAS = ['image', 'statBlock', 'mobPortraits', 'battlemap'] as const;

export const postCreateExtraSchema = z.enum(POST_CREATE_EXTRAS);

export type PostCreateExtra = z.infer<typeof postCreateExtraSchema>;

const personaObjectSchema = z
  .object({
    ...BaseEntitySchema.shape,
    /** 'npc-smith' — unique, used in code. */
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case slug'),
    name: z.string().min(1),
    description: z.string(),
    systemPrompt: z.string(),
    /** OpenRouter model id; '' means "use the default chat model". */
    model: z.string(),
    /** Reasoning effort override ('default' = inherit default/model setting). */
    reasoningEffort: reasoningEffortSchema.default('default'),
    temperature: z.number().min(0).max(2),
    /**
     * Artifact kind this persona outputs. Required for generate/review
     * personas; image personas (mode 'image') never produce one.
     */
    producesKind: artifactKindSchema.optional(),
    /**
     * 'generate' personas create artifacts from a brief (M1 pipeline);
     * 'review' personas check an existing artifact against the campaign and
     * produce a report (M2 Continuity Editor); 'image' personas decorate an
     * existing artifact with generated images (M3-A Illustrator); 'encounter'
     * produces a complete encounter plus generated room map.
     */
    mode: z.enum(['generate', 'review', 'image', 'encounter']).default('generate'),
    /**
     * Extras the creation dialog offers for a freshly created artifact
     * (POST_CREATE_EXTRAS). Optional: unset → the dialog derives the
     * offered set from `mode`/`producesKind` (src/llm/personas/extras.ts).
     */
    postCreateExtras: z.array(postCreateExtraSchema).optional(),
    /** Built-ins are re-seeded on app start if missing (never overwritten). */
    builtIn: z.boolean(),
  })
  .superRefine((persona, ctx) => {
    if (persona.mode !== 'image' && persona.producesKind === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['producesKind'],
        message: 'generate/review/encounter personas must declare producesKind',
      });
    }
    if (persona.mode === 'encounter' && persona.producesKind !== 'encounter') {
      ctx.addIssue({
        code: 'custom',
        path: ['producesKind'],
        message: 'encounter personas must produce encounters',
      });
    }
  });

/**
 * The persona schema every boundary parses through: the documented legacy
 * pre-pass runs FIRST (same house pattern as `encounterDataSchema` +
 * `normalizeEncounterShapeData`), so repo reads/updates and restored backup
 * rows normalize the git-proven removed values before the object validates.
 */
export const personaSchema = z.preprocess(
  // Raw rows are untrusted input — the house cast pattern (encounterDataSchema).
  (row: unknown) => normalizeLegacyProducesKind(row as { producesKind?: unknown }),
  personaObjectSchema,
);

export type Persona = z.infer<typeof personaSchema>;

/** Default temperature for personas (01-DATA-MODEL). */
export const DEFAULT_PERSONA_TEMPERATURE = 0.8;
