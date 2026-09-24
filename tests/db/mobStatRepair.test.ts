import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getBattle, mutateBattleBoard } from '@/db/battleRepo';
import { seedBattleFromEncounter, spawnRosterInstance } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { buildFighterStatsLookup } from '@/db/fighterStats';
import { repairStatlessMobsForBattle } from '@/db/mobStatRepair';
import { createRulebook } from '@/db/rulebookRepo';
import { combatHpForToken } from '@/domain/battle/board';
import { initiativeTotal, rollTokenInitiative } from '@/domain/battle/initiative';
import { ruleChunkSchema, stampNewEntity, statBlockSchema, newId, libraryCreatureKey } from '@/domain';
import type { Id, MonsterEntry } from '@/domain';
import { buildMobPickEntry } from '@/features/play/battle/spawn-picker-logic';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase, encounterDataFixture } from './helpers';

// The repair's spawn-side siblings toast on promotion; keep the DB suite quiet.
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

/**
 * THE CLEAN-CUT ROSTER REPAIR (docs/17 row 349).
 *
 * The owner's report, verbatim: *"Spawned mobs say they don't have combat
 * attributes although they do have them. So initiative and damaging does not
 * work. These were standard core mobs"*. The purge (`db/cleanCut`) rewrote a
 * roster entry that CITED a library creature into a NAME-ONLY entry
 * (`{ type: 'none' }`), so the creature's numbers were gone from the row even
 * though the library still holds them.
 *
 * The pins below hold the owner's decision (A) — heal the ROW by COPYING the
 * library block onto it, never by pointing at it:
 *  - the healed entry IS the entry the SPAWN path builds (a DIFFERENTIAL against
 *    `buildMobPickEntry`, so two shapes cannot appear);
 *  - an already-statful entry and its whole artifact row are BYTE-IDENTICAL
 *    after a pass;
 *  - an unresolvable name stays name-only and is NAMED in the report;
 *  - a second pass writes nothing;
 *  - and the journey the owner reported works end to end: the frozen statless
 *    token gains a seed row, rolls initiative and takes damage, while its
 *    position and conditions do not move.
 */

let campaignId = '';

beforeEach(async () => {
  await clearDatabase();
  campaignId = (await createCampaign({ name: 'Repair campaign', system: 'dnd5e' })).id;
});

/** The library creature a roster row names: its block is the numbers the purge
 *  dropped (hp 21, dex 14 ⇒ initiative +2 at the fixture's `statBlock` shape). */
async function seedCreatureChunk(name: string, hp: number, dex: number): Promise<Id> {
  const book = await createRulebook({
    title: 'Bestiary',
    system: 'dnd5e',
    filename: 'bestiary.pdf',
  });
  const text = `${name}, humanoid, agile commander.`;
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: [name],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex, con: 10, int: 10, wis: 8, cha: 8 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('the fixture chunk was not stored');
  return chunk.id;
}

/** One encounter whose roster is exactly the entries the test hands in. */
async function addEncounter(monsters: unknown[]) {
  return createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: encounterDataFixture(monsters) as never,
  });
}

/** The stored roster entry at `index`, through the artifact read seam. */
async function storedEntry(encounterId: Id, index = 0): Promise<MonsterEntry | undefined> {
  const artifact = await getArtifact(encounterId);
  if (artifact?.kind !== 'encounter') return undefined;
  return artifact.data.monsters[index];
}

/** The library block of a fixture chunk, for building an already-statful row. */
async function blockOf(chunkId: Id) {
  const chunk = await db.chunks.get(chunkId);
  if (chunk?.statBlock == null) throw new Error('the fixture chunk carries no block');
  return chunk.statBlock;
}

describe('the clean-cut roster repair (docs/17 row 349)', () => {
  it('heals a name-only row into EXACTLY the entry the spawn path builds', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, notes: '', treasure: '', source: { type: 'none' } },
    ]);

    const report = await repairStatlessMobsForBattle(
      (await seedBattleFromEncounter(campaignId, newId(), encounter.id)).battle.id,
    );

    expect(report.healed).toEqual(['Goblin Boss']);
    expect(report.unresolved).toEqual([]);
    // THE DIFFERENTIAL: the repaired entry and the spawn pick's entry for the
    // same library creature are IDENTICAL — one shape, two callers.
    expect(await storedEntry(encounter.id)).toEqual(await buildMobPickEntry(chunkId, 'Goblin Boss'));
  });

  it('writes the copy’s stamped origin line and opaque token onto the healed row', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    await repairStatlessMobsForBattle(
      (await seedBattleFromEncounter(campaignId, newId(), encounter.id)).battle.id,
    );

    const entry = await storedEntry(encounter.id);
    // ASSERTED AGAINST THE LIBRARY'S OWN FACTS, not against the builder: the
    // spawn path and the repair now share that builder, so a builder-vs-builder
    // differential is BLIND to a field the builder itself drops. These three
    // facts come from the fixture and the identity seam.
    expect(entry?.source.type === 'inline' ? entry.source.statBlock.hp : null).toBe(21);
    expect(entry?.sourceLine).toBe('Bestiary p.12');
    expect(entry?.originToken).toBe(libraryCreatureKey(chunkId));
  });

  it('never rewrites the row’s own name, count, notes or treasure', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      {
        name: 'Goblin Boss',
        count: 3,
        notes: 'keeps the loot',
        treasure: 'a jade ring',
        source: { type: 'none' },
      },
    ]);

    await repairStatlessMobsForBattle(
      (await seedBattleFromEncounter(campaignId, newId(), encounter.id)).battle.id,
    );

    const built = await buildMobPickEntry(chunkId, 'Goblin Boss');
    expect(await storedEntry(encounter.id)).toEqual({
      name: 'Goblin Boss',
      count: 3,
      notes: 'keeps the loot',
      treasure: 'a jade ring',
      source: built.source,
      sourceLine: built.sourceLine,
      originToken: built.originToken,
    });
  });

  it('leaves an already-statful roster entry BYTE-IDENTICAL while healing the name-only one', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', 21, 14);
    await seedCreatureChunk('Hobgoblin', 15, 12);
    const statBlock = await blockOf(chunkId);
    // An AUTHORED inline block — the arm that must NEVER be replaced by the
    // library's copy (it is the campaign's own numbers, and it differs from the
    // library's hp on purpose so a rewrite cannot pass unnoticed).
    const statfulEntry = {
      name: 'Goblin Boss',
      count: 2,
      notes: 'the chief’s own guard',
      treasure: 'a jade ring',
      source: { type: 'inline', statBlock: { ...statBlock, hp: 30 } },
    };
    const encounter = await addEncounter([
      statfulEntry,
      { name: 'Hobgoblin', count: 1, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);

    const report = await repairStatlessMobsForBattle(battle.id);

    // The pass RAN (the name-only row was healed)…
    expect(report.healed).toEqual(['Hobgoblin']);
    expect((await storedEntry(encounter.id, 1))?.source.type).toBe('inline');
    // …and the already-statful entry is untouched, BYTE for byte.
    expect(JSON.stringify(await storedEntry(encounter.id, 0))).toBe(
      JSON.stringify(statfulEntry),
    );
  });

  it('keeps an unresolvable name name-only and NAMES it in the report', async () => {
    const encounter = await addEncounter([
      { name: 'Void Lurker', count: 2, notes: '', treasure: '', source: { type: 'none' } },
    ]);

    const report = await repairStatlessMobsForBattle(
      (await seedBattleFromEncounter(campaignId, newId(), encounter.id)).battle.id,
    );

    expect(report.healed).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.name).toBe('Void Lurker');
    // The seam's OWN sentence, naming the fact — never an invented creature.
    expect(report.unresolved[0]?.reason).toContain('holds no creature of that name');
    expect(await storedEntry(encounter.id)).toEqual({
      name: 'Void Lurker',
      count: 2,
      notes: '',
      treasure: '',
      source: { type: 'none' },
    });
  });

  it('is idempotent: a second pass changes nothing', async () => {
    await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 2, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    await repairStatlessMobsForBattle(battle.id);
    const artifactAfterFirst = JSON.stringify(await getArtifact(encounter.id));
    const battleAfterFirst = JSON.stringify(await getBattle(battle.id));

    const second = await repairStatlessMobsForBattle(battle.id);

    expect(second).toEqual({ healed: [], unresolved: [], tokensHealed: [] });
    expect(JSON.stringify(await getArtifact(encounter.id))).toBe(artifactAfterFirst);
    expect(JSON.stringify(await getBattle(battle.id))).toBe(battleAfterFirst);
  });
});

describe('the battle the owner reported (docs/17 row 349)', () => {
  it('gives the frozen statless tokens a seed row, initiative and damage', async () => {
    const chunkId = await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 2, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    const seeded = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(seeded.statless).toEqual(['Goblin Boss 1 (no stats)', 'Goblin Boss 2 (no stats)']);
    const before = seeded.battle.board.tokens.map((token) => ({
      id: token.id,
      x: token.x,
      y: token.y,
      conditions: token.conditions,
    }));

    const report = await repairStatlessMobsForBattle(seeded.battle.id);

    expect(report.tokensHealed).toEqual(['Goblin Boss 1', 'Goblin Boss 2']);
    const healed = await getBattle(seeded.battle.id);
    if (healed === undefined) throw new Error('the battle vanished');
    const stats = buildFighterStatsLookup(healed, await listArtifactsByCampaign(campaignId));
    // ONE seed row for the creature identity, shared by both instances — what a
    // fresh seed of the whole group freezes.
    expect(healed.seedFighters).toHaveLength(1);
    expect(healed.seedFighters[0]?.maxHp).toBe(21);
    expect(healed.seedFighters[0]?.initiativeBonus).toBe(2);
    expect(healed.seedFighters[0]?.creatureKey).toBe(`chunk:${chunkId}`);
    expect(healed.seedFighters[0]?.statBlock?.hp).toBe(21);
    expect(healed.board.tokens.map((token) => token.artifactId)).toEqual([
      healed.seedFighters[0]?.id,
      healed.seedFighters[0]?.id,
    ]);
    for (const token of healed.board.tokens) {
      // THE BADGE PREDICATE: `BattleSurface` badges a token exactly when this is
      // null ("No combat stats — excluded from initiative").
      const resolved = combatHpForToken(token, stats);
      expect(resolved).toEqual({ maxHp: 21, currentHp: 21, ownedBy: 'token' });
      // IT ROLLS: the bonus is frozen onto the token at roll time.
      const rolled = rollTokenInitiative(token, stats);
      expect(rolled.initiativeBonus).toBe(2);
      expect(initiativeTotal(rolled)).not.toBeNull();
    }
    // NOTHING ELSE MOVED: positions and conditions are the frozen ones.
    expect(
      healed.board.tokens.map((token) => ({
        id: token.id,
        x: token.x,
        y: token.y,
        conditions: token.conditions,
      })),
    ).toEqual(before);
  });

  it('lets HP change on a healed token (damage works on the board)', async () => {
    await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    const seeded = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    await repairStatlessMobsForBattle(seeded.battle.id);
    const healed = await getBattle(seeded.battle.id);
    if (healed === undefined) throw new Error('the battle vanished');
    const target = healed.board.tokens[0];
    if (target === undefined) throw new Error('the fixture seeded no token');

    // The surface's own NPC damage arm: NPCs own current HP on the token, and
    // the write goes through the ONE board-mutation seam.
    await mutateBattleBoard(seeded.battle.id, (board) => ({
      ...board,
      tokens: board.tokens.map((token) =>
        token.id === target.id ? { ...token, currentHp: 16 } : token,
      ),
    }));

    const after = await getBattle(seeded.battle.id);
    const stats = buildFighterStatsLookup(after ?? healed, await listArtifactsByCampaign(campaignId));
    const damaged = after?.board.tokens[0];
    if (damaged === undefined) throw new Error('the token vanished');
    expect(combatHpForToken(damaged, stats)).toEqual({
      maxHp: 21,
      currentHp: 16,
      ownedBy: 'token',
    });
  });

  it('makes a spawn from the healed roster statful too', async () => {
    await seedCreatureChunk('Goblin Boss', 21, 14);
    const encounter = await addEncounter([
      { name: 'Goblin Boss', count: 1, notes: '', treasure: '', source: { type: 'none' } },
    ]);
    const seeded = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    await repairStatlessMobsForBattle(seeded.battle.id);

    const spawn = await spawnRosterInstance(seeded.battle.id, 0);

    expect(spawn.statless).toEqual([]);
    const after = await getBattle(seeded.battle.id);
    const spawned = after?.board.tokens.at(-1);
    if (spawned === undefined) throw new Error('no token was spawned');
    const stats = buildFighterStatsLookup(after ?? seeded.battle, await listArtifactsByCampaign(campaignId));
    expect(combatHpForToken(spawned, stats)?.currentHp).toBe(21);
  });
});
