import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_KINDS,
  normalizeLegacyProducesKind,
  personaSchema,
  newId,
  type Id,
  type Persona,
} from '@/domain';
import { getPersona, listPersonas, findPersonaBySlug, updatePersona } from '@/db/personaRepo';
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

/**
 * Legacy producesKind rows (docs/01 §Persona legacy table): 'session' is the
 * ONLY artifact kind the current enum ever dropped (existed M2 cd8e751 →
 * removed M6-E a670751 together with the built-in `session-chronicler`,
 * added b18e33a). The v11 migration deleted session artifacts but never
 * persona rows, personas are global and seeding skips existing slugs — so a
 * pre-M6-E DB keeps the row and parse-on-read (caa40b0) crashed every
 * workspace render. The schema boundary normalizes the git-proven value;
 * everything else still fails loudly.
 */
describe('personaRepo legacy producesKind rows (git-proven removed values)', () => {
  beforeEach(clearDatabase);

  /** Verbatim pre-M6-E Session Chronicler row (no reasoningEffort — added 810f634). */
  async function putSessionChroniclerRow(producesKind: unknown = 'session'): Promise<Id> {
    const row = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      slug: 'session-chronicler',
      name: 'Session Chronicler',
      description: 'Ready-to-run session plans',
      systemPrompt: 'You are the Session Chronicler, a table-ready session planner.',
      model: '',
      temperature: 0.8,
      producesKind,
      mode: 'generate',
      builtIn: true,
    };
    await db.personas.put(row as unknown as Persona);
    return row.id;
  }

  it('listPersonas — the crash site — normalizes the legacy row instead of throwing', async () => {
    await putSessionChroniclerRow();
    const personas = await listPersonas();
    expect(personas).toHaveLength(1);
    expect(personas[0]?.producesKind).toBe('note');
    expect(personas[0]?.mode).toBe('generate');
    expect(personas[0]?.name).toBe('Session Chronicler');
  });

  it('getPersona and findPersonaBySlug normalize it too', async () => {
    const id = await putSessionChroniclerRow();
    expect((await getPersona(id))?.producesKind).toBe('note');
    expect((await findPersonaBySlug('session-chronicler'))?.producesKind).toBe('note');
  });

  it('updatePersona heals the stored row on first edit', async () => {
    const id = await putSessionChroniclerRow();
    await updatePersona(id, { name: 'My Chronicler' });
    const raw = await db.personas.get(id);
    expect(raw?.producesKind).toBe('note');
  });

  it('every current ARTIFACT_KIND parses through unchanged', () => {
    for (const kind of ARTIFACT_KINDS) {
      const parsed = personaSchema.parse({
        id: newId(),
        createdAt: 1,
        updatedAt: 1,
        slug: 'kind-pin',
        name: 'Kind Pin',
        description: '',
        systemPrompt: '',
        model: '',
        temperature: 0.8,
        producesKind: kind,
        builtIn: false,
      });
      expect(parsed.producesKind).toBe(kind);
    }
  });

  it('normalizeLegacyProducesKind leaves absent producesKind (image personas) untouched', () => {
    const row = { slug: 'illustrator', producesKind: undefined };
    expect(normalizeLegacyProducesKind(row).producesKind).toBeUndefined();
  });

  it('unknown values still fail loudly — the map is the full historic enumeration', async () => {
    await putSessionChroniclerRow('story');
    await expect(listPersonas()).rejects.toThrow(/producesKind/);
  });

  it('null still fails loudly — no write path ever produced it', async () => {
    await putSessionChroniclerRow(null);
    await expect(listPersonas()).rejects.toThrow(/producesKind/);
  });

  it('schema-level pin: session → note, unknown rejected', () => {
    const base = {
      id: newId(),
      createdAt: 1,
      updatedAt: 1,
      slug: 'session-chronicler',
      name: 'Session Chronicler',
      description: '',
      systemPrompt: '',
      model: '',
      temperature: 0.8,
      mode: 'generate',
      builtIn: true,
    };
    expect(personaSchema.parse({ ...base, producesKind: 'session' }).producesKind).toBe('note');
    expect(() => personaSchema.parse({ ...base, producesKind: 'map' })).toThrow();
  });
});
