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

const CITATION = {
  type: 'rulebook' as const,
  chunkId: '11111111-1111-4111-8111-111111111111',
  contentHash: 'a'.repeat(64),
  creatureName: 'Zombie',
};

/** ONE instance: a pin asserts the SAME block comes back, not an equal copy. */
const INLINE_BLOCK = STAT_BLOCK();

describe('rosterReferenceFor — one rule for every source type', () => {
  it('prints the REAL origin of a cited creature, not a constant', () => {
    const resolved: ResolvedMonster = { statBlock: null, origin: 'Bestiary p.132' };
    const reference = rosterReferenceFor(entry({ name: 'Zombie', source: CITATION }), resolved);

    // The owner's line, before → after: the reference NAMES the book and page
    // the numbers come from, so a GM can find them.
    expect(reference.printed).toBe(' — Bestiary p.132');
    expect(reference.printed).not.toContain('see Bestiary');
  });

  it('prints a pack citation’s creature name (the pack has no page numbers)', () => {
    const resolved: ResolvedMonster = { statBlock: null, origin: 'Monster Core: Cave Fisher' };
    expect(
      rosterReferenceFor(entry({ name: 'Cave Fisher', source: CITATION }), resolved).printed,
    ).toBe(' — Monster Core: Cave Fisher');
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
    expect(rosterReferenceFor(entry({ source: { type: 'none' } }), undefined).printed).toBe(
      ' — no stats: this roster entry names the creature without a citation',
    );
  });

  it('never claims a citation it could not resolve', () => {
    // A `rulebook` entry with NO resolution (a builder called without the
    // pre-pass): the document says so LOUDLY rather than printing a
    // citation-shaped claim it cannot honour (AGENTS rule 1).
    const reference = rosterReferenceFor(entry({ source: CITATION }), undefined);
    expect(reference.printed).toContain('unresolved citation');
    expect(reference.printed).not.toContain('see Bestiary');
  });
});

describe('rosterStatBlockFor — whose numbers a row prints', () => {
  it('prints the cited library chunk’s own numbers', () => {
    const block = STAT_BLOCK();
    expect(
      rosterStatBlockFor(entry({ source: CITATION }), { statBlock: block, origin: 'Bestiary p.132' }),
    ).toBe(block);
  });

  it('prints NO block for a citation whose chunk carries no parseable block', () => {
    // `chunk.statBlock` is legitimately null (best-effort ingest parse): the
    // row keeps its named missing-ref line and prints NO box — never an empty
    // or placeholder one (AGENTS rule 1).
    expect(
      rosterStatBlockFor(entry({ source: CITATION }), {
        statBlock: null,
        origin: 'missing ref (Zombie)',
      }),
    ).toBeNull();
  });

  it('prints NO block for a citation the pre-pass never resolved', () => {
    expect(rosterStatBlockFor(entry({ source: CITATION }), undefined)).toBeNull();
  });

  it('prints an inline entry’s own block', () => {
    // `toEqual`: the boundary PARSES the entry, so an inline block comes back
    // as an equal value rather than the same object — the pin is that the row's
    // OWN block prints, not a resolved one.
    const printed = rosterStatBlockFor(
      entry({ source: { type: 'inline', statBlock: INLINE_BLOCK } }),
      { statBlock: null, origin: 'inline' },
    );
    expect(printed).toEqual(INLINE_BLOCK);
    // Non-vacuity: it is the inline block's own numbers.
    expect(printed?.creatureType).toBe('undead');
  });

  it('prints no block for npc-ref and none', () => {
    expect(
      rosterStatBlockFor(entry({ source: { type: 'none' } }), {
        statBlock: STAT_BLOCK(),
        origin: 'Bestiary p.132',
      }),
    ).toBeNull();
    expect(
      rosterStatBlockFor(
        entry({ source: { type: 'npc-ref', artifactId: '22222222-2222-4222-8222-222222222222' } }),
        { statBlock: STAT_BLOCK(), origin: 'NPC: Vexra' },
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
