import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { addPersona, findPersonaBySlug } from '@/db/personaRepo';

/**
 * Seeds the built-in personas on app start (01-DATA-MODEL: built-ins are
 * re-seeded if missing; 04-LLM-PERSONAS: never overwrite user edits —
 * insertion is skipped whenever the slug already exists).
 *
 * Idempotent; safe to call on every app start.
 */
export async function seedBuiltInPersonas(): Promise<void> {
  for (const persona of BUILT_IN_PERSONAS) {
    const existing = await findPersonaBySlug(persona.slug);
    if (!existing) {
      await addPersona(persona);
    }
  }
}
