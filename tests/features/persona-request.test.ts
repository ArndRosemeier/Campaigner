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
      undefined,
    );
    expect(brief).toContain('Harbormaster Ilse');
    expect(brief).toContain('tide gate');
    expect(brief).toContain('flooded chapel');
  });

  it('produces a usable brief even without context', () => {
    const brief = buildEntityBrief('The Gray Nun', '', '', undefined);
    expect(brief).toContain('The Gray Nun');
    expect(brief.trim()).not.toBe('');
  });

  it('frames an ENCOUNTER brief as the scene it must stage, and only there', () => {
    // The assertion rule's brief-side framing (docs/11, docs/17 row 89).
    // Revert-proof: passing the flag through to every kind — or ignoring it —
    // fails one of the two halves here (the framing appearing where it must
    // not, or missing where it must). The omitted argument is the pre-rule
    // byte-identical default that every other stub kind takes.
    const scene = 'Two risen lumberjacks stand motionless on the footbridge.';
    const plain = buildEntityBrief('The Sunken Bridge', scene, 'premise', 3);
    expect(plain).toContain('Where it is mentioned:');
    expect(buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], false)).toBe(plain);

    const encounter = buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], true);
    expect(encounter).toContain('The scene this encounter must stage');
    expect(encounter).toContain('is FIXED, and the roster and the map must match it');
    expect(encounter).not.toContain('Where it is mentioned:');
    // The scene text itself is byte-identical: only the label changed.
    expect(encounter).toBe(
      plain.replace(
        'Where it is mentioned:',
        'The scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:',
      ),
    );
  });

  it('adds no scene block to an encounter brief that carries no context', () => {
    const brief = buildEntityBrief('The Gray Nun', '', 'premise', undefined, [], true);
    expect(brief).not.toContain('The scene this encounter must stage');
    expect(brief).not.toContain('Where it is mentioned:');
  });
});

describe('STUB_KINDS and persona slugs', () => {
  it('every stub kind maps to a persona slug', () => {
    for (const kind of STUB_KINDS) {
      expect(STUB_PERSONA_SLUGS[kind]).toMatch(/^[a-z-]+$/);
    }
  });
});
