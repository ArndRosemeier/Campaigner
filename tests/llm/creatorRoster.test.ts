import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CREATOR_ROSTER_LIMIT,
  buildCreatorRoster,
  collectCreatorRoster,
  creatorRosterEntries,
  nearestLibraryCreatures,
} from '@/llm/creatorRoster';
import { libraryCitationForEntity } from '@/features/modules/entity-batch';
import { bestiaryVocabularyBlock } from '@/llm/promptStyles';
import { listLibraryCreatures, wikiLinkCreatures, type LibraryCreature } from '@/db/creatureRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { db } from '@/db/db';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import type { GameSystem } from '@/domain/gameSystem';
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
 *    slot while listing nothing) — and, since docs/17 row 207, only the
 *    CAMPAIGN'S OWN game system's books when the campaign system is passed
 *    (the dnd5e-only creature is never offered to a Pathfinder 2e module);
 * 2. the ratified §7 order (level distance to the target, ties by levelSort
 *    then locale name, `—` last), the 300-line cap and its truncation note;
 * 3. determinism for an unchanged library;
 * 4. the SUGGESTIONS a refusal may name, and the silence when nothing is close.
 *
 * Since docs/17 row 163 a line also carries the creature's REAL pack title
 * (`Name — Pack Title`, `llm/creatorRoster.CREATOR_ROSTER_TITLE_SEPARATOR`), so
 * a model filling the slot's `book` can COPY a title instead of guessing a
 * translation of one — and a creature whose library records no title prints its
 * NAME ALONE, never a stand-in.
 */

/** The window's line for a seeded creature, with the shape WRITTEN OUT: a
 *  separator change must redden these pins rather than silently re-baseline
 *  them. `Monster Manual` is `seedCreature`'s default book title. */
function line(name: string, title = 'Monster Manual'): string {
  return `${name} \u2014 ${title}`;
}

/** The NAME half of every window line — the half the cast resolves. */
function windowNames(lines: readonly string[]): string[] {
  return lines.map((entry) => entry.split(' \u2014 ')[0] ?? entry);
}


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
  /** The book's (and its stat block's) game system — `'dnd5e'` is the
   *  pre-row-207 default. */
  system?: GameSystem;
}): Promise<string> {
  const system = options.system ?? 'dnd5e';
  const book = await createRulebook({
    title: options.bookTitle ?? 'Monster Manual',
    system,
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
      system,
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
    for (const name of windowNames(roster.lines)) {
      expect(pool.some((creature) => creature.name === name)).toBe(true);
    }
  });

  it('lists creatures from a `processing` book too — the pool is not filtered by status', async () => {
    await seedCreature({ name: 'Zombie', level: '1', status: 'processing' });
    const roster = await collectCreatorRoster();
    expect(roster.lines).toEqual([line('Zombie')]);
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
    expect(roster.lines).toEqual([line('Zombie', 'Tome of Horrors')]);
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
      line('Marsh Wisp'),
      line('Ash Ghoul'),
      line('Bog Shambler'),
      line('Rot Zombie'),
      line('Zombie'),
      line('Deep Horror'),
    ]);
  });

  it('puts an unparsable "—" level LAST, whatever the target is', async () => {
    await seedCreature({ name: 'Avatar of Death', level: '—' });
    await seedCreature({ name: 'Zombie', level: '1' });
    await seedCreature({ name: 'Deep Horror', level: '20' });

    expect((await collectCreatorRoster(1)).lines).toEqual([
      line('Zombie'),
      line('Deep Horror'),
      line('Avatar of Death'),
    ]);
    expect((await collectCreatorRoster(20)).lines).toEqual([
      line('Deep Horror'),
      line('Zombie'),
      line('Avatar of Death'),
    ]);
    // Two CR-less creatures tie at +Infinity: the levelSort comparison must not
    // become a NaN comparator result — they fall to locale name order, last.
    await seedCreature({ name: 'Animated Armor', level: '—' });
    expect((await collectCreatorRoster(1)).lines).toEqual([
      line('Zombie'),
      line('Deep Horror'),
      line('Animated Armor'),
      line('Avatar of Death'),
    ]);
  });

  it('without a target keeps the historical level/name-ascending order', async () => {
    await seedCreature({ name: 'Deep Horror', level: '9' });
    await seedCreature({ name: 'Zombie', level: '1' });
    await seedCreature({ name: 'Ash Ghoul', level: '4' });
    await seedCreature({ name: 'Bog Shambler', level: '4' });

    expect((await collectCreatorRoster()).lines).toEqual([
      line('Zombie'),
      line('Ash Ghoul'),
      line('Bog Shambler'),
      line('Deep Horror'),
    ]);
  });

  it('orders fractional levels by their value, not their text', async () => {
    await seedCreature({ name: 'Quarter Thing', level: '1/4' });
    await seedCreature({ name: 'Full Thing', level: '1' });
    // At a target of 1 the integer is nearer than the fraction: a parser that
    // read "1/4" as 0 (or as text) would put the fraction first.
    expect((await collectCreatorRoster(1)).lines).toEqual([
      line('Full Thing'),
      line('Quarter Thing'),
    ]);

    await seedCreature({ name: 'Half Thing', level: '1/2' });
    // At a target of 1/2: Half (0), Quarter (0.25), Full (2.5) — while every
    // text or integer parse of "1/2"/"1/4" puts the two fractions in the same
    // bucket and orders them by name.
    expect((await collectCreatorRoster(1 / 2)).lines).toEqual([
      line('Half Thing'),
      line('Quarter Thing'),
      line('Full Thing'),
    ]);
  });
});

describe('the cap and the truncation note', () => {
  /** A synthetic library of `count` creatures with distinct levels. Every one
   *  belongs to the same book (`book-0`), which no titles map covers — so these
   *  entries build a window of BARE NAMES, exactly the shape a title-less read
   *  produces (the non-vacuity half of the title pins below). */
  function syntheticEntries(count: number): ReturnType<typeof creatorRosterEntries> {
    return creatorRosterEntries(
      Array.from({ length: count }, (_, index) => ({
        chunkId: `chunk-${String(index)}`,
        name: `Creature ${String(index).padStart(4, '0')}`,
        contentHash: 'hash',
        headingPath: [`Creature ${String(index)}`],
        statBlock: { level: String(index % 20) } as never,
        bookId: 'book-0',
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

  it('a window built WITHOUT titles cannot satisfy the title pins (non-vacuity)', () => {
    // The SAME entries, built through the titles-free arm: the lines are bare
    // names. If the pins below could pass against this window, they would say
    // nothing about the pack titles the real path prints.
    const entries = syntheticEntries(3);
    const untitled = buildCreatorRoster(entries, 0);
    expect(untitled.lines).toEqual(['Creature 0000', 'Creature 0001', 'Creature 0002']);
    expect(untitled.lines.some((entry) => entry.includes('\u2014'))).toBe(false);
    // …while the real entries DO carry the book the title is read from.
    expect(entries.map((entry) => entry.bookId)).toEqual(['book-0', 'book-0', 'book-0']);
  });
});

describe('every line carries the pack title of the book it really comes from (docs/17 row 163)', () => {
  it('prints "Name — Pack Title" for each creature, in window order', async () => {
    await seedCreature({ bookTitle: 'Pathfinder Monster Core', name: 'Plague Zombie', level: '1' });
    await seedCreature({ bookTitle: 'NPC Gallery', name: 'Farmer', level: '2' });
    await seedCreature({ bookTitle: 'Pathfinder Monster Core', name: 'Ghoul', level: '3' });

    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toEqual([
      line('Plague Zombie', 'Pathfinder Monster Core'),
      line('Farmer', 'NPC Gallery'),
      line('Ghoul', 'Pathfinder Monster Core'),
    ]);
    // The NAME half is the library's own spelling of the castable name, and the
    // title half the book's own title — never a decoration of either.
    expect(windowNames(roster.lines)).toEqual(['Plague Zombie', 'Farmer', 'Ghoul']);
  });

  it('adds the pack title and NOTHING else to a line — the name list is untouched', async () => {
    await seedCreature({ bookTitle: 'Bestiary', name: 'Zombie', level: '3' });
    await seedCreature({ bookTitle: 'Tome of Horrors', name: 'Ghoul', level: '1' });
    const roster = await collectCreatorRoster(3);
    const untitled = buildCreatorRoster(roster.entries, 3);
    expect(untitled.lines).toEqual(['Zombie', 'Ghoul']);
    // Same creatures, same order, same names: the ONLY delta is the separator
    // plus the book's own title, per line.
    expect(windowNames(roster.lines)).toEqual(untitled.lines);
    roster.lines.forEach((entry, index) => {
      const name = untitled.lines[index] ?? '';
      const growth = entry.length - name.length;
      const title = entry.slice(name.length + 3);
      expect(growth).toBe(3 + title.length);
      expect(title).toMatch(/^(Bestiary|Tome of Horrors)$/);
    });
  });

  it('reads ONE book per book, not one per line — two books behind five lines cost two reads', async () => {
    // The pool is injected because the PROPERTY is about the read pattern, not
    // the DB: five creatures, two books. `seedCreature` writes a book per call,
    // so it cannot express "two creatures of one book" without a second helper.
    const creature = (chunkId: string, name: string, bookId: string): LibraryCreature => ({
      chunkId,
      name,
      contentHash: 'hash',
      headingPath: [name],
      statBlock: { level: '1' } as never,
      bookId,
    });
    const reads: string[] = [];
    const roster = await collectCreatorRoster(
      1,
      undefined,
      () =>
        Promise.resolve([
          creature('c-1', 'Zombie', 'book-a'),
          creature('c-2', 'Ghoul', 'book-a'),
          creature('c-3', 'Wight', 'book-a'),
          creature('c-4', 'Farmer', 'book-b'),
          creature('c-5', 'Mayor', 'book-b'),
        ]),
      (bookId) => {
        reads.push(bookId);
        return Promise.resolve(
          bookId === 'book-a' ? 'Pathfinder Monster Core' : 'Pathfinder NPC Core',
        );
      },
    );
    // Two books, five lines: the cap is a prompt budget, and so is the number
    // of book reads behind it.
    expect(reads).toHaveLength(2);
    expect(new Set(reads).size).toBe(2);
    expect(roster.lines).toEqual([
      line('Farmer', 'Pathfinder NPC Core'),
      line('Ghoul', 'Pathfinder Monster Core'),
      line('Mayor', 'Pathfinder NPC Core'),
      line('Wight', 'Pathfinder Monster Core'),
      line('Zombie', 'Pathfinder Monster Core'),
    ]);
  });
});

describe('a creature whose library records no pack title prints its NAME ALONE (docs/17 row 163)', () => {
  it('prints no separator, no empty dash and no stand-in when the book row is gone', async () => {
    const chunkId = await seedCreature({ bookTitle: 'Bestiary', name: 'Zombie', level: '1' });
    const chunk = await db.chunks.get(chunkId);
    if (chunk === undefined) throw new Error('the seeded chunk vanished');
    // A library row can be missing in a real workspace (a deleted book, a
    // citation that outlived its pack). The window then knows NO title.
    await db.rulebooks.delete(chunk.bookId);

    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toEqual(['Zombie']);
    const only = roster.lines[0] ?? '';
    expect(only.endsWith('\u2014')).toBe(false);
    expect(only).not.toContain('\u2014');
    expect(only.trim()).toBe(only);
    // The LABEL reading would have printed its `Rulebook` stand-in here — a
    // value a model would copy as if it were a title (AGENTS rule 1).
    expect(only).not.toContain('Rulebook');
    expect(only).not.toMatch(/unknown|n\/a|none/i);
  });

  it('mixes titled and untitled lines in one window without inventing anything', async () => {
    const orphan = await seedCreature({ bookTitle: 'Bestiary', name: 'Zombie', level: '1' });
    await seedCreature({ bookTitle: 'Tome of Horrors', name: 'Ghoul', level: '2' });
    const chunk = await db.chunks.get(orphan);
    if (chunk === undefined) throw new Error('the seeded chunk vanished');
    await db.rulebooks.delete(chunk.bookId);

    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toEqual(['Zombie', line('Ghoul', 'Tome of Horrors')]);
  });

  it('reads the title through the ONE stamping read, never the LABEL stand-in (source pin)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/llm/creatorRoster.ts', 'utf8');
    // `citationBookTitle` is the stamp reading (undefined when nothing is
    // known); `rulebookDisplayTitle` is the label reading, which PRINTS the
    // `Rulebook` stand-in for exactly that case — a placeholder the model would
    // copy into a module. A second reading here is the defect this pin catches;
    // the scan is over CALLS, so the doc comment that names the forbidden one
    // (to say why it is forbidden) does not satisfy it.
    const calls = (name: string): boolean =>
      new RegExp(`(?<![.\\w])${name}\\(`).test(source);
    expect(calls('citationBookTitle')).toBe(true);
    expect(calls('rulebookDisplayTitle')).toBe(false);
    // …and the window does not re-read the chunk table it just pooled: the book
    // is a carried row fact (`LibraryCreature.bookId`).
    expect(calls('listLibraryCreatures')).toBe(true);
    expect(source.includes('db.chunks')).toBe(false);
  });
});

describe('the window is a budget: what the pack titles cost (docs/17 row 163)', () => {
  /** The owner's OWN library, as `docs/16-BESTIARY-FETCH.md` §4 verifies it: the
   *  eight curated pf2e packs with their documented creature counts (1,800
   *  creatures). The NAMES are irrelevant to the cost — a title is appended to
   *  whatever the name was — while the TITLES and the POPULATION are the real
   *  ones, which is exactly what the prompt budget depends on. */
  const OWNER_PACKS: readonly { title: string; creatures: number }[] = [
    { title: 'Pathfinder Monster Core', creatures: 492 },
    { title: 'Pathfinder Monster Core 2', creatures: 446 },
    { title: 'Pathfinder NPC Core', creatures: 272 },
    { title: 'Pathfinder Bestiary', creatures: 166 },
    { title: 'Pathfinder Bestiary 3', creatures: 165 },
    { title: 'Pathfinder Bestiary 2', creatures: 160 },
    { title: 'Menace under Otari', creatures: 93 },
    { title: 'NPC Gallery', creatures: 6 },
  ];

  function ownerLibrary(): ReturnType<typeof creatorRosterEntries> {
    return creatorRosterEntries(
      OWNER_PACKS.flatMap((pack, packIndex) =>
        Array.from({ length: pack.creatures }, (_, index) => ({
          chunkId: `chunk-${String(packIndex)}-${String(index)}`,
          name: `Creature ${String(packIndex)}-${String(index)}`,
          contentHash: 'hash',
          headingPath: [`Creature ${String(packIndex)}`],
          statBlock: { level: String((index % 20) + 1) } as never,
          bookId: `book-${String(packIndex)}`,
        })),
      ),
    );
  }

  it('costs the separator plus the book’s own title per line, and nothing else', () => {
    const entries = ownerLibrary();
    const titles = new Map(
      OWNER_PACKS.map((pack, index) => [`book-${String(index)}`, pack.title]),
    );
    expect(entries).toHaveLength(1800);
    const bare = buildCreatorRoster(entries, 10);
    const titled = buildCreatorRoster(entries, 10, titles);
    expect(titled.lines).toHaveLength(CREATOR_ROSTER_LIMIT);

    const bareBlock = bestiaryVocabularyBlock(bare);
    const titledBlock = bestiaryVocabularyBlock(titled);
    if (bareBlock === null || titledBlock === null) {
      throw new Error('the vocabulary block is missing');
    }
    // MEASURED through the real path: a full 300-line window over this library
    // grows by exactly `300 × separator + Σ title` — no name, level or trait
    // byte rides along, so the cost is bounded by the cap and the titles.
    //
    // The expectation is derived from the ENTRIES and the library's OWN titles,
    // never from the rendered lines: an expectation read back off the same lines
    // it measures would agree with a window that dropped its titles entirely
    // (measured — that arm passed this pin before the derivation was fixed).
    const expectedGrowth = titled.entries
      .slice(0, CREATOR_ROSTER_LIMIT)
      .reduce((total, entry) => total + 3 + (titles.get(entry.bookId) ?? '').length, 0);
    const growth = titledBlock.length - bareBlock.length;
    expect(growth).toBe(expectedGrowth);
    // …and the absolute figure the ledger records for the owner's library: 900
    // separator + 6,607 title = 7,507 characters, mean 25.0 per line.
    expect(growth).toBeGreaterThan(7000);
    // The budget guard (docs/17 row 163): a change that starts DECORATING a line
    // (a level, traits) would add ~8 bytes × 300 and turn this red instead of
    // quietly inflating every spine prompt.
    expect(growth).toBeLessThan(9000);
  });
});

describe('the title the window prints is the title the cast compares (docs/17 row 163)', () => {
  it('a title COPIED from a line narrows an ambiguous name to the creature that line lists', async () => {
    // Two installed books really do hold this name — the one case where the
    // slot's `book` decides. Before row 163 the model had no way to learn
    // either title, so it guessed a translation and the cast refused.
    const monsterCore = await seedCreature({
      bookTitle: 'Pathfinder Monster Core',
      name: 'Plague Zombie',
      level: '1',
    });
    const bestiary = await seedCreature({
      bookTitle: 'Pathfinder Bestiary',
      name: 'Plague Zombie',
      level: '2',
    });
    const roster = await collectCreatorRoster(1);
    expect(roster.lines).toEqual([
      line('Plague Zombie', 'Pathfinder Monster Core'),
      line('Plague Zombie', 'Pathfinder Bestiary'),
    ]);

    for (const [index, chunkId] of [monsterCore, bestiary].entries()) {
      const printed = roster.lines[index] ?? '';
      const copiedTitle = printed.slice(printed.indexOf(' \u2014 ') + 3);
      const citation = await libraryCitationForEntity('Aunt Agatha', {
        creature: 'Plague Zombie',
        book: copiedTitle,
      });
      expect(citation.chunkId).toBe(chunkId);
      // The stamp stays the LIBRARY's title (row 155), which is the same string
      // the window printed — the copy is honest end to end.
      expect(citation.bookTitle).toBe(copiedTitle);
    }
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

describe('the window is scoped to the campaign’s game system (docs/17 row 207)', () => {
  /** The two books the owner's report is about: a Pathfinder 2e pack and a
   *  dnd5e pack in ONE workspace, with one creature each that exists ONLY in
   *  its own system. */
  async function seedBothSystems(): Promise<void> {
    await seedCreature({
      name: 'Goblin Warrior',
      level: '1',
      bookTitle: 'Pathfinder Monster Core',
      system: 'pathfinder2e',
    });
    await seedCreature({
      name: 'Beholder',
      level: '5',
      bookTitle: 'D&D 5e SRD',
      system: 'dnd5e',
    });
  }

  it('offers a Pathfinder 2e campaign ONLY pf2e creatures — never the dnd5e-only one', async () => {
    await seedBothSystems();
    const roster = await collectCreatorRoster(3, 'pathfinder2e');
    expect(windowNames(roster.lines)).toEqual(['Goblin Warrior']);
    expect(roster.lines.join('\n')).not.toContain('Beholder');
    // Non-vacuity: the UNSCOPED read really holds the dnd5e creature, so the
    // absence above is the scope doing the work — not an empty library.
    const everything = await collectCreatorRoster(3);
    expect(windowNames(everything.lines)).toEqual(['Goblin Warrior', 'Beholder']);
  });

  it('is the mirror for a dnd5e campaign', async () => {
    await seedBothSystems();
    const roster = await collectCreatorRoster(3, 'dnd5e');
    expect(windowNames(roster.lines)).toEqual(['Beholder']);
    expect(roster.lines.join('\n')).not.toContain('Goblin Warrior');
  });

  it('keeps the wiki-link pool UNSCOPED — an explicit `[[Beholder]]` still resolves', async () => {
    // The stated decision (docs/17 row 207): the wiki-link resolver is a
    // library-wide reference reader, not a generation read. Scoping it would
    // silently turn a resolvable mention in a pf2e campaign into a dangling
    // link the moment the owner also owns the dnd5e book.
    await seedBothSystems();
    expect((await wikiLinkCreatures()).map((creature) => creature.name)).toEqual([
      'Beholder',
      'Goblin Warrior',
    ]);
    // …and the unscoped pool read itself is unchanged (the pre-207 contract).
    expect((await listLibraryCreatures()).map((creature) => creature.name)).toEqual([
      'Beholder',
      'Goblin Warrior',
    ]);
  });

  it('names a creature whose OWNING BOOK row is gone as out of scope, not as present', async () => {
    // The system lives on the BOOK row, so a chunk whose book has been deleted
    // cannot be attributed to the campaign's system. It is therefore not
    // offered — the honest answer — while the unscoped read still sees it.
    const chunkId = await seedCreature({
      name: 'Goblin Warrior',
      level: '1',
      bookTitle: 'Pathfinder Monster Core',
      system: 'pathfinder2e',
    });
    const chunk = await db.chunks.get(chunkId);
    if (chunk === undefined) throw new Error('the seeded chunk vanished');
    await db.rulebooks.delete(chunk.bookId);
    expect((await collectCreatorRoster(1, 'pathfinder2e')).lines).toEqual([]);
    // The unscoped read still pools it — with its title now unreadable, so the
    // line is the bare name (the pre-207 shape).
    expect((await collectCreatorRoster(1)).lines).toEqual(['Goblin Warrior']);
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
