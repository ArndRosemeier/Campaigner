import type { GameSystem } from '@/domain/gameSystem';
import type { Id, MonsterEntry, RuleChunk, StatBlock } from '@/domain';
import { parseLevelSort } from '@/llm/encounterRoster';

/**
 * The asymmetric per-room budget loop (docs/11 D12, owner-specified): every
 * layout room carries a `targetLevel` — the level this room ALONE should
 * challenge — and the assigned creatures' levels are summed against a
 * documented band for that target. Asymmetric by design:
 *
 * - **too easy ⇒ ship silently** (owner: fine) — there is no lower bound;
 * - **too hard ⇒ lower that room's `targetLevel` a step (floor 1) and retry
 *   through the encounter brief's EXISTING single repair turn** — budget
 *   issues join the repair turn's issue list exactly like coverage/source
 *   issues (no new repair machinery);
 * - **still over after the bounded retry ⇒ LOUD advisory** persisted on the
 *   step output and the artifact (`data.budgetAdvisory`) — never silent,
 *   never a failed run. The final (possibly lowered) `targetLevel` persists
 *   on the room, visible and owner-editable.
 *
 * Licensing shape (mirrors the treasure-ladder stance, docs/12 §13.2/§14):
 * - **dnd5e** — the DMG encounter-building tables are NOT licensable, so the
 *   band below IS the shipped approximation, in our own words (no Wizards
 *   text is quoted, paraphrased or restated numerically). Recorded verbatim
 *   in docs/11.
 * - **pathfinder2e** — creature budgets are Paizo's (GM Core). Campaigner
 *   ships NO numeric pf2e budget: the prompt directs the model to the
 *   retrieved GM Core excerpts VERBATIM when present, and the deterministic
 *   check is replaced by a loud advisory. Whether an excerpt actually
 *   surfaced is not deterministically decidable from the retrieval output,
 *   so the advisory always persists for pf2e — over-loud by design, never a
 *   fabricated paraphrase (AGENTS rule 1).
 */

/** The band's headroom over the target level (our own dnd5e approximation). */
export const ROOM_BUDGET_OVER_MARGIN = 2;

/**
 * dnd5e band (Campaigner's own documented approximation): a room tuned for
 * target level T is over budget when its assigned creatures' levels (CR)
 * sum to MORE than T + 2 — roughly a hard single fight's worth of creature
 * levels. Fractional levels (1/2, 1/4) count fractionally; "—" (CR-less
 * summons) counts as 0; there is NO lower bound (a quiet room ships
 * silently, per the owner's asymmetric call).
 */
export function roomBudgetBandUpper(targetLevel: number): number {
  return Math.max(1, targetLevel) + ROOM_BUDGET_OVER_MARGIN;
}

export type ParsedBudgetLevel =
  | { kind: 'level'; value: number }
  | { kind: 'unparseable'; raw: string }
  | { kind: 'unknown' };

/**
 * Creature level for budget sums — the SAME parser that orders the bestiary
 * roster (`parseLevelSort`, the one level parser in the codebase), with two
 * budget-specific readings: '—' (CR-less summons) contributes 0, and a
 * level the parser cannot read is reported as `unparseable` (the room
 * becomes loud-unverified — never silently dropped, AGENTS rule 1).
 */
export function parseBudgetLevel(level: string | undefined): ParsedBudgetLevel {
  if (level === undefined || level.trim() === '') return { kind: 'unknown' };
  const trimmed = level.trim();
  if (trimmed === '—') return { kind: 'level', value: 0 };
  try {
    return { kind: 'level', value: parseLevelSort(trimmed) };
  } catch {
    return { kind: 'unparseable', raw: trimmed };
  }
}

export interface BudgetCreature {
  name: string;
  count: number;
  /** The creature's printed level string, when its stats resolved. */
  level: string | undefined;
}

export interface BudgetRoomInput {
  roomIndex: number;
  roomName: string;
  targetLevel: number | undefined;
  creatures: readonly BudgetCreature[];
}

export interface RoomBudgetVerdict {
  roomIndex: number;
  roomName: string;
  status: 'ok' | 'over' | 'unverified';
  /** Sum of assigned creature levels (0 for unverified rooms). */
  sumLevels: number;
  /** Band upper used for the verdict; null when no target was derivable. */
  bandUpper: number | null;
  targetLevel: number | null;
  /** One step below the target (floor 1) — set only for 'over' verdicts. */
  loweredTargetLevel: number | null;
  /** Repair-turn issue text ('over' on the pre-repair pass). */
  issue: string | null;
  /** Loud advisory text ('over' after the final pass; 'unverified'). */
  advisory: string | null;
}

/** The verdict for one room against the documented band. */
export function checkRoomBudget(room: BudgetRoomInput): RoomBudgetVerdict {
  const base: RoomBudgetVerdict = {
    roomIndex: room.roomIndex,
    roomName: room.roomName,
    status: 'ok',
    sumLevels: 0,
    bandUpper: null,
    targetLevel: null,
    loweredTargetLevel: null,
    issue: null,
    advisory: null,
  };
  const problems: string[] = [];
  let sum = 0;
  for (const creature of room.creatures) {
    const parsed = parseBudgetLevel(creature.level);
    if (parsed.kind === 'level') {
      sum += parsed.value * creature.count;
      continue;
    }
    if (parsed.kind === 'unknown') {
      problems.push(`"${creature.name}" has no readable level`);
    } else {
      problems.push(`"${creature.name}" has an unreadable level "${parsed.raw}"`);
    }
  }
  if (problems.length > 0) {
    return {
      ...base,
      status: 'unverified',
      sumLevels: sum,
      advisory:
        `Room "${room.roomName}": challenge not budget-verified — ${problems.join(', ')}. ` +
        'Review the room by hand or re-run with resolvable stat sources.',
    };
  }
  if (room.targetLevel === undefined) {
    return {
      ...base,
      status: 'unverified',
      sumLevels: sum,
      advisory:
        `Room "${room.roomName}": no target level is derivable (the room carries no targetLevel and the ` +
        'encounter\'s level hint has no digits) — challenge not budget-verified. Set a target level in the editor.',
    };
  }
  const bandUpper = roomBudgetBandUpper(room.targetLevel);
  if (sum <= bandUpper) {
    return { ...base, sumLevels: sum, bandUpper, targetLevel: room.targetLevel };
  }
  const lowered = Math.max(1, room.targetLevel - 1);
  return {
    ...base,
    status: 'over',
    sumLevels: sum,
    bandUpper,
    targetLevel: room.targetLevel,
    loweredTargetLevel: lowered,
    issue:
      `rooms[${String(room.roomIndex)}].targetLevel ("${room.roomName}"): the assigned creatures sum to ` +
      `${sumLabel(sum)} creature-levels, over the band of at most ${String(bandUpper)} for target level ` +
      `${String(room.targetLevel)} — the room alone would overpower the party. Lower this room to ` +
      `"targetLevel": ${String(lowered)} and field weaker or fewer creatures so it fits its band.`,
    advisory:
      `Room "${room.roomName}" ships over its challenge budget: the assigned creatures sum to ` +
      `${sumLabel(sum)} creature-levels against a band of at most ${String(bandUpper)} for target level ` +
      `${String(room.targetLevel)}. Review the room or regenerate the map.`,
  };
}

function sumLabel(sum: number): string {
  return Number.isInteger(sum) ? String(sum) : sum.toFixed(1);
}

/** The pf2e loud advisory (deterministic replacement for the numeric check). */
export const PF2E_BUDGET_ADVISORY =
  'Per-room challenge was not deterministically budget-checked: pathfinder2e encounter budgets are ' +
  'Paizo\'s (GM Core) and no numeric budget ships with Campaigner. The Cartographer was directed to the ' +
  'retrieved GM Core excerpts verbatim when present; review each room\'s challenge.';

/**
 * The budget-loop mode for a system: 'band' runs the documented dnd5e-style
 * numeric check; 'verbatim' ships no numbers (Paizo licensing) and persists
 * the loud pf2e advisory instead.
 */
export function roomBudgetMode(system: GameSystem): 'band' | 'verbatim' {
  return system === 'pathfinder2e' ? 'verbatim' : 'band';
}

/** The prompt clause teaching the per-room challenge contract. */
export function roomBudgetGuidanceFor(system: GameSystem): string {
  const shared = [
    'Per-room challenge: every room must ALONE challenge the party — a complex is a sequence of fights, not one fight spread thin.',
    'Each room carries a "targetLevel": the party level this room alone should challenge. When you omit it, the encounter\'s own level is used.',
  ].join('\n');
  if (roomBudgetMode(system) === 'verbatim') {
    return [
      shared,
      'pathfinder2e budget: the GM Core encounter-building rules are the law — when the retrieved rule excerpts include them, follow those budgets VERBATIM per room (exact XP values, never a paraphrase of a Paizo number). When the excerpts do NOT include the encounter-budget rules, set each room\'s "targetLevel" from the party level and describe the intended difficulty without inventing XP amounts.',
    ].join('\n');
  }
  return [
    shared,
    `dnd5e band (Campaigner's own documented approximation; the DMG encounter-building tables are not licensable, so no DMG text is quoted or restated): a room is over budget when its assigned creatures' levels (CR) sum to more than targetLevel + ${String(ROOM_BUDGET_OVER_MARGIN)}. Fractional levels (1/2, 1/4) count fractionally; "—" (CR-less summons) counts as 0. Stay at or under the band — under is fine (a quiet room is a feature).`,
  ].join('\n');
}

// --- Roster level resolution -------------------------------------------------

export interface BriefLevelLookups {
  /** Chunk stat blocks by id (the retrieval pool + roster citations). */
  chunkById: ReadonlyMap<Id, RuleChunk>;
  rosterChunkByName: Readonly<Record<string, Id>>;
  statblockChunkIds: readonly Id[];
}

/**
 * Level strings for a FRESH brief's monsters: inline stat block → roster
 * name citation → excerpt index citation (the M-B §7 precedence). Entries
 * with no resolvable stats yield undefined (the room becomes loud-unverified).
 */
export function resolveBriefMonsterLevels(
  monsters: readonly {
    statBlock?: StatBlock | undefined;
    sourceName?: string | undefined;
    sourceChunkIndex?: number | undefined;
  }[],
  lookups: BriefLevelLookups,
): (string | undefined)[] {
  return monsters.map((monster) => {
    if (monster.statBlock !== undefined) return monster.statBlock.level;
    if (monster.sourceName !== undefined) {
      const chunkId = lookups.rosterChunkByName[monster.sourceName];
      const chunk = chunkId === undefined ? undefined : lookups.chunkById.get(chunkId);
      return chunk?.statBlock?.level;
    }
    if (monster.sourceChunkIndex !== undefined) {
      const chunkId = lookups.statblockChunkIds[monster.sourceChunkIndex];
      const chunk = chunkId === undefined ? undefined : lookups.chunkById.get(chunkId);
      return chunk?.statBlock?.level;
    }
    return undefined;
  });
}

export interface EntryLevelLookups {
  chunkById: ReadonlyMap<Id, RuleChunk>;
  /** Resolves an npc-ref entry's stat block (null when missing/statless). */
  getArtifactStatBlock: (artifactId: Id) => Promise<StatBlock | null>;
}

/**
 * Level strings for persisted roster entries (MonsterEntry sources) — used
 * by the in-place Smith fill, whose reconciled roster is the real thing.
 */
export async function resolveEntryLevels(
  entries: readonly MonsterEntry[],
  lookups: EntryLevelLookups,
): Promise<(string | undefined)[]> {
  const npcCache = new Map<Id, StatBlock | null>();
  return Promise.all(
    entries.map(async (entry) => {
      switch (entry.source.type) {
        case 'inline':
          return entry.source.statBlock.level;
        case 'rulebook':
          return lookups.chunkById.get(entry.source.chunkId)?.statBlock?.level;
        case 'npc-ref': {
          const cached = npcCache.get(entry.source.artifactId);
          if (cached !== undefined) return cached?.level;
          const statBlock = await lookups.getArtifactStatBlock(entry.source.artifactId);
          npcCache.set(entry.source.artifactId, statBlock);
          return statBlock?.level;
        }
        case 'none':
          return undefined;
      }
    }),
  );
}

// --- In-place fill reconciliation -------------------------------------------

export interface ReconciledRoomAssignment {
  roomId: string;
  monsterIndexes: number[];
}

/**
 * Reconciles the room→roster partition for the in-place Smith content fill
 * (docs/11 D12): the fill rewrites `data.monsters` while the layout keeps
 * its rooms byte-identical, so `room.monsterIndexes` would dangle, shift or
 * skip against the NEW roster. Exact rules (deterministic, disclosed):
 *
 * 1. **Preserve by name-match** — every existing assignment (an OLD roster
 *    index) whose creature name (trim/case-insensitive) still exists in the
 *    new roster is kept on its room, remapped to the new roster index; the
 *    FIRST room to claim a name wins (rooms in layout order), so a name is
 *    never assigned to two rooms.
 * 2. **Append round-robin** — new roster entries whose name no room claimed
 *    are appended in roster order, one room per entry, cycling
 *    rooms[0], rooms[1], … rooms[n-1], rooms[0] … (single-site layouts
 *    therefore place everything in their one room).
 * 3. **Drop the gone** — assignments whose name no longer exists in the new
 *    roster are removed.
 *
 * The result keeps the layout invariant every roster entry belongs to
 * exactly one room. Room CAPACITY is not re-derived here (the rooms keep
 * their rectangles): an overfull room fails loudly at seed via the layout
 * validation, never silently.
 */
export function reconcileRoomAssignments(
  rooms: readonly { id: string; monsterIndexes: readonly number[] }[],
  oldRoster: readonly { name: string }[],
  newRoster: readonly { name: string }[],
): ReconciledRoomAssignment[] {
  const newIndexByName = new Map<string, number>();
  for (const [index, entry] of newRoster.entries()) {
    const key = entry.name.trim().toLowerCase();
    if (!newIndexByName.has(key)) newIndexByName.set(key, index);
  }
  const claimed = new Set<number>();
  const perRoom: number[][] = rooms.map(() => []);
  // 1. preserve by name-match, room order first
  for (const [roomIndex, room] of rooms.entries()) {
    for (const oldIndex of room.monsterIndexes) {
      const oldEntry = oldRoster[oldIndex];
      if (oldEntry === undefined) continue;
      const key = oldEntry.name.trim().toLowerCase();
      const newIndex = newIndexByName.get(key);
      if (newIndex === undefined || claimed.has(newIndex)) continue; // gone / already claimed
      claimed.add(newIndex);
      perRoom[roomIndex]?.push(newIndex);
    }
  }
  // 2. append the new entries round-robin
  let cursor = 0;
  for (const [index] of newRoster.entries()) {
    if (claimed.has(index)) continue;
    const roomIndex = rooms.length === 0 ? null : cursor % rooms.length;
    cursor += 1;
    if (roomIndex === null) break;
    claimed.add(index);
    perRoom[roomIndex]?.push(index);
  }
  return rooms.map((room, roomIndex) => ({
    roomId: room.id,
    monsterIndexes: perRoom[roomIndex] ?? [],
  }));
}
