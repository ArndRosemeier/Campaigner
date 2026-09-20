import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { loadSpellIndexesFor } from '@/db/spellRepo';
import { createArtifact } from '@/db/artifactRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import {
  copiedSpellEntry,
  encounterDataSchema,
  mobCasterLevel,
  mobSpellChipDetail,
  mobSpellChips,
  newId,
  ruleChunkSchema,
  spellAtRank,
  spellDataSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type MobSpellAssignment,
  type SpellData,
  type StatBlock,
} from '@/domain';
import type { CreatureCopyLookups } from '@/domain/libraryCopy';
import { sha256Hex } from '@/lib/hash';

import { clearDatabase } from '../db/helpers';

/**
 * A COPIED MOB'S SPELLS ARE THE FULL LIBRARY ENTRY (docs/17 row 255c) — the
 * last content family of the owner's rule: *"Core items should always ever only
 * be copied."*
 *
 * THE SHAPE. A library creature's block names its spells; the values a chip
 * shows come from the campaign's spell library at read time. A copy that kept
 * only the NAME would still need the library installed, which is exactly the
 * dependency the rule removes — so the copy carries the entry itself, its
 * `publication {title, license}` line included (the owner's already-made
 * decision: the text came from his own imported rulebook, self-containment is
 * the goal, and the publication line keeps the source named).
 *
 * THE PROPERTY THE ARC USES EVERYWHERE. A copied row must render with the
 * library ABSENT, so every resolution below hands `mobSpellChips` an EMPTY
 * index, and the seam that makes the copy is given a `spellIndex` that THROWS —
 * a value that still resolves is the copy's own, by construction.
 */

const SYSTEM = 'pathfinder2e' as const;

function spellData(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: SYSTEM,
    rank: 3,
    cantrip: false,
    traditions: ['arcane'],
    traits: ['concentrate'],
    rarity: 'common',
    cast: { time: '2', range: '500 feet', target: '', duration: '' },
    damage: { 0: { formula: '6d6', type: 'fire', materials: [] } },
    area: { type: 'burst', value: 20 },
    heightening: { interval: 1, damage: { 0: '2d6' }, type: 'interval' },
    heighteningEntries: [
      { kind: 'increment', increment: 1, text: 'The damage increases by 2d6.' },
    ],
    heighteningUnparsed: [],
    publication: { title: 'Pathfinder Player Core', license: 'ORC' },
    ...over,
  });
}

const FIREBALL = spellData();
const IGNITION = spellData({
  rank: 0,
  cantrip: true,
  traditions: ['arcane', 'primal'],
  traits: ['cantrip', 'fire'],
  damage: { 0: { formula: '2d4', type: 'fire', materials: [] } },
  area: null,
  heightening: null,
  heighteningEntries: [],
  cast: { time: '2', range: '30 feet', target: '', duration: '' },
});

/** A caster's block as a library creature carries it: the BARE assignment shape
 *  — a name and a rank, exactly what `domain/mobSpells`' own contract says. */
function libraryStatBlock(): StatBlock {
  return statBlockSchema.parse({
    system: SYSTEM,
    level: '7',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 24,
    acNote: '',
    hp: 100,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 14, dex: 16, con: 14, int: 18, wis: 16, cha: 12 },
    saves: '',
    skills: '',
    senses: '',
    languages: 'Common',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    spellDC: 25,
    spells: [{ name: 'Fireball', castRank: 3 }, { name: 'Ignition' }],
  });
}

function spellChunk(bookId: Id, name: string, data: SpellData, seq: number) {
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'spell',
    headingPath: ['Spells', name],
    text: name,
    statBlock: null,
    contentHash: 'e'.repeat(62) + String(seq).padStart(2, '0'),
    spellData: data,
  });
}

async function installLibrary(): Promise<{ chunkId: Id; bookId: Id }> {
  const book = await createRulebook({
    title: 'Pathfinder Player Core',
    system: SYSTEM,
    filename: 'player-core.pdf',
  });
  await updateRulebook(book.id, { status: 'ready', pageCount: 400 });
  const text = 'Nirklex, a test caster.';
  const creature = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 12,
    pageEnd: 12,
    chunkType: 'statblock',
    headingPath: ['Nirklex'],
    text,
    statBlock: libraryStatBlock(),
    contentHash: await sha256Hex(text),
  });
  await putChunks([
    creature,
    spellChunk(book.id, 'Fireball', FIREBALL, 1),
    spellChunk(book.id, 'Ignition', IGNITION, 2),
  ]);
  const { db } = await import('@/db/db');
  const [chunk] = await db.chunks.where('chunkType').equals('statblock').toArray();
  if (chunk === undefined) throw new Error('the creature chunk is missing');
  return { chunkId: chunk.id, bookId: book.id };
}

/** The copy the LIVE seam makes for the library fixture. */
async function copiedBlock(): Promise<StatBlock> {
  const { chunkId } = await installLibrary();
  const result = await copyCreatureStatsFromDb({ chunkId }, 'Nirklex');
  if (result.status !== 'copied') throw new Error('the fixture creature must be copyable');
  return result.copy.statBlock;
}

describe('a stat block’s spells are COPIED, not referenced (docs/17 row 255c)', () => {
  beforeEach(clearDatabase);

  it('the copy carries the full library entry and its publication line', async () => {
    const block = await copiedBlock();
    const spells = block.spells ?? [];
    expect(spells).toHaveLength(2);
    // The assignment's own keys survive byte-identically beside the payload.
    expect({ name: spells[0]?.name, castRank: spells[0]?.castRank }).toEqual({
      name: 'Fireball',
      castRank: 3,
    });
    // The copied payload is the library's OWN row, field for field…
    expect(copiedSpellEntry(spells[0] as MobSpellAssignment)).toEqual(FIREBALL);
    // …including the `publication {title, license}` line the owner decided to
    // keep: the text came from his imported rulebook and the source stays named.
    const copied = copiedSpellEntry(spells[0] as MobSpellAssignment);
    expect(copied?.publication).toEqual({ title: 'Pathfinder Player Core', license: 'ORC' });
    // The cantrip is copied too, with NO rank defaulted onto its assignment.
    expect(copiedSpellEntry(spells[1] as MobSpellAssignment)).toEqual(IGNITION);
    expect(spells[1]?.castRank ?? null).toBeNull();
  });

  it('a copied spell RESOLVES WITH THE LIBRARY ABSENT, and the corpus is what filled it', async () => {
    const block = await copiedBlock();
    // Resolve the COPY with an EMPTY index — the library uninstalled, or
    // another machine. The bare library row does NOT resolve this way (the
    // differential arm below), so this is the copy's own payload answering.
    const chips = mobSpellChips(block.spells, mobCasterLevel(block.level), new Map());
    expect(chips.map((chip) => chip.resolved)).toEqual([true, true]);
    expect(chips.map((chip) => chip.libraryName)).toEqual(['Fireball', 'Ignition']);
    expect(chips.map((chip) => chip.system)).toEqual([SYSTEM, SYSTEM]);
    expect(chips.flatMap((chip) => chip.issues)).toEqual([]);
    expect(chips[0]?.result?.appliedRank).toBe(3);
    // The chip's printed line is the real detail, not an unresolved notice.
    const fireball = chips[0];
    if (fireball === undefined) throw new Error('the copy must answer both spells');
    expect(mobSpellChipDetail(fireball)).toContain('Fireball — cast at rank 3');
    expect(mobSpellChipDetail(fireball)).toContain('6d6 fire');
    // The cantrip's rank is still the RULE's (derived from the caster's level).
    expect(chips[1]?.result?.cantripAuto).toBe(true);

    // THE DIFFERENTIAL: the SAME resolution over the LIBRARY's bare block and
    // the same empty index answers the loud unresolved chip — so the empty
    // index is genuinely empty and the copy is what resolved.
    const bare = mobSpellChips(libraryStatBlock().spells, 7, new Map());
    expect(bare.map((chip) => chip.resolved)).toEqual([false, false]);
    expect(bare[0]?.issues[0]).toContain('Fireball');
  });

  it('the corpus read at COPY time is what fills the assignment (an empty corpus leaves it bare)', async () => {
    const { chunkId } = await installLibrary();
    const { db } = await import('@/db/db');
    const creature = await db.chunks.get(chunkId);
    if (creature?.statBlock == null) throw new Error('the fixture chunk must carry a block');
    const { copyCreatureStats } = await import('@/domain/libraryCopy');
    const arm = async (spellIndex: CreatureCopyLookups['spellIndex']) => {
      const result = await copyCreatureStats({ chunkId }, 'Nirklex', {
        getChunk: () => db.chunks.get(chunkId),
        getChunkByContentHash: () => Promise.resolve(undefined),
        getRulebook: () => db.rulebooks.get(creature.bookId),
        spellIndex,
      });
      if (result.status !== 'copied') throw new Error('the fixture creature must be copyable');
      return result.copy.statBlock;
    };
    // Arm A: the REAL corpus (the SAME lazy lookup the live wrapper builds).
    const withCorpus = await arm(async (system) => (await loadSpellIndexesFor([system])).get(system));
    // Arm B: an EMPTY one. The two MUST differ, or this probe measured nothing
    // (the repo's own differential rule: identical arms are the tell).
    const withoutCorpus = await arm(() => Promise.resolve(new Map()));
    expect(JSON.stringify(withCorpus)).not.toEqual(JSON.stringify(withoutCorpus));
    expect(withCorpus.spells?.every((spell) => copiedSpellEntry(spell) !== null)).toBe(true);
    expect(withoutCorpus.spells?.every((spell) => copiedSpellEntry(spell) === null)).toBe(true);
  });

  it('the copy and the library answer the IDENTICAL chip (a differential, not a paraphrase)', async () => {
    const block = await copiedBlock();
    const index = (await loadSpellIndexesFor([SYSTEM])).get(SYSTEM);
    if (index === undefined) throw new Error('the fixture library must build an index');
    // The library's own answer, over the BARE block the library holds…
    const fromLibrary = mobSpellChips(libraryStatBlock().spells, 7, index).map(mobSpellChipDetail);
    // …and the copy's answer, over an EMPTY index.
    const fromCopy = mobSpellChips(block.spells, 7, new Map()).map(mobSpellChipDetail);
    expect(fromCopy).toEqual(fromLibrary);
    expect(fromCopy[0]).toContain('Fireball');
  });

  it('leaves a name the library does not hold as a LOUD bare assignment (never dropped)', async () => {
    const { chunkId } = await installLibrary();
    const { db } = await import('@/db/db');
    const creature = await db.chunks.get(chunkId);
    if (creature?.statBlock == null) throw new Error('the fixture chunk must carry a block');
    const sparse: StatBlock = {
      ...libraryStatBlock(),
      spells: [{ name: 'Wish', castRank: 9 }],
    };
    const { copyCreatureStats } = await import('@/domain/libraryCopy');
    const result = await copyCreatureStats({ chunkId }, 'Nirklex', {
      getChunk: () => Promise.resolve({ ...creature, statBlock: sparse }),
      getChunkByContentHash: () => Promise.resolve(undefined),
      getRulebook: () => db.rulebooks.get(creature.bookId),
      spellIndex: () => Promise.resolve(new Map()),
    });
    if (result.status !== 'copied') throw new Error('the fixture creature must be copyable');
    // The assignment is left EXACTLY as it was: no payload, no placeholder.
    expect(result.copy.statBlock.spells).toEqual([{ name: 'Wish', castRank: 9 }]);
    expect(copiedSpellEntry(result.copy.statBlock.spells?.[0] as MobSpellAssignment)).toBeNull();
    const chips = mobSpellChips(result.copy.statBlock.spells, 7, new Map());
    expect(chips[0]?.resolved).toBe(false);
    expect(chips[0]?.issues[0]).toContain('Wish');
  });

  it('the EXPORT carries the copy: a serialization round trip keeps the whole entry', async () => {
    const block = await copiedBlock();
    // The export writes pretty-printed JSON (`lib/exportImport`), so the round
    // trip through JSON IS the save/load boundary a campaign export performs.
    const exported = JSON.stringify({ artifacts: [{ data: { statBlock: block } }] }, null, 2);
    expect(exported).toContain('Pathfinder Player Core');
    expect(exported).toContain('"publication"');
    expect(exported).toContain('"license": "ORC"');
    // No library row is present in this payload — the copy is the whole source.
    expect(exported).not.toContain('"chunkType": "spell"');
    const roundTripped = JSON.parse(exported) as {
      artifacts: { data: { statBlock: unknown } }[];
    };
    const reimported = statBlockSchema.parse(roundTripped.artifacts[0]?.data.statBlock);
    expect(reimported).toEqual(block);
    const chips = mobSpellChips(reimported.spells, mobCasterLevel(reimported.level), new Map());
    expect(chips.map((chip) => chip.libraryName)).toEqual(['Fireball', 'Ignition']);
    expect(chips[0]?.result).toEqual(
      spellAtRank(copiedSpellEntry(reimported.spells?.[0] as MobSpellAssignment), { castRank: 3 }),
    );
  });

  it('copies a spell-less creature byte-identically and skips the corpus read', async () => {
    const { chunkId } = await installLibrary();
    const { db } = await import('@/db/db');
    const creature = await db.chunks.get(chunkId);
    if (creature?.statBlock == null) throw new Error('the fixture chunk must carry a block');
    const mundane: StatBlock = { ...libraryStatBlock(), spells: undefined };
    const { copyCreatureStats } = await import('@/domain/libraryCopy');
    let consulted = false;
    const result = await copyCreatureStats({ chunkId }, 'Mundane', {
      getChunk: () => Promise.resolve({ ...creature, statBlock: mundane }),
      getChunkByContentHash: () => Promise.resolve(undefined),
      getRulebook: () => db.rulebooks.get(creature.bookId),
      spellIndex: () => {
        consulted = true;
        return Promise.resolve(new Map());
      },
    });
    if (result.status !== 'copied') throw new Error('the fixture creature must be copyable');
    expect(result.copy.statBlock.spells).toBeUndefined();
    expect(consulted).toBe(false);
  });

  /**
   * docs/17 row 270 — THE FROZEN BATTLE SEED IS A COPY TOO. `db/battleSeed`
   * freezes the resolved block onto `seedFighters[]` and the battle card reads
   * THAT row (`db/creatureRepo`'s frozen arm), so a seed is a copy by the same
   * rule as every mob row: it must render its spell entries with the library
   * ABSENT. A LEGACY `rulebook` citation is the arm that arrives BARE here (the
   * v24 migration copies what it can; this seed resolves the rest at read
   * time), so the seed stamps the library's entries through the SAME spell seam
   * the copy operation uses (`db/libraryCopy.copyStatBlockSpellsFromDb`).
   *
   * WHAT jsdom CANNOT PROVE: the rendering of the chip (the DOM, the sheet).
   * What it proves is the DATA that render reads — `domain/mobSpells
   * .mobSpellChips` over the frozen block with an EMPTY index answers exactly
   * as over the library's own block, which is the whole property in question.
   */
  it('freezes the library’s spell entry onto a battle seed, so the card answers with the library ABSENT', async () => {
    const { chunkId } = await installLibrary();
    void chunkId;
    const campaign = await createCampaign({ name: 'Seed campaign', system: SYSTEM });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Caster ambush',
      data: encounterDataSchema.parse({
        difficulty: 'medium',
        levelHint: '7',
        monsters: [
          {
            name: 'Nirklex',
            count: 1,
            notes: '',
            treasure: '',
            // A COPIED library caster (docs/17 row 255a): the row owns the
            // block; the frozen seed row carries it to the battle card.
            source: { type: 'inline' as const, statBlock: libraryStatBlock() },
            sourceLine: 'Pathfinder Player Core p.12',
            originToken: `chunk:${chunkId}`,
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      }),
    });

    const { battle } = await seedBattleFromEncounter(campaign.id, newId(), encounter.id);
    const seed = battle.seedFighters[0];
    if (seed?.statBlock == null) throw new Error('the frozen seed row must carry a block');
    const assignment = seed.statBlock.spells?.[0] as MobSpellAssignment;
    expect(copiedSpellEntry(assignment)).toEqual(FIREBALL);

    // THE ACCEPTANCE: delete the WHOLE library — the frozen copy still answers,
    // and the library's own bare block answers nothing over the same index.
    const { db } = await import('@/db/db');
    await db.chunks.clear();
    await db.rulebooks.clear();
    const frozen = mobSpellChips(
      seed.statBlock.spells,
      mobCasterLevel(seed.statBlock.level),
      new Map(),
    );
    expect(frozen.map((chip) => chip.resolved)).toEqual([true, true]);
    expect(frozen.map((chip) => chip.libraryName)).toEqual(['Fireball', 'Ignition']);
    const bare = mobSpellChips(libraryStatBlock().spells, 7, new Map());
    expect(bare.map((chip) => chip.resolved)).toEqual([false, false]);
  });
});
