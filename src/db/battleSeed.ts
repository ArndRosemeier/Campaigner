import type { AnyArtifact, Battle, BattleToken, BattleVeil, Id, MonsterEntry, SeedFighter } from '@/domain';
import { GRID_SIZE_DEFAULT, newId, placeMonsters, spawnRoom, veilsFromRooms } from '@/domain';
import {
  ensurePcTokens,
  fallbackSpawnPoint,
  spawnPointInStagingGround,
  stagingGroundAt,
  tokenFromFighter,
} from '@/domain/battle/board';
import { stagingBlockRect } from '@/domain/encounterMap/layout';
import { abilityModifier } from '@/domain/statblock';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';
import { getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import {
  ensureBattle,
  getBattle,
  getBattleByModule,
  patchBattle,
  saveBattleBoard,
} from '@/db/battleRepo';
import { pcFightersOf } from '@/db/fighterStats';
import { getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';

/**
 * Seeding a battle from an encounter artifact (09-MILESTONE-5 M5-C):
 * "Run battle" expands the designed roster into portrait tokens, resolves
 * the battlemap, and hands the board to the table surface (live: false
 * until the table opens). One live battle per module — seeding an already
 * running battle REPLACES it (the UI confirms; the stage snapshot is
 * discarded).
 *
 * Mob artifacts (owner-ratified): every statful rulebook entry shares ONE
 * npc artifact keyed by its cited chunk across all instances, frozen with a
 * single seedFighters row; entries written before `mobArtifactId` existed
 * retro-fill their artifact here via the shared get-or-create (idempotent).
 *
 * Loud-by-contract (AGENTS rule 1): roster entries without stats seed as
 * tokens WITHOUT HP that are excluded from initiative; the report lists them
 * so the UI can badge them. No placeholder numbers anywhere.
 */

/**
 * Staging ground used before the board has a real pixel size: normalized
 * center, one default grid cell of 3×3 spawn block. The table surface
 * re-captures real geometry when it mounts (M5-D).
 */
function defaultStagingGround(): ReturnType<typeof stagingGroundAt> {
  return stagingGroundAt(0.5, 0.5, 1000, 1000, GRID_SIZE_DEFAULT);
}

/**
 * The battle's map (M5-C step 2): the encounter's designed battlemap, else
 * the cover of a linked location when that cover is map-role, else no map
 * (viewport board — the source behavior for mapless encounters).
 */
async function resolveMapImageId(
  encounter: AnyArtifact & { kind: 'encounter' },
): Promise<Id | null> {
  if (encounter.data.mapImageId !== null) {
    return encounter.data.mapImageId;
  }
  const linked = await db.artifacts.bulkGet(encounter.links.map((link) => link.targetId));
  for (const artifact of linked) {
    if (artifact?.kind !== 'location') continue;
    if (artifact.coverImageId === null) continue;
    const image = await db.images.get(artifact.coverImageId);
    if (image?.role === 'map') {
      return artifact.coverImageId;
    }
  }
  return null;
}

export interface SeedReport {
  battle: Battle;
  /** Roster entries that seeded tokens without stats ("Goblin 2 (missing ref)"). */
  statless: string[];
}

export interface RosterExpansion {
  tokens: BattleToken[];
  /** Frozen stat rows to merge into the battle row (deduped by id). */
  seedFighters: SeedFighter[];
  /** Labels expanded without stats ("Goblin 2 (missing ref)") — loud badge. */
  statless: string[];
}

export interface RosterExpansionOptions {
  /** Token visibility (seed: layout presence; in-battle spawn: the live board). */
  visible: boolean;
  /**
   * Placement per instance (1-based instanceIndex). Seeding resolves layout
   * room cells (and throws when a layout lacks one); in-battle spawn hands
   * the next staging-ground cell. Returning undefined falls back to the
   * cascade layout.
   */
  placeAt: (monsterIndex: number, instanceIndex: number) => { x: number; y: number } | undefined;
  /** 1-based label numbering start (in-battle spawn continues the count). */
  numberFrom?: number;
  /** Always suffix the label with its number (spawned single instances). */
  forceNumbering?: boolean;
}

/**
 * Roster → tokens + frozen seed rows (M5-C step 3). THE identity rules live
 * here and are shared by seeding and in-battle spawn: npc-ref entries resolve
 * through the real artifact; rulebook entries share ONE mob artifact per
 * cited chunk with ONE seed row (get-or-create is idempotent); inline entries
 * freeze per-instance synthetic rows; statless entries produce HP-less
 * tokens excluded from initiative and are reported loudly (AGENTS rule 1).
 */
export async function expandRosterEntries(
  campaignId: Id,
  entries: readonly MonsterEntry[],
  options: RosterExpansionOptions,
): Promise<RosterExpansion> {
  const seedFighters: SeedFighter[] = [];
  // Mob artifacts: deduplicates get-or-creates within one expansion when
  // several roster entries cite the same creature chunk.
  const mobArtifacts = new Map<Id, Id>();
  const statless: string[] = [];
  const tokens: BattleToken[] = [];
  for (const [monsterIndex, entry] of entries.entries()) {
    const resolved = await resolveMonsterEntryWithRepos(entry);
    const numberStart = options.numberFrom ?? 1;
    for (let index = 1; index <= entry.count; index += 1) {
      const number = numberStart + index - 1;
      const label =
        entry.count > 1 || options.forceNumbering === true
          ? `${entry.name} ${String(number)}`
          : entry.name;
      const at = options.placeAt(monsterIndex, index) ?? fallbackSpawnPoint(tokens.length);
      if (resolved.statBlock === null) {
        statless.push(`${label} (${resolved.origin === '' ? 'no stats' : resolved.origin})`);
        const statlessToken: BattleToken = {
          id: newId(),
          // A statless token points at its npc artifact when one exists (so
          // the badge can link back); rulebook/inline rows point nowhere.
          artifactId: entry.source.type === 'npc-ref' ? entry.source.artifactId : null,
          label,
          x: at.x,
          y: at.y,
          visible: options.visible,
          scale: 1,
          shape: 'portrait',
          color: null,
          currentHp: null,
          initiativeRoll: null,
          initiativeBonus: null,
          conditions: [],
        };
        tokens.push(statlessToken);
        continue;
      }
      const maxHp = resolved.statBlock.hp;
      const bonus = abilityModifier(resolved.statBlock.abilities.dex);
      let artifactId: Id;
      if (entry.source.type === 'npc-ref') {
        // npc-ref tokens resolve stats through the real artifact — no seed
        // copy to drift (the artifact must NEVER store current HP).
        artifactId = entry.source.artifactId;
      } else if (entry.source.type === 'rulebook') {
        // Mob artifact (owner-ratified): ALL instances of a rulebook creature
        // share ONE image-able npc artifact keyed by the cited chunk — created
        // here lazily for encounters written before the marker existed (the
        // get-or-create is idempotent, so old rows retro-fill on first seed),
        // otherwise the finalize-stamped mobArtifactId is used verbatim (a
        // dangling one behaves like a deleted npc-ref: scrubbed tokens, no
        // stats). ONE seedFighters row under that artifact id carries the
        // chunk-resolved stats; the fighterStats fallthrough (mob artifact
        // itself has no statBlock → seed row) resolves every instance.
        artifactId =
          entry.source.mobArtifactId ??
          (await getOrCreateMobArtifact(
            campaignId,
            entry.source.chunkId,
            entry.name,
            { source: 'user' },
            mobArtifacts,
          ));
        if (!seedFighters.some((seed) => seed.id === artifactId)) {
          seedFighters.push({ id: artifactId, name: entry.name, maxHp, initiativeBonus: bonus });
        }
      } else {
        // Inline monsters have no artifact: freeze the resolved stats onto
        // the battle row under a synthetic per-instance id.
        artifactId = newId();
        seedFighters.push({ id: artifactId, name: label, maxHp, initiativeBonus: bonus });
      }
      // tokenFromFighter gives a fresh NPC instance max HP and empty
      // initiative — exactly the seeding rule.
      tokens.push(tokenFromFighter(artifactId, { kind: 'npc', name: label, maxHp }, tokens.length, options.visible, at));
    }
  }
  return { tokens, seedFighters, statless };
}

export async function seedBattleFromEncounter(
  campaignId: Id,
  moduleId: Id,
  encounterArtifactId: Id,
): Promise<SeedReport> {
  const encounter = await getAnyArtifact(encounterArtifactId);
  if (encounter === undefined) throw new NotFoundError('Encounter artifact', encounterArtifactId);
  if (encounter.kind !== 'encounter') {
    throw new Error(`Artifact “${encounter.name}” is not an encounter`);
  }

  const mapImageId = await resolveMapImageId(encounter);
  const layout = encounter.data.layout;
  const placements = layout === null ? [] : placeMonsters(layout, encounter.data.monsters);
  const placementByInstance = new Map(
    placements.map((placement) => [
      `${String(placement.monsterIndex)}:${String(placement.instanceIndex)}`,
      placement,
    ]),
  );

  // Expand the roster (M5-C step 3): each entry with stats produces `count`
  // portrait tokens at fresh max HP (the token instance owns it); statless
  // entries produce HP-less tokens excluded from initiative. The expansion
  // (identity rules, mob-artifact dedupe, seed freezing) is shared with
  // in-battle spawn (encounter-resume arc) — only placement differs.
  const expansion = await expandRosterEntries(campaignId, encounter.data.monsters, {
    visible: layout !== null,
    placeAt: (monsterIndex, instanceIndex) => {
      const placement = placementByInstance.get(
        `${String(monsterIndex)}:${String(instanceIndex - 1)}`,
      );
      if (layout !== null && placement === undefined) {
        const entry = encounter.data.monsters[monsterIndex];
        if (entry === undefined) throw new Error('Roster entry missing from the encounter');
        const label = entry.count > 1 ? `${entry.name} ${String(instanceIndex)}` : entry.name;
        throw new Error(`The generated layout has no room cell for ${label}`);
      }
      return placement;
    },
  });
  const rosterTokens = expansion.tokens;
  const seedFighters = expansion.seedFighters;
  const statless = expansion.statless;

  // M5-C step 4: PCs spawn row-major in the staging ground via
  // normalize-on-write; statful only — a statless PC is skipped and badged.
  const artifacts = await listArtifactsByCampaign(campaignId);
  const entryRoom = layout === null ? undefined : spawnRoom(layout);
  // Entrance-anchored staging (entrance/exit spawn zones, doc 11): the party
  // block is the mobsRect-sized rect slid along the entrance axis until it
  // hugs the entrance wall (staying inside the room union). Without an
  // entrance (legacy layouts) this is exactly the mobsRect — byte-identical
  // to the pre-entrance behavior.
  const stagingRect = layout === null || entryRoom === undefined ? null : stagingBlockRect(entryRoom);
  const stagingGround =
    stagingRect === null || layout === null
      ? defaultStagingGround()
      : {
          x: (stagingRect.x + stagingRect.w / 2) / layout.gridW,
          y: (stagingRect.y + stagingRect.h / 2) / layout.gridH,
          // ensurePcTokens fills a 3×3 staging block; scale that block to the
          // staging rect even when it is only two cells wide.
          cellWidth: stagingRect.w / 3 / layout.gridW,
          cellHeight: stagingRect.h / 3 / layout.gridH,
        };
  const entrance =
    layout === null || entryRoom?.entrance === undefined
      ? null
      : {
          x: (entryRoom.entrance.x + 0.5) / layout.gridW,
          y: (entryRoom.entrance.y + 0.5) / layout.gridH,
          side: entryRoom.entrance.side,
        };
  // Adjudicated fog exception: with an entrance the party STARTS in the spawn
  // room, so seeding skips that room's fog veil (the GM reveals the rest).
  let veils: BattleVeil[] = layout === null ? [] : veilsFromRooms(layout);
  if (layout !== null && entryRoom?.entrance !== undefined) {
    veils = veils.filter((veil) => veil.id !== entryRoom.id);
  }
  const board = ensurePcTokens(
    {
      mapImageId,
      mapLayout: layout === null ? null : { cols: layout.gridW, rows: layout.gridH },
      live: false,
      // A fresh seed has not spent its first-entry reveal yet — entering the
      // table reveals every token exactly once (encounter-resume arc).
      everLive: false,
      tokens: rosterTokens,
      veils,
      effects: [],
      gridSize: GRID_SIZE_DEFAULT,
      tokenSize: 64,
      sceneryMovementLocked: false,
      initiativeEnabled: false,
      initiativeOrder: [],
      activeIndex: 0,
      stage: null,
      stagingGround,
      entrance,
    },
    pcFightersOf(artifacts),
  );

  // Seeding REPLACES any running battle for the module (the UI confirms):
  // fresh board, no stage snapshot, provenance + frozen seed stats stamped
  // BEFORE the normalized save (the stats lookup drives HP clamping). When a
  // battle already ran, the row records the destructive re-seed — who (the
  // acting seed), when, and what replaced the board (encounter-resume arc).
  const existing = await getBattleByModule(moduleId);
  const battle = await ensureBattle(campaignId, moduleId);
  const reseed =
    existing === undefined
      ? null
      : { at: Date.now(), encounterArtifactId, encounterName: encounter.name };
  await patchBattle(battle.id, { encounterArtifactId, seedFighters, reseed });
  await saveBattleBoard(battle.id, board);
  const saved = await getBattle(battle.id);
  if (saved === undefined) throw new NotFoundError('Battle', battle.id);
  return { battle: saved, statless };
}

export interface SpawnReport {
  /** Labels spawned without stats — loud badge, never placeholder numbers. */
  statless: string[];
}

/**
 * In-battle spawn (encounter-resume arc, M5-C addition): appends ONE
 * instance of a provenance-encounter roster entry to the LIVE board through
 * the shared expandRosterEntries path — the same identity rules as seeding
 * (one mob artifact per cited chunk, one frozen seed row, npc-ref by
 * reference), never a stat copy. Labels continue the on-board count
 * ("Goblin 4" when three are out); placement is the next staging-ground
 * cell, else the fallback cascade. Spawned tokens are visible and get
 * auto-rolled by useInitiativeReconcile when initiative is on.
 */
export async function spawnRosterInstance(
  battleId: Id,
  monsterIndex: number,
): Promise<SpawnReport> {
  const battle = await getBattle(battleId);
  if (battle === undefined) throw new NotFoundError('Battle', battleId);
  if (battle.encounterArtifactId === null) {
    throw new Error('This battle has no seeding encounter to spawn from');
  }
  const encounter = await getAnyArtifact(battle.encounterArtifactId);
  if (encounter === undefined) {
    throw new NotFoundError('Encounter artifact', battle.encounterArtifactId);
  }
  if (encounter.kind !== 'encounter') {
    throw new Error(`Artifact “${encounter.name}” is not an encounter`);
  }
  const entry = encounter.data.monsters[monsterIndex];
  if (entry === undefined) {
    throw new Error(`The seeding encounter has no roster entry ${String(monsterIndex)}`);
  }
  // Numbering continues the on-board count: "Goblin", "Goblin 2" … occupy
  // label slots named exactly or numbered after the entry.
  const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slotPattern = new RegExp(`^${escaped}(?: \\d+)?$`);
  const existing = battle.board.tokens.filter((token) => slotPattern.test(token.label)).length;
  const at =
    battle.board.stagingGround === null
      ? fallbackSpawnPoint(battle.board.tokens.length)
      : spawnPointInStagingGround(battle.board.tokens.length, battle.board.stagingGround);
  // ONE instance per spawn: clone the entry with count 1 — the expansion's
  // per-entry count would stamp the whole designed group.
  const expansion = await expandRosterEntries(battle.campaignId, [{ ...entry, count: 1 }], {
    visible: true,
    placeAt: () => at,
    numberFrom: existing + 1,
    forceNumbering: true,
  });
  // Frozen seed rows merge FIRST (deduped by id — a mob artifact already
  // carrying a row must not gain a second), so the normalized board save
  // resolves HP/initiative bonuses through the new rows.
  const merged = [...battle.seedFighters];
  for (const seed of expansion.seedFighters) {
    if (!merged.some((existingSeed) => existingSeed.id === seed.id)) merged.push(seed);
  }
  await patchBattle(battle.id, { seedFighters: merged });
  await saveBattleBoard(battle.id, {
    ...battle.board,
    tokens: [...battle.board.tokens, ...expansion.tokens],
  });
  return { statless: expansion.statless };
}
