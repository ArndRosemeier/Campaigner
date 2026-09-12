import type { AnyArtifact, Battle, BattleToken, BattleVeil, Id, MonsterEntry, SeedFighter } from '@/domain';
import {
  contentCreatureKey,
  GRID_SIZE_DEFAULT,
  libraryCreatureKey,
  newId,
  placeMonsters,
  spawnRoom,
  veilsFromSpawnClusters,
} from '@/domain';
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
import { toastError } from '@/lib/toast';
import { getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import {
  ensureBattle,
  getBattle,
  getBattleByModule,
  patchBattle,
} from '@/db/battleRepo';
import { pcFightersOf } from '@/db/fighterStats';
import { promoteRosterUses } from '@/db/artifactAutoPromote';
import { inventedCreatureIdentity, resolveCreatureCitation } from '@/db/creatureRepo';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';

/**
 * Seeding a battle from an encounter artifact (09-MILESTONE-5 M5-C):
 * "Run battle" expands the designed roster into portrait tokens, resolves
 * the battlemap, and hands the board to the table surface (live: false
 * until the table opens). One live battle per module — seeding an already
 * running battle REPLACES it (the UI confirms; the stage snapshot is
 * discarded).
 *
 * Library creatures (docs/11 D5 amendment): a statful `rulebook` entry is a
 * CITATION, not a row — it freezes ONE synthetic `seedFighters` row for its
 * creature identity and stamps that identity onto each token's `creatureKey`
 * (`domain/creature`), which is how the board finds the creature's portrait
 * with no artifact anywhere. Seeding therefore creates NOTHING: a battle seed
 * is pure read + write on the battle row.
 *
 * Loud-by-contract (AGENTS rule 1): roster entries without stats seed as
 * tokens WITHOUT HP that are excluded from initiative; the report lists them
 * so the UI can badge them. No placeholder numbers anywhere.
 */

/**
 * The creature identity a roster entry carries into its TOKENS, or null when it
 * has none (an authored `npc-ref` keeps its portrait on its own artifact
 * cover). ONE spelling, shared by the statful and the statless token paths so a
 * cited creature's portrait never depends on whether its library row resolved.
 */
function creatureKeyForEntry(entry: MonsterEntry): string | null {
  if (entry.source.type === 'rulebook') return libraryCreatureKey(entry.source.chunkId);
  if (entry.source.type === 'inline') return contentCreatureKey(entry.name, entry.source.statBlock);
  if (entry.source.type === 'none') return contentCreatureKey(entry.name, null);
  return null;
}

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
 *
 * Single-map-slot robustness: the encounter's `mapImageId` wins ONLY when
 * its image row still exists — a pruned row falls through to the
 * location-cover branch (LOUD toast, never a frozen dangling id that would
 * seed a board pointing at nothing). Precedence stays mapImageId →
 * location map-cover → null.
 */
async function resolveMapImageId(
  encounter: AnyArtifact & { kind: 'encounter' },
): Promise<Id | null> {
  if (encounter.data.mapImageId !== null) {
    if ((await db.images.get(encounter.data.mapImageId)) !== undefined) {
      return encounter.data.mapImageId;
    }
    // Loud (AGENTS rule 2): the encounter names a battlemap whose blob is
    // gone — the seed does NOT freeze the dangling id onto the board.
    toastError(
      `The battlemap for encounter “${encounter.name}” is missing — seeding without it. ` +
        'Regenerate the encounter map to restore it.',
    );
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
 * through the real artifact; rulebook entries are LIBRARY CREATURE CITATIONS
 * that share ONE frozen seed row per creature identity (nothing is created);
 * inline entries freeze per-instance synthetic rows; statless entries produce
 * HP-less tokens excluded from initiative and are reported loudly (AGENTS
 * rule 1).
 */
export async function expandRosterEntries(
  entries: readonly MonsterEntry[],
  options: RosterExpansionOptions,
): Promise<RosterExpansion> {
  const seedFighters: SeedFighter[] = [];
  // Library creatures: ONE frozen seed row per cited creature identity within
  // one expansion, so several entries citing the same chunk share it.
  const creatureFighters = new Map<string, Id>();
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
        const statlessCreatureKey = creatureKeyForEntry(entry);
        const statlessToken: BattleToken = {
          id: newId(),
          // A statless token points at its npc artifact when one exists (so
          // the badge can link back); an inline row points nowhere. Its creature
          // identity rides along when it has one — a cited creature whose
          // library row is absent still shows the campaign's presentation
          // portrait, and the token is badged for its missing STATS, not for
          // looking unknown.
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
          treasure: entry.treasure,
          conditions: [],
        };
        if (statlessCreatureKey !== null) statlessToken.creatureKey = statlessCreatureKey;
        tokens.push(statlessToken);
        continue;
      }
      const maxHp = resolved.statBlock.hp;
      const bonus = abilityModifier(resolved.statBlock.abilities.dex);
      let artifactId: Id;
      /** The creature identity a CITATION gives its tokens (docs/11 D5
       * amendment); undefined for every token that is not a cited creature. */
      let creatureKey: string | undefined;
      if (entry.source.type === 'npc-ref') {
        // npc-ref tokens resolve stats through the real artifact — no seed
        // copy to drift (the artifact must NEVER store current HP).
        artifactId = entry.source.artifactId;
        // An authored NPC cast from a library creature carries that creature's
        // identity, so its token shows the creature's portrait; a hand-made NPC
        // has no creature identity and keeps its portrait on its own cover.
        const npc = await getAnyArtifact(entry.source.artifactId);
        if (npc?.kind === 'npc' && npc.data.creatureRef !== undefined) {
          const listing = await resolveCreatureCitation(npc.data.creatureRef, npc.name);
          if (listing.chunk !== null) creatureKey = listing.identity.key;
        }
      } else if (entry.source.type === 'rulebook') {
        // A LIBRARY CREATURE CITATION (docs/11 D5 amendment): no row is created
        // for it, so the creature identity is the token's portrait handle. ONE
        // seedFighters row per IDENTITY (not per instance) carries the
        // chunk-resolved stats; every instance resolves through it, exactly as
        // the retired mob artifact's row used to.
        const listing = await resolveCreatureCitation(entry.source, entry.name);
        creatureKey = listing.identity.key;
        const known = creatureFighters.get(creatureKey);
        if (known === undefined) {
          artifactId = newId();
          creatureFighters.set(creatureKey, artifactId);
          seedFighters.push({
            id: artifactId,
            name: entry.name,
            maxHp,
            initiativeBonus: bonus,
            creatureKey,
          });
        } else {
          artifactId = known;
        }
      } else {
        // Inline monsters have no artifact and no creature identity of their
        // own beyond their content: freeze the resolved stats onto the battle
        // row under a synthetic per-instance id and key their portrait on the
        // content identity (docs/11 D5) so the invented mob still gets a look.
        artifactId = newId();
        seedFighters.push({ id: artifactId, name: label, maxHp, initiativeBonus: bonus });
        creatureKey = inventedCreatureIdentity(entry.name, resolved.statBlock).key;
      }
      // tokenFromFighter gives a fresh NPC instance max HP and empty
      // initiative — exactly the seeding rule. The roster entry's treasure
      // is frozen onto the token (GM-only checklist; the entry can vanish
      // from the artifact later, the seeded token keeps its copy).
      const token = tokenFromFighter(artifactId, { kind: 'npc', name: label, maxHp }, tokens.length, options.visible, at, entry.treasure);
      if (creatureKey !== undefined) token.creatureKey = creatureKey;
      tokens.push(token);
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

  // Auto-promote on second-module use (BATTLE hook): a token whose artifact
  // is owned by another module promotes to campaign level BEFORE the seed
  // freezes identity — the seed rows then point at the shared row, and the
  // first module never loses its monster silently.
  await promoteRosterUses(moduleId, encounter.data.monsters);

  const mapImageId = await resolveMapImageId(encounter);
  const layout = encounter.data.layout;
  // The encounter's shape (docs/11 D11): parsed rows always carry it
  // ('single' default; normalizeEncounterShapeData derives complex for
  // multi-room layouts at the read boundary).
  const siteShape = encounter.data.siteShape;
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
  // (identity rules, creature-identity dedupe, seed freezing) is shared with
  // in-battle spawn (encounter-resume arc) — only placement differs.
  const expansion = await expandRosterEntries(encounter.data.monsters, {
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
  // Vision-path staging (docs/11 vision path): the spawn room carries no
  // staging rect — the party stages AT its observed plaque point (the same
  // point monsters scatter around), never a defaulted center. A room
  // without its observed point fails the seed loud here.
  const visionSpawnPoint = layout?.mapPath === 'vision' && entryRoom !== undefined
    ? (() => {
      const { observedX, observedY } = entryRoom;
      if (observedX === undefined || observedY === undefined) {
        throw new Error(
          `The generated layout has no observed plaque point for “${entryRoom.name}” — refusing a defaulted spawn`,
        );
      }
      return { x: observedX, y: observedY };
    })()
    : null;
  // Entrance-anchored staging (entrance/exit spawn zones, doc 11): the party
  // block is the mobsRect-sized rect slid along the entrance axis until it
  // hugs the entrance wall (staying inside the room union). Without an
  // entrance (legacy layouts) this is exactly the mobsRect — byte-identical
  // to the pre-entrance behavior.
  const stagingRect = layout === null || entryRoom === undefined || visionSpawnPoint !== null
    ? null
    : stagingBlockRect(entryRoom);
  // Start position (docs/11 D11): a SINGLE site starts AT the entrance cell
  // when the layout carries one (the party walks in), else at the room's
  // mobsRect center. Complex sites keep the entrance-hugging staging block.
  // Vision sites start at the spawn room's observed plaque point.
  const stagingCenter =
    layout === null
      ? null
      : visionSpawnPoint ?? (stagingRect === null
        ? null
        : siteShape === 'single' && entryRoom?.entrance !== undefined
          ? {
            x: (entryRoom.entrance.x + 0.5) / layout.gridW,
            y: (entryRoom.entrance.y + 0.5) / layout.gridH,
          }
          : {
            x: (stagingRect.x + stagingRect.w / 2) / layout.gridW,
            y: (stagingRect.y + stagingRect.h / 2) / layout.gridH,
          });
  const stagingGround =
    stagingCenter === null || layout === null
      ? defaultStagingGround()
      : visionSpawnPoint !== null
        ? stagingGroundAt(visionSpawnPoint.x, visionSpawnPoint.y, 1000, 1000, GRID_SIZE_DEFAULT)
        : stagingRect === null
          ? defaultStagingGround()
          : {
            ...stagingCenter,
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
  // Spawn-group veils (docs/11 D4): EVERY monster spawn group is covered by
  // default — one VEIL per `monsterIndexes` entry, including the spawn
  // room's groups (the old spawn-room exemption is gone: the party starts in
  // the spawn room, but its monsters still begin veiled). A generated cover
  // over a mob area is a veil, never a fog (fog-cloud arc, owner-directed):
  // the veil's transparent body leaves the map readable, its taps pass
  // through to the room-key marker an opaque fog used to swallow, and player
  // view removes the covered mob tokens from the DOM — that REMOVAL is the
  // hiding mechanic, never the fill. Fog stays GM-drawn and blocking. Each
  // veil covers its spawn area plus a one-cell margin (the cover convention
  // in `veilsFromSpawnClusters`) so the GM can grab and resize it around the
  // tokens; same-room covers sharing ground merge to one veil at seed (the
  // overlap merge — adjacent same-room spawns veil as a single cover, never a
  // purposeless stack). A room with no monster groups seeds no veil; a SINGLE site
  // therefore seeds exactly its spawn groups' veils instead of zero. The
  // room's first group keeps `id = room.id` so the Path rail's "Reveal next
  // room" still resolves per room — reveal-all lifts every group veil of the
  // room (an advisory aid, never a lock).
  let veils: BattleVeil[] = [];
  if (layout !== null) {
    veils = veilsFromSpawnClusters(
      layout,
      encounter.data.monsters.map((entry) => entry.count),
    );
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
  // Provenance and board land in ONE patchBattle (it merges + normalizes
  // once) — the previous two-phase patch-then-board-save normalized the row
  // twice and briefly persisted a half-seeded board.
  const existing = await getBattleByModule(moduleId);
  const battle = await ensureBattle(campaignId, moduleId);
  const reseed =
    existing === undefined
      ? null
      : { at: Date.now(), encounterArtifactId, encounterName: encounter.name };
  const saved = await patchBattle(battle.id, {
    encounterArtifactId,
    seedFighters,
    reseed,
    board,
  });
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
  // Auto-promote on second-module use (BATTLE hook): same ownership check
  // as seeding — spawning another module's monster shares it campaign-wide.
  await promoteRosterUses(battle.moduleId, [entry]);
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
  const expansion = await expandRosterEntries([{ ...entry, count: 1 }], {
    visible: true,
    placeAt: () => at,
    numberFrom: existing + 1,
    forceNumbering: true,
  });
  // Frozen seed rows merge FIRST, deduped by CREATURE IDENTITY: a re-expansion
  // of the same roster entry resolves the same identity, so it must not gain a
  // second row (under the retired mob-artifact model the synthetic id WAS that
  // stable key; now the identity is). Rows without an identity fall back to the
  // id, which is stable for them (npc-ref/pc rows mirror an artifact).
  const merged = [...battle.seedFighters];
  for (const seed of expansion.seedFighters) {
    const duplicate = merged.some((existingSeed) =>
      seed.creatureKey !== undefined
        ? existingSeed.creatureKey === seed.creatureKey
        : existingSeed.id === seed.id,
    );
    if (!duplicate) merged.push(seed);
  }
  await patchBattle(battle.id, {
    seedFighters: merged,
    board: {
      ...battle.board,
      tokens: [...battle.board.tokens, ...expansion.tokens],
    },
  });
  return { statless: expansion.statless };
}
