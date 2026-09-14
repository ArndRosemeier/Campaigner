import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { libraryCitationForEntity } from '@/features/modules/entity-batch';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * THE BESTIARY LOOKUP INHERITS THE ONE COMPARABLE FORM (docs/17 row 166).
 *
 * The gap, found by row 162's writer and recorded there rather than fixed
 * (the file belonged to row 161): `libraryCitationForEntity` filtered the
 * library pool with a hand-rolled
 * `creature.name.trim().toLowerCase() === wanted.toLowerCase()`. It was the
 * LAST hand-rolled name comparison in `src/` that the row-121/162 fold had not
 * reached, and it therefore did not inherit Unicode canonical equivalence: a
 * DECOMPOSED creature name in a bestiary slot (`Müller` typed on a Mac: `u` +
 * U+0308) missed a COMPOSED library name (U+00FC) — the same string to a
 * reader, different bytes — and the cast refused a creature the library holds.
 *
 * WHAT IS PINNED HERE, and why each pin exists:
 * - the failing case, in BOTH directions (slot decomposed / library composed,
 *   and the reverse), because the bug is symmetric and a one-directional fold
 *   would look fixed from one side only;
 * - the EXACTNESS BOUNDARY: NFC is canonical equivalence and NOT diacritic
 *   folding. `Schläger` and `Schlager` are still two names, so the fix cannot
 *   be "strip accents";
 * - that the lookup went onto the STRICT seam (`sameCreatureName`) and not onto
 *   the LOOSE one (`normalizeCreatureName`, which also strips punctuation and a
 *   trailing `(…)` qualifier and must never resolve anything — docs/17 row 114
 *   says so in its own header). `Zombie (variant)` must still REFUSE against a
 *   library holding `Zombie`; the loose form would resolve it.
 *
 * The seam's SOURCE accounting — that `entity-batch.ts` is named as a folded
 * file, so a hand-rolled comparison reappearing in it goes red — is the OTHER
 * half, in `tests/features/alias-merge-seam.test.ts` (§the alias merge is ONE
 * seam). Behaviour can never see a reverted fold (the two spellings agree on
 * every ASCII input); only the source can.
 *
 * WHAT A TEST CANNOT PROVE: that a real Mac-authored module produces these
 * bytes. The fixtures below are strings WE composed, from the same in-memory
 * text — a genuine NFD name arrives from a file an author typed on his own
 * machine, and no fixture can be that. What is measured is the only thing that
 * can be: that a name differing ONLY by Unicode composition, arriving in a
 * slot, resolves instead of refusing. If the fold regressed, the owner would
 * see the row-161 refusal sentence — "this workspace's library holds no
 * creature of that name" — naming a creature his library plainly holds, from a
 * module whose own text spells the name correctly on screen.
 */

const BESTIARY_BOOK = 'Pathfinder Monster Core';
const SECOND_BOOK = 'Bestiary 2';
const WATCHER = 'Wächter';
const ENTITY = 'Der Torwächter';

/** The two spellings of ONE name, built from the same source text so neither
 *  is a literal somebody could accidentally "tidy up" into the other. */
const WATCHER_COMPOSED = WATCHER.normalize('NFC');
const WATCHER_DECOMPOSED = WATCHER.normalize('NFD');

/** One stat-block chunk in a book, seeded exactly the way the creature tier
 *  seeds one (`db/creatureRepo.listLibraryCreatures` pools it). The library's
 *  own spelling is the chunk's last non-empty heading, VERBATIM — nothing
 *  normalizes it on the way in, which is what makes a decomposed heading a real
 *  fixture rather than a fabricated one. */
async function seedCreature(name: string, hp: number, bookTitle = BESTIARY_BOOK): Promise<string> {
  const book = await createRulebook({
    title: bookTitle,
    system: 'dnd5e',
    filename: `${bookTitle.toLowerCase().replaceAll(' ', '-')}.pdf`,
  });
  const text = `${name}\nMedium fey, neutral\nArmor Class 15\nHit Points ${String(hp)}`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 316,
    pageEnd: 316,
    chunkType: 'statblock',
    headingPath: [name],
    text,
    contentHash: await sha256Hex(text),
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '4',
      size: 'Medium',
      creatureType: 'fey',
      ac: 15,
      acNote: '',
      hp,
      hpFormula: '8d8+8',
      speed: '30 ft.',
      abilities: { str: 12, dex: 16, con: 13, int: 11, wis: 14, cha: 10 },
      saves: '',
      skills: 'Perception +4',
      senses: 'darkvision 60 ft.',
      languages: 'Common, Sylvan',
      traits: [],
      actions: [{ name: 'Staff', text: 'Melee Weapon Attack: +4 to hit, 1d6+2 bludgeoning.' }],
      reactions: [],
      legendary: [],
      extras: {},
    }),
  });
  await putChunks([chunk]);
  return chunk.id;
}

/** The REFUSAL a slot produced, as its message. A slot that RESOLVES instead
 *  fails this call by NAME rather than quietly grading its own error sentence. */
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

describe('a creature name written in another Unicode composition is the SAME name', () => {
  it('the fixtures really are two spellings of one name, and only composition differs', () => {
    // NON-VACUITY, first: if these two were equal strings the whole file would
    // prove nothing, and if a diacritic differed it would be testing the wrong
    // relation. Same code points, different composition, same normalized text.
    expect(WATCHER_DECOMPOSED).not.toBe(WATCHER_COMPOSED);
    // Longer in code units because a combining mark was added — the composition
    // difference IS the extra character, not a different letter.
    expect(WATCHER_DECOMPOSED.length).toBeGreaterThan(WATCHER_COMPOSED.length);
    // Canonical equivalence, not diacritic folding: the two are the SAME
    // normalized text, and the composed spelling is already canonical.
    expect(WATCHER_DECOMPOSED.normalize('NFC')).toBe(WATCHER_COMPOSED);
    expect(WATCHER_COMPOSED.normalize('NFC')).toBe(WATCHER_COMPOSED);
  });

  it('a DECOMPOSED slot name resolves a COMPOSED library name (THE FAILING CASE)', async () => {
    const chunkId = await seedCreature(WATCHER_COMPOSED, 44);

    const citation = await libraryCitationForEntity(ENTITY, { creature: WATCHER_DECOMPOSED });

    expect(citation.chunkId).toBe(chunkId);
    expect(citation.bookTitle).toBe(BESTIARY_BOOK);
  });

  it('and the reverse: a COMPOSED slot name resolves a DECOMPOSED library name', async () => {
    const chunkId = await seedCreature(WATCHER_DECOMPOSED, 44);

    const citation = await libraryCitationForEntity(ENTITY, { creature: WATCHER_COMPOSED });

    expect(citation.chunkId).toBe(chunkId);
    expect(citation.bookTitle).toBe(BESTIARY_BOOK);
  });

  it('the ambiguous arm resolves across compositions too, and the book still narrows', async () => {
    // The same folded comparison answers BOTH arms of the seam; a fold applied
    // only to the empty/unique arm would leave the disambiguation path blind.
    // Both rows carry the DECOMPOSED spelling and the slot asks in the composed
    // one, so every step of the ambiguous arm is exercised across compositions.
    await seedCreature(WATCHER_DECOMPOSED, 44);
    const secondChunkId = await seedCreature(WATCHER_DECOMPOSED, 60, SECOND_BOOK);

    const citation = await libraryCitationForEntity(ENTITY, {
      creature: WATCHER_COMPOSED,
      book: SECOND_BOOK,
    });

    expect(citation.chunkId).toBe(secondChunkId);
    expect(citation.bookTitle).toBe(SECOND_BOOK);
  });

  it('trimming is part of the comparable form, so a padded slot name resolves', async () => {
    const chunkId = await seedCreature(WATCHER_COMPOSED, 44);

    const citation = await libraryCitationForEntity(ENTITY, { creature: `  ${WATCHER_DECOMPOSED}  ` });

    expect(citation.chunkId).toBe(chunkId);
  });
});

describe('the match is otherwise EXACT — composition is folded, nothing else is', () => {
  it('a DIACRITIC difference is still two names (NFC yes, diacritic folding NO)', async () => {
    await seedCreature('Schläger', 30);

    // One diacritic apart — the same distinction row 162 pinned for aliases. A
    // comparison that had been made "looser than the seam" (NFKD + strip the
    // combining marks, which is `normalizeCreatureName`'s first step) would
    // resolve this to the wrong creature, silently.
    const message = await refusalFor(ENTITY, { creature: 'Schlager' });

    expect(message).toContain('no creature of that name');
    expect(message).toContain('never a guess');
  });

  it('the LOOSE normalization is NOT what this resolves through: a trailing qualifier still refuses', async () => {
    await seedCreature('Zombie', 22);

    // `normalizeCreatureName` strips a trailing `(…)` and collapses hyphens, so
    // it would answer `Zombie (variant)` and `Zombie-Variant` with `Zombie`.
    // Both must refuse: the loose form is a MESSAGE helper and may never turn
    // into a resolution (docs/17 row 114's own contract).
    const qualified = await refusalFor(ENTITY, { creature: 'Zombie (variant)' });
    expect(qualified).toContain('no creature of that name');

    const hyphenated = await refusalFor(ENTITY, { creature: 'Zombie-Variant' });
    expect(hyphenated).toContain('no creature of that name');
  });

  it('a one-edit near miss still refuses (row 161’s exactness pin, unchanged)', async () => {
    await seedCreature(WATCHER_COMPOSED, 44);

    const message = await refusalFor(ENTITY, { creature: 'Wächte' });

    expect(message).toContain('no creature of that name');
    expect(message).toContain('never a guess');
  });
});
