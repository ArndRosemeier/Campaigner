import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { SwordsIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { getBattleByModule } from '@/db/battleRepo';
import { runBattle } from '@/features/play/run-battle-seed';
import { battlePath } from '@/app/routes';
import { Button } from '@/components/ui/button';

/**
 * Opens a module's battle, or seeds it the FIRST time. Owner-directed
 * (2026-09-18): this button NEVER re-seeds a battle that exists — every
 * existing battle opens as-is and keeps its state, whatever encounter it was
 * seeded from; starting fresh is the IN-BATTLE Reseed alone. That is why there
 * is no confirm state and no destructive label here any more: a running board
 * can no longer be destroyed from this affordance.
 *
 * A successful first seed, or an open, navigates straight to that module's
 * battle table (the toast only confirms a seed — it never tells the user to go
 * open it themselves). The artifact editor reuses this exact button (directly
 * for module-owned encounters, inside a module picker for campaign-scoped
 * ones), so the open/seed split is one shared implementation.
 *
 * The seed action itself (`runBattle`) lives in the `run-battle-seed.ts`
 * sibling.
 */
function isRunning(battle: Awaited<ReturnType<typeof getBattleByModule>>): boolean {
  return battle !== undefined && (battle.board.tokens.length > 0 || battle.encounterArtifactId !== null);
}

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
    async () => getBattleByModule(moduleId),
    [moduleId],
    undefined,
  );
  const running = isRunning(existingBattle);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="run-battle"
      onClick={() => {
        // A battle exists: OPEN it. Never seed over it — its state is the
        // table's, and only the in-battle Reseed may replace it.
        if (running) {
          onRun?.();
          navigate(battlePath(campaignId, moduleId));
          return;
        }
        // No battle yet: seed this encounter, then open it.
        void runBattle(campaignId, moduleId, encounter).then((report) => {
          if (report === null) return;
          onRun?.();
          navigate(battlePath(campaignId, moduleId));
        });
      }}
    >
      <SwordsIcon aria-hidden data-icon="inline-start" />
      {running ? 'Open battle' : 'Run battle'}
    </Button>
  );
}
