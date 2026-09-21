import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  deleteArtifact,
  listArtifactsByCampaign,
  listGlobalArtifacts,
  publishToLibrary,
} from '@/db/artifactRepo';
import {
  deleteBattleIfEmpty,
  ensureBattleForEncounter,
  getBattle,
  getBattleByEncounter,
  getBattleForEncounter,
  listBattlesByModule,
  normalizeBattleOnOpen,
  patchBattle,
  resetBattleToStage,
  saveBattleBoard,
} from '@/db/battleRepo';
import { openEncounterBattle } from '@/features/play/open-encounter-battle';
import { createCampaign } from '@/db/campaignRepo';
import { buildFighterStatsLookup, fighterStatsFromPc, isBattleEmpty } from '@/db/fighterStats';
import { db } from '@/db/db';
import { captureStageSnapshot, combatHpForToken, fighterTokens, tokenFromFighter } from '@/domain/battle/board';
import type { Artifact, Battle, BattleToken, FighterStats, FighterStatsLookup, StatBlock } from '@/domain';
import { newId, statBlockSchema } from '@/domain';
import { clearDatabase } from './helpers';

/**
 * Battle persistence (10-MILESTONE-6 M6-E; re-keyed by encounter, docs/17 row
 * 254): ONE battle per ENCOUNTER (lazy create — two encounters in one module
 * are two boards), normalize-on-write (PC tokens ensured, NPC instance HP
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

/** A pc artifact with NO stat block — the owner's ordinary new player
 *  (docs/17 row 308): 20 HP by default, an optional own initiative bonus. */
async function addStatelessPc(name: string, initiativeOverride: number | null = null): Promise<string> {
  const pc = await createArtifact({
    campaignId,
    kind: 'pc',
    name,
    data: {
      playerName: '',
      statBlock: null,
      currentHp: 20,
      initiativeOverride,
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

describe('ensureBattleForEncounter', () => {
  it('gives two encounters in ONE module two independent boards, one row each', async () => {
    const moduleId = newId();
    const firstEncounter = newId();
    const secondEncounter = newId();
    const first = await ensureBattleForEncounter(campaignId, moduleId, firstEncounter);
    expect(first.board.live).toBe(false);
    expect(first.board.tokens).toEqual([]);
    expect(first.encounterArtifactId).toBe(firstEncounter);
    // Same encounter again: the SAME row, never a second board.
    const again = await ensureBattleForEncounter(campaignId, moduleId, firstEncounter);
    expect(again.id).toBe(first.id);
    expect((await getBattleByEncounter(firstEncounter))?.id).toBe(first.id);
    // The owner's repro (docs/17 row 254): a second encounter in the SAME
    // module owns its OWN board instead of resolving the first one's.
    const second = await ensureBattleForEncounter(campaignId, moduleId, secondEncounter);
    expect(second.id).not.toBe(first.id);
    expect(second.encounterArtifactId).toBe(secondEncounter);
    expect((await getBattleByEncounter(secondEncounter))?.id).toBe(second.id);
    // Both boards coexist under the one module — the module is not a key.
    expect((await listBattlesByModule(moduleId)).map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect((await getBattleByEncounter(firstEncounter))?.id).toBe(first.id);
  });

  /**
   * Race pin (docs/17 row 254): the arbiter moved from the v16 UNIQUE
   * `&moduleId` index to the readwrite transaction inside
   * `ensureBattleForEncounter`. Two seeds racing for ONE encounter must land on
   * one row: under a bare read-then-put both reads would see an empty table and
   * both puts would materialize a board; IndexedDB serializes the overlapping
   * readwrite transactions, so the loser's read runs after the winner commits
   * and finds its row.
   */
  it('two concurrent seeds for one encounter converge on one battle', async () => {
    const moduleId = newId();
    const encounterId = newId();
    const [first, second] = await Promise.all([
      ensureBattleForEncounter(campaignId, moduleId, encounterId),
      ensureBattleForEncounter(campaignId, moduleId, encounterId),
    ]);
    expect(second.id).toBe(first.id);
    expect(await db.battles.where('encounterArtifactId').equals(encounterId).count()).toBe(1);
  });
});

/**
 * Regression pin (deployed-bundle crash `Cannot read properties of undefined
 * (reading 'find')` on the battle route): a row written by an OLDER app
 * version predates board fields added in later arcs (effects, veils-era
 * stamps, mapLayout, entrance, everLive, reseed, token treasure). Reads are
 * the legacy-row boundary: every repo getter parse-normalizes, so the zod
 * schema's `.default(...)` values materialize instead of handing the UI
 * `undefined` arrays.
 */
describe('legacy rows (parse-normalize on read)', () => {
  /** The oldest battle row shape that can exist (M5-B board on an M6-E row:
   * the v12 session migration re-anchored/cleared everything older). */
  function legacyRow(moduleId: string) {
    const stamp = Date.now();
    return {
      id: newId(),
      createdAt: stamp,
      updatedAt: stamp,
      campaignId,
      moduleId,
      encounterArtifactId: null,
      seedFighters: [],
      board: {
        mapImageId: null,
        live: false,
        tokens: [
          {
            id: newId(),
            artifactId: null,
            label: 'Brazier stamp',
            x: 0.5,
            y: 0.5,
            visible: true,
            scale: 1,
            shape: 'square',
            color: '#ff0000',
            currentHp: null,
            initiativeRoll: null,
            initiativeBonus: null,
            conditions: [],
            // NO `treasure` — added in a later arc.
          },
        ],
        veils: [],
        gridSize: 72,
        tokenSize: 64,
        sceneryMovementLocked: false,
        initiativeEnabled: false,
        initiativeOrder: [],
        activeIndex: 0,
        stage: null,
        stagingGround: null,
        // NO `mapLayout`, `everLive`, `effects`, `entrance` — later arcs.
      },
      // NO `reseed` — added in a later arc.
    };
  }

  /** Stores the row RAW: the missing keys are the point (a pre-arc write). */
  async function putLegacyRow(moduleId: string): Promise<string> {
    const row = legacyRow(moduleId);
    await db.battles.put(row as unknown as Battle);
    return row.id;
  }

  it('materializes later-arc fields with their schema defaults on read', async () => {
    const moduleId = newId();
    const id = await putLegacyRow(moduleId);
    const battle = await getBattle(id);
    expect(battle).toBeDefined();
    expect(battle?.board.effects).toEqual([]);
    expect(battle?.board.entrance).toBeNull();
    expect(battle?.board.mapLayout).toBeNull();
    expect(battle?.board.everLive).toBe(false);
    expect(battle?.reseed).toBeNull();
    expect(battle?.board.tokens[0]?.treasure).toBe('');
    expect(battle?.board.tokens[0]?.conditions).toEqual([]);
  });

  it('persists the materialized defaults back on the next write', async () => {
    const moduleId = newId();
    const row = legacyRow(moduleId);
    await db.battles.put(row as unknown as Battle);
    const battle = await getBattle(row.id);
    if (battle === undefined) throw new Error('legacy row vanished');
    await patchBattle(battle.id, {});
    const stored = await db.battles.get(battle.id);
    expect(stored?.board.effects).toEqual([]);
    expect(stored?.board.entrance).toBeNull();
    expect(stored?.board.tokens[0]?.treasure).toBe('');
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
  it('re-ensures a token for every PC artifact on every write', async () => {
    const pcId = await addPc('Serren');
    const moduleId = newId();
    const battle = await ensureBattleForEncounter(campaignId, moduleId, newId());
    expect(fighterTokens(battle.board).map((token) => token.artifactId)).toEqual([pcId]);
    // A second PC joins the party → the next write spawns it too.
    await addPc('Mira');
    const updated = await patchBattle(battle.id, {});
    expect(fighterTokens(updated.board)).toHaveLength(2);
  });

  /**
   * INVERTED at docs/17 row 308 (superseding docs/09 M5-C step 4): this pin
   * used to read "leaves statless PCs unspawned (loud badge upstream, no
   * placeholder)" — the behavior the owner's rule REVERSES. Every campaign
   * player is in every battle, always; a stat block is not required, and no
   * stat is invented for a fighter the app is not tracking.
   */
  it('spawns a token for a STATLESS PC too — no stat block required (docs/17 row 308)', async () => {
    const statlessId = await addStatelessPc('Statless');
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    expect(battle.board.tokens.map((token) => token.label)).toEqual(['Statless']);
    const token = battle.board.tokens[0];
    if (token === undefined) throw new Error('statless PC token was not spawned');
    expect(token.artifactId).toBe(statlessId);
    // The artifact owns the PC's HP; the token never carries an instance HP.
    expect(token.currentHp).toBeNull();
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    // Its maximum is UNKNOWN (null) and its bonus is exactly the artifact's
    // own override (0 here) — never an invented 0-max or a made-up dex.
    expect(requireStats(stats, statlessId)).toEqual({
      kind: 'pc',
      name: 'Statless',
      maxHp: null,
      initiativeBonus: 0,
      currentHp: 20,
    });
  });

  it('re-fills null NPC token HP from the artifact and clamps to [0, maxHp]', async () => {
    const npcId = await addNpc('Goblin', { hp: 7 });
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
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
      treasure: '',
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
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    // dex 14 → +2 modifier.
    const pc = requireStats(stats, pcId);
    expect(pc.maxHp).toBe(22);
    expect(pc.initiativeBonus).toBe(2);
    expect(pc.currentHp).toBe(22);
    expect(stats(newId())).toBeUndefined();
  });

  /**
   * The battle initiative reads the STORED d20 SCORE (docs/12 §5, docs/17 row
   * 95): a Pathfinder 2e creature's dexterity is stored as `10 + 2·mod` by the
   * importer, so `abilityModifier(score)` is the app's one formula applied to
   * the score — never to the printed modifier it was derived from.
   *
   * Revert-proof: apply the formula to the MODIFIER instead (dex 18 → printed
   * +4 → floor((4 - 10) / 2) = -3) and this reads -3.
   */
  it("derives a Pathfinder 2e fighter's initiative from the stored score, not its printed modifier", async () => {
    const npcId = await addNpc('Wolf', {
      system: 'pathfinder2e',
      // The real Monster Core Wolf: Str +2, Dex +4, Con +1, Int -4, Wis +2, Cha -2.
      abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
    });
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    expect(requireStats(stats, npcId).initiativeBonus).toBe(4);
  });

  it('never writes PC current HP onto the token — the pc artifact owns it', async () => {
    await addPc('Serren');
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
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

describe('the OPEN-path trigger of the PC-token seam (docs/17 row 308)', () => {
  async function addEncounter(): Promise<Artifact & { kind: 'encounter' }> {
    const encounter = await createArtifact({ campaignId, kind: 'encounter', name: 'Ford ambush' });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    return encounter;
  }

  it('adds players created AFTER the board went live — and the plain READ adds nothing', async () => {
    const moduleId = newId();
    const encounter = await addEncounter();
    const battle = await ensureBattleForEncounter(campaignId, moduleId, encounter.id);
    // The board is on the table (the surface's mount write); only THEN do the
    // players appear — the case a plain open used to miss entirely.
    await saveBattleBoard(battle.id, { ...battle.board, live: true, everLive: true });
    const statfulId = await addPc('Serren');
    const statlessId = await addStatelessPc('Statless');

    // A READ STAYS A READ: the one encounter→battle resolver adds nothing.
    const readOnly = await getBattleForEncounter(campaignId, encounter.id);
    expect(fighterTokens(readOnly?.board ?? battle.board)).toEqual([]);

    // The OPEN seam writes them through the ONE normalize-on-write, and names
    // the battle's own key (the campaign-owned encounter).
    const key = await openEncounterBattle({ campaignId, moduleId, encounter });
    expect(key).toBe(encounter.id);
    const opened = await getBattle(battle.id);
    expect(fighterTokens(opened?.board ?? battle.board).map((token) => token.artifactId).sort()).toEqual(
      [statfulId, statlessId].sort(),
    );
  });

  it('writes NOTHING when the board already holds every player — an unchanged open is a read', async () => {
    await addPc('Serren'); // present BEFORE the board exists
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    expect(fighterTokens(battle.board)).toHaveLength(1);
    const put = vi.spyOn(db.battles, 'put');
    try {
      const reopened = await normalizeBattleOnOpen(battle.id);
      expect(put).not.toHaveBeenCalled();
      expect(fighterTokens(reopened?.board ?? battle.board)).toHaveLength(1);
    } finally {
      put.mockRestore();
    }
  });
});

describe('scrub on artifact delete', () => {
  it('removes a deleted NPC’s tokens; the battle survives if PCs remain', async () => {
    const pcId = await addPc('Serren');
    const npcId = await addNpc('Goblin');
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
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
      treasure: '',
      conditions: [],
    };
    await saveBattleBoard(battle.id, { ...battle.board, tokens: [...battle.board.tokens, npcToken] });
    await deleteArtifact(npcId);
    const after = await getBattle(battle.id);
    expect(after?.board.tokens.map((token) => token.artifactId)).toEqual([pcId]);
    expect(after?.board.initiativeOrder).toEqual([]);
  });

  it('scrubs the STAGE snapshot too — no dangling token in EITHER carrier (docs/17 row 263)', async () => {
    const pcId = await addPc('Serren');
    const npcId = await addNpc('Goblin');
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
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
      treasure: '',
      conditions: [],
    };
    // `⚑ Set stage` snapshots the LIVE tokens, so the stage carries the same
    // reference one revision later.
    const opened: Battle['board'] = {
      ...battle.board,
      tokens: [...battle.board.tokens, npcToken],
    };
    await saveBattleBoard(battle.id, { ...opened, stage: captureStageSnapshot(opened) });

    await deleteArtifact(npcId);

    const after = await getBattle(battle.id);
    expect(after?.board.tokens.map((token) => token.artifactId)).toEqual([pcId]);
    // The defect: the live list was scrubbed but the stage snapshot was not, so
    // a Reset would put the deleted artifact's token back on the board.
    expect(after?.board.stage?.tokens.map((token) => token.artifactId)).toEqual([pcId]);
  });

  it('deletes a board that empties to nothing and has no provenance', async () => {
    const npcId = await addNpc('Goblin');
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    // The empty rule is about a board with NOTHING left — no fighters, no map
    // and no owning encounter. A board that still names its encounter is that
    // encounter's board and is never auto-deleted (docs/18 §5).
    await patchBattle(battle.id, { encounterArtifactId: null });
    const token = tokenFromFighter(npcId, { kind: 'npc', name: 'Goblin', maxHp: 7 }, 0, true, null);
    await saveBattleBoard(battle.id, { ...battle.board, tokens: [token] });
    const before = await getBattle(battle.id);
    expect(before !== undefined && !isBattleEmpty(before)).toBe(true);
    await deleteArtifact(npcId);
    expect(await getBattle(battle.id)).toBeUndefined();
  });

});

describe('stage reset', () => {
  it('restores the saved layout against current stats and PC roster', async () => {
    const npcId = await addNpc('Troll', { hp: 84 });
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
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
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    await expect(resetBattleToStage(battle.id)).rejects.toThrow('No stage snapshot saved');
  });
});

describe('deleteBattleIfEmpty', () => {
  it('keeps battles that still have a map or provenance', async () => {
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    await patchBattle(battle.id, { encounterArtifactId: newId() });
    await deleteBattleIfEmpty(battle.id);
    expect(await getBattle(battle.id)).toBeDefined();
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
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const stats = buildFighterStatsLookup(battle, [
      ...(await campaignArtifacts()),
      ...(await listGlobalArtifacts()),
    ]);
    const resolved = stats(monster.id);
    expect(resolved?.maxHp).toBe(21);
    expect(resolved?.initiativeBonus).toBe(2);
  });
});
