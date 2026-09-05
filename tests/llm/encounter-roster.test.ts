import { describe, expect, it } from 'vitest';

import type { Rulebook, RuleChunk } from '@/domain';
import { ruleChunkSchema, statBlockSchema } from '@/domain';
import {
  buildPackRoster,
  collectPackRoster,
  collectPackRosterWithRetry,
  formatRosterSection,
  parseLevelSort,
  parseRosterTargetLevel,
  rosterNameIndex,
  type PackRosterDeps,
  type PackRosterEntry,
} from '@/llm/encounterRoster';

function chunk(overrides: {
  name: string;
  level: string;
  traits?: string;
}): RuleChunk {
  return ruleChunkSchema.parse({
    id: crypto.randomUUID(),
    createdAt: 1,
    updatedAt: 1,
    bookId: crypto.randomUUID(),
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath: [overrides.name],
    text: `${overrides.name} — Creature ${overrides.level}`,
    statBlock: statBlockSchema.parse({
      system: 'pathfinder2e',
      level: overrides.level,
      size: 'Small',
      creatureType: 'humanoid',
      ac: 15,
      hp: 10,
      speed: '25 feet',
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      extras: overrides.traits === undefined ? {} : { Traits: overrides.traits },
    }),
    contentHash: crypto.randomUUID().replaceAll('-', '0').padEnd(64, '0'),
  });
}

function book(overrides: Partial<Rulebook> = {}): Rulebook {
  return {
    id: 'book-1',
    createdAt: 1,
    updatedAt: 1,
    title: 'Bestiary',
    system: 'pathfinder2e',
    filename: 'bestiary.zip',
    pageCount: 0,
    status: 'ready',
    errorMessage: '',
    origin: 'pack',
    packMeta: null,
    ...overrides,
  };
}

describe('parseLevelSort', () => {
  it('orders printed d20 levels numerically', () => {
    expect(parseLevelSort('3')).toBe(3);
    expect(parseLevelSort('-1')).toBe(-1);
    expect(parseLevelSort('1/2')).toBe(0.5);
    expect(parseLevelSort('1 / 4')).toBe(0.25);
    expect(parseLevelSort('0')).toBe(0);
  });

  it('orders dnd5e CR fractions by value (12-BESTIARY-PACKS §5/§11)', () => {
    expect(parseLevelSort('1/8')).toBe(0.125);
    expect(parseLevelSort('3/4')).toBe(0.75);
    const chain = ['1/4', '1/2', '1', '2'].map(parseLevelSort);
    expect(chain).toEqual([0.25, 0.5, 1, 2]);
    expect([...chain].sort((a, b) => a - b)).toEqual(chain);
    expect(parseLevelSort('1/4')).toBeLessThan(parseLevelSort('1/2'));
  });

  it('rejects levels that cannot be ordered', () => {
    expect(() => parseLevelSort('boss')).toThrow('cannot order creatures by level');
  });
});

describe('parseRosterTargetLevel (12-BESTIARY-PACKS §7 ratified chain, step a)', () => {
  it('parses the first digit run of the free-text hint deterministically', () => {
    expect(parseRosterTargetLevel('5')).toBe(5);
    expect(parseRosterTargetLevel('4–6')).toBe(4);
    expect(parseRosterTargetLevel('CR 5')).toBe(5);
    expect(parseRosterTargetLevel(' 12 ')).toBe(12);
    expect(parseRosterTargetLevel('level 3 party')).toBe(3);
  });

  it('returns undefined for a hint without digits — a legitimate preference state, not an error', () => {
    expect(parseRosterTargetLevel('')).toBeUndefined();
    expect(parseRosterTargetLevel('mid')).toBeUndefined();
    expect(parseRosterTargetLevel('—')).toBeUndefined();
  });
});

/** A roster fixture of `count` creatures whose level (and levelSort) is 1..count. */
function creatureLadder(count: number): PackRosterEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const level = index + 1;
    return {
      name: `Creature ${String(level).padStart(3, '0')}`,
      level: String(level),
      traits: '',
      chunkId: `c${String(level).padStart(3, '0')}`,
      levelSort: level,
      bookId: 'b1',
      bookTitle: 'Bestiary',
    };
  });
}

describe('buildPackRoster with a target level (§7 ratified window ordering)', () => {
  it('keeps the ascending window byte-identical when no target exists (pin)', () => {
    const entries = creatureLadder(305);
    const noArg = buildPackRoster(entries);
    const explicitUndefined = buildPackRoster(entries, undefined);
    expect(explicitUndefined).toEqual(noArg);
    // The historical order: levels 1..300 ascending, 5 truncated.
    expect(noArg.lines[0]).toBe('Creature 001 (1)');
    expect(noArg.lines[299]).toBe('Creature 300 (300)');
    expect(noArg.total).toBe(305);
    expect(noArg.truncated).toBe(5);
  });

  it('fills the 300-line window with the creatures closest to the target level', () => {
    // 305 creatures, levels 1..305, target 300: the ascending window would
    // hold levels 1..300, the distance window holds levels 6..305 — the two
    // windows differ by {1..5} out, {301..305} in.
    const roster = buildPackRoster(creatureLadder(305), 300);
    expect(roster.total).toBe(305);
    expect(roster.truncated).toBe(5);
    expect(roster.lines).toHaveLength(300);
    // Distance ties (299/301 both 1 away) break by levelSort ascending.
    expect(roster.lines[0]).toBe('Creature 300 (300)');
    expect(roster.lines[1]).toBe('Creature 299 (299)');
    expect(roster.lines[2]).toBe('Creature 301 (301)');
    expect(roster.lines[3]).toBe('Creature 298 (298)');
    expect(roster.lines[4]).toBe('Creature 302 (302)');
    // The five farthest (levels 1..5) drop out; near-target high levels are in.
    expect(roster.lines).toContain('Creature 305 (305)');
    expect(roster.lines).not.toContain('Creature 001 (1)');
    expect(roster.lines).not.toContain('Creature 005 (5)');
  });

  it('breaks distance ties by levelSort ascending, then name', () => {
    const roster = buildPackRoster(
      [
        { name: 'Gamma', level: '3', traits: '', chunkId: 'c3', levelSort: 3, bookId: 'b1', bookTitle: 'Bestiary' },
        { name: 'Zeta', level: '4', traits: '', chunkId: 'c4a', levelSort: 4, bookId: 'b1', bookTitle: 'Bestiary' },
        { name: 'Alpha', level: '4', traits: '', chunkId: 'c4b', levelSort: 4, bookId: 'b1', bookTitle: 'Bestiary' },
        { name: 'Beta', level: '6', traits: '', chunkId: 'c6', levelSort: 6, bookId: 'b1', bookTitle: 'Bestiary' },
      ],
      5,
    );
    // Distances: level 4 → 1, level 6 → 1, level 3 → 2. The distance-1 tie
    // orders 4 before 6 (levelSort), and the two level-4 rows by name.
    expect(roster.lines).toEqual([
      'Alpha (4)',
      'Zeta (4)',
      'Beta (6)',
      'Gamma (3)',
    ]);
  });

  it('sorts the CR-less "—" creatures after every leveled creature, even at huge distance', () => {
    const roster = buildPackRoster(
      [
        { name: 'Avatar of Death', level: '—', traits: '', chunkId: 'c-a', levelSort: Number.POSITIVE_INFINITY, bookId: 'b1', bookTitle: 'Bestiary' },
        { name: 'Goblin', level: '1', traits: '', chunkId: 'c-g', levelSort: 1, bookId: 'b1', bookTitle: 'Bestiary' },
        { name: 'Animated Object', level: '—', traits: '', chunkId: 'c-b', levelSort: Number.POSITIVE_INFINITY, bookId: 'b1', bookTitle: 'Bestiary' },
      ],
      20,
    );
    // Two "—" creatures tie at +Infinity distance without NaN-poisoning the
    // comparator; their mutual order falls through to the name.
    expect(roster.lines).toEqual([
      'Goblin (1)',
      'Animated Object (—)',
      'Avatar of Death (—)',
    ]);
  });
});

describe('buildPackRoster', () => {
  it('formats level-ordered lines with traits', () => {
    const roster = buildPackRoster([
      { name: 'Ogre', level: '2', traits: 'large, giant', chunkId: 'c3', levelSort: 2, bookId: 'b1', bookTitle: 'Bestiary' },
      { name: 'Goblin Warrior', level: '-1', traits: 'humanoid, grunt', chunkId: 'c1', levelSort: -1, bookId: 'b1', bookTitle: 'Bestiary' },
      { name: 'Giant Rat', level: '1/2', traits: '', chunkId: 'c2', levelSort: 0.5, bookId: 'b1', bookTitle: 'Bestiary' },
    ]);
    expect(roster.lines).toEqual([
      'Goblin Warrior (-1, humanoid, grunt)',
      'Giant Rat (1/2)',
      'Ogre (2, large, giant)',
    ]);
    expect(roster.total).toBe(3);
    expect(roster.truncated).toBe(0);
  });

  it('breaks ties by name and caps the roster with a truncation count', () => {
    const entries = Array.from({ length: 305 }, (_, index) => ({
      name: `Creature ${String(305 - index).padStart(3, '0')}`,
      level: '1',
      traits: '',
      chunkId: `c${String(index)}`,
      levelSort: 1,
      bookId: 'b1',
      bookTitle: 'Bestiary',
    }));
    const roster = buildPackRoster(entries);
    expect(roster.lines).toHaveLength(300);
    expect(roster.total).toBe(305);
    expect(roster.truncated).toBe(5);
    expect(roster.lines[0]).toBe('Creature 001 (1)');
  });

  it('suffixes duplicate cross-book names with the book title, unique names stay bare (fix-02 decision 5)', () => {
    const roster = buildPackRoster([
      { name: 'Dire Wolf', level: '2', traits: 'animal', chunkId: 'c-old', levelSort: 2, bookId: 'b-old', bookTitle: 'Older Bestiary' },
      { name: 'Dire Wolf', level: '2', traits: 'animal', chunkId: 'c-new', levelSort: 2, bookId: 'b-new', bookTitle: 'Newer Bestiary' },
      { name: 'Ogre', level: '2', traits: '', chunkId: 'c3', levelSort: 2, bookId: 'b-new', bookTitle: 'Newer Bestiary' },
      // Same book as the first Dire Wolf: same-book duplicates never suffix.
      { name: 'Goblin', level: '1', traits: '', chunkId: 'c4', levelSort: 1, bookId: 'b-old', bookTitle: 'Older Bestiary' },
      { name: 'Goblin', level: '-1', traits: '', chunkId: 'c5', levelSort: -1, bookId: 'b-old', bookTitle: 'Older Bestiary' },
    ]);
    expect(roster.lines).toEqual([
      'Goblin (-1)',
      'Goblin (1)',
      'Dire Wolf (2, animal) — Older Bestiary',
      'Dire Wolf (2, animal) — Newer Bestiary',
      'Ogre (2)',
    ]);
  });

  it('keeps the level/name ordering unaffected by the disambiguation suffix', () => {
    const roster = buildPackRoster([
      { name: 'Zeta Beast', level: '1', traits: '', chunkId: 'cz', levelSort: 1, bookId: 'b1', bookTitle: 'One' },
      { name: 'Alpha Beast', level: '3', traits: '', chunkId: 'ca', levelSort: 3, bookId: 'b2', bookTitle: 'Two' },
      { name: 'Alpha Beast', level: '2', traits: '', chunkId: 'ca2', levelSort: 2, bookId: 'b1', bookTitle: 'One' },
    ]);
    // level 1 < level 2 < level 3; the duplicate lines carry their books.
    expect(roster.lines).toEqual([
      'Zeta Beast (1)',
      'Alpha Beast (2) — One',
      'Alpha Beast (3) — Two',
    ]);
  });
});

describe('collectPackRoster', () => {
  it('collects pack chunks for the campaign system only', async () => {    const packBook = book();
    const pdfBook = book({
      id: 'book-2',
      title: 'PDF Rulebook',
      filename: 'book.pdf',
      origin: 'pdf',
      packMeta: null,
    });
    const otherSystem = book({ id: 'book-3', system: 'dnd5e', title: 'SRD' });

    const chunks = [
      chunk({ name: 'Goblin Warrior', level: '-1', traits: 'humanoid, grunt' }),
      chunk({ name: 'Ogre', level: '2', traits: 'large, giant' }),
    ];
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([packBook, pdfBook, otherSystem]),
      listChunks: (bookIds) => {
        expect(bookIds).toEqual([packBook.id]);
        return Promise.resolve(chunks);
      },
    };

    const roster = await collectPackRoster('pathfinder2e', deps);
    expect(roster.lines).toEqual([
      'Goblin Warrior (-1, humanoid, grunt)',
      'Ogre (2, large, giant)',
    ]);
    expect(roster.entries.map((entry) => entry.name)).toEqual(['Goblin Warrior', 'Ogre']);
  });

  it('fails loudly on a pack chunk without a validated stat block', async () => {
    const bad = chunk({ name: 'Broken', level: '1' });
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([book()]),
      listChunks: () => Promise.resolve([{ ...bad, statBlock: null }]),
    };
    await expect(collectPackRoster('pathfinder2e', deps)).rejects.toThrow(
      'has no validated stat block',
    );
  });

  it('skips books that are not ready packs (§7: origin, system, status)', async () => {
    const processing = book({ id: 'book-4', status: 'processing' });
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([book(), processing]),
      listChunks: (bookIds) => {
        expect(bookIds).toEqual(['book-1']);
        return Promise.resolve([]);
      },
    };
    const roster = await collectPackRoster('pathfinder2e', deps);
    expect(roster.lines).toEqual([]);
    expect(roster.chunkByName.size).toBe(0);
  });

  it('threads the target level into the window while the name index still covers ALL entries', async () => {
    const packBook = book();
    const entries = creatureLadder(302);
    const chunks = entries.map((entry) => ({ ...chunk({ name: entry.name, level: entry.level }), id: entry.chunkId }));
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([packBook]),
      listChunks: () => Promise.resolve(chunks),
    };

    const roster = await collectPackRoster('pathfinder2e', deps, 302);
    // The window is distance-ordered: levels 1..2 drop out, the target leads.
    expect(roster.lines[0]).toBe('Creature 302 (302)');
    expect(roster.lines).not.toContain('Creature 001 (1)');
    expect(roster.truncated).toBe(2);
    // Resolution is NOT windowed: a creature outside the visible 300 still
    // resolves through the index built over every entry.
    expect(roster.chunkByName.get('creature 001')).toBe('c001');
    expect(roster.chunkByName.get('creature 002')).toBe('c002');
    expect(roster.chunkByName.size).toBe(302);
  });

  it('keeps the ascending window when no target level is passed', async () => {
    const packBook = book();
    const entries = creatureLadder(302);
    const chunks = entries.map((entry) => ({ ...chunk({ name: entry.name, level: entry.level }), id: entry.chunkId }));
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([packBook]),
      listChunks: () => Promise.resolve(chunks),
    };

    const roster = await collectPackRoster('pathfinder2e', deps);
    expect(roster.lines[0]).toBe('Creature 001 (1)');
    expect(roster.lines).not.toContain('Creature 302 (302)');
    expect(roster.truncated).toBe(2);
  });

  it('resolves duplicate names to the most recently updated pack book first', async () => {
    // listRulebooks returns most-recently-updated first, so 'b-new' ranks 0.
    const newer = book({ id: 'b-new', title: 'Newer Bestiary' });
    const older = book({ id: 'b-old', title: 'Older Bestiary', updatedAt: 1 });
    const chunks = [
      { ...chunk({ name: 'Dire Wolf', level: '2', traits: 'animal' }), id: 'chunk-old', bookId: 'b-old' },
      { ...chunk({ name: 'Dire Wolf', level: '2', traits: 'animal' }), id: 'chunk-new', bookId: 'b-new' },
    ];
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([newer, older]),
      listChunks: () => Promise.resolve(chunks),
    };
    const roster = await collectPackRoster('pathfinder2e', deps);
    // Keys are lowercased; runEngine lowercases citations before lookup (§7).
    expect(roster.chunkByName.get('dire wolf')).toBe('chunk-new');
  });
});

describe('rosterNameIndex', () => {
  it('breaks duplicate-name ties by book rank, then level/name order', () => {
    const index = rosterNameIndex(
      [
        { name: 'Bandit', level: '1', traits: '', chunkId: 'c-late', levelSort: 1, bookId: 'b2', bookTitle: 'Two' },
        { name: 'Bandit', level: '1', traits: '', chunkId: 'c-early', levelSort: 1, bookId: 'b1', bookTitle: 'One' },
        { name: 'Bandit', level: '1', traits: '', chunkId: 'c-early2', levelSort: 1, bookId: 'b1', bookTitle: 'One' },
      ],
      new Map([
        ['b1', 0],
        ['b2', 1],
      ]),
    );
    expect(index.get('bandit')).toBe('c-early');
  });
});

describe('formatRosterSection', () => {
  it('is null without roster lines and adds a citation instruction', () => {
    expect(formatRosterSection([], 0)).toBeNull();
    const section = formatRosterSection(['Goblin (-1, humanoid)', 'Ogre (2, large)'], 0);
    expect(section).toContain('Bestiary roster');
    expect(section).toContain('Goblin (-1, humanoid)');
    expect(section).toContain('sourceName');
    expect(section).toContain('sourceChunkIndex');
    expect(section).not.toContain('roster truncated');
  });

  it('appends the truncation note with the hidden count (§7)', () => {
    const section = formatRosterSection(['Ogre (2)'], 12);
    expect(section).toContain('(roster truncated; 12 more)');
  });

  it('tells the model to cite the bare creature name, not the book suffix', () => {
    const section = formatRosterSection(['Dire Wolf (2, animal) — Older Bestiary'], 0);
    expect(section).toContain('never the parenthesized level/traits or a " — book" suffix');
  });
});

describe('collectPackRosterWithRetry (fix-02 decision 4)', () => {
  it('retries a transient failure once and succeeds on attempt 2', async () => {
    const packBook = book({ title: 'Flaky Bestiary' });
    let calls = 0;
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([packBook]),
      listChunks: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('DatabaseClosedError: transient'));
        return Promise.resolve([chunk({ name: 'Ogre', level: '2', traits: 'large' })]);
      },
    };

    const roster = await collectPackRosterWithRetry('pathfinder2e', deps);
    expect(calls).toBe(2);
    expect(roster.lines).toEqual(['Ogre (2, large)']);
  });

  it('fails loudly with a named roster error after exactly 2 attempts', async () => {
    const packBook = book({ title: 'Broken Bestiary' });
    let calls = 0;
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([packBook]),
      listChunks: () => {
        calls += 1;
        return Promise.reject(new Error('pack chunk abc has no validated stat block — re-import the pack'));
      },
    };

    await expect(collectPackRosterWithRetry('pathfinder2e', deps)).rejects.toThrow(
      /Bestiary pack roster for system "pathfinder2e" failed after 2 attempts: .*no validated stat block/,
    );
    expect(calls).toBe(2);
  });

  it('does not retry a successful build (single call)', async () => {
    let calls = 0;
    const deps: PackRosterDeps = {
      listBooks: () => Promise.resolve([book()]),
      listChunks: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    };
    await collectPackRosterWithRetry('pathfinder2e', deps);
    expect(calls).toBe(1);
  });
});
