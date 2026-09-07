import { describe, expect, it } from 'vitest';

import { createPersona, createPersonaRun, defaultSettings, type Persona } from '@/domain';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { derivePostCreateExtras, extrasForPersona, statblockExtraNotice } from '@/llm/personas/extras';
import { npcDataSchema } from '@/domain/artifact';

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
    expect(extrasForPersona(personaBySlug('event-weaver'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('faction-designer'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('plot-architect'))).toEqual(['image']);
    expect(extrasForPersona(personaBySlug('arc-weaver'))).toEqual(['image']);
    // Content-only variant: the battlemap extra is GONE (D10 amendment arc)
    // — every freshly created encounter maps automatically via the
    // unattended queue, so the Smith offers image + mobPortraits only.
    expect(extrasForPersona(personaBySlug('encounter-smith'))).toEqual([
      'image',
      'mobPortraits',
    ]);
    // The Cartographer produces the map in-run — an extra would duplicate it.
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

  it('the statblock extra notice is verification-only', () => {
    const extrasOn = { image: false, statBlock: true, mobPortraits: false, battlemap: false };
    const statless = npcDataSchema.parse({ appearance: '', personality: '', statBlock: null });
    expect(statblockExtraNotice('npc', extrasOn, statless)).toBe(
      'No stat block was generated — add one in the artifact editor.',
    );
    const statted = npcDataSchema.parse({
      appearance: '',
      personality: '',
      statBlock: { system: 'dnd5e', level: '3', size: 'Small', creatureType: 'humanoid', ac: 14, acNote: '', hp: 22, hpFormula: '5d6', speed: '30 ft.', abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 }, saves: '', skills: '', senses: '', languages: '', traits: [], actions: [], reactions: [], legendary: [], extras: {} },
    });
    expect(statblockExtraNotice('npc', extrasOn, statted)).toBeNull();
    // Non-npc kinds and unticked extras never notice.
    expect(statblockExtraNotice('location', extrasOn, { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] })).toBeNull();
    expect(statblockExtraNotice('event', extrasOn, { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] })).toBeNull();
    expect(statblockExtraNotice('npc', { ...extrasOn, statBlock: false }, statless)).toBeNull();
  });

  it('settings default the remembered extras off', () => {
    expect(defaultSettings().runExtras).toEqual({
      image: false,
      statBlock: false,
      mobPortraits: false,
    });
  });
});
