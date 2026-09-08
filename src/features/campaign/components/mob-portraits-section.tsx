import { useState } from 'react';
import type { JSX } from 'react';
import { ImageIcon, SparklesIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import {
  enqueueInventedCreaturePortraits,
  enqueueMobPortraits,
} from '@/features/campaign/mob-portrait-queue';
import { Button } from '@/components/ui/button';
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
      } else if (enqueued === 0) {
        toastSuccess('All mob portraits are already generated');
      }
    } catch (error) {
      toastError('Could not start mob portrait generation', error);
    } finally {
      setBusy(false);
    }
  }

  async function handleEntry(index: number, name: string): Promise<void> {
    setBusyIndex(index);
    try {
      const result = await enqueueInventedCreaturePortraits(artifact, campaignId, [index]);
      if (result.enqueued === 0 && result.alreadyImaged.length > 0) {
        toastInfo(`"${name}" already has a portrait`);
      }
    } catch (error) {
      toastError(`Could not create a creature for "${name}"`, error);
    } finally {
      setBusyIndex(null);
    }
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
    </div>
  );
}
