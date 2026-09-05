import { describe, expect, it } from 'vitest';

import { createPersona, createPersonaRun, defaultSettings, type Persona } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { derivePostCreateExtras, extrasForPersona } from '@/llm/personas/extras';

function personaBySlug(slug: string): Persona {
  const persona = BUILT_IN_PERSONAS.find((candidate) => candidate.slug === slug);
  if (persona === undefined) throw new Error(`missing builtin persona ${slug}`);
  return persona;
}

/**
 * Creation-dialog extras: the derive function is the dialog's single source
 * (declared persona field wins; custom personas fall back to the mode/kind
 * derivation) — plus the persisted-default shapes the dialog reads.
 */
describe('post-create extras derivation', () => {
  it('derives the ratified extras per builtin persona', () => {
    expect(extrasForPersona(personaBySlug('npc-smith'))).toEqual(['image', 'statBlock']);
    expect(extrasForPersona(personaBySlug('worldbuilder'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('faction-designer'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('plot-architect'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('arc-weaver'))).toEqual(['image']);
    // Content-only variant: map generation rides the unattended queue, so
    // the battlemap extra is offered here — the ONLY persona that offers it.
    expect(extrasForPersona(personaBySlug('encounter-smith'))).toEqual([
      'image',
      'mobPortraits',
      'battlemap',
    ]);
    // The Cartographer produces the map in-run — offering a battlemap extra
    // would duplicate the run's own work.
    expect(extrasForPersona(personaBySlug('encounter-cartographer'))).toEqual([
      'image',
      'mobPortraits',
    ]);
    expect(extrasForPersona(personaBySlug('continuity-editor'))).toEqual([]);
    expect(extrasForPersona(personaBySlug('illustrator'))).toEqual([]);
  });

  it('derives extras for custom personas from mode/producesKind', () => {
    const customNpc = createPersona({
      slug: 'custom-smith',
      name: 'Custom Smith',
      description: '',
      systemPrompt: '',
      producesKind: 'npc',
      builtIn: false,
    });
    expect(extrasForPersona(customNpc)).toEqual(['image', 'statBlock']);
    const customReview = createPersona({
      slug: 'custom-checker',
      name: 'Custom Checker',
      description: '',
      systemPrompt: '',
      producesKind: 'note',
      mode: 'review',
      builtIn: false,
    });
    expect(extrasForPersona(customReview)).toEqual([]);
  });

  it('a declared postCreateExtras field wins over the derivation', () => {
    const declared = createPersona({
      slug: 'no-image-smith',
      name: 'No-Image Smith',
      description: '',
      systemPrompt: '',
      producesKind: 'npc',
      postCreateExtras: ['statBlock'],
      builtIn: false,
    });
    expect(extrasForPersona(declared)).toEqual(['statBlock']);
    expect(derivePostCreateExtras(declared)).toEqual(['image', 'statBlock']);
  });

  it('run rows default to campaign placement and no extras (old rows parse)', () => {
    const run = createPersonaRun({
      campaignId: '0b60cf44-8b7e-4d6f-9d75-6aa2cb1f4c4c',
      personaId: '0b60cf44-8b7e-4d6f-9d75-6aa2cb1f4c4d',
      autonomy: 'auto',
      userBrief: 'a goblin alchemist',
    });
    expect(run.placementModuleId).toBeNull();
    expect(run.runExtras).toBeNull();
  });

  it('settings default the remembered extras off', () => {
    expect(defaultSettings().runExtras).toEqual({
      image: false,
      statBlock: false,
      mobPortraits: false,
    });
  });
});
