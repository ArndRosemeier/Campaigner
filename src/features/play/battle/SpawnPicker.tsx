import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';

import type {
  AnyArtifact,
  Id,
  MonsterEntry,
  NpcArtifact,
  StagingGround,
} from '@/domain';
import { monsterEntrySchema } from '@/domain';
import { fallbackSpawnPoint, spawnPointInStagingGround } from '@/domain/battle/board';
import { getBattle, patchBattle } from '@/db/battleRepo';
import { expandRosterEntries, spawnRosterInstance, type SpawnReport } from '@/db/battleSeed';
import { listChunksByBooks } from '@/db/chunkRepo';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { listRulebooks } from '@/db/rulebookRepo';
import { buildBestiaryRows, filterRosterRows, type RosterEntry } from '@/features/bestiary/roster';
import { parseLevelSort } from '@/llm/encounterRoster';
import { NotFoundError } from '@/lib/errors';
import { toastError } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Mid-fight spawn picker (spawn-picker arc): ONE "Spawn" button on the battle
 * rail opens this dialog instead of the old per-roster-entry Spawn buttons.
 * Three groups — (1) this encounter's roster, (2) campaign NPCs, (3) core
 * rulebook mobs — share one search field and one name/level sort toggle.
 *
 * Spawn paths (no parallel paths — the file-boundary rule keeps battleSeed
 * itself untouched, so this file composes its exported seams):
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

export type SpawnSortMode = 'name' | 'level';

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

/** A statless spawn is a loud toast (AGENTS rule 1) — never dummy numbers. */
function announceStatless(statless: readonly string[]): void {
  if (statless.length > 0) {
    toastError(`No combat stats for: ${statless.join('; ')} — they will not roll initiative`);
  }
}

export interface SpawnPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  battleId: Id;
  campaignId: Id;
  /** The provenance encounter's roster (group 1) + its name for the header. */
  roster: readonly MonsterEntry[];
  encounterName: string;
  /** Campaign + global artifacts; npc-kind rows of this campaign are group 2. */
  artifacts: readonly AnyArtifact[];
}

interface RosterPick {
  index: number;
  name: string;
  count: number;
  level: string | null;
}

interface NpcPick {
  artifactId: Id;
  name: string;
  level: string | null;
}

export function SpawnPicker({
  open,
  onOpenChange,
  battleId,
  campaignId,
  roster,
  encounterName,
  artifacts,
}: SpawnPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SpawnSortMode>('name');
  const mobListRef = useRef<HTMLDivElement | null>(null);

  // The roster entries' levels need async stat resolution (same resolver the
  // Stat blocks panel uses); NPC/mob levels read straight off their blocks.
  // Loaded only while the dialog is open.
  const rosterKey = useMemo(() => JSON.stringify(roster), [roster]);
  const resolvedRoster = useLiveQuery(
    async () => {
      if (!open) return undefined;
      const entries = monsterEntrySchema.array().parse(JSON.parse(rosterKey) as unknown);
      return resolveMonsterEntries(entries);
    },
    [open, rosterKey],
    undefined,
  );

  const library = useLiveQuery(
    async () => {
      if (!open) return undefined;
      const books = (await listRulebooks()).filter((book) => book.status === 'ready');
      const chunks = await listChunksByBooks(books.map((book) => book.id));
      return { books, chunks };
    },
    [open],
    undefined,
  );

  const rosterPicks: RosterPick[] = useMemo(
    () =>
      roster.map((entry, index) => ({
        index,
        name: entry.name,
        count: entry.count,
        level: resolvedRoster?.[index]?.statBlock?.level ?? null,
      })),
    [roster, resolvedRoster],
  );

  const npcPicks: NpcPick[] = useMemo(() => {
    const npcs = artifacts.filter(
      (artifact): artifact is NpcArtifact =>
        artifact.kind === 'npc' && artifact.campaignId === campaignId,
    );
    return npcs.map((npc) => ({ artifactId: npc.id, name: npc.name, level: npc.data.statBlock?.level ?? null }));
  }, [artifacts, campaignId]);

  const mobRows = useMemo(() => {
    if (library === undefined) return undefined;
    return filterRosterRows(buildBestiaryRows(library.books, library.chunks), query);
  }, [library, query]);

  const needle = query.trim().toLowerCase();
  const matches = (name: string): boolean => needle === '' || name.toLowerCase().includes(needle);

  const sortPicks = <T extends { name: string; level: string | null }>(picks: readonly T[]): T[] =>
    [...picks].sort((a, b) =>
      sortMode === 'level'
        ? parseLevelOrLast(a.level) - parseLevelOrLast(b.level) || compareSpawnNames(a.name, b.name)
        : compareSpawnNames(a.name, b.name),
    );

  const visibleRoster = sortPicks(rosterPicks.filter((pick) => matches(pick.name)));
  const visibleNpcs = sortPicks(npcPicks.filter((pick) => matches(pick.name)));
  const visibleMobEntries: RosterEntry[] = useMemo(() => {
    if (mobRows === undefined) return [];
    const entries = mobRows.filter((row): row is RosterEntry => row.kind === 'entry');
    if (sortMode === 'level') {
      return [...entries].sort(
        (a, b) => a.levelSort - b.levelSort || compareSpawnNames(a.name, b.name),
      );
    }
    return [...entries].sort((a, b) => compareSpawnNames(a.name, b.name));
  }, [mobRows, sortMode]);
  const mobErrors = useMemo(
    () => mobRows?.filter((row) => row.kind === 'data-error') ?? [],
    [mobRows],
  );

  const mobVirtualizer = useVirtualizer({
    count: visibleMobEntries.length,
    getScrollElement: () => mobListRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  async function spawnRosterPick(index: number): Promise<void> {
    try {
      const result = await spawnRosterInstance(battleId, index);
      announceStatless(result.statless);
    } catch (error) {
      toastError('Could not spawn from the roster', error);
    }
  }

  async function spawnNpcPick(pick: NpcPick): Promise<void> {
    try {
      const result = await spawnPickedEntry(
        battleId,
        monsterEntrySchema.parse({
          name: pick.name,
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: pick.artifactId },
        }),
      );
      announceStatless(result.statless);
    } catch (error) {
      toastError(`Could not spawn “${pick.name}”`, error);
    }
  }

  async function spawnMobPick(entry: RosterEntry): Promise<void> {
    try {
      const result = await spawnPickedEntry(
        battleId,
        monsterEntrySchema.parse({
          name: entry.name,
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: entry.chunkId },
        }),
      );
      announceStatless(result.statless);
    } catch (error) {
      toastError(`Could not spawn “${entry.name}”`, error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="spawn-picker" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Spawn into battle</DialogTitle>
          <DialogDescription>
            Reinforcements land on a free spot near the board center through the shared seed
            path — labels continue the on-board count, and picks without combat stats toast
            loudly instead of spawning dummy numbers.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            className="h-8 text-sm"
            placeholder="Search all groups…"
            aria-label="Search spawn candidates by name"
            value={query}
            data-testid="spawn-picker-search"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            data-testid="spawn-picker-sort"
            aria-label={`Sort spawn candidates by ${sortMode === 'name' ? 'level' : 'name'}`}
            onClick={() => {
              setSortMode((mode) => (mode === 'name' ? 'level' : 'name'));
            }}
          >
            Sort: {sortMode === 'name' ? 'Name' : 'Level'}
          </Button>
        </div>
        <div className="flex max-h-[50vh] min-h-0 flex-col gap-3 overflow-y-auto pr-1">
          <section aria-label="This encounter" data-testid="spawn-picker-group-roster">
            <p className="mb-1 text-xs font-medium text-zinc-400">
              This encounter — “{encounterName}”
            </p>
            {roster.length === 0 ? (
              <p className="text-xs text-zinc-500">The seeding encounter has no roster.</p>
            ) : visibleRoster.length === 0 ? (
              <p className="text-xs text-zinc-500">No roster entries match.</p>
            ) : (
              <ul className="space-y-1">
                {visibleRoster.map((pick) => (
                  <li key={pick.index} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs">
                      {pick.name} ×{String(pick.count)}
                      {pick.level !== null && pick.level !== '' && (
                        <span className="ml-1 text-zinc-500">Lv {pick.level}</span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`spawn-pick-roster-${String(pick.index)}`}
                      onClick={() => {
                        void spawnRosterPick(pick.index);
                      }}
                    >
                      Spawn
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Campaign NPCs" data-testid="spawn-picker-group-npcs">
            <p className="mb-1 text-xs font-medium text-zinc-400">Campaign NPCs</p>
            {npcPicks.length === 0 ? (
              <p className="text-xs text-zinc-500">No campaign NPCs yet.</p>
            ) : visibleNpcs.length === 0 ? (
              <p className="text-xs text-zinc-500">No NPCs match.</p>
            ) : (
              <ul className="space-y-1">
                {visibleNpcs.map((pick) => (
                  <li key={pick.artifactId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs">
                      {pick.name}
                      {pick.level !== null && pick.level !== '' ? (
                        <span className="ml-1 text-zinc-500">Lv {pick.level}</span>
                      ) : (
                        <span className="ml-1 text-amber-400">no stats</span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`spawn-pick-npc-${pick.artifactId}`}
                      onClick={() => {
                        void spawnNpcPick(pick);
                      }}
                    >
                      Spawn
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Core mobs" data-testid="spawn-picker-group-mobs">
            <p className="mb-1 text-xs font-medium text-zinc-400">Core mobs</p>
            {library === undefined ? (
              <p className="text-xs text-zinc-500">Loading rulebook creatures…</p>
            ) : (
              <>
                {mobErrors.map((error) => (
                  <p key={error.chunkId} className="text-xs text-destructive" data-testid="spawn-picker-mob-error">
                    {error.message}
                  </p>
                ))}
                {visibleMobEntries.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    {needle === ''
                      ? 'No rulebook creatures — import a bestiary pack or a rulebook PDF with stat blocks.'
                      : 'No creatures match.'}
                  </p>
                ) : (
                  <div ref={mobListRef} className="max-h-56 overflow-auto" data-testid="spawn-picker-mob-list">
                    <div
                      style={{ height: `${String(mobVirtualizer.getTotalSize())}px`, position: 'relative' }}
                    >
                      {mobVirtualizer.getVirtualItems().map((item) => {
                        const entry = visibleMobEntries[item.index];
                        if (entry === undefined) return null;
                        return (
                          <div
                            key={entry.chunkId}
                            data-testid="spawn-picker-mob-row"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: `${String(item.size)}px`,
                              transform: `translateY(${String(item.start)}px)`,
                            }}
                            className="flex items-center justify-between gap-2 py-1"
                          >
                            <span className="min-w-0 truncate text-xs">
                              {entry.name}
                              {entry.level !== '' && (
                                <span className="ml-1 text-zinc-500">Lv {entry.level}</span>
                              )}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`spawn-pick-mob-${entry.chunkId}`}
                              onClick={() => {
                                void spawnMobPick(entry);
                              }}
                            >
                              Spawn
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
