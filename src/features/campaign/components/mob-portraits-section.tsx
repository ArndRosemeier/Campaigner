import { useState } from 'react';
import type { JSX } from 'react';
import { ImageIcon, SparklesIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
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
 * via the existing coverImageId token path.
 *
 * Regeneration (owner-ordered, docs/11 D5 amendment): when a batch would
 * enqueue NOTHING because every portrait already exists, the section offers
 * a "Regenerate N portrait(s)?" confirm instead of the old
 * already-generated toast — Confirm replaces the existing covers
 * delete-after-replace (canonical slots are republished with fresh bytes first; see
 * `regenerateMobPortraits`), Cancel keeps the old all-generated toast.
 * Partial states (some enqueued, some imaged) keep today's silent behavior
 * with NO dialog — regen there is out of scope by owner-shaped decision
 * (docs/05-UI). The per-entry invented action offers the same confirm for
 * its single portrait. The old art stays until the fresh cover commits — a
 * failed or dropped regen leaves every portrait intact (docs/11 D5
 * preservation rule).
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
  const [regenBatch, setRegenBatch] = useState<string[] | null>(null);
  const [regenEntry, setRegenEntry] = useState<{ index: number; name: string } | null>(null);
  if (artifact.campaignId === null) return null;
  const data = artifact.data;
  const rulebookCount = data.monsters.filter((monster) => monster.source.type === 'rulebook').length;
  const uncited = data.monsters
    .map((monster, index) => ({ monster, index }))
    .filter(({ monster }) => monster.source.type === 'inline' || monster.source.type === 'none');

  async function handleBatch(): Promise<void> {
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
      const alreadyImaged = [...rulebook.alreadyImaged, ...invented.alreadyImaged];
      if (enqueued === 0 && alreadyImaged.length === 0 && invented.created === 0) {
        toastInfo('No creatures to illustrate — add roster entries first');
      } else if (enqueued === 0 && alreadyImaged.length > 0) {
        // All-imaged: offer regeneration instead of the old toast (Cancel
        // replays it — see cancelRegen).
        setRegenBatch(alreadyImaged);
      }
    } catch (error) {
      toastError('Could not start mob portrait generation', error);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRegenBatch(): Promise<void> {
    setRegenBatch(null);
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

  function cancelRegenBatch(): void {
    setRegenBatch(null);
    toastSuccess('All mob portraits are already generated');
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
  const regenNames = regenBatch ?? (regenEntry === null ? [] : [regenEntry.name]);

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
        open={regenBatch !== null || regenEntry !== null}
        onOpenChange={(next) => {
          // Silent dismiss (Esc/backdrop): clears the pending regen with no
          // toast — the explicit Cancel buttons below replay today's toasts.
          if (!next) {
            setRegenBatch(null);
            setRegenEntry(null);
          }
        }}
      >
        <AlertDialogContent data-testid="mob-portraits-regen-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Regenerate {regenNames.length} portrait{regenNames.length === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="mob-portraits-regen-copy">
              Existing covers are replaced — {regenNames.map((name) => `"${name}"`).join(', ')}.
              The current art stays until the new art lands — if generation fails, nothing changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="mob-portraits-regen-cancel"
              onClick={() => {
                if (regenBatch !== null) cancelRegenBatch();
                else if (regenEntry !== null) cancelRegenEntry(regenEntry);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="mob-portraits-regen-confirm"
              onClick={() => {
                if (regenBatch !== null) void confirmRegenBatch();
                else if (regenEntry !== null) void confirmRegenEntry(regenEntry);
              }}
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
