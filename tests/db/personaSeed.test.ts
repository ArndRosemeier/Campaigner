import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/domain';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  addPersona,
  findPersonaBySlug,
  listPersonas,
  resetPersonaToDefault,
  updatePersona,
} from '@/db/personaRepo';
import { db } from '@/db/db';
import { clearDatabase, expectNotFound } from './helpers';

describe('built-in persona seeding', () => {
  it('seeds all four built-ins exactly once', async () => {
    await seedBuiltInPersonas();
    await seedBuiltInPersonas();

    expect(await db.personas.count()).toBe(4);
    const slugs = (await listPersonas()).map((persona) => persona.slug);
    // listPersonas sorts by name.
    expect(slugs).toEqual(['faction-designer', 'npc-smith', 'plot-architect', 'worldbuilder']);
  });

  it('seeds NPC Smith with the verbatim system prompt', async () => {
    await seedBuiltInPersonas();

    const smith = await findPersonaBySlug('npc-smith');
    expect(smith?.name).toBe('NPC Smith');
    expect(smith?.producesKind).toBe('npc');
    expect(smith?.builtIn).toBe(true);
    expect(smith?.systemPrompt).toMatch(/^You are NPC Smith,/);
    expect(smith?.systemPrompt).toContain('Never include commentary');
  });

  it('never overwrites user edits on re-seed', async () => {
    await seedBuiltInPersonas();

    const smith = await findPersonaBySlug('npc-smith');
    if (!smith) throw new Error('npc-smith should be seeded');
    await updatePersona(smith.id, { name: 'Custom Smith', temperature: 0.3 });

    await seedBuiltInPersonas();

    const edited = await findPersonaBySlug('npc-smith');
    expect(edited?.name).toBe('Custom Smith');
    expect(edited?.temperature).toBe(0.3);
  });

  it('re-seeds a built-in that is missing from the DB', async () => {
    await seedBuiltInPersonas();
    const smith = await findPersonaBySlug('npc-smith');
    if (!smith) throw new Error('npc-smith should be seeded');
    await db.personas.delete(smith.id);

    await seedBuiltInPersonas();

    expect(await findPersonaBySlug('npc-smith')).toBeDefined();
    expect(await db.personas.count()).toBe(4);
  });

  it('resetPersonaToDefault restores built-in values, keeping the row id', async () => {
    await seedBuiltInPersonas();
    const smith = await findPersonaBySlug('npc-smith');
    if (!smith) throw new Error('npc-smith should be seeded');

    await updatePersona(smith.id, {
      name: 'Custom Smith',
      systemPrompt: 'custom prompt',
      model: 'openai/gpt-4o',
    });
    const reset = await resetPersonaToDefault('npc-smith');

    expect(reset.id).toBe(smith.id);
    expect(reset.name).toBe('NPC Smith');
    expect(reset.systemPrompt).toBe(smith.systemPrompt);
    expect(reset.model).toBe('');
    expect(reset.builtIn).toBe(true);
  });

  it('resetPersonaToDefault rejects unknown or missing personas', async () => {
    await expectNotFound(resetPersonaToDefault('no-such-persona'));
  });

  it('enforces unique slugs at the DB level', async () => {
    await seedBuiltInPersonas();
    const smith = await findPersonaBySlug('npc-smith');
    if (!smith) throw new Error('npc-smith should be seeded');

    const dupe = { ...smith, id: newId() };
    await expect(addPersona(dupe)).rejects.toThrow();
  });

  beforeEach(clearDatabase);
});
