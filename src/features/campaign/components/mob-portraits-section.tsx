import { useState } from 'react';
import type { JSX } from 'react';
import { ImageIcon, SparklesIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import type { MobPortraitBatchPlan } from '@/features/campaign/mob-portrait-queue';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
  planMobPortraitBatch,
  regenerateInventedCreaturePortraits,
  regenerateMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import { Button } from '@/components/ui/button';
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
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * Mob portraits (owner-ratified one-click batch, docs/11 D5 amendment):
 * rulebook-cited creature kinds get one cover portrait per mob artifact
 * (lazy retro-fill for old encounters), and uncited roster entries
 * (`inline` / `none` — model-invented mobs with no bestiary citation) get
 * an on-demand creature artifact plus a local portrait ("Create creature +
 * portrait", per entry and batch-all). Every instance of an illustrated
 * creature shares the artifact — and its portrait — on the battle board
 * via the existing `coverImageId` token path.
 *
 * The batch press never guesses and never replaces anything silently
 * (owner report: "2 mobs already have an image and I just want to fill a
 * hole" — the old one-sided confirm only ever offered replace-all). It
 * first runs the READ-ONLY count (`planMobPortraitBatch`: creates nothing,
 * clones nothing, enqueues nothing) and then:
 *
 * - **pure gaps** (nothing imaged yet): fills immediately, exactly as
 *   before — there is nothing to choose;
 * - **mixed** (some imaged, some not): the confirm states the counts and
 *   offers BOTH ways — **Fill the missing N** (primary: additive, every
 *   existing portrait kept) and **Replace all M** (secondary/destructive:
 *   today's delete-after-replace regen, unchanged semantics — old art stays
 *   until the fresh art lands, canonical republishing stays shared). The
 *   additive action is never unreachable while a hole exists;
 * - **nothing missing** (every kind already has art): the confirm offers
 *   only replace-all, with the reason stated — never a dead or misleading
 *   control.
 *
 * The confirm states the SHARED consequence of replacing a Monster Core
 * (canonical) citation BEFORE the choice — republishing the bestiary slot
 * means every future portrait in every campaign uses the new art, while
 * existing covers elsewhere keep theirs (the old flow said it in a toast,
 * after the click). It also names what the counts mean: art that is not set
 * as a creature's cover (the board still shows initials until the owner sets
 * it) and roster rows that share one creature kind's portrait. The per-entry
 * invented action keeps its own confirm, unchanged.
 *
 * Rendered beside the encounter's monsters section (after the roster form),
 * only for campaign-scoped encounters: mob artifacts are campaign-scoped, so
 * a library row has no campaign to own them. GM-only by surface: the
 * artifact editor never mounts in player-safe view, so portrait generation
 * stays a GM action like every other queue on this screen.
 */
export function MobPortraitsSection({
  artifact,
  campaignId,
}: {
  artifact: AnyArtifact & { kind: 'encounter' };
  campaignId: Id;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [batchChoice, setBatchChoice] = useState<MobPortraitBatchPlan | null>(null);
  const [regenEntry, setRegenEntry] = useState<{ index: number; name: string } | null>(null);
  if (artifact.campaignId === null) return null;
  const data = artifact.data;
  const rulebookCount = data.monsters.filter((monster) => monster.source.type === 'rulebook').length;
  const uncited = data.monsters
    .map((monster, index) => ({ monster, index }))
    .filter(({ monster }) => monster.source.type === 'inline' || monster.source.type === 'none');

  /** The additive path — the owner's ask: fill every kind with no portrait,
   * keep every portrait that exists. Never regenerates, never replaces. */
  async function fillMissing(): Promise<void> {
    setBatchChoice(null);
    setBusy(true);
    try {
      const rulebook =
        rulebookCount === 0
          ? { enqueued: 0, alreadyImaged: [] as string[] }
          : await enqueueMobPortraits(artifact, campaignId);
      const invented =
        uncited.length === 0
          ? { created: 0, enqueued: 0, alreadyImaged: [] as string[] }
          : await enqueueInventedCreaturePortraits(artifact, campaignId);
      const enqueued = rulebook.enqueued + invented.enqueued;
      const kept = rulebook.alreadyImaged.length + invented.alreadyImaged.length;
      if (enqueued === 0) {
        // Covers landed between the count and this call (read-through or a
        // concurrent run) — nothing left to fill, and nothing was replaced.
        toastInfo('Nothing left to fill — every creature kind already has a portrait');
      } else {
        toastSuccess(
          `Filling ${String(enqueued)} missing portrait${enqueued === 1 ? '' : 's'} — ${
            kept === 0
              ? 'nothing is replaced'
              : `keeping the ${String(kept)} that exist${kept === 1 ? 's' : ''}`
          }`,
        );
      }
    } catch (error) {
      toastError('Could not start mob portrait generation', error);
    } finally {
      setBusy(false);
    }
  }

  /** The replace-all path: today's delete-after-replace regen, unchanged
   * semantics (canonical slots republished first, old art kept until the
   * fresh art commits). */
  async function replaceAll(): Promise<void> {
    setBatchChoice(null);
    setBusy(true);
    try {
      const rulebook =
        rulebookCount === 0
          ? { regenerated: 0, republishedCanonical: [] as string[] }
          : await regenerateMobPortraits(artifact, campaignId);
      const invented =
        uncited.length === 0
          ? { created: 0, regenerated: 0 }
          : await regenerateInventedCreaturePortraits(artifact, campaignId);
      const regenerated = rulebook.regenerated + invented.regenerated;
      if (regenerated === 0) {
        // Covers landed between the dialog and Confirm (read-through or a
        // concurrent run) — nothing left to regen.
        toastSuccess('All mob portraits are already generated');
      } else {
        toastSuccess(
          `Regenerating ${String(regenerated)} portrait${regenerated === 1 ? '' : 's'} — existing covers are replaced`,
        );
        if (rulebook.republishedCanonical.length > 0) {
          toastSuccess(
            `Shared portrait republished for ${rulebook.republishedCanonical.map((name) => `"${name}"`).join(', ')} — future portraits in every campaign use the new art; existing covers elsewhere keep theirs`,
          );
        }
      }
    } catch (error) {
      toastError('Could not regenerate mob portraits', error);
    } finally {
      setBusy(false);
    }
  }

  async function handleBatch(): Promise<void> {
    setBusy(true);
    try {
      // Read-only count first: every number the owner sees comes from the
      // same enumeration the queue acts on (never a hardcoded or optimistic
      // label), and nothing is created or cloned by counting.
      const plan = await planMobPortraitBatch(artifact, campaignId);
      if (plan.missing.length + plan.imaged.length === 0) {
        toastInfo('No creatures to illustrate — add roster entries first');
        return;
      }
      if (plan.missing.length === 0) {
        // Nothing missing: replace-all is the only honest action left.
        setBatchChoice(plan);
        return;
      }
      if (plan.imaged.length === 0) {
        // Pure gaps: nothing to choose, fill immediately (unchanged).
        await fillMissing();
        return;
      }
      setBatchChoice(plan);
    } catch (error) {
      toastError('Could not start mob portrait generation', error);
    } finally {
      setBusy(false);
    }
  }

  function cancelBatch(plan: MobPortraitBatchPlan): void {
    setBatchChoice(null);
    if (plan.missing.length === 0) {
      // Nothing was missing: today's honest already-generated outcome.
      toastSuccess('All mob portraits are already generated');
      return;
    }
    // The press queued nothing — say so instead of letting the owner guess
    // whether the holes were filled.
    toastInfo(
      `Nothing queued — ${String(plan.missing.length)} creature kind${
        plan.missing.length === 1 ? ' still has' : 's still have'
      } no portrait`,
    );
  }

  async function handleEntry(index: number, name: string): Promise<void> {
    setBusyIndex(index);
    try {
      const result = await enqueueInventedCreaturePortraits(artifact, campaignId, [index]);
      if (result.enqueued === 0 && result.alreadyImaged.length > 0) {
        setRegenEntry({ index, name });
      }
    } catch (error) {
      toastError(`Could not create a creature for "${name}"`, error);
    } finally {
      setBusyIndex(null);
    }
  }

  async function confirmRegenEntry(entry: { index: number; name: string }): Promise<void> {
    setRegenEntry(null);
    setBusyIndex(entry.index);
    try {
      const result = await regenerateInventedCreaturePortraits(artifact, campaignId, [entry.index]);
      if (result.regenerated === 0) {
        toastInfo(`"${entry.name}" already has a portrait`);
      } else {
        toastSuccess(`Regenerating portrait for "${entry.name}" — the existing cover is replaced`);
      }
    } catch (error) {
      toastError(`Could not regenerate a portrait for "${entry.name}"`, error);
    } finally {
      setBusyIndex(null);
    }
  }

  function cancelRegenEntry(entry: { index: number; name: string }): void {
    setRegenEntry(null);
    toastInfo(`"${entry.name}" already has a portrait`);
  }

  const batchLabel = rulebookCount === 0 ? 'Create creatures + portraits' : 'Generate mob portraits';
  const batchDisabled = busy || busyIndex !== null || (rulebookCount === 0 && uncited.length === 0);

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      data-testid="mob-portraits-section"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {rulebookCount === 0 && uncited.length === 0
            ? 'No creatures to illustrate — add roster entries first.'
            : rulebookCount === 0
              ? 'No bestiary-cited creatures — each invented entry gets its own creature artifact plus a portrait.'
              : uncited.length === 0
                ? 'One portrait per cited creature kind; every instance of that creature shares it on the battle board.'
                : 'One portrait per cited creature kind, shared on the battle board — invented entries below get a creature artifact first, then a portrait.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="generate-mob-portraits"
          disabled={batchDisabled}
          onClick={() => {
            void handleBatch();
          }}
        >
          <ImageIcon aria-hidden data-icon="inline-start" />
          {batchLabel}
        </Button>
      </div>
      {uncited.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="mob-portraits-uncited">
          {uncited.map(({ monster, index }) => {
            const entryBusy = busyIndex === index;
            return (
              <li
                key={`${monster.name}-${String(index)}`}
                className="flex items-center justify-between gap-3 rounded-md border border-dashed p-2"
              >
                <p className="text-xs">
                  <span className="font-medium">{monster.name}</span>{' '}
                  <span className="text-muted-foreground">
                    {monster.source.type === 'inline' ? '· invented, with stat block' : '· invented, name only'}
                  </span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`create-creature-portrait-${String(index)}`}
                  disabled={busy || busyIndex !== null}
                  onClick={() => {
                    void handleEntry(index, monster.name);
                  }}
                >
                  <SparklesIcon aria-hidden data-icon="inline-start" />
                  {entryBusy ? 'Creating…' : 'Create creature + portrait'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog
        open={batchChoice !== null || regenEntry !== null}
        onOpenChange={(next) => {
          // Silent dismiss (Esc/backdrop): clears the pending confirm with no
          // toast — the explicit Cancel buttons below do the honest reporting.
          if (!next) {
            setBatchChoice(null);
            setRegenEntry(null);
          }
        }}
      >
        <AlertDialogContent
          data-testid={batchChoice !== null ? 'mob-portraits-choice-dialog' : 'mob-portraits-regen-dialog'}
        >
          {batchChoice === null ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate 1 portrait?</AlertDialogTitle>
                <AlertDialogDescription data-testid="mob-portraits-regen-copy">
                  Existing covers are replaced — &quot;{regenEntry?.name ?? ''}&quot;. The current art
                  stays until the new art lands — if generation fails, nothing changes.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  data-testid="mob-portraits-regen-cancel"
                  onClick={() => {
                    if (regenEntry !== null) cancelRegenEntry(regenEntry);
                  }}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="mob-portraits-regen-confirm"
                  onClick={() => {
                    if (regenEntry !== null) void confirmRegenEntry(regenEntry);
                  }}
                >
                  Regenerate
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {batchChoice.missing.length > 0
                    ? `Fill ${String(batchChoice.missing.length)} missing portrait${
                        batchChoice.missing.length === 1 ? '' : 's'
                      } or replace ${String(batchChoice.imaged.length)}?`
                    : `Replace all ${String(batchChoice.imaged.length)} portrait${
                        batchChoice.imaged.length === 1 ? '' : 's'
                      }?`}
                </AlertDialogTitle>
                <AlertDialogDescription
                  data-testid="mob-portraits-choice-copy"
                  className="flex flex-col gap-1"
                >
                  {batchChoiceCopy(batchChoice).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel
                  data-testid="mob-portraits-choice-cancel"
                  onClick={() => {
                    cancelBatch(batchChoice);
                  }}
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  data-testid="mob-portraits-choice-replace"
                  onClick={() => {
                    void replaceAll();
                  }}
                >
                  Replace all {batchChoice.imaged.length}
                </AlertDialogAction>
                {batchChoice.missing.length > 0 && (
                  <AlertDialogAction
                    data-testid="mob-portraits-choice-fill"
                    onClick={() => {
                      void fillMissing();
                    }}
                  >
                    Fill the missing {batchChoice.missing.length}
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** `"A", "B"` — the named creatures behind a count (never counts alone). */
function named(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/**
 * The confirm's copy — every line a count or a consequence that is TRUE for
 * this roster (never a hardcoded or optimistic label): what exists, what the
 * fill adds, what replacing does to the existing art, and the SHARED
 * canonical consequence stated before the choice rather than in a toast
 * afterwards.
 */
function batchChoiceCopy(plan: MobPortraitBatchPlan): string[] {
  const kinds = plan.missing.length + plan.imaged.length;
  const lines: string[] = [];
  if (plan.imaged.length === 0) {
    lines.push(`None of this roster's ${String(kinds)} creature kinds has a portrait yet.`);
  } else if (plan.missing.length === 0) {
    lines.push(
      `All ${String(kinds)} creature kinds already have a portrait: ${named(plan.imaged)}.`,
    );
  } else {
    lines.push(
      `${String(plan.imaged.length)} of ${String(kinds)} creature kinds already have a portrait (${named(
        plan.imaged,
      )}); ${String(plan.missing.length)} ${plan.missing.length === 1 ? 'has' : 'have'} none (${named(
        plan.missing,
      )}).`,
    );
  }
  if (plan.missing.length > 0) {
    lines.push(
      `Filling adds only the missing portrait${plan.missing.length === 1 ? '' : 's'}${
        plan.creates > 0
          ? ` (creating ${String(plan.creates)} creature artifact${plan.creates === 1 ? '' : 's'} first)`
          : ''
      } and keeps the ${String(plan.imaged.length)} that exist${plan.imaged.length === 1 ? 's' : ''} — nothing is replaced.`,
    );
  } else {
    lines.push('Nothing is missing, so there is nothing to fill.');
  }
  lines.push(
    plan.missing.length > 0
      ? `Replacing regenerates all ${String(plan.imaged.length)} existing portrait${
          plan.imaged.length === 1 ? '' : 's'
        } and still fills the missing one${plan.missing.length === 1 ? '' : 's'} — the current art stays until each fresh portrait lands, so a failure changes nothing.`
      : 'Replacing regenerates every existing portrait — the current art stays until each fresh portrait lands, so a failure changes nothing.',
  );
  if (plan.sharedPortraitNames.length > 0) {
    lines.push(
      `Monster Core (bestiary-cited) portraits are shared: republishing ${named(
        plan.sharedPortraitNames,
      )} changes the shared portrait every future campaign clones — existing covers elsewhere keep theirs.`,
    );
  }
  if (plan.unreadableCitations.length > 0) {
    lines.push(
      `The bestiary citation for ${named(plan.unreadableCitations)} can no longer be read — replacing ${
        plan.unreadableCitations.length === 1 ? 'it' : 'them'
      } fails loudly and keeps ${plan.unreadableCitations.length === 1 ? 'its' : 'their'} cover.`,
    );
  }
  if (plan.artWithoutCover.length > 0) {
    lines.push(
      `${named(plan.artWithoutCover)} already carr${
        plan.artWithoutCover.length === 1 ? 'ies' : 'y'
      } art on the creature artifact that is not set as its cover — the battle board still shows initials until you set it (open the creature artifact → Images → Set as cover). Filling leaves ${
        plan.artWithoutCover.length === 1 ? 'it' : 'them'
      } alone; replacing regenerates ${plan.artWithoutCover.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (plan.sharedRows > 0) {
    lines.push(
      `${String(plan.sharedRows)} roster row${plan.sharedRows === 1 ? '' : 's'} share${
        plan.sharedRows === 1 ? 's' : ''
      } a creature kind with another row — each kind keeps ONE shared portrait on the battle board.`,
    );
  }
  return lines;
}
