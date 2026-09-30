import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  comparableName,
  ruleChunkSchema,
  spellDataSchema,
  spellChunkName,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type RuleChunk,
  type SpellData,
  type StatBlock,
} from '@/domain';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { loadSpellChunksFor, loadSpellIndexesFor, statBlockSystems } from '@/db/spellRepo';

import { clearDatabase } from './helpers';

/**
 * THE one spell-corpus read and its scope (docs/17 row 184, docs/18 §2.1).
 *
 * The dispatcher's verification found this seam UNPINNED: dropping
 * `loadSpellChunksFor`'s system restriction (`readyBookIds(system)` →
 * `readyBookIds()`) changed the file's bytes and left every test GREEN, so the
 * doc comment's promise — *"A cross-system chunk is dropped by the book-id
 * intersection, never merged: a Pathfinder 2e campaign must never assign a
 * dnd5e spell"* — was prose, not a rule. This file is the pin that makes it a
 * rule: two ready books of DIFFERENT systems both carrying `spell` chunks, and
 * a corpus read that returns only its own system's rows (both directions).
 *
 * It also covers the two derivations built on the read — the per-system index
 * (`loadSpellIndexesFor`) and the systems-per-build collector
 * (`statBlockSystems`) — because a wrong system there would leak the same way
 * one layer up.
 */

let seq = 0;

function spellData(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: 'pathfinder2e',
    rank: 1,
    cantrip: false,
    traditions: ['arcane'],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
    ...over,
  });
}

function spellChunk(bookId: Id, name: string, data: SpellData): RuleChunk {
  seq += 1;
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'spell',
    headingPath: ['Spells', name],
    text: name,
    statBlock: null,
    contentHash: 'e'.repeat(63) + String(seq % 10),
    spellData: data,
  });
}

async function readyBook(title: string, system: 'pathfinder2e' | 'dnd5e'): Promise<Id> {
  const book = await createPackBook({ title, system, filename: 'pack.json' });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-pack',
    license: 'CC-BY-4.0',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  return finished.id;
}

/** The corpus read's own answer as names, so a failure reads. */
async function corpusNames(system: 'pathfinder2e' | 'dnd5e'): Promise<string[]> {
  return (await loadSpellChunksFor(system)).map((chunk) => spellChunkName(chunk));
}

function statBlock(system: 'pathfinder2e' | 'dnd5e'): StatBlock {
  return statBlockSchema.parse({
    system,
    level: '5',
    size: 'Small',
    creatureType: 'goblinoid',
    ac: 20,
    acNote: '',
    hp: 60,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 14, dex: 16, con: 14, int: 16, wis: 12, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
});

describe('the spell corpus never crosses systems (docs/17 row 184)', () => {
  it("returns only the asked system's ready spell chunks — in BOTH directions", async () => {
    const pf2eBook = await readyBook('PF2e Spells', 'pathfinder2e');
    const dndBook = await readyBook('D&D SRD', 'dnd5e');
    await putChunks([
      spellChunk(pf2eBook, 'Fireball', spellData({ system: 'pathfinder2e', rank: 3 })),
      spellChunk(dndBook, 'Eldritch Blast', spellData({ system: 'dnd5e', rank: 0, cantrip: true })),
    ]);

    expect(await corpusNames('pathfinder2e')).toEqual(['Fireball']);
    expect(await corpusNames('dnd5e')).toEqual(['Eldritch Blast']);
  });

  it('drops a spell chunk whose book is not READY', async () => {
    // `createPackBook` alone leaves the book mid-import: its chunks exist but
    // are not part of the campaign's material yet.
    const importing = await createPackBook({
      title: 'Half-imported',
      system: 'pathfinder2e',
      filename: 'pack.json',
    });
    const ready = await readyBook('PF2e Spells', 'pathfinder2e');
    await putChunks([
      spellChunk(importing.id, 'Unready Spell', spellData()),
      spellChunk(ready, 'Fireball', spellData({ rank: 3 })),
    ]);

    expect(await corpusNames('pathfinder2e')).toEqual(['Fireball']);
  });

  it("indexes ONLY the systems the build's blocks carry", async () => {
    const pf2eBook = await readyBook('PF2e Spells', 'pathfinder2e');
    const dndBook = await readyBook('D&D SRD', 'dnd5e');
    await putChunks([
      spellChunk(pf2eBook, 'Fireball', spellData({ system: 'pathfinder2e', rank: 3 })),
      spellChunk(dndBook, 'Eldritch Blast', spellData({ system: 'dnd5e', rank: 0, cantrip: true })),
    ]);

    const pf2eOnly = await loadSpellIndexesFor(statBlockSystems([statBlock('pathfinder2e')]));
    expect(pf2eOnly.get('pathfinder2e')?.get(comparableName('Fireball'))?.name).toBe('Fireball');
    // The other system's spell is not in this index, and the other system has
    // no index at all — a merged map would leak it one layer up.
    expect(pf2eOnly.get('pathfinder2e')?.has(comparableName('Eldritch Blast'))).toBe(false);
    expect(pf2eOnly.has('dnd5e')).toBe(false);

    const both = await loadSpellIndexesFor(
      statBlockSystems([statBlock('pathfinder2e'), statBlock('dnd5e'), null, undefined]),
    );
    expect([...both.keys()].sort()).toEqual(['dnd5e', 'pathfinder2e']);
    expect(both.get('dnd5e')?.get(comparableName('Eldritch Blast'))?.name).toBe('Eldritch Blast');
    expect(both.get('dnd5e')?.has(comparableName('Fireball'))).toBe(false);
  });

  it("reads a block's own system and ignores a null block", () => {
    expect([...statBlockSystems([null, undefined])]).toEqual([]);
    expect([...statBlockSystems([statBlock('dnd5e'), statBlock('dnd5e')])]).toEqual(['dnd5e']);
  });
});
