import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { seedBattleFromEncounter, spawnRosterInstance } from '@/db/battleSeed';
import { ensureBattle, getBattleByModule } from '@/db/battleRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createImage } from '@/db/imageRepo';
import { buildFighterStatsLookup, fighterStatsFromPc } from '@/db/fighterStats';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { createRulebook } from '@/db/rulebookRepo';
import { fighterTokens } from '@/domain/battle/board';
import { stagingBlockRect } from '@/domain/encounterMap/layout';
import type { Artifact, EncounterLayout, Id, StatBlock } from '@/domain';
import { newId, packRooms, placeMonsters, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from './helpers';

/**
 * Seeding a battle from an encounter artifact (09-MILESTONE-5 M5-C): roster
 * expansion (npc-ref / inline / rulebook / statless), map resolution, PC
 * auto-include, and provenance stamping. Map-role images take the bigger
 * intake cap at the intake layer; pickers only offer map-role images.
 */

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 7,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/4',
    proficiency: 2,
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

let campaignId = '';

beforeEach(async () => {
  await clearDatabase();
  campaignId = (await createCampaign({ name: 'Seed campaign', system: 'dnd5e' })).id;
});

async function addPc(name: string): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'pc',
    name,
    data: {
      playerName: '',
      statBlock: statBlock({ hp: 20, abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 10, cha: 10 } }),
      currentHp: 20,
      initiativeOverride: null,
      notes: '',
    },
  });
}

async function addNpc(name: string, withStats: boolean): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'npc',
    name,
    data: {
      appearance: '',
      personality: '',
      statBlock: withStats ? statBlock({ hp: 84 }) : null,
    },
  });
}

interface SeedOptions {
  mapImageId?: Id | null;
  monsters?: { name: string; count: number; source: Record<string, unknown> }[];
  linkLocationId?: Id;
  layout?: EncounterLayout | null;
}

async function addEncounter(over: SeedOptions = {}): Promise<Artifact> {
  return createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Bridge ambush',
    data: {
      difficulty: 'medium',
      levelHint: '3',
      monsters: (over.monsters ?? []).map((monster) => ({
        name: monster.name,
        count: monster.count,
        notes: '',
        source: monster.source,
      })) as never,
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: over.mapImageId ?? null,
      layout: over.layout ?? null,
    },
    links: over.linkLocationId === undefined ? [] : [{ targetId: over.linkLocationId, relation: 'at' }],
  });
}

/** A pack-style statblock chunk to cite (hp 21, dex 14 → initiative +2). */
async function seedGoblinChunk(): Promise<Id> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  const text = 'Goblin Boss, humanoid, agile commander.';
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: ['Goblin Boss'],
      text,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp: 21,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
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
  const { db } = await import('@/db/db');
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

describe('roster expansion', () => {
  it('seeds count tokens per entry with fresh max HP and npc-ref artifacts', async () => {
    const npc = await addNpc('Troll', true);
    const encounter = await addEncounter({
      monsters: [
        { name: 'Troll', count: 1, source: { type: 'npc-ref', artifactId: npc.id } },
        { name: 'Goblin', count: 3, source: { type: 'inline', statBlock: statBlock({ hp: 7 }) } },
      ],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const fighters = fighterTokens(battle.board);
    expect(fighters).toHaveLength(4);
    const troll = fighters.find((token) => token.artifactId === npc.id);
    expect(troll?.currentHp).toBe(84);
    expect(troll?.label).toBe('Troll');
    const goblins = fighters.filter((token) => token.label.startsWith('Goblin'));
    expect(goblins.map((token) => token.label)).toEqual(['Goblin 1', 'Goblin 2', 'Goblin 3']);
    // Inline monsters carry frozen seed stats under synthetic ids.
    expect(battle.seedFighters).toHaveLength(3);
    expect(battle.seedFighters[0]).toMatchObject({ name: 'Goblin 1', maxHp: 7, initiativeBonus: 1 });
    // The lookup resolves seeds and artifacts through ONE interface.
    const stats = buildFighterStatsLookup(battle, await listArtifactsByCampaign(campaignId));
    const firstSeed = battle.seedFighters[0];
    if (firstSeed === undefined) throw new Error('no seed fighters');
    expect(stats(firstSeed.id)?.maxHp).toBe(7);
    expect(stats(npc.id)?.maxHp).toBe(84);
  });

  it('seeds statless entries as HP-less tokens excluded from initiative, reported loudly', async () => {
    const statlessNpc = await addNpc('Wight', false);
    const encounter = await addEncounter({
      monsters: [
        { name: 'Wight', count: 1, source: { type: 'npc-ref', artifactId: statlessNpc.id } },
        { name: 'Mystery beast', count: 2, source: { type: 'none' } },
      ],
    });
    const { battle, statless } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(statless).toEqual([
      'Wight (NPC: Wight)',
      'Mystery beast 1 (no stats)',
      'Mystery beast 2 (no stats)',
    ]);
    const statlessTokens = battle.board.tokens.filter((token) => token.currentHp === null);
    expect(statlessTokens.map((token) => token.label)).toEqual(['Wight', 'Mystery beast 1', 'Mystery beast 2']);
    // Every token is artifact-backed-but-statless or null-backed: no fighter
    // stats resolve for them, so initiative excludes them all.
    const stats = buildFighterStatsLookup(battle, []);
    for (const token of statlessTokens) {
      if (token.artifactId === null) continue;
      expect(stats(token.artifactId)).toBeUndefined();
    }
    expect(battle.seedFighters).toEqual([]);
  });

  it('auto-includes statful PCs row-major at the staging ground', async () => {
    await addPc('Serren');
    await addPc('Mira');
    const npc = await addNpc('Troll', true);
    const encounter = await addEncounter({
      monsters: [{ name: 'Troll', count: 1, source: { type: 'npc-ref', artifactId: npc.id } }],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    // PC tokens exist even while the board is prep scratch (visible: false
    // until Show battle — the source seeding rule for artifact-backed tokens).
    const pcIds = new Set(
      (await listArtifactsByCampaign(campaignId)).filter((row) => row.kind === 'pc').map((row) => row.id),
    );
    const pcTokens = battle.board.tokens.filter((token) => token.artifactId !== null && pcIds.has(token.artifactId));
    expect(pcTokens).toHaveLength(2);
    // Row-major: first column then second column of the 3×3 block.
    const ground = battle.board.stagingGround;
    expect(ground).not.toBeNull();
    const firstPc = pcTokens[0];
    const secondPc = pcTokens[1];
    if (firstPc === undefined || secondPc === undefined) throw new Error('PC tokens missing');
    expect(firstPc.x).toBeLessThan(secondPc.x);
    expect(firstPc.y).toBeCloseTo(secondPc.y, 10);
    // Seeded while the board is still prep scratch: monsters hidden, live false.
    expect(battle.board.live).toBe(false);
    expect(battle.board.tokens.find((token) => token.label === 'Troll')?.visible).toBe(false);
  });

  it('stamps provenance and REPLACES a running battle (stage discarded)', async () => {
    const npc = await addNpc('Troll', true);
    const encounter = await addEncounter({
      monsters: [{ name: 'Troll', count: 1, source: { type: 'npc-ref', artifactId: npc.id } }],
    });
    const moduleId = newId();
    const first = await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    expect(first.battle.encounterArtifactId).toBe(encounter.id);
    // A fresh seed discards any stage snapshot and initiative.
    const second = await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    expect(second.battle.id).toBe(first.battle.id);
    expect(second.battle.board.stage).toBeNull();
    expect(second.battle.board.initiativeOrder).toEqual([]);
  });

  it('seeds generated room placements, room veils, map dimensions and entry-room PCs', async () => {
    const roomA = newId();
    const roomB = newId();
    const monsters = [
      { name: 'Goblin', count: 2, source: { type: 'inline', statBlock: statBlock({ hp: 7 }) } },
      { name: 'Ogre', count: 1, source: { type: 'inline', statBlock: statBlock({ hp: 30 }) } },
    ];
    const layout = packRooms({
      theme: 'Ruined gatehouse',
      aspect: '4:3',
      entryRoomId: roomA,
      rosterCounts: monsters.map((monster) => monster.count),
      rooms: [
        {
          id: roomA,
          name: 'Gate',
          description: '',
          size: 'small',
          monsterIndexes: [],
          adjacentRoomIds: [roomB],
        },
        {
          id: roomB,
          name: 'Barracks',
          description: '',
          size: 'large',
          monsterIndexes: [0, 1],
          adjacentRoomIds: [roomA],
        },
      ],
    });
    await addPc('Serren');
    const encounter = await addEncounter({ monsters, layout });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);

    expect(battle.board.mapLayout).toEqual({ cols: layout.gridW, rows: layout.gridH });
    // Adjudicated fog exception (doc 11): with an entrance the party STARTS
    // in the spawn room, so its fog veil is skipped at seed.
    const spawnRoomOfLayout = layout.rooms.find((room) => room.spawn);
    const expectedVeils = layout.rooms.length - (spawnRoomOfLayout?.entrance !== undefined ? 1 : 0);
    expect(battle.board.veils).toHaveLength(expectedVeils);
    expect(battle.board.veils.every((veil) => veil.kind === 'fog')).toBe(true);
    expect(battle.board.veils.some((veil) => veil.id === spawnRoomOfLayout?.id)).toBe(
      spawnRoomOfLayout?.entrance === undefined,
    );
    const expected = placeMonsters(layout, monsters);
    const npcTokens = battle.board.tokens.filter((token) => token.currentHp !== null);
    expect(npcTokens.map((token) => [token.x, token.y])).toEqual(
      expected.map((placement) => [placement.x, placement.y]),
    );
    expect(npcTokens.every((token) => token.visible)).toBe(true);

    const entry = layout.rooms.find((room) => room.spawn);
    if (entry === undefined) throw new Error('spawn room missing');
    const pc = battle.board.tokens.find((token) => token.currentHp === null && token.artifactId !== null);
    if (pc === undefined) throw new Error('pc token missing');
    // Entrance-anchored staging: the party block is slid to the entrance wall,
    // so PCs fill the STAGING BLOCK inside the spawn room UNION (the border
    // ring included) — no longer pinned to the mobsRect bounds.
    const unionCells = new Set<string>();
    for (const rect of entry.rects) {
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) unionCells.add(`${String(x)},${String(y)}`);
      }
    }
    const pcCell = `${String(Math.floor(pc.x * layout.gridW))},${String(Math.floor(pc.y * layout.gridH))}`;
    expect(unionCells.has(pcCell)).toBe(true);
  });

  it('rejects non-encounter artifacts (loud, no empty seed)', async () => {
    const npc = await addNpc('Troll', true);
    await expect(seedBattleFromEncounter(campaignId, newId(), npc.id)).rejects.toThrow('not an encounter');
  });
});

describe('mob artifact identity (owner-ratified arc)', () => {
  it('shares ONE mob artifact across N same-creature instances with ONE seed row (chunk-resolved stats)', async () => {
    const chunkId = await seedGoblinChunk();
    const encounter = await addEncounter({
      monsters: [{ name: 'Goblin Boss', count: 3, source: { type: 'rulebook', chunkId } }],
    });
    const { battle, statless } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(statless).toEqual([]);
    const fighters = fighterTokens(battle.board);
    expect(fighters.map((token) => token.label)).toEqual([
      'Goblin Boss 1',
      'Goblin Boss 2',
      'Goblin Boss 3',
    ]);
    // ALL instances carry the SAME artifact id — the shared mob artifact.
    const artifactIds = new Set(fighters.map((token) => token.artifactId));
    expect(artifactIds.size).toBe(1);
    const mobArtifactId = fighters[0]?.artifactId;
    expect(mobArtifactId).toBeDefined();
    const mob = await getAnyArtifact(mobArtifactId ?? '');
    expect(mob?.kind).toBe('npc');
    expect(mob?.name).toBe('Goblin Boss');
    if (mob?.kind !== 'npc') throw new Error('not an npc');
    expect(mob.data.monsterChunkId).toBe(chunkId);
    // NO stat duplication: the chunk stays the source of truth.
    expect(mob.data.statBlock).toBeNull();
    // Exactly ONE seed row, keyed by the artifact id, stats from the chunk.
    expect(battle.seedFighters).toHaveLength(1);
    expect(battle.seedFighters[0]).toMatchObject({
      id: mobArtifactId,
      name: 'Goblin Boss',
      maxHp: 21,
      initiativeBonus: 2,
    });
    // Every instance: fresh max HP, initiative resolves through the fallthrough.
    for (const token of fighters) expect(token.currentHp).toBe(21);
    const stats = buildFighterStatsLookup(battle, await listArtifactsByCampaign(campaignId));
    expect(stats(mobArtifactId ?? '')?.maxHp).toBe(21);
    expect(stats(mobArtifactId ?? '')?.initiativeBonus).toBe(2);
  });

  it('retro-fills lazily: an old encounter (no mobArtifactId) converges on the same artifact across seeds', async () => {
    const chunkId = await seedGoblinChunk();
    const encounter = await addEncounter({
      monsters: [{ name: 'Goblin Boss', count: 1, source: { type: 'rulebook', chunkId } }],
    });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    // Pre-marker row: the stored source carries no mobArtifactId.
    expect(encounter.data.monsters[0]?.source).toMatchObject({ type: 'rulebook', chunkId });
    const first = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const second = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const firstId = fighterTokens(first.battle.board)[0]?.artifactId;
    const secondId = fighterTokens(second.battle.board)[0]?.artifactId;
    expect(secondId).toBe(firstId);
    const mobs = (await listArtifactsByCampaign(campaignId)).filter(
      (row) => row.kind === 'npc' && row.data.monsterChunkId === chunkId,
    );
    expect(mobs).toHaveLength(1);
  });

  it('uses the finalize-stamped mobArtifactId verbatim instead of creating another artifact', async () => {
    const chunkId = await seedGoblinChunk();
    const preexisting = await seedGoblinChunkCampaignArtifact(chunkId);
    const encounter = await addEncounter({
      monsters: [
        { name: 'Goblin Boss', count: 2, source: { type: 'rulebook', chunkId, mobArtifactId: preexisting } },
      ],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    for (const token of fighterTokens(battle.board)) {
      expect(token.artifactId).toBe(preexisting);
    }
    expect(battle.seedFighters).toHaveLength(1);
    expect(battle.seedFighters[0]?.id).toBe(preexisting);
    const mobs = (await listArtifactsByCampaign(campaignId)).filter(
      (row) => row.kind === 'npc' && row.data.monsterChunkId === chunkId,
    );
    expect(mobs).toHaveLength(1);
  });

  it('a portrait on the mob artifact is resolvable via coverImageId from the seeded tokens', async () => {
    const chunkId = await seedGoblinChunk();
    const encounter = await addEncounter({
      monsters: [{ name: 'Goblin Boss', count: 2, source: { type: 'rulebook', chunkId } }],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const mobArtifactId = fighterTokens(battle.board)[0]?.artifactId ?? '';
    const portrait = await createImage({
      campaignId,
      blob: new Blob([new Uint8Array([9, 9])], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 64,
      height: 64,
      source: 'uploaded',
    });
    await updateArtifact(mobArtifactId, { imageIds: [portrait.id], coverImageId: portrait.id });
    // The TokenView path: token → artifact → coverImageId → image url. Zero
    // BattleSurface changes — the artifact lookup is the only requirement.
    const mob = await getAnyArtifact(mobArtifactId);
    expect(mob?.coverImageId).toBe(portrait.id);
  });

  it('old seeding shapes are unchanged: inline keeps per-instance rows, a missing chunk stays statless', async () => {
    const chunkId = await seedGoblinChunk();
    const encounter = await addEncounter({
      monsters: [
        { name: 'Goblin', count: 2, source: { type: 'inline', statBlock: statBlock({ hp: 7 }) } },
        { name: 'Vanished', count: 1, source: { type: 'rulebook', chunkId: newId() } },
        { name: 'Real', count: 1, source: { type: 'rulebook', chunkId } },
      ],
    });
    const { battle, statless } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    // Inline: two synthetic ids, two seed rows (per-instance identity kept).
    const goblins = fighterTokens(battle.board).filter((token) => token.label.startsWith('Goblin'));
    expect(new Set(goblins.map((token) => token.artifactId)).size).toBe(2);
    expect(battle.seedFighters.filter((seed) => seed.name.startsWith('Goblin'))).toHaveLength(2);
    // Missing chunk: statless token pointing nowhere — reported loudly.
    expect(statless).toEqual(['Vanished (missing ref)']);
    const vanished = battle.board.tokens.find((token) => token.label === 'Vanished');
    expect(vanished?.artifactId).toBeNull();
    expect(vanished?.currentHp).toBeNull();
    // The statful rulebook entry still retro-fills its mob artifact.
    const real = fighterTokens(battle.board).find((token) => token.label === 'Real');
    expect(real?.artifactId).toBeDefined();
  });
});

/** Creates the mob artifact the way finalize would have stamped it. */
async function seedGoblinChunkCampaignArtifact(chunkId: Id): Promise<Id> {
  return getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
}

describe('map resolution', () => {
  it('uses the encounter’s battlemap, else a linked location’s map-role cover, else no map', async () => {
    // A map-role image via createImage(role: 'map').
    const mapImage = await createImage({
      campaignId,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 100,
      height: 80,
      source: 'uploaded',
      role: 'map',
    });
    const artworkImage = await createImage({
      campaignId,
      blob: new Blob([new Uint8Array([4, 5])], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 100,
      height: 80,
      source: 'uploaded',
    });
    expect(mapImage.role).toBe('map');
    expect(artworkImage.role).toBe('artwork');

    const location = await createArtifact({
      campaignId,
      kind: 'location',
      name: 'Bridge',
      data: { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
    await updateArtifact(location.id, {
      imageIds: [artworkImage.id, mapImage.id],
      coverImageId: mapImage.id,
    });

    const withOwnMap = await addEncounter({ mapImageId: mapImage.id });
    const seededOwn = await seedBattleFromEncounter(campaignId, newId(), withOwnMap.id);
    expect(seededOwn.battle.board.mapImageId).toBe(mapImage.id);

    const viaLocation = await addEncounter({ linkLocationId: location.id });
    const seededVia = await seedBattleFromEncounter(campaignId, newId(), viaLocation.id);
    expect(seededVia.battle.board.mapImageId).toBe(mapImage.id);

    // An ARTWORK-role cover does NOT become a battlemap.
    await updateArtifact(location.id, { coverImageId: artworkImage.id });
    const artworkCover = await addEncounter({ linkLocationId: location.id });
    const seededArtwork = await seedBattleFromEncounter(campaignId, newId(), artworkCover.id);
    expect(seededArtwork.battle.board.mapImageId).toBeNull();

    const mapless = await addEncounter();
    const seededMapless = await seedBattleFromEncounter(campaignId, newId(), mapless.id);
    expect(seededMapless.battle.board.mapImageId).toBeNull();
  });

  it('keeps the battle row reachable by module after seeding', async () => {
    const encounter = await addEncounter();
    const moduleId = newId();
    const { battle } = await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    const byModule = await getBattleByModule(moduleId);
    expect(byModule?.id).toBe(battle.id);
  });
});

describe('pc stats resolution', () => {
  it('derives max HP and initiative bonus from the pc artifact (dex + override)', async () => {
    const pc = await addPc('Serren');
    if (pc.kind !== 'pc') throw new Error('not a pc');
    const updatedData = { ...pc.data, initiativeOverride: 5 };
    await updateArtifact(pc.id, { data: updatedData });
    const stats = fighterStatsFromPc({ ...pc, data: updatedData });
    // dex 16 → +3, override +5.
    expect(stats?.initiativeBonus).toBe(8);
    expect(stats?.maxHp).toBe(20);
    expect(stats?.currentHp).toBe(20);
  });

describe('entrance-anchored staging (adjudicated)', () => {
  function gatehouseLayout(): EncounterLayout {
    const roomA = newId();
    const roomB = newId();
    return packRooms({
      theme: 'Ruined gatehouse',
      aspect: '4:3',
      entryRoomId: roomA,
      rosterCounts: [1],
      rooms: [
        { id: roomA, name: 'Gate', description: '', size: 'small', monsterIndexes: [], adjacentRoomIds: [roomB] },
        { id: roomB, name: 'Barracks', description: '', size: 'large', monsterIndexes: [0], adjacentRoomIds: [roomA] },
      ],
    });
  }

  const monsters = [{ name: 'Goblin', count: 1, source: { type: 'inline', statBlock: statBlock({ hp: 7 }) } }];

  it('anchors the staging block at the entrance wall and stamps board.entrance', async () => {
    const layout = gatehouseLayout();
    const encounter = await addEncounter({ monsters, layout });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const spawn = layout.rooms.find((room) => room.spawn);
    if (spawn === undefined) throw new Error('spawn room missing');
    if (spawn.entrance === undefined) throw new Error('packed layout has no entrance');

    const block = stagingBlockRect(spawn);
    expect(battle.board.stagingGround).toEqual({
      x: (block.x + block.w / 2) / layout.gridW,
      y: (block.y + block.h / 2) / layout.gridH,
      cellWidth: block.w / 3 / layout.gridW,
      cellHeight: block.h / 3 / layout.gridH,
    });
    expect(battle.board.entrance).toEqual({
      x: (spawn.entrance.x + 0.5) / layout.gridW,
      y: (spawn.entrance.y + 0.5) / layout.gridH,
      side: spawn.entrance.side,
    });
    // The block actually MOVED toward the wall: it hugs the entrance axis.
    expect(block).not.toEqual(spawn.mobsRect);
  });

  it('skips the spawn-room fog veil when an entrance exists (adjudicated)', async () => {
    const layout = gatehouseLayout();
    const encounter = await addEncounter({ monsters, layout });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const spawn = layout.rooms.find((room) => room.spawn);
    if (spawn?.entrance === undefined) throw new Error('entrance missing');
    expect(battle.board.veils.some((veil) => veil.id === spawn.id)).toBe(false);
    expect(battle.board.veils).toHaveLength(layout.rooms.length - 1);
    expect(battle.board.veils.every((veil) => veil.id !== spawn.id)).toBe(true);
  });

  it('keeps legacy behavior byte-identical when the layout has no entrance', async () => {
    const packed = gatehouseLayout();
    const legacy: EncounterLayout = {
      ...packed,
      rooms: packed.rooms.map((room) => ({ ...room, entrance: undefined })),
    };
    const encounter = await addEncounter({ monsters, layout: legacy });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const spawn = legacy.rooms.find((room) => room.spawn);
    if (spawn === undefined) throw new Error('spawn room missing');
    expect(battle.board.stagingGround).toEqual({
      x: (spawn.mobsRect.x + spawn.mobsRect.w / 2) / legacy.gridW,
      y: (spawn.mobsRect.y + spawn.mobsRect.h / 2) / legacy.gridH,
      cellWidth: spawn.mobsRect.w / 3 / legacy.gridW,
      cellHeight: spawn.mobsRect.h / 3 / legacy.gridH,
    });
    expect(battle.board.entrance).toBeNull();
    expect(battle.board.veils).toHaveLength(legacy.rooms.length);
  });
});
});

describe('in-battle spawn (encounter-resume arc)', () => {
  it('appends one rulebook instance through the shared path — same mob artifact, label numbering continues, ONE seed row', async () => {
    const chunkId = await seedGoblinChunk();
    const encounter = await addEncounter({
      monsters: [{ name: 'Goblin Boss', count: 3, source: { type: 'rulebook', chunkId } }],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(fighterTokens(battle.board).map((token) => token.label)).toEqual([
      'Goblin Boss 1',
      'Goblin Boss 2',
      'Goblin Boss 3',
    ]);
    const beforeSeedRows = battle.seedFighters.length;
    const report = await spawnRosterInstance(battle.id, 0);
    expect(report.statless).toEqual([]);
    const after = await getBattleByModule(battle.moduleId);
    if (after === undefined) throw new Error('battle missing');
    const fighters = fighterTokens(after.board);
    expect(fighters).toHaveLength(4);
    const spawned = fighters[3];
    if (spawned === undefined) throw new Error('spawned token missing');
    // Numbering continues the on-board count.
    expect(spawned.label).toBe('Goblin Boss 4');
    // Visible on the live board, fresh max HP, SAME shared mob artifact.
    expect(spawned.visible).toBe(true);
    expect(spawned.currentHp).toBe(21);
    expect(spawned.artifactId).toBe(fighters[0]?.artifactId);
    expect(spawned.initiativeRoll).toBeNull();
    // NO stat duplication: the shared seed row is deduped, not duplicated.
    expect(after.seedFighters).toHaveLength(beforeSeedRows);
    const stats = buildFighterStatsLookup(after, await listArtifactsByCampaign(campaignId));
    expect(stats(spawned.artifactId ?? '')?.maxHp).toBe(21);
    // Placement: inside the staging ground region, on the live board.
    expect(spawned.x).toBeGreaterThanOrEqual(0);
    expect(spawned.x).toBeLessThanOrEqual(1);
    expect(spawned.y).toBeGreaterThanOrEqual(0);
    expect(spawned.y).toBeLessThanOrEqual(1);
    // The rest of the board is untouched — spawn appends, never reseeds
    // (everLive is the surface's first-entry act; the repo path leaves it).
    expect(after.board.live).toBe(battle.board.live);
    expect(after.board.everLive).toBe(battle.board.everLive);
    expect(after.board.stage).toEqual(battle.board.stage);
    expect(after.board.tokens.slice(0, 3)).toEqual(battle.board.tokens);
  });

  it('spawns npc-ref instances by reference — no seed-row freeze, stats through the artifact', async () => {
    const npc = await addNpc('Vexra', true);
    const encounter = await addEncounter({
      monsters: [{ name: 'Vexra', count: 1, source: { type: 'npc-ref', artifactId: npc.id } }],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const rowsBefore = battle.seedFighters.length;
    const report = await spawnRosterInstance(battle.id, 0);
    expect(report.statless).toEqual([]);
    const after = await getBattleByModule(battle.moduleId);
    if (after === undefined) throw new Error('battle missing');
    const fighters = fighterTokens(after.board);
    expect(fighters.map((token) => token.label)).toEqual(['Vexra', 'Vexra 2']);
    expect(fighters[1]?.artifactId).toBe(npc.id);
    expect(fighters[1]?.currentHp).toBeGreaterThan(0);
    // npc-ref resolves through the artifact — the battle row never grows.
    expect(after.seedFighters).toHaveLength(rowsBefore);
  });

  it('spawns statless entries as HP-less tokens and reports them loudly', async () => {
    const npc = await addNpc('Wisp', false);
    const encounter = await addEncounter({
      monsters: [{ name: 'Wisp', count: 1, source: { type: 'npc-ref', artifactId: npc.id } }],
    });
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    const report = await spawnRosterInstance(battle.id, 0);
    expect(report.statless).toHaveLength(1);
    const after = await getBattleByModule(battle.moduleId);
    if (after === undefined) throw new Error('battle missing');
    const fighters = fighterTokens(after.board);
    expect(fighters[1]?.label).toBe('Wisp 2');
    expect(fighters[1]?.currentHp).toBeNull();
    expect(fighters[1]?.initiativeRoll).toBeNull();
  });

  it('throws loudly without provenance — a battle with no seeding encounter cannot spawn', async () => {
    const bare = await ensureBattle(campaignId, newId());
    await expect(spawnRosterInstance(bare.id, 0)).rejects.toThrow(
      'This battle has no seeding encounter to spawn from',
    );
  });
});
