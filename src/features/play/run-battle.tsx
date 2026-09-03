import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SwordsIcon } from 'lucide-react';

import type { AnyArtifact, Id } from '@/domain';
import { seedBattleFromEncounter, type SeedReport } from '@/db/battleSeed';
import { getBattleByModule } from '@/db/battleRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import { Button } from '@/components/ui/button';

/**
 * Seeds a module's live battle from an encounter. The module reader is the
 * only play view (M6-E); replacing an existing board remains a two-step act.
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
    toastSuccess('Battle seeded — open the module\'s Battle table');
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
}: {
  campaignId: Id;
  moduleId: Id;
  encounter: AnyArtifact & { kind: 'encounter' };
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
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
        void runBattle(campaignId, moduleId, encounter);
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
