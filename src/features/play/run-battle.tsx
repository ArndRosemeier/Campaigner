import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { SwordsIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { seedBattleFromEncounter, type SeedReport } from '@/db/battleSeed';
import { getBattleByModule } from '@/db/battleRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import { battlePath } from '@/app/routes';
import { Button } from '@/components/ui/button';

/**
 * Seeds a module's live battle from an encounter. The module reader is the
 * only play view (M6-E); replacing an existing board remains a two-step act.
 * The artifact editor reuses this exact button — directly for module-owned
 * encounters, inside a module picker for campaign-scoped ones — so the
 * two-step replace confirm stays one shared implementation. A successful
 * seed NAVIGATES straight to that module's battle table (the toast only
 * confirms the seed — it never tells the user to go open it themselves).
 */
function isRunning(battle: Awaited<ReturnType<typeof getBattleByModule>>): boolean {
  return battle !== undefined && (battle.board.tokens.length > 0 || battle.encounterArtifactId !== null);
}

export async function runBattle(
  campaignId: Id,
  moduleId: Id,
  encounter: AnyArtifact & { kind: 'encounter' },
): Promise<SeedReport | null> {
  try {
    const report = await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    toastSuccess('Battle seeded');
    if (report.statless.length > 0) {
      toastError(
        `No combat stats for: ${report.statless.join('; ')} — they will not roll initiative`,
      );
    }
    return report;
  } catch (error) {
    toastError('Could not seed the battle', error);
    return null;
  }
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
   * Fired only when a press actually seeds (a press that merely arms the
   * replace confirm does not count) and the seed succeeded — the editor's
   * module picker closes its dialog on it. The module view passes nothing.
   */
  onRun?: (() => void) | undefined;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
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
      variant={confirming ? 'destructive' : 'outline'}
      data-testid="run-battle"
      onClick={() => {
        if (running && !confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        void runBattle(campaignId, moduleId, encounter).then((report) => {
          if (report === null) return;
          onRun?.();
          navigate(battlePath(campaignId, moduleId));
        });
      }}
      onBlur={() => {
        setConfirming(false);
      }}
    >
      <SwordsIcon aria-hidden data-icon="inline-start" />
      {confirming ? 'Replace running battle?' : running ? 'Re-run battle' : 'Run battle'}
    </Button>
  );
}
