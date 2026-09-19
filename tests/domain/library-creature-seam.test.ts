import { describe, expect, it } from 'vitest';

import type { RuleChunk, Rulebook } from '@/domain';
import {
  bookDisplayTitleOf,
  bookStampTitleOf,
  libraryCitationForSlot,
  libraryCreaturePool,
} from '@/domain/libraryCreature';

/**
 * THE ONE library name-matching seam, called the way a DEXIE TRANSACTION calls
 * it (docs/17 row 248's remaining slice).
 *
 * The seam exists because the v24 mob-copy migration runs INSIDE the upgrade
 * transaction, before the upgraded `db` instance is usable, so the live cast's
 * read path (`listLibraryCreatures` → `db.rulebooks`) cannot be reached. These
 * pins drive the seam with a POOL AND A BOOK INDEX THE TEST HOLDS — no
 * database at all — which is exactly the property that makes it tx-callable:
 * if it ever grew a `db` read, these calls could not be made this way.
 *
 * The BOOK rules are pinned too, because the seam is what decides which title a
 * slot's `book` is compared against (the reader-facing one) and which title a
 * citation STAMPS (the row's own, or nothing).
 */

const BOOK: Rulebook = {
  id: '00000000-0000-4000-8000-00000000000b',
  system: 'dnd5e',
  status: 'ready',
  title: 'Bestiary',
  createdAt: 1,
  updatedAt: 1,
} as Rulebook;

const PACK_BOOK: Rulebook = {
  id: '00000000-0000-4000-8000-00000000000c',
  system: 'dnd5e',
  status: 'ready',
  title: 'Tome of Beasts',
  origin: 'pack',
  createdAt: 1,
  updatedAt: 1,
} as Rulebook;

const UNTITLED_BOOK: Rulebook = {
  id: '00000000-0000-4000-8000-00000000000d',
  system: 'dnd5e',
  status: 'ready',
  title: '',
  createdAt: 1,
  updatedAt: 1,
} as Rulebook;

/** The one stat block every fixture creature carries. */
const BLOCK = {
  system: 'dnd5e',
  level: '3',
  size: 'Large',
  creatureType: 'monstrosity',
  ac: 13,
  acNote: '',
  hp: 59,
  hpFormula: '7d10+21',
  speed: '40 ft.',
  abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 },
  saves: '',
  skills: '',
  senses: '',
  languages: '',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: {},
} as RuleChunk['statBlock'];

/** A stat-block chunk with only the facts the seam reads. */
function chunk(id: string, bookId: string, name: string, statBlock: RuleChunk['statBlock']): RuleChunk {
  return {
    id,
    bookId,
    pageStart: 12,
    pageEnd: 12,
    chunkType: 'statblock',
    headingPath: [name],
    text: `${name}.`,
    contentHash: `hash-${name.toLowerCase()}`,
    statBlock,
  } as RuleChunk;
}

const CHUNKS: RuleChunk[] = [
  chunk('00000000-0000-4000-8000-000000000001', BOOK.id, 'Owlbear', BLOCK),
  chunk('00000000-0000-4000-8000-000000000002', PACK_BOOK.id, 'Zombie', BLOCK),
  // Two creatures of ONE name in two books: the ambiguity the book narrows.
  chunk('00000000-0000-4000-8000-000000000003', BOOK.id, 'Ghost', BLOCK),
  chunk('00000000-0000-4000-8000-000000000004', PACK_BOOK.id, 'Ghost', BLOCK),
  // A stat-block chunk with NO stat block: never a candidate.
  chunk('00000000-0000-4000-8000-000000000005', BOOK.id, 'Husk', null),
];

const POOL = libraryCreaturePool(CHUNKS, {
  books: new Map([
    [BOOK.id, BOOK],
    [PACK_BOOK.id, PACK_BOOK],
    [UNTITLED_BOOK.id, UNTITLED_BOOK],
  ]),
});

const BOOKS = new Map([
  [BOOK.id, BOOK],
  [PACK_BOOK.id, PACK_BOOK],
  [UNTITLED_BOOK.id, UNTITLED_BOOK],
]);

const LOOKUPS = {
  bookTitleOf: (chunkId: string) => Promise.resolve(bookDisplayTitleOf(chunkId, CHUNKS, BOOKS)),
  stampBookTitleOf: (chunkId: string) => Promise.resolve(bookStampTitleOf(chunkId, CHUNKS, BOOKS)),
};

describe('the library name-match seam, called with NO database (docs/17 row 248)', () => {
  it('derives the pool purely: a stat block and a heading required, sorted by name', () => {
    expect(POOL.map((creature) => creature.name)).toEqual(['Ghost', 'Ghost', 'Owlbear', 'Zombie']);
    // The stat-block-less chunk is not a creature at all.
    expect(POOL.some((creature) => creature.name === 'Husk')).toBe(false);
  });

  it('resolves a UNIQUE name and stamps the book title the row carries', async () => {
    const citation = await libraryCitationForSlot('Aunt Agatha', { creature: 'Zombie' }, POOL, LOOKUPS);
    expect(citation.chunkId).toBe('00000000-0000-4000-8000-000000000002');
    expect(citation.creatureName).toBe('Zombie');
    expect(citation.bookTitle).toBe('Tome of Beasts');
    expect(citation.contentHash).toBe('hash-zombie');
  });

  it('refuses a name the library does not hold, NAMING what it asked for', async () => {
    await expect(
      libraryCitationForSlot('Aunt Agatha', { creature: 'Beholder' }, POOL, LOOKUPS),
    ).rejects.toThrow(/holds no creature of that name/);
  });

  it('narrows an AMBIGUOUS name by the slot book, and refuses without one', async () => {
    await expect(
      libraryCitationForSlot('Aunt Agatha', { creature: 'Ghost' }, POOL, LOOKUPS),
    ).rejects.toThrow(/holds 2 creatures of that name/);
    const narrowed = await libraryCitationForSlot(
      'Aunt Agatha',
      { creature: 'Ghost', book: 'Bestiary' },
      POOL,
      LOOKUPS,
    );
    expect(narrowed.chunkId).toBe('00000000-0000-4000-8000-000000000003');
    // ...and the STAMP is the resolved row's own title, not the slot's string.
    expect(narrowed.bookTitle).toBe('Bestiary');
  });

  it('a UNIQUE name ignores the slot book entirely (the book is a disambiguator)', async () => {
    const citation = await libraryCitationForSlot(
      'Aunt Agatha',
      { creature: 'Zombie', book: 'Metaphorically Wrong' },
      POOL,
      LOOKUPS,
    );
    expect(citation.chunkId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('reads a missing title as the ONE reading each side needs', () => {
    // The reader-facing side prints the placeholder; the STAMP side says
    // nothing rather than storing the placeholder (AGENTS rule 1).
    expect(bookDisplayTitleOf('00000000-0000-4000-8000-000000000099', CHUNKS, BOOKS)).toBe('Rulebook');
    expect(bookStampTitleOf('00000000-0000-4000-8000-000000000099', CHUNKS, BOOKS)).toBeUndefined();
  });
});
