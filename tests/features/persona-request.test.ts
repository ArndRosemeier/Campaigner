import { describe, expect, it } from 'vitest';

import { buildEntityBrief, guessKindFromSentence, STUB_KINDS, STUB_PERSONA_SLUGS } from '@/features/modules/persona-request';

/**
 * Pure helpers behind the module stub popover (08-MODULE-DESIGNER M4-C):
 * kind guessing from context and the persona brief construction.
 */

describe('guessKindFromSentence', () => {
  it('guesses location for "at/in the" context', () => {
    expect(guessKindFromSentence('The party hides at the old mill')).toBe('location');
    expect(guessKindFromSentence('They arrive in the drowned chapel')).toBe('location');
  });

  it('guesses faction for organized-group context', () => {
    expect(guessKindFromSentence('The guild controls the harbor')).toBe('faction');
  });

  it('defaults to npc', () => {
    expect(guessKindFromSentence('A silent figure watches the docks')).toBe('npc');
  });
});

describe('buildEntityBrief', () => {
  it('includes the name, surrounding context and premise', () => {
    const brief = buildEntityBrief(
      'Harbormaster Ilse',
      'The party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.',
      'A flooded chapel hides a cult.',
    );
    expect(brief).toContain('Harbormaster Ilse');
    expect(brief).toContain('tide gate');
    expect(brief).toContain('flooded chapel');
  });

  it('produces a usable brief even without context', () => {
    const brief = buildEntityBrief('The Gray Nun', '', '');
    expect(brief).toContain('The Gray Nun');
    expect(brief.trim()).not.toBe('');
  });
});

describe('STUB_KINDS and persona slugs', () => {
  it('every stub kind maps to a persona slug', () => {
    for (const kind of STUB_KINDS) {
      expect(STUB_PERSONA_SLUGS[kind]).toMatch(/^[a-z-]+$/);
    }
  });
});
