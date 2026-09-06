import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { personaSchema, newId, type Persona } from '@/domain';
import { getPersona, listPersonas, findPersonaBySlug } from '@/db/personaRepo';
import { db } from '@/db/db';
import { clearDatabase } from './helpers';

/**
 * personaRepo read boundary: the three reads schema-parse, so M1-era rows
 * (written before `mode`/`reasoningEffort` existed — built-in seeding skips
 * existing slugs, so old rows are never rewritten) materialize the schema
 * defaults on read, and a corrupt row fails loudly (AGENTS rules 1+3).
 */
describe('personaRepo legacy rows (parse-on-read materializes defaults)', () => {
  beforeEach(clearDatabase);

  async function putLegacyPersona(): Promise<Persona> {
    const legacy = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      slug: 'm1-era-smith',
      name: 'M1 Smith',
      description: '',
      systemPrompt: '',
      model: '',
      temperature: 0.8,
      producesKind: 'note',
      builtIn: false,
      // NO mode/reasoningEffort — added after M1.
    };
    await db.personas.put(legacy as unknown as Persona);
    return legacy as unknown as Persona;
  }

  it('getPersona materializes mode/reasoningEffort defaults', async () => {
    const legacy = await putLegacyPersona();
    const persona = await getPersona(legacy.id);
    expect(persona?.mode).toBe('generate');
    expect(persona?.reasoningEffort).toBe('default');
    // …and the parsed row still validates against the current schema.
    expect(personaSchema.parse(persona).mode).toBe('generate');
  });

  it('findPersonaBySlug materializes the defaults', async () => {
    await putLegacyPersona();
    const persona = await findPersonaBySlug('m1-era-smith');
    expect(persona?.mode).toBe('generate');
    expect(persona?.reasoningEffort).toBe('default');
  });

  it('listPersonas materializes the defaults', async () => {
    await putLegacyPersona();
    const personas = await listPersonas();
    expect(personas).toHaveLength(1);
    expect(personas[0]?.mode).toBe('generate');
    expect(personas[0]?.reasoningEffort).toBe('default');
  });
});
