import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { SwordsIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { getBattleForEncounter } from '@/db/battleRepo';
import { openEncounterBattle } from '@/features/play/open-encounter-battle';
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
 * The open-or-seed ACT is `features/play/open-encounter-battle.openEncounterBattle`
 * (docs/17 row 298) — extracted so the module reader's encounter link and the
 * battle surface's empty state cannot drift from this button. This component
 * only owns the label (which reads the live query) and the navigation.
 *
 * The artifact editor reuses this exact button (directly for module-owned
 * encounters, inside a module picker for campaign-scoped ones), so the
 * open/seed split is one shared implementation.
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
  // THE encounter→battle resolver (docs/17 row 268): a LIBRARY encounter the
  // owner is looking at has no battle keyed to it — the battle is keyed to the
  // campaign's ADOPTED COPY — so this hop is what keeps "Open battle" honest
  // and what stops a second press from re-seeding a board that already exists.
  // It is read here for the LABEL ONLY (docs/17 row 298): the press itself asks
  // the shared seam, which is the authority and re-reads the same resolver.
  const existingBattle = useLiveQuery(
    async () => getBattleForEncounter(campaignId, encounter.id),
    [campaignId, encounter.id],
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
        // The seam names the path's key (the battle's OWN key — the
        // campaign-owned encounter), or null when the seed failed loudly; a
        // failed seed must never navigate.
        void openEncounterBattle({ campaignId, moduleId, encounter }).then((key) => {
          if (key === null) return;
          onRun?.();
          navigate(battlePath(campaignId, moduleId, key));
        });
      }}
    >
      <SwordsIcon aria-hidden data-icon="inline-start" />
      {running ? 'Open battle' : 'Run battle'}
    </Button>
  );
}
