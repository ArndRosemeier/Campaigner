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
  applyBattleBoardMap,
  convergeBoardsToRegeneratedMap,
  deleteBattleIfEmpty,
  ensureBattleForEncounter,
  getBattle,
  getBattleByEncounter,
  getBattleForEncounter,
  healBattleBoardMap,
  listBattlesByModule,
  normalizeBattleOnOpen,
  patchBattle,
  resetBattleToStage,
  mutateBattleBoard,
  updateBattle,
} from '@/db/battleRepo';
import type { BattlePatch } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { openEncounterBattle } from '@/features/play/open-encounter-battle';
import { createCampaign } from '@/db/campaignRepo';
import { buildFighterStatsLookup, fighterStatsFromPc, isBattleEmpty } from '@/db/fighterStats';
import { db } from '@/db/db';
import { captureStageSnapshot, combatHpForToken, fighterTokens, tokenFromFighter } from '@/domain/battle/board';
import type { Artifact, Battle, BattleToken, EncounterLayout, FighterStats, FighterStatsLookup, Id, StatBlock } from '@/domain';
import { newId, statBlockSchema } from '@/domain';
import { clearDatabase } from './helpers';
import { adoptionArenaLayout, createMapImage } from '../helpers/battle-map-fixtures';

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
    const saved = await mutateBattleBoard(battle.id, () => ({
      ...battle.board,
      tokens: [token, { ...token, id: newId(), currentHp: 99, label: 'Goblin 2' }],
    }));
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
    await mutateBattleBoard(battle.id, () => ({ ...battle.board, live: true, everLive: true }));
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
    await mutateBattleBoard(battle.id, () => ({ ...battle.board, tokens: [...battle.board.tokens, npcToken] }));
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
    await mutateBattleBoard(battle.id, () => ({ ...opened, stage: captureStageSnapshot(opened) }));

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
    await mutateBattleBoard(battle.id, () => ({ ...battle.board, tokens: [token] }));
    const before = await getBattle(battle.id);
    expect(before !== undefined && !isBattleEmpty(before)).toBe(true);
    await deleteArtifact(npcId);
    expect(await getBattle(battle.id)).toBeUndefined();
  });

});

/**
 * THE BOARD-MUTATION SEAM (docs/17 row 336; owner, verbatim: *"when spawning an
 * authored mob it appears in the scene, but is gone at the next redraw"*).
 *
 * The lost update was structural: `BattleSurface.commit` wrote a board derived
 * from the component's RENDER SNAPSHOT and the repo replaced the row's board
 * wholesale, so any write that landed after that render — the initiative
 * reconcile the spawn itself re-triggers, because the fresh npc artifact
 * changes `stats` — put the OLD token list back. These pins are the repo half:
 * the seam the surface now writes through must apply the caller's mutation to
 * the row read INSIDE its own transaction.
 */
describe('the board-mutation seam (docs/17 row 336)', () => {
  it('applies the mutation to the board read in-transaction — a token written after the caller’s snapshot survives', async () => {
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    // The caller's render snapshot: an EMPTY board.
    const snapshot = battle.board;
    const foreign = geometricToken('Goblin 1');
    const mine = geometricToken('Goblin 2');
    // A foreign writer lands a token AFTER the caller took its snapshot.
    await mutateBattleBoard(battle.id, (board) => ({ ...board, tokens: [foreign] }));
    // The stale caller's own mutation, handed to the seam as a CHANGE rather
    // than as the board it saw: it must land on the row as it is now.
    const saved = await mutateBattleBoard(battle.id, (board) => ({
      ...board,
      tokens: [...board.tokens, mine],
    }));
    expect(saved.board.tokens.map((token) => token.id)).toEqual([foreign.id, mine.id]);
    // The snapshot really was stale — a snapshot-derived write would have saved
    // this empty board over the foreign token (the owner's vanishing mob).
    expect(snapshot.tokens).toEqual([]);
  });

  it('serializes two mutations issued together — the read and the write are ONE transaction, so neither is lost', async () => {
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const first = geometricToken('First');
    const second = geometricToken('Second');
    // Both calls take their read before either writes. A seam that read the row
    // OUTSIDE the transaction (the pre-336 shape) would have both callers see
    // the same board and the later write would erase the earlier token.
    await Promise.all([
      mutateBattleBoard(battle.id, (board) => ({ ...board, tokens: [...board.tokens, first] })),
      mutateBattleBoard(battle.id, (board) => ({ ...board, tokens: [...board.tokens, second] })),
    ]);
    const after = await getBattle(battle.id);
    expect(after?.board.tokens.map((token) => token.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('refuses a whole-board patch at the TYPE level — a snapshot board cannot even be expressed (docs/17 row 336)', () => {
    // The compile tier is the enforcement (GATE_TESTS=0): if `board` is ever
    // put back into `BattlePatch`, the directive below becomes unused and
    // `tsc -b` fails. A comment cannot make that guarantee; this can.
    // @ts-expect-error a board in a plain patch is a snapshot-derived replace
    const patch: BattlePatch = { board: null };
    expect(patch).toBeDefined();
  });

  it('derives a mutation from the CURRENT board — a combined update cannot resurrect a removed token', async () => {
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const doomed = geometricToken('Doomed');
    await mutateBattleBoard(battle.id, () => ({ ...battle.board, tokens: [doomed] }));
    const stale = (await getBattle(battle.id))?.board ?? battle.board;
    // Someone else removes it (a scrub, a delete on another surface).
    await mutateBattleBoard(battle.id, (board) => ({ ...board, tokens: [] }));
    // The stale render's own toggle commits: it must not put the token back.
    const saved = await mutateBattleBoard(battle.id, (board) => ({
      ...board,
      sceneryMovementLocked: !board.sceneryMovementLocked,
    }));
    expect(saved.board.tokens).toEqual([]);
    expect(saved.board.sceneryMovementLocked).not.toBe(stale.sceneryMovementLocked);
  });
});

/** A geometric stamp (no artifact): survives normalize-on-write untouched. */
function geometricToken(label: string): BattleToken {
  return {
    id: newId(),
    artifactId: null,
    label,
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'circle',
    color: '#3366ff',
    currentHp: 10,
    initiativeRoll: null,
    initiativeBonus: null,
    treasure: '',
    conditions: [],
  };
}

describe('stage reset', () => {
  it('restores the saved layout against current stats and PC roster', async () => {
    const npcId = await addNpc('Troll', { hp: 84 });
    const battle = await ensureBattleForEncounter(campaignId, newId(), newId());
    const stats = buildFighterStatsLookup(battle, await campaignArtifacts());
    const token = tokenFromFighter(npcId, { kind: 'npc', name: 'Troll', maxHp: 84 }, 0, true, null);
    const opened = await mutateBattleBoard(battle.id, () => ({
      ...battle.board,
      live: true,
      tokens: [token],
    }));
    const stage = captureStageSnapshot(opened.board);
    await updateBattle(battle.id, () => ({ board: { ...opened.board, stage } }));
    // Drift: the troll drops to 0 and initiative rolls.
    await mutateBattleBoard(battle.id, () => ({
      ...opened.board,
      stage,
      tokens: [{ ...token, currentHp: 0, initiativeRoll: 19, initiativeBonus: 2 }],
      initiativeEnabled: true,
      initiativeOrder: [token.id],
    }));
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

/**
 * A battle adopting the encounter's CURRENT map (docs/17 row 328). The heal
 * covers the owner's repro (a board that went live before its map existed,
 * docs/17 row 325); the explicit apply is the GM's own action on a live board.
 * Both go through the ONE board-map write and neither auto-converges anything.
 */
describe('board-map adoption (docs/17 row 328)', () => {
  async function addEncounterWithMap(
    mapImageId: Id | null,
    encounterLayout: EncounterLayout | null,
  ): Promise<Artifact & { kind: 'encounter' }> {
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Adoption ambush',
      data: {
        difficulty: 'medium',
        levelHint: '', partyLevel: 3,
        monsters: [{ name: 'Cultist', count: 1, notes: '', treasure: '', source: { type: 'inline', statBlock: statBlock({ hp: 22 }) } }],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId,
        layout: encounterLayout,
        preset: 'standard',
        locationKind: 'other',
        siteShape:
          encounterLayout === null || encounterLayout.rooms.length <= 1 ? 'single' : 'complex',
        budgetAdvisory: '',
      },
    });
    if (encounter.kind !== 'encounter') throw new Error('not an encounter');
    return encounter;
  }

  it('HEALS a mapless board ONCE: adopts the map + layout, tokens and veils untouched', async () => {
    const map = await createMapImage(campaignId, 1);
    const encounterLayout = adoptionArenaLayout('4:3');
    const encounter = await addEncounterWithMap(null, encounterLayout);
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(battle.board.mapImageId).toBeNull();
    // The owner's repro (docs/17 row 325): the board went LIVE before its map
    // existed, so the regeneration convergence deliberately skips it.
    await updateBattle(battle.id, () => ({ board: { ...battle.board, live: true, everLive: true } }));
    const before = await getBattle(battle.id);
    if (before === undefined) throw new Error('battle missing');

    const healed = await healBattleBoardMap(battle.id, {
      mapImageId: map,
      mapLayout: { cols: encounterLayout.gridW, rows: encounterLayout.gridH },
    });
    expect(healed).toBe(true);
    const after = await getBattle(battle.id);
    expect(after?.board.mapImageId).toBe(map);
    expect(after?.board.mapLayout).toEqual({
      cols: encounterLayout.gridW,
      rows: encounterLayout.gridH,
    });
    expect(after?.board.tokens).toEqual(before.board.tokens);
    expect(after?.board.veils).toEqual(before.board.veils);
    // The freeze flag is not the heal's business: this is not a re-seed.
    expect(after?.board.everLive).toBe(true);

    // ONCE: a second call applies nothing — the `null` layout is the
    // discriminator that would show a second write.
    const again = await healBattleBoardMap(battle.id, { mapImageId: map, mapLayout: null });
    expect(again).toBe(false);
    expect((await getBattle(battle.id))?.board.mapLayout).toEqual({
      cols: encounterLayout.gridW,
      rows: encounterLayout.gridH,
    });
  });

  it('leaves a board that ALREADY has a map BYTE-IDENTICAL — the heal never touches it', async () => {
    const own = await createMapImage(campaignId, 2);
    const other = await createMapImage(campaignId, 3);
    const encounter = await addEncounterWithMap(own, adoptionArenaLayout('4:3'));
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    expect(battle.board.mapImageId).toBe(own);
    const before = await getBattle(battle.id);

    const healed = await healBattleBoardMap(battle.id, {
      mapImageId: other,
      mapLayout: { cols: 9, rows: 9 },
    });
    expect(healed).toBe(false);
    const after = await getBattle(battle.id);
    expect(after).toEqual(before);
    expect(after?.board.mapImageId).toBe(own);
  });

  it('APPLIES on demand: the explicit action moves map + layout and leaves tokens/veils alone', async () => {
    const mapA = await createMapImage(campaignId, 4);
    const mapB = await createMapImage(campaignId, 5);
    const encounter = await addEncounterWithMap(mapA, adoptionArenaLayout('4:3'));
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    await updateBattle(battle.id, () => ({ board: { ...battle.board, live: true, everLive: true } }));
    const before = await getBattle(battle.id);
    if (before === undefined) throw new Error('battle missing');

    const applied = await applyBattleBoardMap(battle.id, {
      mapImageId: mapB,
      mapLayout: { cols: 28, rows: 16 },
    });
    expect(applied.board.mapImageId).toBe(mapB);
    expect(applied.board.mapLayout).toEqual({ cols: 28, rows: 16 });
    expect(applied.board.tokens).toEqual(before.board.tokens);
    expect(applied.board.veils).toEqual(before.board.veils);
    expect(applied.board.everLive).toBe(true);

    // A missing row is loud, never a silent no-op.
    await expect(
      applyBattleBoardMap(newId(), { mapImageId: mapB, mapLayout: null }),
    ).rejects.toThrow('Battle');
  });

  it('still SKIPS a live board on regeneration — live boards are never auto-converged', async () => {
    const mapA = await createMapImage(campaignId, 6);
    const mapB = await createMapImage(campaignId, 7);
    const encounter = await addEncounterWithMap(mapA, adoptionArenaLayout('4:3'));
    const { battle } = await seedBattleFromEncounter(campaignId, newId(), encounter.id);
    await updateBattle(battle.id, () => ({ board: { ...battle.board, live: true, everLive: true } }));

    const result = await convergeBoardsToRegeneratedMap(encounter.id, {
      mapImageId: mapB,
      mapLayout: { cols: 28, rows: 16 },
    });
    expect(result).toEqual({ converged: 0, liveSkipped: 1 });
    // The rejected option (docs/17 row 328): the ground never moves under
    // tokens mid-play. Only the surface's explicit action may switch it.
    expect((await getBattle(battle.id))?.board.mapImageId).toBe(mapA);
  });
});
