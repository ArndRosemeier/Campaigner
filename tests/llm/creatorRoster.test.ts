import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CREATOR_ROSTER_LIMIT,
  buildCreatorRoster,
  collectCreatorRoster,
  creatorRosterEntries,
  nearestLibraryCreatures,
} from '@/llm/creatorRoster';
import { listLibraryCreatures } from '@/db/creatureRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { db } from '@/db/db';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * THE MODULE CREATOR'S BESTIARY WINDOW (docs/17 row 114, docs/12 §7).
 *
 * The owner's report, with the terminal's umlaut damage ignored, is the cast
 * refusing by name — «Zombie-Schläger», «Zombie-Schlurfer» and a degenerate
 * level-adapted variant — against a library that holds none of them. The
 * prompt offered the slot and showed no vocabulary; this window IS the
 * vocabulary, and what this file pins is that it describes the population the
 * cast actually resolves against:
 *
 * 1. every stat-block chunk of ANY book origin (a rulebook import is as
 *    castable as a pack — the trap is a pack-only window, which would offer the
 *    slot while listing nothing);
 * 2. the ratified §7 order (level distance to the target, ties by levelSort
 *    then locale name, `—` last), the 300-line cap and its truncation note;
 * 3. determinism for an unchanged library;
 * 4. the SUGGESTIONS a refusal may name, and the silence when nothing is close.
 */

/** One stat-block chunk in a book — the shape `listLibraryCreatures` pools and
 *  the cast resolves. `origin`/`status` default to the ORDINARY import case (a
 *  `pdf` book, `ready`), because that is the case a pack-only window would
 *  hide. */
async function seedCreature(options: {
  name: string;
  level: string;
  bookTitle?: string;
  origin?: 'pdf' | 'pack';
  status?: 'ready' | 'processing';
}): Promise<string> {
  const book = await createRulebook({
    title: options.bookTitle ?? 'Monster Manual',
    system: 'dnd5e',
    filename: `${(options.bookTitle ?? 'monster-manual').toLowerCase().replaceAll(' ', '-')}.pdf`,
  });
  if (options.origin === 'pack' || options.status === 'processing') {
    await db.rulebooks.put({
      ...book,
      origin: options.origin ?? 'pdf',
      status: options.status ?? 'ready',
    });
  }
  const text = `${options.name}\nMedium undead, neutral evil\nArmor Class 8\nHit Points 22`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 316,
    pageEnd: 316,
    chunkType: 'statblock',
    headingPath: [options.name],
    text,
    contentHash: await sha256Hex(text),
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: options.level,
      size: 'Medium',
      creatureType: 'undead',
      ac: 8,
      acNote: '',
      hp: 22,
      hpFormula: '3d8+9',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: 'Wis +0',
      skills: '',
      senses: 'darkvision 60 ft.',
      languages: 'understands the languages it knew in life but cannot speak',
      traits: [],
      actions: [{ name: 'Slam', text: 'Melee Weapon Attack: +3 to hit, 1d6+1 bludgeoning.' }],
      reactions: [],
      legendary: [],
      extras: {},
    }),
  });
  await putChunks([chunk]);
  return chunk.id;
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

describe('the window lists the population the cast resolves against', () => {
  it('lists a creature from a PDF-imported book — not just pack books', async () => {
    // The trap: the encounter roster filters `origin === 'pack'`. Built from
    // THAT population, this window would be empty for a library a user built by
    // importing an ordinary rulebook, while the bestiary slot stayed on offer —
    // inventing names again, with the app's blessing.
    await seedCreature({ name: 'Zombie', level: '1' });
    await seedCreature({ name: 'Ghoul', level: '2' });

    const roster = await collectCreatorRoster();
    expect(roster.entries.map((entry) => entry.name)).toEqual(['Zombie', 'Ghoul']);
    expect(roster.total).toBe(2);
    expect(roster.truncated).toBe(0);
    // The window and the lookup read the SAME pool: every listed line names a
    // creature `listLibraryCreatures` returns, so nothing the prompt shows can
    // fail to resolve for a reason other than the model mistyping it.
    const pool = await listLibraryCreatures();
    for (const line of roster.lines) {
      expect(pool.some((creature) => creature.name === line)).toBe(true);
    }
  });

  it('lists creatures from a `processing` book too — the pool is not filtered by status', async () => {
    await seedCreature({ name: 'Zombie', level: '1', status: 'processing' });
    const roster = await collectCreatorRoster();
    expect(roster.lines).toEqual(['Zombie']);
  });

  it('carries the library’s OWN spelling of a nested name (the innermost heading)', async () => {
    const book = await createRulebook({
      title: 'Tome of Horrors',
      system: 'dnd5e',
      filename: 'tome.pdf',
    });
    const text = 'Zombie\nA zombie variant.';
    const chunk = ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Undead', 'Zombie'],
      text,
      contentHash: await sha256Hex(text),
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '2',
        size: 'Medium',
        creatureType: 'undead',
        ac: 8,
        acNote: '',
        hp: 22,
        hpFormula: '3d8+9',
        speed: '20 ft.',
        abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
        saves: '',
        skills: '',
        senses: '',
        languages: '',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
    });
    await putChunks([chunk]);
    // The cast looks a name up with `canonicalCreatureName` (the LAST non-empty
    // heading) — a window built from `headingPath[0]` would print "Undead" and
    // the model would copy an uncastable name.
    const roster = await collectCreatorRoster();
    expect(roster.lines).toEqual(['Zombie']);
  });
});

describe('the window’s order is the ratified §7 order', () => {
  it('orders by level distance to the target, ties by levelSort then name', async () => {
    await seedCreature({ name: 'Deep Horror', level: '9' });
    await seedCreature({ name: 'Bog Shambler', level: '4' });
    await seedCreature({ name: 'Ash Ghoul', level: '4' });
    await seedCreature({ name: 'Rot Zombie', level: '3' });
    await seedCreature({ name: 'Marsh Wisp', level: '5' });
    await seedCreature({ name: 'Zombie', level: '1' });

    // Target 5: distance 0 (Marsh Wisp), then distance 1 (Bog Shambler / Ash
    // Ghoul tie at level 4 — name order), then distance 2 (Rot Zombie), then
    // distance 4 (both the level-1 Zombie and the level-9 Deep Horror — the
    // tie falls to levelSort, so Zombie comes first).
    const roster = await collectCreatorRoster(5);
    expect(roster.lines).toEqual([
      'Marsh Wisp',
      'Ash Ghoul',
      'Bog Shambler',
      'Rot Zombie',
      'Zombie',
      'Deep Horror',
    ]);
  });

  it('puts an unparsable "—" level LAST, whatever the target is', async () => {
    await seedCreature({ name: 'Avatar of Death', level: '—' });
    await seedCreature({ name: 'Zombie', level: '1' });
    await seedCreature({ name: 'Deep Horror', level: '20' });

    expect((await collectCreatorRoster(1)).lines).toEqual([
      'Zombie',
      'Deep Horror',
      'Avatar of Death',
    ]);
    expect((await collectCreatorRoster(20)).lines).toEqual([
      'Deep Horror',
      'Zombie',
      'Avatar of Death',
    ]);
    // Two CR-less creatures tie at +Infinity: the levelSort comparison must not
    // become a NaN comparator result — they fall to locale name order, last.
    await seedCreature({ name: 'Animated Armor', level: '—' });
    expect((await collectCreatorRoster(1)).lines).toEqual([
      'Zombie',
      'Deep Horror',
      'Animated Armor',
      'Avatar of Death',
    ]);
  });

  it('without a target keeps the historical level/name-ascending order', async () => {
    await seedCreature({ name: 'Deep Horror', level: '9' });
    await seedCreature({ name: 'Zombie', level: '1' });
    await seedCreature({ name: 'Ash Ghoul', level: '4' });
    await seedCreature({ name: 'Bog Shambler', level: '4' });

    expect((await collectCreatorRoster()).lines).toEqual([
      'Zombie',
      'Ash Ghoul',
      'Bog Shambler',
      'Deep Horror',
    ]);
  });

  it('orders fractional levels by their value, not their text', async () => {
    await seedCreature({ name: 'Quarter Thing', level: '1/4' });
    await seedCreature({ name: 'Full Thing', level: '1' });
    // At a target of 1 the integer is nearer than the fraction: a parser that
    // read "1/4" as 0 (or as text) would put the fraction first.
    expect((await collectCreatorRoster(1)).lines).toEqual(['Full Thing', 'Quarter Thing']);

    await seedCreature({ name: 'Half Thing', level: '1/2' });
    // At a target of 1/2: Half (0), Quarter (0.25), Full (2.5) — while every
    // text or integer parse of "1/2"/"1/4" puts the two fractions in the same
    // bucket and orders them by name.
    expect((await collectCreatorRoster(1 / 2)).lines).toEqual([
      'Half Thing',
      'Quarter Thing',
      'Full Thing',
    ]);
  });
});

describe('the cap and the truncation note', () => {
  /** A synthetic library of `count` creatures with distinct levels. */
  function syntheticEntries(count: number): ReturnType<typeof creatorRosterEntries> {
    return creatorRosterEntries(
      Array.from({ length: count }, (_, index) => ({
        chunkId: `chunk-${String(index)}`,
        name: `Creature ${String(index).padStart(4, '0')}`,
        contentHash: 'hash',
        headingPath: [`Creature ${String(index)}`],
        statBlock: { level: String(index % 20) } as never,
      })),
    );
  }

  it('caps the window at 300 lines and reports how many it left out', () => {
    const roster = buildCreatorRoster(syntheticEntries(CREATOR_ROSTER_LIMIT + 7), 0);
    expect(CREATOR_ROSTER_LIMIT).toBe(300);
    expect(roster.lines).toHaveLength(300);
    expect(roster.total).toBe(307);
    expect(roster.truncated).toBe(7);
  });

  it('does not claim a truncation when the library fits', () => {
    const roster = buildCreatorRoster(syntheticEntries(3), 0);
    expect(roster.lines).toHaveLength(3);
    expect(roster.truncated).toBe(0);
  });
});

describe('the window is deterministic for an unchanged library', () => {
  it('builds twice to the same lines, in the same order', async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedCreature({ name: `Creature ${String(index)}`, level: String(index % 5) });
    }
    const first = await collectCreatorRoster(2);
    const second = await collectCreatorRoster(2);
    expect(second.lines).toEqual(first.lines);
    expect(second.total).toBe(first.total);
    expect(second.truncated).toBe(first.truncated);
  });
});

describe('the suggestions a refusal may name', () => {
  it('finds a near miss across case, hyphen and umlaut', async () => {
    await seedCreature({ name: 'Zombie-Schläger', level: '1' });
    await seedCreature({ name: 'Ghoul', level: '2' });
    const pool = await listLibraryCreatures();

    expect(nearestLibraryCreatures('zombie schlager', pool).map((row) => row.name)).toEqual([
      'Zombie-Schläger',
    ]);
    expect(nearestLibraryCreatures('Zombie Schlägerin', pool).map((row) => row.name)).toEqual([
      'Zombie-Schläger',
    ]);
    expect(nearestLibraryCreatures('ZOMBIE—SCHLAGER', pool).map((row) => row.name)).toEqual([
      'Zombie-Schläger',
    ]);
  });

  it('forgives a trailing parenthesized qualifier a library name may carry', async () => {
    await seedCreature({ name: 'Zombie (variant)', level: '1' });
    const pool = await listLibraryCreatures();
    expect(nearestLibraryCreatures('Zombie', pool).map((row) => row.name)).toEqual([
      'Zombie (variant)',
    ]);
  });

  it('says NOTHING when the closest creature is not close at all', async () => {
    await seedCreature({ name: 'Ancient Red Dragon', level: '20' });
    await seedCreature({ name: 'Ghoul', level: '2' });
    const pool = await listLibraryCreatures();
    // A wrong "did you mean" is a second wrong answer: the refusal must stay
    // silent rather than point at the dragon.
    expect(nearestLibraryCreatures('Bog Shambler', pool)).toEqual([]);
    expect(nearestLibraryCreatures('Zombie-Schläger der Stufe 1', pool)).toEqual([]);
  });

  it('is bounded to three and never repeats a name', async () => {
    await seedCreature({ name: 'Zombie Alpha', level: '1' });
    await seedCreature({ name: 'Zombie Beta', level: '1' });
    await seedCreature({ name: 'Zombie Gamma', level: '1' });
    await seedCreature({ name: 'Zombie Delta', level: '1' });
    // Two chunks with the SAME name are one suggestion, never two lines.
    await seedCreature({ name: 'Zombie Alpha', level: '2' });
    const pool = await listLibraryCreatures();
    const suggestions = nearestLibraryCreatures('Zombie', pool);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(new Set(suggestions.map((row) => row.name)).size).toBe(suggestions.length);
  });
});
