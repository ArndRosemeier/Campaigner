import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { artifactKindSchema } from '@/domain/artifact';

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
     * existing artifact with generated images (M3-A Illustrator) and are not
     * chainable.
     */
    mode: z.enum(['generate', 'review', 'image']).default('generate'),
    /** Built-ins are re-seeded on app start if missing (never overwritten). */
    builtIn: z.boolean(),
  })
  .superRefine((persona, ctx) => {
    if (persona.mode !== 'image' && persona.producesKind === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['producesKind'],
        message: 'generate/review personas must declare producesKind',
      });
    }
  });

export type Persona = z.infer<typeof personaSchema>;

/** Default temperature for personas (01-DATA-MODEL). */
export const DEFAULT_PERSONA_TEMPERATURE = 0.8;
