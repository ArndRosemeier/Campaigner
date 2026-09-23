import type { AnyArtifact, Id, MonsterEntry, StagingGround } from '@/domain';
import { monsterEntrySchema } from '@/domain';
import {
  fallbackSpawnPoint,
  matchesSlotLabel,
  spawnPointInStagingGround,
} from '@/domain/battle/board';
import { getBattle, patchBattle } from '@/db/battleRepo';
import { expandRosterEntries, type SpawnReport } from '@/db/battleSeed';
import { creatureCoverImageId } from '@/db/creatureRepo';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import { creatureCopyRefusal } from '@/domain/libraryCopy';
import {
  enqueueSingleMobPortrait,
  type SingleMobPortraitTarget,
} from '@/features/campaign/mob-portrait-queue';
import { authoredPortraitKey, rosterParticipantRoute } from '@/features/campaign/mob-portrait-participants';
import { parseLevelSort } from '@/llm/encounterRoster';
import { NotFoundError } from '@/lib/errors';

/**
 * The spawn picker's spawn paths and pure comparators/geometry — everything
 * `SpawnPicker.tsx` needs that is not the dialog itself.
 *
 * Spawn paths (no parallel paths — the file-boundary rule keeps battleSeed
 * itself untouched, so this module composes its exported seams):
 * - roster entries go through `spawnRosterInstance` verbatim (the same
 *   provenance path as the old buttons: on-board count continuation,
 *   staging-ground placement, shared expansion);
 * - NPC and core-mob picks go through `spawnPickedEntry` below: a synthetic
 *   single-instance entry (npc-ref / rulebook) through the SHARED
 *   `expandRosterEntries` — the same identity rules as seeding (one mob
 *   artifact per cited chunk via get-or-create, one frozen seed row,
 *   npc-ref by reference, statless tokens reported loudly, never
 *   placeholder numbers) — merged onto the live board exactly like
 *   `spawnRosterInstance` does.
 */

/**
 * Numeric level ordering with the picker's documented fallback: a missing or
 * unparsable level sorts LAST (positive infinity), never first and never as
 * a fabricated 0. Uses `parseLevelSort` — the one level parser — so picker
 * order matches the bestiary roster order for the same creatures.
 */
export function parseLevelOrLast(level: string | null | undefined): number {
  if (level === null || level === undefined || level.trim() === '') return Number.POSITIVE_INFINITY;
  try {
    return parseLevelSort(level);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Name comparator shared by every group (level ties break by name). */
export function compareSpawnNames(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * How many on-board label slots a name already occupies ("Goblin", "Goblin 2" …).
 * The grammar is `domain/battle/board.matchesSlotLabel` — the ONE seam both
 * spawn paths count with (docs/17 row 295).
 */
export function countLabelSlots(tokens: readonly { label: string }[], name: string): number {
  return tokens.filter((token) => matchesSlotLabel(token.label, name)).length;
}

const FREE_SPOT_STEP = 0.025;
const FREE_SPOT_RADIUS = 8;

/**
 * A free board position near the board's spawn area: the same base the
 * seeding path uses (next staging-ground cell, else the fallback cascade),
 * nudged off positions an existing token already occupies — a spawned token
 * never stacks exactly atop another. Deterministic spiral, clamped inside
 * the board.
 */
export function nextFreeSpawnPoint(
  tokens: readonly { x: number; y: number }[],
  stagingGround: StagingGround | null,
): { x: number; y: number } {
  const base =
    stagingGround === null
      ? fallbackSpawnPoint(tokens.length)
      : spawnPointInStagingGround(tokens.length, stagingGround);
  const occupied = (point: { x: number; y: number }): boolean =>
    tokens.some((token) => token.x === point.x && token.y === point.y);
  const clamp = (value: number): number => Math.min(0.98, Math.max(0.02, value));
  const first = { x: clamp(base.x), y: clamp(base.y) };
  if (!occupied(first)) return first;
  for (let radius = 1; radius <= FREE_SPOT_RADIUS; radius += 1) {
    const step = FREE_SPOT_STEP * radius;
    const candidates = [
      { x: base.x + step, y: base.y },
      { x: base.x, y: base.y + step },
      { x: base.x - step, y: base.y },
      { x: base.x, y: base.y - step },
      { x: base.x + step, y: base.y + step },
      { x: base.x - step, y: base.y - step },
    ];
    for (const candidate of candidates) {
      const point = { x: clamp(candidate.x), y: clamp(candidate.y) };
      if (!occupied(point)) return point;
    }
  }
  // Every candidate occupied (a packed board): the clamped base is still the
  // documented spawn area — loud stacking beats inventing a new rule.
  return first;
}

/**
 * Builds the synthetic single-instance entry for a core-mob pick (the
 * bestiary spawn path): the library creature's stats are COPIED onto the entry
 * at write time through the ONE copy seam (docs/17 row 255a) — the library
 * block, the STAMPED origin line, the opaque `chunk:<id>` token. No pointer is
 * born, so the spawned token's numbers do not depend on the pack staying
 * installed.
 *
 * A vanished chunk is a LOUD refusal (`creatureCopyRefusal`), never a
 * uuid-only pointer: there is nothing to copy, and minting a reference is
 * exactly what the owner's rule forbids. Exported for tests (SpawnPicker.tsx's
 * click handler is UI-only).
 */
export async function buildMobPickEntry(chunkId: Id, entryName: string): Promise<MonsterEntry> {
  const result = await copyCreatureStatsFromDb({ chunkId }, entryName);
  if (result.status === 'unresolved') throw creatureCopyRefusal(entryName, result.reason);
  return monsterEntrySchema.parse({
    name: entryName,
    count: 1,
    notes: '',
    treasure: '',
    source: { type: 'inline', statBlock: result.copy.statBlock },
    sourceLine: result.copy.sourceLine,
    originToken: result.copy.originToken,
  });
}

/**
 * In-battle spawn of a caller-built single-instance entry (NPC / core-mob
 * picks): numbering continues the on-board count, placement is the next free
 * spawn point, and the shared expansion + seed-row merge + single
 * `patchBattle` mirror `spawnRosterInstance` exactly.
 */
export async function spawnPickedEntry(battleId: Id, entry: MonsterEntry): Promise<SpawnReport> {
  const battle = await getBattle(battleId);
  if (battle === undefined) throw new NotFoundError('Battle', battleId);
  const parsed = monsterEntrySchema.parse(entry);
  const at = nextFreeSpawnPoint(battle.board.tokens, battle.board.stagingGround);
  const expansion = await expandRosterEntries([parsed], {
    visible: true,
    placeAt: () => at,
    numberFrom: countLabelSlots(battle.board.tokens, parsed.name) + 1,
    forceNumbering: true,
  });
  const merged = [...battle.seedFighters];
  for (const seed of expansion.seedFighters) {
    if (!merged.some((existing) => existing.id === seed.id)) merged.push(seed);
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

/**
 * The picker's "illustrate mobs with no image" fill — ONE creature a pick just
 * created (docs/17 row 333). Called AFTER the spawn succeeded, once per spawned
 * instance, only while the checkbox is ticked.
 *
 * THE SEAMS IT REUSES, and why none of them is re-derived here:
 * - the creature's lane and its identity come from `rosterParticipantRoute` —
 *   the ONE routing/identity rule the portrait batch, its regen, the module gap
 *   detector and the board all read (docs/17 rows 96/165), so the key enqueued
 *   under is the key the spawned token carries;
 * - the "does it have one" question is `creatureCoverImageId`, the ONE read the
 *   portrait batch and the queue's own skip branch ask (docs/17 row 165). The
 *   narrower `creaturePortraitArt` reads ONLY the campaign's presentation row,
 *   which is exactly the read the batch's own comment records as a defect
 *   (docs/11 D6): a CAST or hand-authored npc carries its portrait on its OWN
 *   cover, so the narrow read calls an already-illustrated mob "missing" and
 *   would enqueue work over the owner's art. "Already-illustrated is never
 *   touched" is the pin that matters, so this asks the wider read;
 * - the enqueue is the EXISTING single-creature entry point
 *   (`enqueueSingleMobPortrait`): same queue, same identity-keyed dedupe, same
 *   skip-if-imaged worker branch, same loud per-creature failure path as the
 *   battle card. No second mechanism, no settings field, no queue.
 *
 * `linked` is the artifact an `npc-ref` points at, as the caller already holds
 * it (the picker's artifact snapshot); `undefined` for every other shape. A
 * dangling link is LOUD — the spawn itself already failed in that case, so
 * silently skipping the illustration would hide a real gap (AGENTS rule 1).
 */
export async function illustrateSpawnedCreature(options: {
  campaignId: Id;
  /** The entry the pick just spawned (its `count` is irrelevant: one instance). */
  entry: MonsterEntry;
  linked: AnyArtifact | undefined;
}): Promise<void> {
  const route = rosterParticipantRoute(options.entry, options.linked);
  if (route.lane === 'missing-ref') {
    throw new Error(
      `Could not illustrate “${options.entry.name}”: the npc it points at no longer exists`,
    );
  }
  const creatureKey =
    route.lane === 'authored' ? authoredPortraitKey(route.artifactId) : route.creatureKey;
  // The authored npc whose OWN cover may already be the creature's art — read
  // for both lanes that have one; an invented mob has no artifact at all.
  const npcArtifactId =
    route.lane === 'creature' || route.lane === 'authored' ? route.artifactId : null;
  // The ONE "is this creature illustrated?" read, asked with the artifact that
  // may own the cover (above): `'none'` is the only state that enqueues.
  const existing = await creatureCoverImageId({
    campaignId: options.campaignId,
    creatureKey,
    npcArtifactId,
  });
  if (existing !== null) return;
  const target: SingleMobPortraitTarget =
    route.lane === 'creature'
      ? {
          campaignId: options.campaignId,
          creatureKey,
          name: route.name,
          ...(route.chunkId === undefined ? {} : { chunkId: route.chunkId }),
          ...(route.statBlock === undefined ? {} : { statBlock: route.statBlock }),
          ...(route.artifactId === null ? {} : { artifactId: route.artifactId }),
        }
      : route.lane === 'authored'
        ? {
            campaignId: options.campaignId,
            creatureKey,
            name: route.name,
            artifactId: route.artifactId,
          }
        : {
            campaignId: options.campaignId,
            creatureKey,
            name: route.name,
            // An invented mob has no artifact and no library row — the roster
            // row's own notes ARE its description (the batch's invented lane
            // passes the very same field), and `buildImagePrompt` still refuses
            // an empty one loudly rather than illustrating a bare name.
            ...(options.entry.notes.trim() === '' ? {} : { grounding: options.entry.notes }),
          };
  enqueueSingleMobPortrait(target);
}
