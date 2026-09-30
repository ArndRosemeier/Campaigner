import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { RefreshCwIcon } from 'lucide-react';

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
import type { AnyArtifact, Campaign, EntityKind, Module } from '@/domain';
import {
  ENTITY_KINDS,
  MODULE_PREMISE_LEVEL,
  moduleDocumentFromView,
  moduleLevelList,
} from '@/domain';
import {
  generationKindLabel,
  overwriteJobCount,
  redrawnByDetail,
  selectGenerationTargets,
  type GenerationChangeScope,
  type GenerationOverwrites,
} from '@/features/modules/generation-selection';
import {
  runGenerationSelection,
  useGenerationRunActive,
  type GenerationRunReport,
} from '@/features/modules/generation-run';
import { toastInfo } from '@/lib/toast';

/**
 * THE CHANGE DIALOG (docs/17 row 431, owner-directed) — the SIBLING of the
 * generation dialog, and the ONE surface that redoes work that already exists.
 *
 * WHY IT IS A SEPARATE DIALOG. The generation dialog answers "what is MISSING?"
 * and grew an overwrite section that borrowed its scope from the generation
 * controls, which made the owner's own case inexpressible — his words: *"if i
 * just want to overwrite all the images i can not do that, button is grey until
 * i select a kind. Which would be wrong since i only want to redo images."*
 * followed by the decision: *"Lets do a sibling dialog just for changes. Keep all
 * the change work out of the generation dialog and leave it to do just that,
 * generate things that are not there. Add another dialog behind a 'Change
 * generations'-Button that works like this: For every kind, 2 checkboxes. Texts &
 * images. For encounters a bit more (the standard extras for encounters)."*
 *
 * Its scope is therefore ITS OWN (the seam's `change` half): the Change dialog
 * never reads the generation dialog's `kinds`, so ticking one kind's Images — or
 * every kind's — is a complete answer on its own.
 *
 * IT CHANGES EVERY LEVEL. There is no level control here on purpose (the owner
 * asked for a small dialog): the scope is the whole document, premise included,
 * so a premise-only entity is redoable rather than silently skipped.
 */

/** The kinds the owner's "standard extras for encounters" means here. */
const ENCOUNTER_KIND: EntityKind = 'encounter';

/** One "redo this for that kind" checkbox — the dialog's ONE spelling of it. */
function LaneCheckbox({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox id={id} data-testid={id} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
    </div>
  );
}

/** Toggle one kind in a per-kind list. */
function withKind(list: readonly EntityKind[], kind: EntityKind, on: boolean): EntityKind[] {
  return on ? [...list, kind] : list.filter((entry) => entry !== kind);
}

/** "3 texts, 1 image" — the change counts per kind of work, zeros left out. */
function changeCountLine(overwrites: GenerationOverwrites): string {
  const parts = [
    [overwrites.details.length, 'text', 'texts'],
    [overwrites.images.length, 'image', 'images'],
    [overwrites.maps.length, 'battlemap', 'battlemaps'],
    [overwrites.mobPortraits.length, 'encounter’s mob portraits', 'encounters’ mob portraits'],
  ] as const;
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${String(count)} ${count === 1 ? one : many}`)
    .join(', ');
}

export interface ChangeDialogProps {
  module: Module;
  campaign: Campaign;
  artifacts: readonly AnyArtifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why a change cannot run right now (null = it can) — a busy module. */
  blockedReason: string | null;
}

/**
 * The Change dialog itself. Mounted only while open, like its sibling.
 */
export function ChangeDialog({
  module,
  campaign,
  artifacts,
  open,
  onOpenChange,
  blockedReason,
}: ChangeDialogProps): JSX.Element {
  const [texts, setTexts] = useState<readonly EntityKind[]>([]);
  const [images, setImages] = useState<readonly EntityKind[]>([]);
  const [battlemaps, setBattlemaps] = useState(false);
  const [mobPortraits, setMobPortraits] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const running = useGenerationRunActive(module.id);

  // EVERY LEVEL, premise included: this dialog has no level control, so its
  // scope is the whole document (see the header).
  const range = useMemo(() => {
    const list = moduleLevelList(moduleDocumentFromView(module), module.entityKinds);
    return { min: MODULE_PREMISE_LEVEL, max: Math.max(list.levelMax, MODULE_PREMISE_LEVEL) };
  }, [module]);

  const change: GenerationChangeScope = useMemo(
    () => ({ texts, images, battlemaps, mobPortraits }),
    [texts, images, battlemaps, mobPortraits],
  );

  // THE ONE selection seam, asked for CHANGE work only: no generation kind, no
  // additive image kind, no encounter extra — so every job below is a redo.
  const selection = useMemo(
    () =>
      selectGenerationTargets({
        module,
        artifacts,
        kinds: [],
        imageKinds: [],
        levelRange: range,
        encounterExtras: { battlemaps: false, mobPortraits: false },
        change,
      }),
    [module, artifacts, range, change],
  );

  const overwrites = selection.overwrites;
  const replacing = overwriteJobCount(overwrites);
  // An encounter whose TEXT is redone is regenerated in full, and that
  // regeneration redraws its battlemap (docs/17 row 423) — the confirmation says
  // so, and the battlemap count never includes it.
  const regeneratedEncounters = redrawnByDetail(overwrites).size;

  const blocked = blockedReason !== null;
  const empty = replacing === 0;

  async function run(): Promise<void> {
    if (running || blocked || empty) return;
    setConfirmOpen(false);
    // CLOSE AT ONCE (docs/17 row 419): the run lives in the progress dock, whose
    // entry says "Change generations" for this dialog (docs/17 row 431).
    onOpenChange(false);
    const report: GenerationRunReport = await runGenerationSelection({
      module,
      campaign,
      artifacts,
      kinds: [],
      imageKinds: [],
      levelRange: range,
      encounterExtras: { battlemaps: false, mobPortraits: false },
      change,
    });
    if (report.refused !== null) return; // the seam toasted the reason
    if (report.stopped) {
      toastInfo('Change stopped — nothing further was started.');
      return;
    }
    const started =
      report.regenerated +
      report.imageJobs +
      report.mapJobs +
      report.portraitJobs +
      report.generated;
    if (started === 0 && report.notes.length === 0) {
      toastInfo('Nothing to change — nothing you ticked exists yet.');
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="change-dialog" className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Change generations</DialogTitle>
            <DialogDescription>
              Redo what is already there. Nothing missing is created — that is what Generate does.
              Tick what to redo per kind; the box below states exactly what will be replaced.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1 text-sm font-medium">What to redo (off unless ticked)</legend>
              {ENTITY_KINDS.map((kind) => (
                <div key={kind} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="w-24 text-sm font-medium">{generationKindLabel(kind)}</span>
                  <LaneCheckbox
                    id={`change-texts-${kind}`}
                    checked={texts.includes(kind)}
                    onCheckedChange={(on) => {
                      setTexts((current) => withKind(current, kind, on));
                    }}
                    label="Texts"
                  />
                  <LaneCheckbox
                    id={`change-images-${kind}`}
                    checked={images.includes(kind)}
                    onCheckedChange={(on) => {
                      setImages((current) => withKind(current, kind, on));
                    }}
                    label="Images"
                  />
                  {kind === ENCOUNTER_KIND && (
                    <>
                      <LaneCheckbox
                        id="change-battlemaps"
                        checked={battlemaps}
                        onCheckedChange={setBattlemaps}
                        label="Battlemaps"
                      />
                      <LaneCheckbox
                        id="change-mob-portraits"
                        checked={mobPortraits}
                        onCheckedChange={setMobPortraits}
                        label="Mob portraits"
                      />
                    </>
                  )}
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Texts are rewritten in place by the current model (the previous text stays restorable
                from the artifact’s revisions); old images, battlemaps and portraits are deleted once
                their replacement has landed, so a failed generation keeps the old one. Every level is
                covered, the premise included.
              </p>
            </fieldset>

            <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="change-scope">
              <p className="font-medium" data-testid="change-scope-count">
                {replacing === 0
                  ? 'Nothing to change — nothing you ticked exists yet.'
                  : `${String(replacing)} job${replacing === 1 ? '' : 's'} to replace: ${changeCountLine(overwrites)}`}
              </p>
              {regeneratedEncounters > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="change-scope-encounters">
                  {`${String(regeneratedEncounters)} encounter${regeneratedEncounters === 1 ? ' is' : 's are'} regenerated completely — new roster, room layout and prose, the name kept so links still resolve. That regeneration redraws the battlemap too.`}
                </p>
              )}
              {overwrites.kept.length > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="change-scope-kept">
                  {`Not changed: ${overwrites.kept.map((entry) => `${entry.name} (${entry.reason})`).join('; ')}.`}
                </p>
              )}
              {selection.needsLevel.length > 0 && (
                <p className="mt-1 text-muted-foreground" data-testid="change-scope-needs-level">
                  {`${String(selection.needsLevel.length)} selected NPC/encounter${selection.needsLevel.length === 1 ? '' : 's'} state${selection.needsLevel.length === 1 ? 's' : ''} no level and ${selection.needsLevel.length === 1 ? 'is' : 'are'} NOT changed: ${selection.needsLevel.map((target) => target.name).join(', ')}.`}
                </p>
              )}
              {(blocked || empty) && (
                <p className="mt-1 text-destructive" data-testid="change-scope-blocked">
                  {blocked ? blockedReason : 'Nothing selected — tick Texts or Images for a kind.'}
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
            <BlockedControl testId="change-run" reason={blocked ? blockedReason : null} side="top">
              <Button
                size="sm"
                data-testid="change-run"
                disabled={blocked || empty || running}
                onClick={() => {
                  // ONE question before anything is replaced (docs/17 row 422's
                  // guarantee, now in the dialog that owns replacing).
                  if (replacing > 0) setConfirmOpen(true);
                }}
              >
                <RefreshCwIcon aria-hidden data-icon="inline-start" />
                {running
                  ? 'Changing…'
                  : `Change ${String(replacing)} thing${replacing === 1 ? '' : 's'}`}
              </Button>
            </BlockedControl>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="change-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {`Replace ${changeCountLine(overwrites)}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The replacement is generated first and the old one is deleted only once it has landed,
              so a failure keeps what you have. Texts stay restorable from the artifact’s revisions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="change-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="change-confirm-run"
              onClick={() => {
                void run();
              }}
            >
              Change {replacing} thing{replacing === 1 ? '' : 's'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The "Change generations…" button beside Generate (CanvasPage owns the row).
 * Disabled for the SAME reasons Generate is: a busy module or a live run.
 */
export function ChangeButton({
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
      <BlockedControl testId="canvas-change" reason={reason}>
        <Button
          variant="outline"
          size="xs"
          disabled={reason !== null}
          data-testid="canvas-change"
          onClick={() => {
            setOpen(true);
          }}
        >
          <RefreshCwIcon aria-hidden data-icon="inline-start" />
          Change generations…
        </Button>
      </BlockedControl>
      {open && (
        <ChangeDialog
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
