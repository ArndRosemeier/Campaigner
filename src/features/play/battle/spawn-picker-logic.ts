import type { Id, MonsterEntry, StagingGround } from '@/domain';
import { monsterEntrySchema } from '@/domain';
import { fallbackSpawnPoint, spawnPointInStagingGround } from '@/domain/battle/board';
import { getBattle, patchBattle } from '@/db/battleRepo';
import { expandRosterEntries, type SpawnReport } from '@/db/battleSeed';
import { db } from '@/db/db';
import { contentIdentityFor } from '@/domain/encounterResolve';
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

/** Escape a token label for the on-board slot-count pattern (mirrors `spawnRosterInstance`). */
function slotPatternFor(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?: \\d+)?$`);
}

/** How many on-board label slots a name already occupies ("Goblin", "Goblin 2" …). */
export function countLabelSlots(tokens: readonly { label: string }[], name: string): number {
  const pattern = slotPatternFor(name);
  return tokens.filter((token) => pattern.test(token.label)).length;
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
 * bestiary spawn path): content identity stamped at citation birth
 * (chunk-hash-fallback arc) so the shared expansion resolves it exactly
 * like a persisted citation. A vanished chunk stays uuid-only with the
 * pick name as creature — the statless toast stays loud. Exported
 * for tests (SpawnPicker.tsx's click handler is UI-only).
 */
export async function buildMobPickEntry(chunkId: Id, entryName: string): Promise<MonsterEntry> {
  const chunk = await db.chunks.get(chunkId);
  return monsterEntrySchema.parse({
    name: entryName,
    count: 1,
    notes: '',
    treasure: '',
    source: chunk === undefined
      ? { type: 'rulebook', chunkId, creatureName: entryName }
      : {
        type: 'rulebook',
        chunkId,
        ...contentIdentityFor(chunk.contentHash, chunk.headingPath[0], entryName),
      },
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
  const expansion = await expandRosterEntries(battle.campaignId, [parsed], {
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
