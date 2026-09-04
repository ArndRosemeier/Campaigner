import { describe, expect, it } from 'vitest';

import type { Rulebook, RuleChunk } from '@/domain';
import { ruleChunkSchema, statBlockSchema } from '@/domain';
import {
  buildPackRoster,
  collectPackRoster,
  parseLevelSort,
  type PackRosterDeps,
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

  it('rejects levels that cannot be ordered', () => {
    expect(() => parseLevelSort('boss')).toThrow('cannot order creatures by level');
  });
});

describe('buildPackRoster', () => {
  it('formats level-ordered lines with traits', () => {
    const roster = buildPackRoster([
      { name: 'Ogre', level: '2', traits: 'large, giant', chunkId: 'c3', levelSort: 2 },
      { name: 'Goblin Warrior', level: '-1', traits: 'humanoid, grunt', chunkId: 'c1', levelSort: -1 },
      { name: 'Giant Rat', level: '1/2', traits: '', chunkId: 'c2', levelSort: 0.5 },
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
    }));
    const roster = buildPackRoster(entries);
    expect(roster.lines).toHaveLength(300);
    expect(roster.total).toBe(305);
    expect(roster.truncated).toBe(5);
    expect(roster.lines[0]).toBe('Creature 001 (1)');
  });
});

describe('collectPackRoster', () => {
  it('collects pack chunks for the campaign system only', async () => {
    const packBook = book();
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
});
