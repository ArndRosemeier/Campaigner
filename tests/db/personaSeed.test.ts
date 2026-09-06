import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/domain';
import { seedBuiltInPersonas } from '@/db/seed';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
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
  it('seeds all built-ins exactly once', async () => {
    await seedBuiltInPersonas();
    await seedBuiltInPersonas();

    expect(await db.personas.count()).toBe(BUILT_IN_PERSONAS.length);
    const slugs = (await listPersonas()).map((persona) => persona.slug);
    // listPersonas sorts by name.
    expect(slugs).toEqual(
      [...BUILT_IN_PERSONAS.map((persona) => persona.slug)].sort((a, b) => a.localeCompare(b)),
    );
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

  /**
   * Owner-ratified prompt contract (no verification step, no output
   * stripping — the clause IS the mechanism): the Location generator
   * (Worldbuilder) must never invent monsters. Hazards and complications
   * are explicitly welcome; creatures live in encounters and dungeons, and
   * the draft references where a creature will be encountered instead of
   * statting it.
   */
  it('pins the location no-monsters contract in the Worldbuilder prompt', async () => {
    await seedBuiltInPersonas();

    const worldbuilder = await findPersonaBySlug('worldbuilder');
    expect(worldbuilder?.producesKind).toBe('location');
    const prompt = worldbuilder?.systemPrompt ?? '';
    expect(prompt).toContain('Monsters are NOT');
    expect(prompt).toContain('a location never invents creatures');
    expect(prompt).toContain('monsters live in encounters and dungeons');
    expect(prompt).toContain('reference where it will be encountered');
    expect(prompt).toContain('Hazards, traps and environmental complications are welcome');
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
    expect(await db.personas.count()).toBe(BUILT_IN_PERSONAS.length);
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
    expect(reset.reasoningEffort).toBe('default');
    expect(reset.builtIn).toBe(true);
  });

  it('updates and resets reasoningEffort', async () => {
    await seedBuiltInPersonas();
    const smith = await findPersonaBySlug('npc-smith');
    if (!smith) throw new Error('npc-smith should be seeded');

    expect(smith.reasoningEffort).toBe('default');
    const updated = await updatePersona(smith.id, { reasoningEffort: 'high' });
    expect(updated.reasoningEffort).toBe('high');

    const reset = await resetPersonaToDefault('npc-smith');
    expect(reset.reasoningEffort).toBe('default');
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
