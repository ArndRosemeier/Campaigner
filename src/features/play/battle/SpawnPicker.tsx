import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { AnyArtifact, Id, MonsterEntry, NpcArtifact } from '@/domain';
import { monsterEntrySchema, newId } from '@/domain';
import { resolveMonsterEntries } from '@/db/monsterResolve';
import { listChunksByBooks } from '@/db/chunkRepo';
import { listReadyRulebooks } from '@/db/rulebookRepo';
import { buildBestiaryRows, filterRosterRows, type RosterEntry } from '@/features/bestiary/roster';
import { spawnRosterInstance } from '@/db/battleSeed';
import {
  authorAndSpawnMob,
  buildMobPickEntry,
  compareSpawnNames,
  illustrateSpawnedCreature,
  parseLevelOrLast,
  spawnPickedEntry,
} from '@/features/play/battle/spawn-picker-logic';
import { toastError, toastSuccess } from '@/lib/toast';
import { useProgressStore } from '@/lib/progress';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
 * This file owns the dialog. The spawn paths (roster picks ride
 * `spawnRosterInstance` straight from here; NPC/core-mob picks ride
 * `spawnPickedEntry`) and the pure comparators/geometry live in the
 * `spawn-picker-logic.ts` sibling.
 */

export type SpawnSortMode = 'name' | 'level';

/**
 * A pick row's classes (docs/17 row 336, defect C). On a SHORT viewport the row
 * used to squeeze its action into the label, so the Spawn buttons collided with
 * the names: the label truncates inside its own track (`min-w-0`), the action
 * never shrinks (`shrink-0`), and a long name wraps the action onto its own
 * line instead of squeezing it.
 *
 * `whitespace-nowrap` is the explicit half of that contract (docs/17 row 339):
 * `truncate` already implies `white-space: nowrap`, but the vertical invariant
 * is what the virtualized list below depends on — ONE line per label, so every
 * Core-mobs row is the height of its action button and nothing else. Groups that
 * render IN FLOW use `PICK_ROW_CLASS`; the virtualized Core-mobs rows take these
 * same label/action classes WITHOUT `flex-wrap` and are MEASURED (row 339).
 */
const PICK_ROW_CLASS = 'flex flex-wrap items-center justify-between gap-2';
const PICK_LABEL_CLASS = 'min-w-0 flex-1 truncate whitespace-nowrap text-xs';
const PICK_ACTION_CLASS = 'shrink-0';

/**
 * The Core-mobs row's INITIAL height in px — the floor the virtualizer starts
 * from, never the height its rows are given (docs/17 row 339).
 *
 * WHY A HARD px HEIGHT WAS THE DEFECT: this row's content is REM-based (the
 * `sm` action button carries `pointer-coarse:min-h-11` = 2.75rem, and
 * `app/theme/uiScale` multiplies the root font-size by `--ui-scale`, 0.9–2), so
 * its real height is 44px only at `uiScale` 1 on a fine pointer. The list was
 * the one surface whose item size was a hard `44` px literal, and the row forced
 * itself to that estimate: on the owner's iPad the pointer is COARSE (button
 * 2.75rem = 44px at scale 1, so the row's 4px vertical padding is exactly eaten
 * and adjacent buttons touch) and at scale 1.1–2 the button is 48.4–88px inside
 * a 44px box, which is the reported overlap. A fixed px height therefore cannot
 * be "proven to exceed the content" — the app's own font scale moves the content
 * — so the virtualizer MEASURES instead and this constant is only the
 * pre-measurement guess and the row's `minHeight` floor.
 */
const MOB_ROW_ESTIMATE_PX = 44;

/** A statless spawn is a loud toast (AGENTS rule 1) — never dummy numbers. */
function announceStatless(statless: readonly string[]): void {
  if (statless.length > 0) {
    toastError(`No combat stats for: ${statless.join('; ')} — they will not roll initiative`);
  }
}

/**
 * "Illustrate spawned mobs that have no image" — ONE flag, TWO placements
 * (docs/17 row 336, defect B; owner: *"Also, I do not see a checkbox to
 * illustrate it."*). The owner authored a mob and looked for the tick in the
 * AUTHOR section, so the choice is offered there as well as in the dialog
 * header; both instances are this ONE component bound to the same
 * `illustrateMissing` state, and there is only ever the one illustrate path
 * (`authorAndSpawnMob`'s `illustrate` / `illustrateAfterSpawnIfAsked`), so the
 * two placements cannot disagree and cannot double-illustrate.
 */
function IllustrateToggle({
  testId,
  checked,
  onChange,
}: {
  testId: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox
        checked={checked}
        data-testid={testId}
        aria-label="Illustrate spawned mobs that have no image"
        onCheckedChange={onChange}
      />
      Illustrate spawned mobs that have no image
    </label>
  );
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
  /**
   * "Illustrate spawned mobs that have no image" (docs/17 row 333), default
   * OFF: it spends image-model calls, so it is an explicit opt-in for this
   * dialog session — unticked spawns exactly as they always did.
   */
  const [illustrateMissing, setIllustrateMissing] = useState(false);
  /**
   * "Author a new mob" (docs/17 row 333, part 2): a name, a STRUCTURED level
   * and a free-text description. The level is the block's authority — it is
   * passed as the run's `entityLevelHint` and is never read out of the
   * description.
   */
  const [authorName, setAuthorName] = useState('');
  const [authorLevel, setAuthorLevel] = useState('');
  const [authorDescription, setAuthorDescription] = useState('');
  const [authoring, setAuthoring] = useState(false);
  /**
   * The dialog BODY is the ONE scroll container and therefore the virtualizer's
   * scroll element (docs/17 row 340) — the Core-mobs list no longer scrolls
   * inside it. `mobTrackRef` is the list's `position: relative` track (the
   * virtualizer's coordinate origin), and `mobScrollMargin` is that track's own
   * offset inside the body's content: it sits BELOW the roster and NPC groups,
   * and the virtualizer needs that offset to window the list in the BODY's
   * coordinates (see the measurement effect after the virtualizer).
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const mobTrackRef = useRef<HTMLDivElement | null>(null);
  const [mobScrollMargin, setMobScrollMargin] = useState(0);

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
      // The ONE ready-book rule (docs/17 row 184).
      const books = await listReadyRulebooks();
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

  /**
   * THE BODY IS THE VIRTUALIZER'S SCROLL ELEMENT (docs/17 row 340). Before this
   * row the Core-mobs list carried its OWN `max-h-56 overflow-auto` scroller and
   * the virtualizer observed THAT element, so the dialog had two nested scrollers
   * and the finger's momentum could be swallowed by the inner one. ONE scroller
   * remains — the body — and the virtualizer windows the list against it; the
   * list's own track keeps the measurement (row 339) and the invariants.
   *
   * `scrollMargin` is the track's offset inside the BODY's content, and it is
   * load-bearing rather than cosmetic: the virtualizer computes its visible range
   * as `[scrollOffset, scrollOffset + viewportHeight]` and compares it against
   * `item.start`, which is CONTENT-relative. With the roster and NPC groups above
   * the track the origin is not 0, so a missing margin shifts the window by those
   * groups' height and the top of the list can render blank. The rows therefore
   * position themselves at `item.start - scrollMargin` (the track's own
   * coordinates), exactly as the library's own direct-DOM path does.
   */
  const mobVirtualizer = useVirtualizer({
    count: visibleMobEntries.length,
    getScrollElement: () => bodyRef.current,
    scrollMargin: mobScrollMargin,
    estimateSize: () => MOB_ROW_ESTIMATE_PX,
    overscan: 12,
    /**
     * MEASURE the row, never assume it (docs/17 row 339). The row is absolutely
     * positioned and takes its height from its own content, so the real height is
     * whatever the action button needs at THIS root font size; `getBoundingClientRect`
     * is read rather than the library's default `offsetHeight` because it is also
     * the arm jsdom can drive (the pins stub the row's rect and require the row
     * PITCH to follow it). `Math.max` keeps `MOB_ROW_ESTIMATE_PX` as the floor in
     * both worlds: a browser whose rect is smaller than the estimate (fine
     * pointer) and jsdom, which computes no layout at all and answers 0 — so no
     * row can collapse to zero height in a layout-less environment.
     */
    measureElement: (element: Element): number =>
      Math.max(MOB_ROW_ESTIMATE_PX, element.getBoundingClientRect().height),
  });

  /**
   * Measure the Core-mobs track's offset inside the body after layout, and ONLY
   * when the content ABOVE the track can have changed (a new query, more or fewer
   * roster/NPC rows, a rulebook finishing its load, the list appearing at all) —
   * never on scroll, where the offset cannot change and a forced layout read per
   * frame is exactly the jank this dialog is being cured of.
   *
   * jsdom computes no layout: both rects are the all-zero default and `scrollTop`
   * is 0, so the margin stays 0 and the row-339 pins keep seeing the pitch they
   * already pin (the pins that DO exercise the offset stub the track's rect — see
   * `spawn-picker-illustrate.test`). On a real device this is the offset the
   * virtualizer needs, and NO TEST can verify the rendering it produces: jsdom
   * cannot scroll by touch (docs/17 row 340).
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const track = mobTrackRef.current;
    if (body === null || track === null) return;
    const margin =
      track.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    setMobScrollMargin((current) => (current === margin ? current : margin));
  }, [
    open,
    query,
    visibleRoster.length,
    visibleNpcs.length,
    mobErrors.length,
    library,
    visibleMobEntries.length,
  ]);

  /** The npc artifact an entry points at, from the snapshot this dialog already
   * holds — the grounding `rosterParticipantRoute` needs for an `npc-ref`. */
  function linkedArtifactFor(entry: MonsterEntry): AnyArtifact | undefined {
    const source = entry.source;
    return source.type === 'npc-ref'
      ? artifacts.find((artifact) => artifact.id === source.artifactId)
      : undefined;
  }

  /**
   * The ticked checkbox's fill, run AFTER a successful spawn (docs/17 row 333):
   * ONE creature per spawn, through the existing single-mob portrait seam. A
   * failure here never reads as a spawn failure — the token is already on the
   * board — so it toasts on its own loud path (AGENTS rule 2).
   */
  async function illustrateAfterSpawnIfAsked(entry: MonsterEntry): Promise<void> {
    if (!illustrateMissing) return;
    try {
      await illustrateSpawnedCreature({ campaignId, entry, linked: linkedArtifactFor(entry) });
    } catch (error) {
      toastError(`Could not illustrate “${entry.name}”`, error);
    }
  }

  async function spawnRosterPick(index: number): Promise<void> {
    try {
      const result = await spawnRosterInstance(battleId, index);
      announceStatless(result.statless);
      const entry = roster[index];
      if (entry !== undefined) await illustrateAfterSpawnIfAsked(entry);
    } catch (error) {
      toastError('Could not spawn from the roster', error);
    }
  }

  async function spawnNpcPick(pick: NpcPick): Promise<void> {
    try {
      const entry = monsterEntrySchema.parse({
        name: pick.name,
        count: 1,
        notes: '',
        treasure: '',
        source: { type: 'npc-ref', artifactId: pick.artifactId },
      });
      const result = await spawnPickedEntry(battleId, entry);
      announceStatless(result.statless);
      await illustrateAfterSpawnIfAsked(entry);
    } catch (error) {
      toastError(`Could not spawn “${pick.name}”`, error);
    }
  }

  async function spawnMobPick(row: RosterEntry): Promise<void> {
    try {
      const entry = await buildMobPickEntry(row.chunkId, row.name);
      const result = await spawnPickedEntry(battleId, entry);
      announceStatless(result.statless);
      await illustrateAfterSpawnIfAsked(entry);
    } catch (error) {
      toastError(`Could not spawn “${row.name}”`, error);
    }
  }

  /**
   * "Author & spawn" (docs/17 row 333, part 2): ONE press creates the npc
   * through the campaign tree's own seam, runs the NPC Smith at the STRUCTURED
   * level, and spawns the result — or, on a failed run or a blockless result,
   * spawns NOTHING and says so loudly (the logic throws; this is the surface).
   *
   * The run is observable on the EXISTING app-wide progress dock (`lib/progress`
   * — the same surface the encounter runs use), and BOTH the in-flight detail
   * and the success toast name the level that was used, so a wrong number is
   * visible rather than implicit.
   */
  async function authorMob(): Promise<void> {
    const name = authorName.trim();
    const level = Number(authorLevel);
    const progressId = `author-mob-${newId()}`;
    useProgressStore
      .getState()
      .start(progressId, 'Authoring a new mob', `Level ${authorLevel.trim()} — “${name}”: writing…`);
    setAuthoring(true);
    try {
      const result = await authorAndSpawnMob({
        campaignId,
        battleId,
        name,
        level,
        description: authorDescription,
        illustrate: illustrateMissing,
      });
      announceStatless(result.spawn.statless);
      toastSuccess(
        `Spawned “${result.name}” at level ${String(result.level)} with its stat block`,
      );
      setAuthorName('');
      setAuthorLevel('');
      setAuthorDescription('');
    } catch (error) {
      toastError(`Could not author and spawn “${name}”`, error);
    } finally {
      setAuthoring(false);
      useProgressStore.getState().finish(progressId);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="spawn-picker"
        className="flex max-h-[85vh] flex-col overflow-hidden supports-[height:100svh]:max-h-[min(85svh,85dvh)] sm:max-w-lg"
      >
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
        <IllustrateToggle
          testId="spawn-picker-illustrate"
          checked={illustrateMissing}
          onChange={setIllustrateMissing}
        />
        {/* THE BODY IS THE *ONLY* SCROLLER, AND THE VIRTUALIZER WINDOWS THE
            CORE-MOBS LIST AGAINST IT (docs/17 rows 336 and 340): the dialog is a
            flex column capped against the SMALL visible viewport (`svh` behind
            `@supports`, with the `vh` fallback — docs/17 row 340 — and
            `overflow-hidden` on the content), so the header, the search field and
            the illustrate ticks stay reachable on a short iPad viewport while
            these groups scroll inside `min-h-0 flex-1`. The Core-mobs list no
            longer carries a scroller of its own: a second, nested scroll box was
            one of the two candidate mechanisms behind *"Spawn dialog now does not
            scroll anymore on my ipad"*, and the virtualizer observes THIS
            element (`getScrollElement`). */}
        <div
          ref={bodyRef}
          data-testid="spawn-picker-body"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
        >
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
                  <li key={pick.index} className={PICK_ROW_CLASS}>
                    <span className={PICK_LABEL_CLASS}>
                      {pick.name} ×{String(pick.count)}
                      {pick.level !== null && pick.level !== '' && (
                        <span className="ml-1 text-zinc-500">Lv {pick.level}</span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className={PICK_ACTION_CLASS}
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
                  <li key={pick.artifactId} className={PICK_ROW_CLASS}>
                    <span className={PICK_LABEL_CLASS}>
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
                      className={PICK_ACTION_CLASS}
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
                {/* NO SCROLLER HERE (docs/17 row 340): the body above is the ONE
                    scroll container, and this list is a plain block inside it —
                    the virtualizer still windows it, against the BODY. */}
                {visibleMobEntries.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    {needle === ''
                      ? 'No rulebook creatures — import a bestiary pack or a rulebook PDF with stat blocks.'
                      : 'No creatures match.'}
                  </p>
                ) : (
                  <div data-testid="spawn-picker-mob-list">
                    <div
                      ref={mobTrackRef}
                      data-testid="spawn-picker-mob-track"
                      style={{ height: `${String(mobVirtualizer.getTotalSize())}px`, position: 'relative' }}
                    >
                      {mobVirtualizer.getVirtualItems().map((item) => {
                        const entry = visibleMobEntries[item.index];
                        if (entry === undefined) return null;
                        return (
                          <div
                            key={entry.chunkId}
                            ref={mobVirtualizer.measureElement}
                            data-index={item.index}
                            data-testid="spawn-picker-mob-row"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              /* The estimate is a FLOOR, never the height (docs/17
                                 row 339). `height: item.size` made the measurement
                                 self-fulfilling: the row was 44px by decree, so it
                                 could never report the 48.4–88px its own action
                                 button needs once `--ui-scale` > 1. */
                              minHeight: MOB_ROW_ESTIMATE_PX,
                              /* The track's OWN coordinates: `item.start` is
                                 content-relative (it includes the row-340
                                 `scrollMargin`), so the offset comes back out
                                 here — exactly what the library's own direct-DOM
                                 path writes. */
                              transform: `translateY(${String(item.start - mobScrollMargin)}px)`,
                            }}
                            className="flex items-center justify-between gap-2 py-1"
                          >
                            <span className={PICK_LABEL_CLASS}>
                              {entry.name}
                              {entry.level !== '' && (
                                <span className="ml-1 text-zinc-500">Lv {entry.level}</span>
                              )}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              className={PICK_ACTION_CLASS}
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
          <section
            aria-label="Author a new mob"
            data-testid="spawn-picker-author"
            className="border-t border-white/10 pt-3"
          >
            <p className="mb-1 text-xs font-medium text-zinc-400">Author a new mob (NPC Smith)</p>
            {/* Defect B: the SAME choice as the header's, where the owner
                looked for it. One state, one illustrate path. */}
            <div className="mb-2">
              <IllustrateToggle
                testId="spawn-picker-author-illustrate"
                checked={illustrateMissing}
                onChange={setIllustrateMissing}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Input
                className="h-8 text-sm"
                placeholder="Mob name"
                aria-label="New mob name"
                value={authorName}
                data-testid="author-mob-name"
                onChange={(event) => {
                  setAuthorName(event.target.value);
                }}
              />
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 w-20 shrink-0 text-sm"
                  type="number"
                  min={1}
                  max={20}
                  placeholder="Level"
                  aria-label="New mob level (1–20)"
                  value={authorLevel}
                  data-testid="author-mob-level"
                  onChange={(event) => {
                    setAuthorLevel(event.target.value);
                  }}
                />
                <span className="text-xs text-zinc-500">
                  Level 1–20 — the stat block is built at exactly this level
                </span>
              </div>
              <Textarea
                className="text-sm"
                rows={2}
                placeholder="What is this mob? Flavour only — it never sets the level."
                aria-label="New mob description"
                value={authorDescription}
                data-testid="author-mob-description"
                onChange={(event) => {
                  setAuthorDescription(event.target.value);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={authoring || authorName.trim() === '' || authorLevel.trim() === ''}
                data-testid="author-mob-submit"
                onClick={() => {
                  void authorMob();
                }}
              >
                {authoring ? 'Authoring…' : 'Author & spawn'}
              </Button>
              <p className="text-xs text-zinc-500">
                The Smith writes the mob and its stat block; it reaches the board only when the
                block is there.
              </p>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
