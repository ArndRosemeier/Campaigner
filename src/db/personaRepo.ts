import { createPersona as buildPersona, personaSchema, type Id, type Persona } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

/** Mutable persona fields; `slug` is code-facing and `builtIn` is seeding-owned. */
export interface PersonaPatch {
  name?: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: Persona['reasoningEffort'];
  temperature?: number;
  producesKind?: Persona['producesKind'];
}

/** Inserts a persona row (unique slug enforced by the `&slug` index). */
export async function addPersona(persona: Persona): Promise<Persona> {
  await db.personas.put(persona);
  return persona;
}

export async function createPersona(input: Parameters<typeof buildPersona>[0]): Promise<Persona> {
  return addPersona(buildPersona(input));
}

/**
 * Legacy-row guard at the Dexie boundary (the ratified `parseBattleRow`
 * template): M1-era rows predate `mode`/`reasoningEffort` — the schema
 * defaults materialize on read ('generate'/'default'), and a corrupt row
 * fails loudly instead of leaking a partial type (AGENTS rules 1+3).
 * Built-in seeding skips existing slugs, so old rows are never rewritten.
 */
function parsePersonaRow(row: Persona): Persona {
  return personaSchema.parse(row);
}

export async function getPersona(id: Id): Promise<Persona | undefined> {
  const row = await db.personas.get(id);
  return row === undefined ? undefined : parsePersonaRow(row);
}

/** All personas, alphabetically (dropdown order). */
export async function listPersonas(): Promise<Persona[]> {
  const rows = await db.personas.toArray();
  return rows.map(parsePersonaRow).sort((a, b) => a.name.localeCompare(b.name));
}

export async function findPersonaBySlug(slug: string): Promise<Persona | undefined> {
  const row = await db.personas.where('slug').equals(slug).first();
  return row === undefined ? undefined : parsePersonaRow(row);
}

export async function updatePersona(id: Id, patch: PersonaPatch): Promise<Persona> {
  return db.transaction('rw', db.personas, async () => {
    const current = await db.personas.get(id);
    if (!current) throw new NotFoundError('Persona', id);
    const updated = personaSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    await db.personas.put(updated);
    return updated;
  });
}

/**
 * Overwrites a built-in persona's definition with its built-in values while
 * keeping the row identity (runs reference the persona id).
 */
export async function resetPersonaToDefault(slug: string): Promise<Persona> {
  const builtin = BUILT_IN_PERSONAS.find((persona) => persona.slug === slug);
  if (!builtin) throw new NotFoundError('Built-in persona', slug);

  return db.transaction('rw', db.personas, async () => {
    const current = await findPersonaBySlug(slug);
    if (!current) throw new NotFoundError('Persona', slug);
    const updated = personaSchema.parse({
      ...current,
      name: builtin.name,
      description: builtin.description,
      systemPrompt: builtin.systemPrompt,
      model: builtin.model,
      reasoningEffort: builtin.reasoningEffort,
      temperature: builtin.temperature,
      producesKind: builtin.producesKind,
      builtIn: true,
      updatedAt: Date.now(),
    });
    await db.personas.put(updated);
    return updated;
  });
}
