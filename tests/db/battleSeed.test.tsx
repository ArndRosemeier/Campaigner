import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { getBattleByModule } from '@/db/battleRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { buildFighterStatsLookup, fighterStatsFromPc } from '@/db/fighterStats';
import { fighterTokens } from '@/domain/battle/board';
import type { Artifact, EncounterLayout, Id, StatBlock } from '@/domain';
import { newId, packRooms, placeMonsters, statBlockSchema } from '@/domain';
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
      role: '',
      appearance: '',
      personality: '',
      motivation: '',
      secrets: '',
      voiceNotes: '',
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
    expect(battle.board.veils).toHaveLength(layout.rooms.length);
    expect(battle.board.veils.every((veil) => veil.kind === 'fog')).toBe(true);
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
    expect(pc.x).toBeGreaterThanOrEqual(entry.mobsRect.x / layout.gridW);
    expect(pc.x).toBeLessThanOrEqual((entry.mobsRect.x + entry.mobsRect.w) / layout.gridW);
    expect(pc.y).toBeGreaterThanOrEqual(entry.mobsRect.y / layout.gridH);
    expect(pc.y).toBeLessThanOrEqual((entry.mobsRect.y + entry.mobsRect.h) / layout.gridH);
  });

  it('rejects non-encounter artifacts (loud, no empty seed)', async () => {
    const npc = await addNpc('Troll', true);
    await expect(seedBattleFromEncounter(campaignId, newId(), npc.id)).rejects.toThrow('not an encounter');
  });
});

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
});
