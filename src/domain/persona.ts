import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { artifactKindSchema } from '@/domain/artifact';

export const personaSchema = z.object({
  ...BaseEntitySchema.shape,
  /** 'npc-smith' — unique, used in code. */
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case slug'),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  /** OpenRouter model id; '' means "use the default chat model". */
  model: z.string(),
  temperature: z.number().min(0).max(2),
  /** Artifact kind this persona outputs. */
  producesKind: artifactKindSchema,
  /** Built-ins are re-seeded on app start if missing (never overwritten). */
  builtIn: z.boolean(),
});

export type Persona = z.infer<typeof personaSchema>;

/** Default temperature for personas (01-DATA-MODEL). */
export const DEFAULT_PERSONA_TEMPERATURE = 0.8;
