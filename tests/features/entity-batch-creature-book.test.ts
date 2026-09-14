import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { createRulebook } from '@/db/rulebookRepo';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { libraryCitationForEntity } from '@/features/modules/entity-batch';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * THE SLOT'S BOOK IS A DISAMBIGUATOR, NEVER A VETO (docs/17 row 161).
 *
 * The owner hit this repeatedly while generating a module, verbatim (his paste
 * transport mangles the quotes, not the data):
 *
 *   - «Plague Zombie» from the book «Monsterkern» → refused, "that book holds
 *     no creature of that name — the library has Plague Zombie (Pathfinder
 *     Monster Core)";
 *   - «Commoner» / «Mayor» / «Farmer» from «NSC-Galerie» → the same shape,
 *     against a library whose book is «Pathfinder NPC Core»;
 *   - «Butcher» with NO book → CORRECT then and still correct now: "this
 *     workspace's library holds no creature of that name … the nearest
 *     creatures this library holds: Poacher, Teacher, Bounty Hunter".
 *
 * The cause is neither the library nor the citation: the module is authored in
 * GERMAN, so the model localises the pack titles it was shown ("Monsterkern" =
 * Monster Core, "NSC-Galerie" = NPC Gallery) while the library's own titles are
 * English. The old code narrowed the candidates by the named book and THREW when
 * nothing matched — even at `sameName.length === 1`, where there was nothing to
 * disambiguate — and the refusal named the very creature it refused to use.
 *
 * These pins drive `libraryCitationForEntity` DIRECTLY: it is the ONE seam that
 * answers "which library creature does the module's bestiary slot mean?"
 * (docs/18 §2), and it reads the real pool through the real Dexie tables. The
 * end-to-end path — a real spine slot, a real cast row, the real refill run — is
 * pinned in `tests/llm/moduleGen-cast.test.ts`.
 *
 * WHAT A TEST CANNOT PROVE HERE: no pin below shows a real model writing a
 * localised title into a slot. The fixture string «Monsterkern» STANDS IN for
 * that, because a live provider's vocabulary is not reproducible. What is
 * measured is the only thing that can be: that such a string, arriving in the
 * slot, resolves instead of vetoing a cast whose answer is unique.
 */

const BESTIARY_BOOK = 'Pathfinder Monster Core';
const NPC_BOOK = 'Pathfinder NPC Core';
const SECOND_BOOK = 'Bestiary 2';
const LOCALIZED_BESTIARY = 'Monsterkern';
const LOCALIZED_NPC = 'NSC-Galerie';
const NECROMANCER = 'The Risen Watchman';

/** One stat-block chunk in a book, seeded exactly the way the creature tier
 * seeds one (the shape `db/creatureRepo.listLibraryCreatures` pools). The `hp`
 * distinguishes two same-named creatures that come from different books. */
async function seedCreature(options: {
  bookTitle: string;
  name: string;
  hp: number;
}): Promise<string> {
  const book = await createRulebook({
    title: options.bookTitle,
    system: 'dnd5e',
    filename: `${options.bookTitle.toLowerCase().replaceAll(' ', '-')}.pdf`,
  });
  const text = `${options.name}\nMedium undead, neutral evil\nArmor Class 8\nHit Points ${String(options.hp)}`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 316,
    pageEnd: 316,
    chunkType: 'statblock',
    // A creature's canonical name is the LAST non-empty heading.
    headingPath: [options.name],
    text,
    contentHash: await sha256Hex(text),
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '1',
      size: 'Medium',
      creatureType: 'undead',
      ac: 8,
      acNote: '',
      hp: options.hp,
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

/** The REFUSAL a slot produced, as its message — the assertion target for every
 * "this must NOT resolve" pin. A slot that RESOLVES instead fails this call by
 * name rather than quietly grading its own error sentence. */
async function refusalFor(
  entityName: string,
  slot: { creature: string; book?: string },
): Promise<string> {
  const outcome = await libraryCitationForEntity(entityName, slot).then(
    (citation) => ({ resolved: citation }),
    (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
  );
  if ('resolved' in outcome) {
    throw new Error(
      `expected a refusal for «${slot.creature}», but it RESOLVED to chunk ${outcome.resolved.chunkId}`,
    );
  }
  return outcome.message;
}

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

describe('a unique creature resolves whatever book the slot named (rule 2)', () => {
  it('the owner’s case: «Plague Zombie» from «Monsterkern», and the citation records the LIBRARY’s book', async () => {
    const chunkId = await seedCreature({
      bookTitle: BESTIARY_BOOK,
      name: 'Plague Zombie',
      hp: 22,
    });

    const citation = await libraryCitationForEntity(NECROMANCER, {
      creature: 'Plague Zombie',
      book: LOCALIZED_BESTIARY,
    });

    // The library's ONE creature of that name IS the creature the entity asked
    // for: there is nothing to disambiguate, so the slot's foreign title cannot
    // refuse the cast.
    expect(citation.chunkId).toBe(chunkId);
    // …and the citation records the LIBRARY's real book, never the model's
    // string (docs/17 row 155): the `missing ref` banner must name the pack that
    // actually has to be installed, and «Monsterkern» is not a book that exists.
    expect(citation.bookTitle).toBe(BESTIARY_BOOK);
    expect(citation.creatureName).toBe('Plague Zombie');
    expect(citation.contentHash).toBe((await db.chunks.get(chunkId))?.contentHash);
  });

  it('the owner’s second shape: «Farmer» from «NSC-Galerie» against «Pathfinder NPC Core»', async () => {
    const chunkId = await seedCreature({ bookTitle: NPC_BOOK, name: 'Farmer', hp: 4 });

    const citation = await libraryCitationForEntity('Old Mertens', {
      creature: 'Farmer',
      book: LOCALIZED_NPC,
    });

    expect(citation.chunkId).toBe(chunkId);
    expect(citation.bookTitle).toBe(NPC_BOOK);
  });

  it('a book the library does not have AT ALL resolves too — the title is a hint, not a key', async () => {
    const chunkId = await seedCreature({
      bookTitle: BESTIARY_BOOK,
      name: 'Plague Zombie',
      hp: 22,
    });

    const citation = await libraryCitationForEntity(NECROMANCER, {
      creature: 'Plague Zombie',
      book: 'A Book Nobody Ever Imported',
    });

    expect(citation.chunkId).toBe(chunkId);
    expect(citation.bookTitle).toBe(BESTIARY_BOOK);
  });

  it('a slot with NO book resolves the unique name as it always did', async () => {
    const chunkId = await seedCreature({
      bookTitle: BESTIARY_BOOK,
      name: 'Plague Zombie',
      hp: 22,
    });

    const citation = await libraryCitationForEntity(NECROMANCER, { creature: 'Plague Zombie' });

    expect(citation.chunkId).toBe(chunkId);
    expect(citation.bookTitle).toBe(BESTIARY_BOOK);
  });

  it('the name match stays EXACT: a one-edit near miss still refuses (a fuzzy match casts another creature)', async () => {
    await seedCreature({ bookTitle: BESTIARY_BOOK, name: 'Plague Zombie', hp: 22 });

    // One character away from the library's only creature of a similar name.
    const message = await refusalFor(NECROMANCER, { creature: 'Plague Zombi' });

    expect(message).toContain('no creature of that name');
    expect(message).toContain('never a guess');
  });
});

describe('an ambiguous name needs the book to name exactly one candidate (rule 3)', () => {
  it('the book resolves the one candidate it matches, and the citation names THAT book', async () => {
    const coreChunkId = await seedCreature({
      bookTitle: BESTIARY_BOOK,
      name: 'Ghoul Soldier',
      hp: 22,
    });
    const secondChunkId = await seedCreature({
      bookTitle: SECOND_BOOK,
      name: 'Ghoul Soldier',
      hp: 40,
    });
    expect(coreChunkId).not.toBe(secondChunkId);

    const citation = await libraryCitationForEntity('The Grave Watch', {
      creature: 'Ghoul Soldier',
      book: SECOND_BOOK,
    });

    expect(citation.chunkId).toBe(secondChunkId);
    expect(citation.bookTitle).toBe(SECOND_BOOK);
  });

  it('a book that matches NO candidate refuses LOUDLY, listing every candidate WITH its book', async () => {
    await seedCreature({ bookTitle: BESTIARY_BOOK, name: 'Ghoul Soldier', hp: 22 });
    await seedCreature({ bookTitle: SECOND_BOOK, name: 'Ghoul Soldier', hp: 40 });

    // The localised title again — but here it decides nothing: two creatures
    // share the name and neither comes from a book by that title.
    const message = await refusalFor('The Grave Watch', {
      creature: 'Ghoul Soldier',
      book: LOCALIZED_BESTIARY,
    });

    expect(message).toContain('2 creatures of that name');
    // The remedy IS the candidate list: both real titles are named, so the owner
    // can see which book to write into the slot.
    expect(message).toContain(BESTIARY_BOOK);
    expect(message).toContain(SECOND_BOOK);
    expect(message).toContain("name the book in the entity's bestiary slot");
  });

  it('an ambiguous name with NO book refuses — never a silent pick', async () => {
    await seedCreature({ bookTitle: BESTIARY_BOOK, name: 'Ghoul Soldier', hp: 22 });
    await seedCreature({ bookTitle: SECOND_BOOK, name: 'Ghoul Soldier', hp: 40 });

    const message = await refusalFor('The Grave Watch', { creature: 'Ghoul Soldier' });

    expect(message).toContain('2 creatures of that name');
    expect(message).toContain(BESTIARY_BOOK);
    expect(message).toContain(SECOND_BOOK);
  });
});

describe('a name the library does not hold still fails, with the nearest names (rules 1 and 4)', () => {
  it('«Butcher» — the NON-VACUITY pin: the nearest creatures are MESSAGE ONLY and never resolve', async () => {
    // The owner's own library shape: the trade names around «Butcher» are what
    // the refusal names, and none of them is the creature that was asked for.
    await seedCreature({ bookTitle: NPC_BOOK, name: 'Poacher', hp: 4 });
    await seedCreature({ bookTitle: NPC_BOOK, name: 'Teacher', hp: 3 });
    await seedCreature({ bookTitle: NPC_BOOK, name: 'Bounty Hunter', hp: 6 });
    await seedCreature({ bookTitle: BESTIARY_BOOK, name: 'Plague Zombie', hp: 22 });

    const message = await refusalFor('The Butcher’s Boy', { creature: 'Butcher' });

    expect(message).toContain('no creature of that name');
    expect(message).toContain('the nearest creatures this library holds');
    expect(message).toContain('Poacher');
    // The throw itself is the proof: a resolution would have returned a citation
    // instead of a sentence, and `refusalFor` fails LOUDLY on one.
    expect(message).not.toContain('Plague Zombie');
  });

  it('an unknown name with a FOREIGN book still fails — a book cannot resurrect a name', async () => {
    await seedCreature({ bookTitle: NPC_BOOK, name: 'Poacher', hp: 4 });

    const message = await refusalFor('The Butcher’s Boy', {
      creature: 'Butcher',
      book: LOCALIZED_NPC,
    });

    expect(message).toContain('no creature of that name');
    expect(message).toContain('Poacher');
  });

  it('an unknown name with nothing close stays quiet — the pre-114 sentence byte for byte', async () => {
    await seedCreature({ bookTitle: BESTIARY_BOOK, name: 'Plague Zombie', hp: 22 });

    const message = await refusalFor('The Butcher’s Boy', { creature: 'Butcher' });

    expect(message).toBe(
      'bestiary cast: the entity «The Butcher’s Boy» asks to borrow the stats of «Butcher», ' +
        "but this workspace's library holds no creature of that name — import the book it comes " +
        'from, or name a creature the library has (never a guess)',
    );
  });
});

describe('the lookup and the cast are ONE seam (AGENTS §Centralization)', () => {
  /** Every `.ts`/`.tsx` under `src/`, repo-relative and sorted. */
  function srcFiles(): string[] {
    const root = join(process.cwd(), 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);
    return found.sort();
  }

  function source(file: string): string {
    return readFileSync(join(process.cwd(), 'src', file), 'utf8');
  }

  /** Every file that really CALLS `name` — not one that merely mentions it in a
   * comment or a doc string. A call is the identifier followed by `(`, and the
   * character before it is neither `.` (a qualified mention such as
   * ``db/creatureRepo.listLibraryCreatures()`` inside a comment) nor part of a
   * longer identifier. */
  function callers(name: string): string[] {
    const call = new RegExp(`(?<![.\\w])${name}\\(`);
    return srcFiles().filter((file) => call.test(source(file)));
  }

  it('the library pool has exactly these readers — a SECOND creature lookup goes red here', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('features/modules/entity-batch.ts');

    // `db/creatureRepo` OWNS the pool, `llm/creatorRoster` turns it into the
    // prompt vocabulary (docs/17 row 114) and `entity-batch` RESOLVES a slot
    // against it. A fourth caller is either a consumer that must state its
    // reason here, or the second copy of "which creature does this name mean?"
    // — the exact defect this pin exists to catch.
    expect(callers('listLibraryCreatures')).toEqual([
      'db/creatureRepo.ts',
      'features/modules/entity-batch.ts',
      'llm/creatorRoster.ts',
    ]);
  });

  it('the slot→citation resolution is defined in ONE place and named in the seam index', () => {
    const definitions = srcFiles().filter((file) =>
      source(file).includes('export async function libraryCitationForEntity('),
    );
    expect(definitions).toEqual(['features/modules/entity-batch.ts']);

    // docs/18 §2 names this seam; a landing that moves it updates the row in the
    // same commit (AGENTS §Centralization 3).
    const seamIndex = readFileSync(join(process.cwd(), 'docs/18-ARCHITECTURE.md'), 'utf8');
    expect(seamIndex).toContain('entity-batch.libraryCitationForEntity');
  });
});
