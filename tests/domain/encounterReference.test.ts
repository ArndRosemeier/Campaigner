import { describe, expect, it } from 'vitest';

import { monsterEntrySchema, type MonsterEntry } from '@/domain';
import {
  rosterReferenceFor,
  rosterStatBlockFor,
  type ResolvedMonster,
} from '@/domain/encounterResolve';

/**
 * WHAT a roster row's reference is, and what a cited mob PRINTS (docs/17 row
 * 142). THE one formatter: both exporters render `rosterReferenceFor`'s own
 * `printed` string, so one entry cannot be labelled two ways — and the parity
 * pin in `tests/lib/roster-reference-parity.test.ts` holds that to the real
 * documents.
 *
 * The owner's report, verbatim: *"Encounters do not have their mobs detailed.
 * Makes it hard for the GM who needs to find references for mobs."* His three
 * answers: he was reading the exported module PDF and his roster lines read
 * like `Zombie ×4 — (see Bestiary)`; keep the reader's jump (a separate slice);
 * and *"Print the numbers for cited mobs too."*
 */

function entry(over: Partial<MonsterEntry> & Pick<MonsterEntry, 'source'>): MonsterEntry {
  return monsterEntrySchema.parse({
    name: 'Zombie',
    count: 4,
    notes: '',
    treasure: '',
    ...over,
  });
}

const CITATION = { type: 'none' } as const;

/** ONE instance: a pin asserts the SAME block comes back, not an equal copy. */
const INLINE_BLOCK = STAT_BLOCK();

describe('rosterReferenceFor — one rule for every source type', () => {
  it('prints the STAMPED origin line of a copied mob (docs/17 row 278)', () => {
    const reference = rosterReferenceFor(
      entry({ name: 'Zombie', source: { type: 'inline', statBlock: INLINE_BLOCK }, sourceLine: 'Bestiary p.132' }),
      { statBlock: INLINE_BLOCK, origin: 'Bestiary p.132' },
    );
    // The copy has no citation left to compose a line from, so the stored line
    // IS the reference — naming the book and page the numbers came from.
    expect(reference.printed).toBe(' — Bestiary p.132');
  });

  it('keeps a citation nothing can satisfy NAMED, in the same words as before', () => {
    const resolved: ResolvedMonster = { statBlock: null, origin: 'missing ref (Zombie)' };
    const reference = rosterReferenceFor(entry({ source: CITATION }), resolved);
    expect(reference.printed).toBe(' — missing ref (Zombie)');
    // The reason still names WHAT is missing — the property the ONE predicate
    // `isMissingRefOrigin` exists for.
    expect(reference.text).toBe('missing ref (Zombie)');
  });

  it('cross-references an npc-ref whose row prints, and names it when it does not', () => {
    const linked = rosterReferenceFor(
      entry({ name: 'Vexra', source: { type: 'npc-ref', artifactId: '22222222-2222-4222-8222-222222222222' } }),
      { statBlock: null, origin: 'NPC: Vexra' },
      { name: 'Vexra', destination: 'node-vexra' },
    );
    expect(linked.printed).toBe(' — see Vexra');
    expect(linked.link).toEqual({ name: 'Vexra', destination: 'node-vexra' });

    // No row at all: the SAME named reason, by the roster entry's own name.
    const dangling = rosterReferenceFor(
      entry({ name: 'Vexra', source: { type: 'npc-ref', artifactId: '22222222-2222-4222-8222-222222222222' } }),
      undefined,
    );
    expect(dangling.printed).toBe(' — missing ref (Vexra)');
    expect(dangling.link).toBeUndefined();
  });

  it('prints NO reference for an inline entry (its own block is underneath)', () => {
    const reference = rosterReferenceFor(
      entry({ source: { type: 'inline', statBlock: INLINE_BLOCK } }),
      { statBlock: INLINE_BLOCK, origin: 'inline' },
    );
    expect(reference.printed).toBe('');
    expect(reference.text).toBe('');
  });

  it('states the no-citation truth for a name-only entry', () => {
    expect(rosterReferenceFor(entry({ source: { type: 'none' as const } }), undefined).printed).toBe(
      ' — no stats: this roster entry names the creature without a citation',
    );
  });

  it('says what is true about a name-only entry with no resolution either', () => {
    const reference = rosterReferenceFor(entry({ source: CITATION }), undefined);
    expect(reference.printed).toContain('no stats: this roster entry names the creature');
  });
});

describe('rosterStatBlockFor — whose numbers a row prints', () => {
  it('prints an inline entry’s own block (the copied mob’s numbers)', () => {
    // `toEqual`: the boundary PARSES the entry, so an inline block comes back
    // as an equal value rather than the same object — the pin is that the row's
    // OWN block prints, not a resolved one.
    const printed = rosterStatBlockFor(
      entry({ source: { type: 'inline', statBlock: INLINE_BLOCK } }),
    );
    expect(printed).toEqual(INLINE_BLOCK);
    // Non-vacuity: it is the inline block's own numbers.
    expect(printed?.creatureType).toBe('undead');
  });

  it('prints no block for npc-ref and none', () => {
    expect(rosterStatBlockFor(entry({ source: { type: 'none' as const } }))).toBeNull();
    expect(
      rosterStatBlockFor(
        entry({ source: { type: 'npc-ref', artifactId: '22222222-2222-4222-8222-222222222222' } }),
      ),
    ).toBeNull();
  });
});

function STAT_BLOCK() {
  return {
    system: 'dnd5e' as const,
    level: '2',
    size: 'Medium',
    creatureType: 'undead',
    ac: 12,
    acNote: '',
    hp: 20,
    hpFormula: '3d8+6',
    speed: '20 ft.',
    abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
    saves: '',
    skills: '',
    senses: 'darkvision 60 ft.',
    languages: '',
    traits: [],
    actions: [],
    reactions: [{ name: 'Retaliate', text: 'Strike back.' }],
    legendary: [],
    extras: {},
  };
}
