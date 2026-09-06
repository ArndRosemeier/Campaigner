import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { artifactKindSchema } from '@/domain/artifact';
import { reasoningEffortSchema } from '@/domain/settings';

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

export const personaSchema = z
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

export type Persona = z.infer<typeof personaSchema>;

/** Default temperature for personas (01-DATA-MODEL). */
export const DEFAULT_PERSONA_TEMPERATURE = 0.8;
