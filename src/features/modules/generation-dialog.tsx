import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { SparklesIcon } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { BlockedControl } from '@/components/blocked-control';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AnyArtifact, Campaign, EntityKind, Module } from '@/domain';
import {
  defaultEncounterFloorGuardrail,
  deriveLevelProblems,
  encounterFloorGuardrailFor,
  ENTITY_KINDS,
  levelProblemLine,
  MODULE_PREMISE_LEVEL,
  moduleDocumentFromView,
  moduleLevelList,
} from '@/domain';
import { patchModule } from '@/db/moduleRepo';
import {
  GENERATION_KINDS,
  generationKindLabel,
  NO_OVERWRITE_LANES,
  overwriteJobCount,
  overwriteScopeActive,
  redrawnByDetail,
  selectGenerationTargets,
  type GenerationKind,
  type GenerationLevelRange,
  type GenerationOverwriteScope,
  type GenerationOverwrites,
} from '@/features/modules/generation-selection';
import { namesAwaitingGate } from '@/features/modules/entity-gate';
import {
  generationRunJobId,
  runGenerationSelection,
  type GenerationRunReport,
} from '@/features/modules/generation-run';
import { useProgressStore } from '@/lib/progress';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { toastError, toastInfo } from '@/lib/toast';

/**
 * ============================================================================
 * THE DETAIL GENERATION DIALOG (docs/23 §7, docs/17 row 394) — the owner's own
 * request: *"No automatism, a detail generation dialog with checkboxes and level
 * ranges (for example: generate everything but encounters and images for levels
 * 1-3, although 6 levels are already defined). … I do not need the old
 * generation mechanism anymore."*
 *
 * IT STATES ITS SCOPE BEFORE IT RUNS. Every tick and every range change
 * re-derives the selection through the ONE seam
 * (`features/modules/generation-selection`) and prints the LEVELS, the KINDS and
 * the TARGET COUNT — so an empty or surprising selection is visible before any
 * work starts. A WIDE selection (more jobs than `WIDE_SELECTION_JOBS`) asks for a
 * second, explicit confirmation naming the same count.
 *
 * OVERWRITE IS ONE BOX, OFF BY DEFAULT (docs/17 row 422 — the owner's model
 * evaluation: "all selected details that were already there get removed and
 * generated freshly"). Ticked, the selection ALSO covers what already exists,
 * and Generate asks before it replaces anything: the SAME confirmation as a wide
 * selection (never two stacked questions), naming the per-kind counts and what
 * happens to the old work — text stays restorable from revisions, old images
 * are deleted once the fresh ones have landed. Nothing to replace, no question.
 *
 * THE DEDUPE RULE AND THE PREMISE ARE SAID OUT LOUD. An entity named in several
 * levels is generated ONCE, at its FIRST mention — the dialog lists the affected
 * names and their later levels rather than choosing silently. A name that only
 * the premise mentions has NO level yet; it is a NAMED bucket, selected ONLY by
 * putting the range's low bound on "Premise (no level yet)".
 *
 * EVERY CHOICE IS EXPLICIT AND OFF UNLESS TICKED: entity kinds default to all
 * six (the owner's "generate everything but encounters and images" is two
 * untickings away), per-kind images/ battlemaps/ mob portraits default to OFF (the image kinds are a remembered preference), and
 * nothing in this app generates on its own any more.
 * ============================================================================
 */

/** Above this many jobs, the run asks a second, explicit question. */
export const WIDE_SELECTION_JOBS = 12;

/** The dialog's initial kinds: the six entity kinds. Images are opt-in. */
const DEFAULT_KINDS: readonly GenerationKind[] = ENTITY_KINDS;

/** "Level 3" / "Premise (no level yet)". */
function levelLabel(level: number): string {
  return level === MODULE_PREMISE_LEVEL ? 'Premise (no level yet)' : `Level ${String(level)}`;
}

/**
 * The overwrite's four LANES (docs/17 row 429) — ONE independent choice per kind
 * of work, in the order the scope statement counts them. The owner's felt
 * problem: *"if i just want to overwrite all the images i can not do that,
 * button is grey until i select a kind. Which would be wrong since i only want
 * to redo images."* Ticking IMAGES alone is now a complete answer.
 */
const OVERWRITE_LANES: readonly { id: keyof GenerationOverwriteScope; label: string }[] = [
  { id: 'details', label: 'Details — regenerate the selected kinds’ text in place' },
  { id: 'images', label: 'Images — replace every existing cover of the selected kinds' },
  { id: 'battlemaps', label: 'Battlemaps — redraw the selected encounters’ maps' },
  {
    id: 'mobPortraits',
    label: 'Mob portraits — regenerate the selected encounters’ portraits',
  },
];

/** "details, images" — the lanes the overwrite was asked for, for the scope line. */
function overwriteLaneLine(scope: GenerationOverwriteScope): string {
  const parts = [
    [scope.details, 'details'],
    [scope.images, 'images'],
    [scope.battlemaps, 'battlemaps'],
    [scope.mobPortraits, 'mob portraits'],
  ] as const;
  return parts
    .filter(([on]) => on)
    .map(([, label]) => label)
    .join(', ');
}

/** "3 details, 1 image" — the overwrite counts per kind of work, zeros left out. */
function overwriteCountLine(overwrites: GenerationOverwrites): string {
  const parts = [
    [overwrites.details.length, 'detail', 'details'],
    [overwrites.images.length, 'image', 'images'],
    [overwrites.maps.length, 'battlemap', 'battlemaps'],
    [overwrites.mobPortraits.length, 'encounter’s mob portraits', 'encounters’ mob portraits'],
  ] as const;
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${String(count)} ${count === 1 ? one : many}`)
    .join(', ');
}

/** "Levels 1–3" / "Level 2" / "the premise only (no level yet)". */
function rangeLabel(range: GenerationLevelRange): string {
  if (range.min === range.max) return levelLabel(range.min);
  return `${levelLabel(range.min)} – ${levelLabel(range.max)}`;
}

export interface GenerationDialogProps {
  module: Module;
  campaign: Campaign;
  artifacts: readonly AnyArtifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why generation cannot run right now (null = it can) — a busy module. */
  blockedReason: string | null;
}

/**
 * The generation dialog itself. Mounted only while open (the caller mounts it
 * conditionally), so its derivation never runs on a page that is not asking for
 * it.
 */
export function GenerationDialog({
  module,
  campaign,
  artifacts,
  open,
  onOpenChange,
  blockedReason,
}: GenerationDialogProps): JSX.Element {
  const list = useMemo(
    () => moduleLevelList(moduleDocumentFromView(module), module.entityKinds),
    [module],
  );
  const highestLevel = Math.max(list.levelMax, MODULE_PREMISE_LEVEL);

  const [kinds, setKinds] = useState<readonly GenerationKind[]>(DEFAULT_KINDS);
  // The default range is every level SECTION (1..levelMax) — the premise bucket
  // is an opt-in, so a premise-only entity is never generated by accident.
  const [range, setRange] = useState<GenerationLevelRange>({
    min: Math.min(1, highestLevel),
    max: highestLevel,
  });
  const [battlemaps, setBattlemaps] = useState(false);
  const [mobPortraits, setMobPortraits] = useState(false);
  // The overwrite LANES (docs/17 rows 422/429): every lane OFF unless ticked,
  // never remembered — replacing existing work is a choice made for ONE run.
  // The lanes are INDEPENDENT, so "redo only the images" is one tick and never
  // drags the details in with it.
  const [overwrite, setOverwrite] = useState<GenerationOverwriteScope>(NO_OVERWRITE_LANES);
  const overwriteActive = overwriteScopeActive(overwrite);
  // A run for this module is in progress while its dock entry exists (docs/17
  // row 419) — the dialog closes at once, so this is what a reopened dialog
  // reads, never a flag that died with the last one.
  const running = useGenerationRunActive(module.id);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The ONE selection seam, re-derived on every choice: the scope statement and
  // the run read the SAME value.
  // The per-kind image choice is a USER PREFERENCE (Settings.generationImageKinds,
  // row 397): absent = none. It is read live, so the scope statement and the run
  // see the value the store holds.
  const storedImageKinds = useLiveQuery(
    async () => (await readSettings()).generationImageKinds,
    [],
  );
  const imageKinds: readonly EntityKind[] = storedImageKinds ?? [];
  const selection = useMemo(
    () =>
      selectGenerationTargets({
        module,
        artifacts,
        kinds,
        imageKinds,
        levelRange: range,
        // The ticked extras ride the seam so `totalCount` is the run's own
        // plan: an extra the owner did not tick contributes nothing (docs/17
        // row 406 — a printed count the run would not honour was the defect).
        encounterExtras: { battlemaps, mobPortraits },
        overwrite,
      }),
    [module, artifacts, kinds, imageKinds, range, battlemaps, mobPortraits, overwrite],
  );

  // The PLAN the scope statement prints, per kind: the work that exists now
  // PLUS the work this run's own detail pass will unlock (docs/17 row 406).
  // The dispatcher re-reads the pool after the pass and enqueues exactly that
  // union, so the printed number is the number that runs.
  // The overwrite's own jobs (all zero with the box off) are part of the SAME
  // per-kind numbers: the printed line always sums to `totalCount`.
  const { overwrites } = selection;
  const replacing = overwriteJobCount(overwrites);
  // Encounters the overwrite regenerates IN FULL (docs/17 row 423): each one's
  // battlemap is redrawn by that regeneration, not by a map job — the
  // confirmation says so, and the map count above never includes them.
  const regeneratedEncounters = redrawnByDetail(overwrites).size;
  const plannedDetails = selection.detail.length + overwrites.details.length;
  const plannedImages =
    selection.images.length + selection.pendingImages.length + overwrites.images.length;
  const plannedMaps =
    (battlemaps ? selection.maps.length + selection.pendingEncounters.length : 0) +
    overwrites.maps.length;
  const plannedPortraits =
    (mobPortraits ? selection.mobPortraits.length + selection.pendingEncounters.length : 0) +
    overwrites.mobPortraits.length;

  // THE PER-LEVEL ENCOUNTER MINIMUM (docs/17 row 401). It lives on the module row
  // (`encounterFloorGuardrail`) because it is a rule OF THIS DOCUMENT read by the
  // ONE floor resolver, not a user preference like the image kinds. The problem
  // list below is the SAME derivation the chat's card shows.
  const floor = encounterFloorGuardrailFor(module);
  const levelReport = useMemo(
    () =>
      deriveLevelProblems({
        document: moduleDocumentFromView(module),
        entityKinds: module.entityKinds,
        floor: module.encounterFloorGuardrail,
      }),
    [module],
  );
  function setFloor(next: { enabled: boolean; perLevel: number }): void {
    const safe = { enabled: next.enabled, perLevel: next.enabled ? Math.max(1, next.perLevel) : 0 };
    void patchModule(module.id, { encounterFloorGuardrail: safe }).catch((error: unknown) => {
      toastError('Could not save the encounter minimum', error);
    });
  }

  function toggleImageKind(kind: EntityKind, checked: boolean): void {
    const next = checked ? [...imageKinds, kind] : imageKinds.filter((entry) => entry !== kind);
    void updateSettings({ generationImageKinds: next }).catch((error: unknown) => {
      toastError('Could not save the image preference', error);
    });
  }

  const blocked = blockedReason !== null;
  // Linked names no batch can see yet (docs/17 row 414): the run classifies
  // them FIRST (the gate's passes) and then generates from what they recorded,
  // so they are work, not an empty selection. A chat-born module starts here.
  const awaiting = useMemo(
    () => (kinds.length === 0 ? [] : namesAwaitingGate(module, artifacts)),
    [module, artifacts, kinds],
  );
  const empty = selection.totalCount === 0 && awaiting.length === 0;

  function toggleKind(kind: GenerationKind, checked: boolean): void {
    setKinds((current) =>
      checked ? [...current, kind] : current.filter((entry) => entry !== kind),
    );
  }

  async function run(): Promise<void> {
    if (running || blocked || empty) return;
    setConfirmOpen(false);
    // CLOSE AT ONCE (docs/17 row 419): the run lives in the progress dock from
    // here on — its own entry names the step, each batch has its own. The
    // outcome toasts below still arrive when it settles.
    onOpenChange(false);
    const report: GenerationRunReport = await runGenerationSelection({
      module,
      campaign,
      artifacts,
      kinds,
      imageKinds,
      levelRange: range,
      encounterExtras: { battlemaps, mobPortraits },
      overwrite,
    });
    if (report.refused !== null) return; // the seam toasted the reason
    if (report.stopped) {
      toastInfo('Generation stopped — nothing further was started.');
      return;
    }
    const started =
      report.generated +
      report.regenerated +
      report.imageJobs +
      report.mapJobs +
      report.portraitJobs;
    // The run's own summary already NAMED every ticked kind that produced
    // nothing, with its reason (docs/17 row 406) — this fallback only covers
    // the genuinely-nothing case, so it can never claim "everything already
    // has its image" while a ticked kind went unexplained.
    if (started === 0 && report.notes.length === 0) {
      toastInfo(
        'Nothing to generate — every selected entity already has its detail, image and map.',
      );
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="generation-dialog" className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate details</DialogTitle>
            <DialogDescription>
              Pick the kinds and the levels to generate for this document. Nothing runs until you
              press Generate, and the box below states exactly what that will start.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1 text-sm font-medium">Kinds</legend>
              <div className="grid grid-cols-2 gap-1.5">
                {GENERATION_KINDS.map((kind) => (
                  <div key={kind} className="flex items-center gap-2">
                    <Checkbox
                      id={`generation-kind-${kind}`}
                      data-testid={`generation-kind-${kind}`}
                      checked={kinds.includes(kind)}
                      onCheckedChange={(checked) => {
                        toggleKind(kind, checked);
                      }}
                    />
                    <Label htmlFor={`generation-kind-${kind}`} className="text-sm">
                      {generationKindLabel(kind)}
                    </Label>
                  </div>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1 text-sm font-medium">
                Also generate an image for (default: none; remembered)
              </legend>
              <div className="grid grid-cols-2 gap-1.5">
                {GENERATION_KINDS.map((kind) => (
                  <div key={kind} className="flex items-center gap-2">
                    <Checkbox
                      id={`generation-image-${kind}`}
                      data-testid={`generation-image-${kind}`}
                      checked={imageKinds.includes(kind)}
                      onCheckedChange={(checked) => {
                        toggleImageKind(kind, checked);
                      }}
                    />
                    <Label htmlFor={`generation-image-${kind}`} className="text-sm">
                      {generationKindLabel(kind)}
                    </Label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Images are only made as part of the run you confirm here, and only for entities
                that have no image yet — including the entities this run's details create.
              </p>
            </fieldset>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="generation-level-min">From level</Label>
                <Select
                  value={String(range.min)}
                  onValueChange={(value) => {
                    const min = Number(value);
                    setRange((current) => ({
                      min,
                      max: Math.max(min, current.max),
                    }));
                  }}
                >
                  <SelectTrigger id="generation-level-min" data-testid="generation-level-min">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: highestLevel + 1 }, (_, level) => (
                      <SelectItem key={level} value={String(level)}>
                        {levelLabel(level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="generation-level-max">To level</Label>
                <Select
                  value={String(range.max)}
                  onValueChange={(value) => {
                    const max = Number(value);
                    setRange((current) => ({ min: Math.min(current.min, max), max }));
                  }}
                >
                  <SelectTrigger id="generation-level-max" data-testid="generation-level-max">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: highestLevel + 1 }, (_, level) => (
                      <SelectItem key={level} value={String(level)} disabled={level < range.min}>
                        {levelLabel(level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                {`${String(list.levelMax)} level section${list.levelMax === 1 ? '' : 's'} in this document.`}
              </p>
            </div>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1 text-sm font-medium">Encounter extras (off unless ticked)</legend>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="generation-battlemaps"
                  data-testid="generation-battlemaps"
                  checked={battlemaps}
                  onCheckedChange={(checked) => {
                    setBattlemaps(checked);
                  }}
                />
                <Label htmlFor="generation-battlemaps" className="text-sm">
                  Battlemaps for the selected encounters
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="generation-mob-portraits"
                  data-testid="generation-mob-portraits"
                  checked={mobPortraits}
                  onCheckedChange={(checked) => {
                    setMobPortraits(checked);
                  }}
                />
                <Label htmlFor="generation-mob-portraits" className="text-sm">
                  Mob portraits for the selected encounters
                </Label>
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="pb-1 text-sm font-medium">
                Existing work — overwrite, off unless ticked
              </legend>
              <div className="flex flex-col gap-1.5">
                {/*
                  ONE LANE PER KIND OF WORK (docs/17 row 429). Ticking IMAGES alone
                  replaces every existing cover of the selected kinds: the lane is
                  its own scope, so it needs neither an "also generate an image
                  for" kind ticked nor the Kinds boxes emptied to spare the
                  details — the two couplings that made it impossible to ask.
                */}
                {OVERWRITE_LANES.map((lane) => (
                  <div key={lane.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`generation-overwrite-${lane.id}`}
                      data-testid={`generation-overwrite-${lane.id}`}
                      checked={overwrite[lane.id]}
                      onCheckedChange={(checked) => {
                        setOverwrite((current) => ({ ...current, [lane.id]: checked }));
                      }}
                    />
                    <Label htmlFor={`generation-overwrite-${lane.id}`} className="text-sm">
                      {lane.label}
                    </Label>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                For comparing models: text is regenerated in place (the old text stays restorable
                from the artifact’s revisions); old images are deleted once the new ones have
                landed. Generate asks before anything is replaced.
              </p>
            </fieldset>

            <fieldset className="flex flex-col gap-1.5" data-testid="generation-encounter-minimum">
              <legend className="pb-1 text-sm font-medium">Encounter minimum</legend>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="generation-floor-enabled"
                  data-testid="generation-floor-enabled"
                  checked={floor.enabled}
                  onCheckedChange={(checked) => {
                    setFloor({
                      enabled: checked,
                      perLevel: floor.perLevel >= 1 ? floor.perLevel : defaultEncounterFloorGuardrail().perLevel,
                    });
                  }}
                />
                <Label htmlFor="generation-floor-enabled" className="text-sm">
                  Require
                </Label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  aria-label="Encounters per level"
                  data-testid="generation-floor-per-level"
                  className="h-7 w-16 rounded border bg-background px-1 text-sm"
                  disabled={!floor.enabled}
                  value={floor.enabled ? floor.perLevel : ''}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1) setFloor({ enabled: true, perLevel: value });
                  }}
                />
                <span className="text-sm">encounters per level</span>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="generation-floor-counts">
                {levelReport.encounterCounts.length === 0
                  ? 'No level sections yet.'
                  : levelReport.encounterCounts
                      .map((entry) => `Level ${String(entry.level)}: ${String(entry.found)}/${String(entry.required)}`)
                      .join(' · ')}
                {levelReport.unclassifiedLinks.length > 0 &&
                  ` — ${String(levelReport.unclassifiedLinks.length)} unclassified link${levelReport.unclassifiedLinks.length === 1 ? '' : 's'} (kind unknown, not counted as encounters)`}
              </p>
            </fieldset>

            {levelReport.problems.length > 0 && (
              <div className="rounded-md border border-amber-400/40 p-3 text-sm" data-testid="generation-level-problems">
                <p className="font-medium">The story still owes the app:</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {levelReport.problems.map((problem) => (
                    <li key={levelProblemLine(problem)}>{levelProblemLine(problem).slice(2)}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs">
                  Nothing is guessed: figures without a level are held back from this run. Close this dialog
                  and press <em>Ask the chat to fix these</em> in the chat — ONE message covers all of them.
                </p>
              </div>
            )}

            {/*
              THE SCOPE STATEMENT — what will run, before it runs. Every number is
              a field of the SAME selection the run uses.
            */}
            <div
              className="rounded-md border bg-muted/30 p-3 text-sm"
              data-testid="generation-scope"
            >
              <p className="font-medium" data-testid="generation-scope-summary">
                {`Levels: ${rangeLabel(range)} · Kinds: ${
                  kinds.length === 0 ? 'none' : kinds.map(generationKindLabel).join(', ')
                }`}
              </p>
              <p className="mt-1" data-testid="generation-scope-count">
                {`${String(selection.totalCount)} job${selection.totalCount === 1 ? '' : 's'} — ${String(plannedDetails)} detail${plannedDetails === 1 ? '' : 's'}, ${String(plannedImages)} image${plannedImages === 1 ? '' : 's'}, ${String(plannedMaps)} battlemap${plannedMaps === 1 ? '' : 's'}, ${String(plannedPortraits)} mob portrait${plannedPortraits === 1 ? '' : 's'}`}
              </p>
              {overwriteActive && (
                <p className="mt-1" data-testid="generation-scope-overwrite">
                  {replacing === 0
                    ? `Overwrite (${overwriteLaneLine(overwrite)}): nothing of that exists yet — nothing is replaced.`
                    : `Overwrite (${overwriteLaneLine(overwrite)}): ${overwriteCountLine(overwrites)} already exist${replacing === 1 ? 's' : ''} and will be replaced.`}
                </p>
              )}
              {selection.levels.length > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="generation-scope-levels">
                  {selection.levels
                    .map((level) => `${levelLabel(level.number)}: ${String(level.count)}`)
                    .join(' · ')}
                </p>
              )}
              {/* The owner's dedupe rule, stated (docs/23 §6). */}
              {selection.duplicates.length > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="generation-scope-dedupe">
                  {`${String(selection.duplicates.length)} entit${selection.duplicates.length === 1 ? 'y is' : 'ies are'} named in several levels and generated ONCE, at the first level that mentions ${selection.duplicates.length === 1 ? 'it' : 'them'}: ${selection.duplicates
                    .map(
                      (entry) =>
                        `${entry.name} (${levelLabel(entry.level)}; also ${entry.laterLevels.map(levelLabel).join(', ')})`,
                    )
                    .join('; ')}`}
                </p>
              )}
              {/* The premise-only bucket, named whether or not it is selected. */}
              {selection.premiseOnly.length > 0 &&
                (range.min <= MODULE_PREMISE_LEVEL ? (
                  <p className="mt-1 text-muted-foreground" data-testid="generation-scope-premise">
                    {`${String(selection.premiseOnly.length)} premise-only entit${selection.premiseOnly.length === 1 ? 'y has' : 'ies have'} no level yet — included in "Premise (no level yet)", and the engine infers each one's level.`}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground" data-testid="generation-scope-premise">
                    {`${String(selection.premiseOnly.length)} premise-only entit${selection.premiseOnly.length === 1 ? 'y has' : 'ies have'} no level yet and ${selection.premiseOnly.length === 1 ? 'is' : 'are'} NOT selected — set "From level" to Premise (no level yet) to include ${selection.premiseOnly.length === 1 ? 'it' : 'them'}.`}
                  </p>
                ))}
              {selection.needsLevel.length > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="generation-scope-needs-level">
                  {`${String(selection.needsLevel.length)} selected NPC/encounter${selection.needsLevel.length === 1 ? '' : 's'} need${selection.needsLevel.length === 1 ? 's' : ''} a level and ${selection.needsLevel.length === 1 ? 'is' : 'are'} NOT generated: ${selection.needsLevel.map((target) => target.name).join(', ')}.`}
                </p>
              )}
              {awaiting.length > 0 && (
                <p className="mt-1" data-testid="generation-scope-unclassified">
                  {`${String(awaiting.length)} linked name${awaiting.length === 1 ? ' has' : 's have'} no recorded kind yet (${awaiting.join(', ')}) — Generate first classifies ${awaiting.length === 1 ? 'it' : 'them'} and normalizes the links (one model call), then generates the selected kinds from the result.`}
                </p>
              )}
              {(blocked || empty) && (
                <p className="mt-1 text-destructive" data-testid="generation-scope-blocked">
                  {blocked ? blockedReason : 'Nothing selected — tick a kind or widen the level range.'}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <BlockedControl
              testId="generation-run"
              reason={blocked ? blockedReason : null}
              side="top"
            >
              <Button
                size="sm"
                data-testid="generation-run"
                disabled={blocked || empty || running}
                onClick={() => {
                  // ONE question for both reasons to ask (a wide selection, or
                  // existing work about to be replaced) — never two stacked.
                  if (selection.totalCount >= WIDE_SELECTION_JOBS || replacing > 0) {
                    setConfirmOpen(true);
                  } else void run();
                }}
              >
                <SparklesIcon aria-hidden data-icon="inline-start" />
                {running
                  ? 'Generating…'
                  : selection.totalCount === 0
                    ? `Classify ${String(awaiting.length)} name${awaiting.length === 1 ? '' : 's'}, then generate`
                    : `Generate ${String(selection.totalCount)} job${selection.totalCount === 1 ? '' : 's'}`}
              </Button>
            </BlockedControl>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        A WIDE selection asks a second, explicit question — the same count, in
        the same words, so the confirmation cannot promise different work.
      */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="generation-wide-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {replacing > 0
                ? `Replace existing work and start ${String(selection.totalCount)} generation jobs?`
                : `Start ${String(selection.totalCount)} generation jobs?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`${replacing > 0 ? 'The selection' : 'This is a wide selection'}: ${rangeLabel(range)}, ${kinds.map(generationKindLabel).join(', ')} — ${String(plannedDetails)} details, ${String(plannedImages)} images, ${String(plannedMaps)} battlemaps and ${String(plannedPortraits)} mob portraits.${replacing > 0 ? '' : ' Every job is additive: nothing already generated is replaced.'}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {replacing > 0 && (
            <div className="flex flex-col gap-1 text-sm" data-testid="generation-overwrite-confirm">
              <p className="font-medium" data-testid="generation-overwrite-counts">
                {`Overwrite replaces ${overwriteCountLine(overwrites)}.`}
              </p>
              {overwrites.details.length > 0 && (
                <p className="text-muted-foreground">
                  Details are regenerated in place by the current model: same artifact, links and
                  battles keep working, and the previous text stays restorable from the artifact’s
                  revisions.
                </p>
              )}
              {regeneratedEncounters > 0 && (
                <p className="text-muted-foreground" data-testid="generation-overwrite-encounters">
                  {`${String(regeneratedEncounters)} encounter${regeneratedEncounters === 1 ? ' is' : 's are'} regenerated completely — new roster, room layout and prose; the name is kept so links still resolve. Regenerating an encounter redraws its battlemap (whether or not Battlemaps is ticked): the old map is deleted once the new one has landed.`}
                </p>
              )}
              {overwrites.images.length + overwrites.maps.length + overwrites.mobPortraits.length > 0 && (
                <p className="text-muted-foreground">
                  Old images, battlemaps and portraits are DELETED once their replacement has
                  landed (a failed generation keeps the old one). A library creature cited by its
                  canonical name shares one portrait across campaigns — replacing it changes the
                  portrait every future campaign gets.
                </p>
              )}
              {overwrites.kept.length > 0 && (
                <p className="text-muted-foreground" data-testid="generation-overwrite-kept">
                  {`Not overwritten: ${overwrites.kept.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}.`}
                </p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="generation-wide-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="generation-wide-confirm-run"
              onClick={() => {
                void run();
              }}
            >
              Generate {selection.totalCount} jobs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The canvas header's ONE generation control: the ticked-icon button plus the
 * dialog, mounted only while open (so the document is derived only when asked).
 */
export function GenerationButton({
  module,
  campaign,
  artifacts,
  blockedReason,
}: {
  module: Module;
  campaign: Campaign;
  artifacts: readonly AnyArtifact[];
  blockedReason: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = useGenerationRunActive(module.id);
  const reason =
    blockedReason ?? (running ? 'Generating — the progress is in the box at the bottom.' : null);
  return (
    <>
      <BlockedControl testId="canvas-generate" reason={reason}>
        <Button
          variant="outline"
          size="xs"
          disabled={reason !== null}
          data-testid="canvas-generate"
          onClick={() => {
            setOpen(true);
          }}
        >
          <SparklesIcon aria-hidden data-icon="inline-start" />
          Generate…
        </Button>
      </BlockedControl>
      {open && (
        <GenerationDialog
          module={module}
          campaign={campaign}
          artifacts={artifacts}
          open
          onOpenChange={setOpen}
          blockedReason={blockedReason}
        />
      )}
    </>
  );
}

/** Re-renders when this module's generation run starts or settles. */
function useGenerationRunActive(moduleId: string): boolean {
  const id = generationRunJobId(moduleId);
  return useProgressStore((state) => state.jobs.some((job) => job.id === id));
}
