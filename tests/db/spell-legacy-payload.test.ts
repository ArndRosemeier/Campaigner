import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  mobSpellChips,
  mobSpellIndex,
  mobSpellIssues,
  spellCorpusEntries,
  spellDataSchema,
  stampNewEntity,
  type Id,
  type RuleChunk,
} from '@/domain';
import { db } from '@/db/db';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { loadSpellChunksFor } from '@/db/spellRepo';

import { clearDatabase } from './helpers';

/**
 * THE LEGACY SPELL PAYLOAD HEALS AT THE LIBRARY READ BOUNDARY (docs/17 row
 * 304, docs/18 §2.1).
 *
 * THE OWNER'S LIVE DEFECT: a PF2e mob («Hanno Beilert», level 2, spells
 * Message, Shield, Animate Rope, Sanctuary) produced the run issue
 * *"the mob «Hanno Beilert» assigns a spell it cannot use: Cannot convert
 * undefined or null to object"*, and the sentence named the mob but never the
 * spell. The TypeError came from `spellHeightening.baseValues`'s
 * `Object.entries(spell.damage)`.
 *
 * THE REACHABLE SHAPE IS THE ABSENT KEY, and only a STORED row carries it:
 * `spellDataSchema` declares `damage: spellDamageMapSchema.default({})` with
 * the explicit promise that it *"keeps a payload written before this field
 * readable"*; rows written in the four-commit window before that default
 * physically lack the key; and — the hole this file pins — NOTHING re-parsed
 * the payload between Dexie and the resolver (`loadSpellChunksFor` →
 * `listChunksByType` → `spellCorpusEntries` passed `chunk.spellData` through
 * untouched), so the schema's own default never ran on the library path.
 *
 * EVERY FIXTURE IN THIS REPO IS BUILT THROUGH `spellDataSchema.parse` — the
 * exact step that HIDES this defect — so the rows below are inserted with the
 * key physically ABSENT, through the REAL read path and with no seam mocked:
 * `loadSpellChunksFor` → `spellCorpusEntries` → `mobSpellIndex` →
 * `mobSpellChips` → `mobSpellIssues`.
 */

let seq = 0;

async function readySpellBook(): Promise<Id> {
  const book = await createPackBook({
    title: 'PF2e Spells',
    system: 'pathfinder2e',
    filename: 'pack.json',
  });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-pack',
    license: 'CC-BY-4.0',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  return finished.id;
}

/**
 * The payload a PRE-`c37e4de` ingest really wrote: every field the first
 * `spellData` commit stamped, and NO `damage` key at all. It is deliberately
 * NOT passed through `spellDataSchema.parse` — parsing it is the thing under
 * test — and one test below asserts the CURRENT schema accepts it, so
 * "unparsed" can never quietly come to mean "unparseable".
 */
function legacySpellPayload(): Record<string, unknown> {
  return {
    system: 'pathfinder2e',
    rank: 1,
    cantrip: false,
    traditions: ['arcane'],
    properties: [],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    area: null,
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
  };
}

/** One raw `spell` chunk row as physically stored; the payload goes in as-is. */
function rawSpellChunkRow(
  bookId: Id,
  name: string,
  spellData: Record<string, unknown>,
): RuleChunk {
  seq += 1;
  return {
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'spell',
    headingPath: ['Spells', name],
    text: name,
    statBlock: null,
    contentHash: 'a'.repeat(63) + String(seq % 10),
    ...({ spellData } as unknown as Pick<RuleChunk, 'spellData'>),
  };
}

/** `Hanno Beilert`'s four spells, every one key-ABSENT as the window wrote it. */
const HANNO_SPELLS = ['Message', 'Shield', 'Animate Rope', 'Sanctuary'] as const;

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
});

describe('a legacy spell payload heals at the library read boundary (docs/17 row 304)', () => {
  it("takes the owner's exact four spells — `damage` key ABSENT — to NO run issue", async () => {
    const book = await readySpellBook();
    const legacy = legacySpellPayload();
    for (const name of HANNO_SPELLS) {
      await db.chunks.put(rawSpellChunkRow(book, name, legacy));
    }

    const entries = spellCorpusEntries(await loadSpellChunksFor('pathfinder2e'));
    expect(entries.map((entry) => entry.name).sort()).toEqual([...HANNO_SPELLS].sort());

    // Through the REAL resolver chain the owner's run used, the issue is GONE.
    // Before the read-boundary parse this line WAS his exact report:
    //   the mob «Hanno Beilert» assigns a spell it cannot use:
    //   Cannot convert undefined or null to object
    const index = mobSpellIndex(
      entries.map((entry) => ({ name: entry.name, spellData: entry.data })),
    );
    const chips = mobSpellChips(
      HANNO_SPELLS.map((name) => ({ name })),
      2,
      index,
    );
    expect(mobSpellIssues(chips, 'Hanno Beilert')).toEqual([]);
    expect(chips.map((chip) => chip.resolved)).toEqual([true, true, true, true]);
    expect(chips.flatMap((chip) => chip.issues)).toEqual([]);

    // The control that keeps the fixture honest: the shape was MISSING A KEY,
    // not schema-invalid — the current schema accepts it and supplies `{}`.
    expect(entries[0]?.data.damage).toEqual({});
  });

  it('FAILS LOUDLY on a row the schema really rejects — `damage: null` is never healed', async () => {
    const book = await readySpellBook();
    await db.chunks.put(
      rawSpellChunkRow(book, 'Message', { ...legacySpellPayload(), damage: null }),
    );

    await expect(loadSpellChunksFor('pathfinder2e')).rejects.toThrow(ZodError);
  });

  it('leaves a CURRENTLY-written payload byte-identical', async () => {
    const book = await readySpellBook();
    const current = {
      ...legacySpellPayload(),
      rank: 0,
      cantrip: true,
      damage: { 0: { formula: '1d6', type: 'fire', category: null, materials: [] } },
    };
    await db.chunks.put(rawSpellChunkRow(book, 'Ignition', current));

    const entries = spellCorpusEntries(await loadSpellChunksFor('pathfinder2e'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data.damage).toEqual(current.damage);
    expect(entries[0]?.data.rank).toBe(0);
  });
});

describe('the run issue names BOTH halves (docs/17 row 304, AGENTS rule 1)', () => {
  it('names the failing SPELL as well as the mob when the rule refuses', () => {
    // A rank-1 spell asked for at rank 0 makes `spellAtRank` throw its own
    // sentence; before row 304 that message reached the owner bare, so all four
    // of his spells produced an identical, spell-less line.
    const spell = spellDataSchema.parse({ ...legacySpellPayload(), rank: 1, damage: {} });
    const index = mobSpellIndex([{ name: 'Message', spellData: spell }]);
    const chips = mobSpellChips([{ name: 'Message' }], 2, index);
    expect(chips[0]?.issues).toEqual([]);

    const refused = mobSpellChips([{ name: 'Message', castRank: 1 }], 2, mobSpellIndex([
      { name: 'Message', spellData: { ...spell, rank: 3 } },
    ]));
    const issues = mobSpellIssues(refused, 'Hanno Beilert');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('the mob «Hanno Beilert» assigns a spell it cannot use:');
    expect(issues[0]).toContain('the spell «Message»: ');
    expect(issues[0]).toContain('cannot be cast at rank');
  });

  it('still names the spell on the unresolved arm', () => {
    const chips = mobSpellChips([{ name: 'Message' }], 2, mobSpellIndex([]));
    expect(mobSpellIssues(chips, 'Hanno Beilert')).toEqual([
      "the mob «Hanno Beilert» assigns a spell it cannot use: the spell «Message» is not in this campaign's imported spell library",
    ]);
  });
});
