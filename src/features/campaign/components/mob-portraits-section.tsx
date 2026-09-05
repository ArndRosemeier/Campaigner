import { useState } from 'react';
import type { JSX } from 'react';
import { ImageIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { enqueueMobPortraits } from '@/features/campaign/mob-portrait-queue';
import { Button } from '@/components/ui/button';
import { toastError, toastInfo, toastSuccess } from '@/lib/toast';

/**
 * "Generate mob portraits" (owner-ratified one-click batch, docs/11 D5
 * amendment): enumerates this encounter's rulebook-cited creature kinds,
 * get-or-creates each mob artifact (lazy retro-fill for old encounters) and
 * generates one cover portrait per creature kind. Every instance of that
 * creature shares the artifact — and its portrait — on the battle board via
 * the existing coverImageId token path.
 *
 * Rendered beside the encounter's monsters section (after the roster form),
 * only for campaign-scoped encounters: mob artifacts are campaign-scoped, so
 * a library row has no campaign to own them.
 */
export function MobPortraitsSection({
  artifact,
  campaignId,
}: {
  artifact: AnyArtifact & { kind: 'encounter' };
  campaignId: Id;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  if (artifact.campaignId === null) return null;
  const data = artifact.data;
  const rulebookCount = data.monsters.filter((monster) => monster.source.type === 'rulebook').length;

  async function handleClick(): Promise<void> {
    setBusy(true);
    try {
      const result = await enqueueMobPortraits(artifact, campaignId);
      if (result.enqueued === 0 && result.alreadyImaged.length === 0) {
        toastInfo('No rulebook-cited creatures to illustrate');
      } else if (result.enqueued === 0) {
        toastSuccess('All mob portraits are already generated');
      }
    } catch (error) {
      toastError('Could not start mob portrait generation', error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border p-3"
      data-testid="mob-portraits-section"
    >
      <p className="text-xs text-muted-foreground">
        {rulebookCount === 0
          ? 'No rulebook-cited creatures — mob portraits apply to bestiary-cited roster entries.'
          : 'One portrait per cited creature kind; every instance of that creature shares it on the battle board.'}
      </p>
      <Button
        variant="outline"
        size="sm"
        data-testid="generate-mob-portraits"
        disabled={busy || rulebookCount === 0}
        onClick={() => {
          void handleClick();
        }}
      >
        <ImageIcon aria-hidden data-icon="inline-start" />
        Generate mob portraits
      </Button>
    </div>
  );
}
