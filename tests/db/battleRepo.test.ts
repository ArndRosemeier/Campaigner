import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createArtifact,
  deleteArtifact,
  listArtifactsByCampaign,
  listGlobalArtifacts,
  publishToLibrary,
} from '@/db/artifactRepo';
import {
  deleteBattleIfEmpty,
  ensureBattle,
  getBattleByModule,
  patchBattle,
  resetBattleToStage,
  saveBattleBoard,
} from '@/db/battleRepo';
import { createCampaign } from '@/db/campaignRepo';
import { buildFighterStatsLookup, fighterStatsFromPc, isBattleEmpty } from '@/db/fighterStats';
import { captureStageSnapshot, combatHpForToken, fighterTokens, tokenFromFighter } from '@/domain/battle/board';
import type { BattleToken, FighterStats, FighterStatsLookup, StatBlock } from '@/domain';
import { newId, statBlockSchema } from '@/domain';
import { clearDatabase } from './helpers';

/**
 * Battle persistence (10-MILESTONE-6 M6-E): one live battle per module
 * (lazy create), normalize-on-write (PC tokens ensured, NPC instance HP
 * re-filled/clamped), scrub-on-delete (empty battles delete themselves), and
 * the stage reset path.
 */

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 10,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/2',
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
  campaignId = (await createCampaign({ name: 'Battle campaign', system: 'dnd5e' })).id;
});

async function addPc(name: string, over: Partial<StatBlock> = {}): Promise<string> {
  const pc = await createArtifact({
    campaignId,
    kind: 'pc',
    name,
    data: {
      playerName: '',
      statBlock: statBlock(over),
      currentHp: statBlock(over).hp,
      initiativeOverride: null,
      notes: '',
    },
  });
  return pc.id;
}

async function addNpc(name: string, over: Partial<StatBlock> = {}): Promise<string> {
  // An NPC artifact stores NO current HP — the token instance owns it.
  const npc = await createArtifact({
    campaignId,
    kind: 'npc',
    name,
    data: {
      appearance: '',
      personality: '',
      statBlock: statBlock(over),
    },
  });
  return npc.id;
}

describe('ensureBattle', () => {
  it('lazily creates exactly one empty battle per module', async () => {
    const moduleId = newId();
    const first = await ensureBattle(campaignId, moduleId);
    expect(first.board.live).toBe(false);
    expect(first.board.tokens).toEqual([]);
    expect(first.encounterArtifactId).toBeNull();
    const second = await ensureBattle(campaignId, moduleId);
    expect(second.id).toBe(first.id);
    expect(await getBattleByModule(moduleId)).toBeDefined();
    const other = await ensureBattle(campaignId, newId());
    expect(other.id).not.toBe(first.id);
  });
});

/** The campaign's live artifact rows (what normalizeBattle reads). */
async function campaignArtifacts() {
  return listArtifactsByCampaign(campaignId);
}

/** Looks up stats with a loud failure instead of an assertion. */
function requireStats(lookup: FighterStatsLookup, id: string): FighterStats {
  const stats = lookup(id);
  if (stats === undefined) throw new Error(`No stats for ${id}`);
  return stats;
}

describe('normalize-on-write', () => {
  it('re-ensures a token for every statful PC artifact on every write', async () => {
    const pcId = await addPc('Serren');
    const moduleId = newId();
    const battle = await ensureBattle(campaignId, moduleId);
    expect(fighterTokens(battle.board).map((token) => token.artifactId)).toEqual([pcId]);
    // A second PC joins the party → the next write spawns it too.
    await addPc('Mira');
    const updated = await patchBattle(battle.id, {});
    expect(fighterTokens(updated.board)).toHaveLength(2);
  });

  it('leaves statless PCs unspawned (loud badge upstream, no placeholder)', async () => {
    await createArtifact({
      campaignId,
      kind: 'pc',
      name: 'Statless',
      data: {
        playerName: '',
        statBlock: null,
        currentHp: 0,
        initiativeOverride: null,
        notes: '',
      },
    });
    const battle = await ensureBattle(campaignId, newId());
    expect(battle.board.tokens).toEqual([]);
  });

  it('re-fills null NPC token HP from the artifact and clamps to [0, maxHp]', async () => {
    const npcId = await addNpc('Goblin', { hp: 7 });
    const battle = await ensureBattle(campaignId, newId());
    const token: BattleToken = {
      id: newId(),
      artifactId: npcId,
      label: 'Goblin 1',
      x: 0.5,
      y: 0.5,
      visible: true,
      scale: 1,
      shape: 'portrait',
      color: null,
      currentHp: null,
      initiativeRoll: null,
      initiativeBonus: null,
      conditions: [],
    };
    const saved = await saveBattleBoard(battle.id, {
      ...battle.board,
      tokens: [token, { ...token, id: newId(), currentHp: 99, label: 'Goblin 2' }],
    });
    expect(saved.board.tokens[0]?.currentHp).toBe(7);
    expect(saved.board.tokens[1]?.currentHp).toBe(7);
  });

  it('resolves fighter stats through artifacts and the frozen seed roster', async () => {
    const pcId = await addPc('Serren', { hp: 22 });
    const battle = await ensureBattle(campaignId, newId());
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    // dex 14 → +2 modifier.
    const pc = requireStats(stats, pcId);
    expect(pc.maxHp).toBe(22);
    expect(pc.initiativeBonus).toBe(2);
    expect(pc.currentHp).toBe(22);
    expect(stats(newId())).toBeUndefined();
  });

  it('never writes PC current HP onto the token — the pc artifact owns it', async () => {
    await addPc('Serren');
    const battle = await ensureBattle(campaignId, newId());
    const token = battle.board.tokens[0];
    if (token === undefined) throw new Error('PC token was not spawned');
    expect(token.currentHp).toBeNull();
    const resolved = combatHpForToken(token, buildFighterStatsLookup(battle, await campaignArtifacts()));
    expect(resolved).toEqual({ maxHp: 10, currentHp: 10, ownedBy: 'artifact' });
    const artifactRow = (await campaignArtifacts()).find((row) => row.kind === 'pc');
    if (artifactRow === undefined) throw new Error('PC artifact missing');
    expect(fighterStatsFromPc(artifactRow)?.currentHp).toBe(10);
  });
});

describe('scrub on artifact delete', () => {
  it('removes a deleted NPC’s tokens; the battle survives if PCs remain', async () => {
    const pcId = await addPc('Serren');
    const npcId = await addNpc('Goblin');
    const battle = await ensureBattle(campaignId, newId());
    const npcToken: BattleToken = {
      id: newId(),
      artifactId: npcId,
      label: 'Goblin',
      x: 0.5,
      y: 0.6,
      visible: true,
      scale: 1,
      shape: 'portrait',
      color: null,
      currentHp: 4,
      initiativeRoll: 12,
      initiativeBonus: 2,
      conditions: [],
    };
    await saveBattleBoard(battle.id, { ...battle.board, tokens: [...battle.board.tokens, npcToken] });
    await deleteArtifact(npcId);
    const after = await getBattleByModule(battle.moduleId);
    expect(after?.board.tokens.map((token) => token.artifactId)).toEqual([pcId]);
    expect(after?.board.initiativeOrder).toEqual([]);
  });

  it('deletes the battle when the last fighter token is gone and there is no map', async () => {
    const npcId = await addNpc('Goblin');
    const battle = await ensureBattle(campaignId, newId());
    const token = tokenFromFighter(npcId, { kind: 'npc', name: 'Goblin', maxHp: 7 }, 0, true, null);
    await saveBattleBoard(battle.id, { ...battle.board, tokens: [token] });
    const before = await getBattleByModule(battle.moduleId);
    expect(before !== undefined && !isBattleEmpty(before)).toBe(true);
    await deleteArtifact(npcId);
    expect(await getBattleByModule(battle.moduleId)).toBeUndefined();
  });

});

describe('stage reset', () => {
  it('restores the saved layout against current stats and PC roster', async () => {
    const npcId = await addNpc('Troll', { hp: 84 });
    const battle = await ensureBattle(campaignId, newId());
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    const token = tokenFromFighter(npcId, { kind: 'npc', name: 'Troll', maxHp: 84 }, 0, true, null);
    const opened = await saveBattleBoard(battle.id, {
      ...battle.board,
      live: true,
      tokens: [token],
    });
    const stage = captureStageSnapshot(opened.board);
    await patchBattle(battle.id, { board: { ...opened.board, stage } });
    // Drift: the troll drops to 0 and initiative rolls.
    await saveBattleBoard(battle.id, {
      ...opened.board,
      stage,
      tokens: [{ ...token, currentHp: 0, initiativeRoll: 19, initiativeBonus: 2 }],
      initiativeEnabled: true,
      initiativeOrder: [token.id],
    });
    const reset = await resetBattleToStage(battle.id);
    expect(reset.board.tokens[0]?.currentHp).toBe(84);
    expect(reset.board.tokens[0]?.initiativeRoll).toBeNull();
    expect(reset.board.initiativeEnabled).toBe(false);
    expect(reset.board.live).toBe(true);
    const resetToken = reset.board.tokens[0];
    if (resetToken === undefined) throw new Error('token missing after reset');
    expect(combatHpForToken(resetToken, stats)?.ownedBy).toBe('token');
  });

  it('refuses to reset without a saved stage (loud, no silent reset)', async () => {
    const battle = await ensureBattle(campaignId, newId());
    await expect(resetBattleToStage(battle.id)).rejects.toThrow('No stage snapshot saved');
  });
});

describe('deleteBattleIfEmpty', () => {
  it('keeps battles that still have a map or provenance', async () => {
    const battle = await ensureBattle(campaignId, newId());
    await patchBattle(battle.id, { encounterArtifactId: newId() });
    await deleteBattleIfEmpty(battle.id);
    expect(await getBattleByModule(battle.moduleId)).toBeDefined();
  });

  it('resolves a global library monster and keeps its HP token-owned (10-MILESTONE-6 C)', async () => {
    const monster = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Grix',
      data: {
        appearance: '',
        personality: '',
        statBlock: statBlock({ hp: 21 }),
        initiativeOverride: 2,
      },
    });
    await publishToLibrary(monster.id);

    // Published = global: it left the campaign query but stays resolvable
    // through the merged pool the battle repo uses.
    expect((await campaignArtifacts()).find((row) => row.id === monster.id)).toBeUndefined();
    const globals = await listGlobalArtifacts();
    expect(globals.map((row) => row.id)).toContain(monster.id);
    const battle = await ensureBattle(campaignId, newId());
    const stats = buildFighterStatsLookup(battle, [
      ...(await campaignArtifacts()),
      ...(await listGlobalArtifacts()),
    ]);
    const resolved = stats(monster.id);
    expect(resolved?.maxHp).toBe(21);
    expect(resolved?.initiativeBonus).toBe(2);
  });
});
