import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { SwordsIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { getBattleByEncounter } from '@/db/battleRepo';
import { runBattle } from '@/features/play/run-battle-seed';
import { battlePath } from '@/app/routes';
import { Button } from '@/components/ui/button';

/**
 * Opens THIS ENCOUNTER's battle, or seeds it the FIRST time (docs/17 row 254:
 * a battle belongs to its encounter, so two encounters in one module are two
 * boards and this button can never collide across them). Owner-directed
 * (2026-09-18, NOT repealed by the encounter re-key): this button NEVER
 * re-seeds a battle that exists — every existing battle opens as-is and keeps
 * its state; starting fresh is the IN-BATTLE Reseed alone. That is why there is
 * no confirm state and no destructive label here any more: a running board can
 * no longer be destroyed from this affordance.
 *
 * A successful first seed, or an open, navigates straight to that encounter's
 * battle table (the toast only confirms a seed — it never tells the user to go
 * open it themselves). The artifact editor reuses this exact button (directly
 * for module-owned encounters, inside a module picker for campaign-scoped
 * ones), so the open/seed split is one shared implementation.
 *
 * The seed action itself (`runBattle`) lives in the `run-battle-seed.ts`
 * sibling.
 */
export function RunBattleButton({
  campaignId,
  moduleId,
  encounter,
  onRun,
}: {
  campaignId: Id;
  moduleId: Id;
  encounter: AnyArtifact & { kind: 'encounter' };
  /**
   * Fired when a press commits a navigation (an open OR a successful seed) so
   * the editor's module picker closes its dialog on it. The module view passes
   * nothing.
   */
  onRun?: (() => void) | undefined;
}): JSX.Element {
  const navigate = useNavigate();
  const existingBattle = useLiveQuery(
    async () => getBattleByEncounter(encounter.id),
    [encounter.id],
    undefined,
  );
  // The row IS this encounter's board: any existing row (however it was left)
  // is opened untouched.
  const running = existingBattle !== undefined;
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="run-battle"
      onClick={() => {
        // A battle exists for this encounter: OPEN it. Never seed over it — its
        // state is the table's, and only the in-battle Reseed may replace it.
        if (running) {
          onRun?.();
          navigate(battlePath(campaignId, moduleId, encounter.id));
          return;
        }
        // No battle yet for this encounter: seed it, then open it.
        void runBattle(campaignId, moduleId, encounter).then((report) => {
          if (report === null) return;
          onRun?.();
          navigate(battlePath(campaignId, moduleId, encounter.id));
        });
      }}
    >
      <SwordsIcon aria-hidden data-icon="inline-start" />
      {running ? 'Open battle' : 'Run battle'}
    </Button>
  );
}
