import type { AnyArtifact, Battle, BattleToken, Id, SeedFighter } from '@/domain';
import { GRID_SIZE_DEFAULT, newId } from '@/domain';
import { ensurePcTokens, fallbackSpawnPoint, stagingGroundAt, tokenFromFighter } from '@/domain/battle/board';
import { abilityModifier } from '@/domain/statblock';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';
import { getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { ensureBattle, getBattle, patchBattle, saveBattleBoard } from '@/db/battleRepo';
import { pcFightersOf } from '@/db/fighterStats';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';

/**
 * Seeding a battle from an encounter artifact (09-MILESTONE-5 M5-C):
 * "Run battle" expands the designed roster into portrait tokens, resolves
 * the battlemap, and hands the board to the table surface (live: false
 * until the table opens). One live battle per module — seeding an already
 * running battle REPLACES it (the UI confirms; the stage snapshot is
 * discarded).
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

  // Expand the roster (M5-C step 3): each entry with stats produces `count`
  // portrait tokens at fresh max HP (the token instance owns it); statless
  // entries produce HP-less tokens excluded from initiative.
  const seedFighters: SeedFighter[] = [];
  const statless: string[] = [];
  const rosterTokens: BattleToken[] = [];
  for (const entry of encounter.data.monsters) {
    const resolved = await resolveMonsterEntryWithRepos(entry);
    for (let index = 1; index <= entry.count; index += 1) {
      const label = entry.count > 1 ? `${entry.name} ${String(index)}` : entry.name;
      const at = fallbackSpawnPoint(rosterTokens.length);
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
          visible: false,
          scale: 1,
          shape: 'portrait',
          color: null,
          currentHp: null,
          initiativeRoll: null,
          initiativeBonus: null,
          conditions: [],
        };
        rosterTokens.push(statlessToken);
        continue;
      }
      const maxHp = resolved.statBlock.hp;
      const bonus = abilityModifier(resolved.statBlock.abilities.dex);
      let artifactId: Id;
      if (entry.source.type === 'npc-ref') {
        // npc-ref tokens resolve stats through the real artifact — no seed
        // copy to drift (the artifact must NEVER store current HP).
        artifactId = entry.source.artifactId;
      } else {
        // Rulebook/inline monsters have no artifact: freeze the resolved
        // stats onto the battle row under a synthetic per-instance id.
        artifactId = newId();
        seedFighters.push({ id: artifactId, name: label, maxHp, initiativeBonus: bonus });
      }
      // tokenFromFighter gives a fresh NPC instance max HP and empty
      // initiative — exactly the seeding rule.
      rosterTokens.push(
        tokenFromFighter(artifactId, { kind: 'npc', name: label, maxHp }, rosterTokens.length, false, at),
      );
    }
  }

  // M5-C step 4: PCs spawn row-major in the staging ground via
  // normalize-on-write; statful only — a statless PC is skipped and badged.
  const artifacts = await listArtifactsByCampaign(campaignId);
  const board = ensurePcTokens(
    {
      mapImageId,
      live: false,
      tokens: rosterTokens,
      veils: [],
      gridSize: GRID_SIZE_DEFAULT,
      tokenSize: 64,
      sceneryMovementLocked: false,
      initiativeEnabled: false,
      initiativeOrder: [],
      activeIndex: 0,
      stage: null,
      stagingGround: defaultStagingGround(),
    },
    pcFightersOf(artifacts),
  );

  // Seeding REPLACES any running battle for the module (the UI confirms):
  // fresh board, no stage snapshot, provenance + frozen seed stats stamped
  // BEFORE the normalized save (the stats lookup drives HP clamping).
  const battle = await ensureBattle(campaignId, moduleId);
  await patchBattle(battle.id, { encounterArtifactId, seedFighters });
  await saveBattleBoard(battle.id, board);
  const saved = await getBattle(battle.id);
  if (saved === undefined) throw new NotFoundError('Battle', battle.id);
  return { battle: saved, statless };
}
