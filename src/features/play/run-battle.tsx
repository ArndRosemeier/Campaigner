import { useState } from 'react';
import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SwordsIcon } from 'lucide-react';

import type { Artifact, Id } from '@/domain';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { seedBattleFromEncounter, type SeedReport } from '@/db/battleSeed';
import { getBattleBySession } from '@/db/battleRepo';
import { toastError, toastSuccess } from '@/lib/toast';
import { usePlayStore } from '@/features/play/playStore';
import { Button } from '@/components/ui/button';

/**
 * "Run battle" (09-MILESTONE-5 M5-C): seeds a live battle from an encounter
 * artifact into the campaign's active session. The battle replaces any
 * battle already running for that session — a running battle arms a
 * two-step confirm on the button (fresh seed, stage snapshot discarded).
 */

/** The session the battle attaches to: active, else first, else created. */
async function resolveSessionId(campaignId: Id): Promise<Id> {
  const play = usePlayStore.getState().stateOf(campaignId);
  if (play.activeSessionId !== null) {
    const session = await getArtifact(play.activeSessionId);
    if (session?.kind === 'session') return session.id;
  }
  const sessions = (await listArtifactsByCampaign(campaignId)).filter(
    (artifact) => artifact.kind === 'session',
  );
  const first = sessions[0];
  if (first !== undefined) {
    usePlayStore.getState().setActiveSession(campaignId, first.id);
    return first.id;
  }
  const created = await createArtifact({
    campaignId,
    kind: 'session',
    name: `Session ${new Date().toLocaleDateString()}`,
  });
  usePlayStore.getState().setActiveSession(campaignId, created.id);
  return created.id;
}

/** True when a battle row for the session already carries a running game. */
function isRunning(battle: Awaited<ReturnType<typeof getBattleBySession>>): boolean {
  return battle !== undefined && (battle.board.tokens.length > 0 || battle.encounterArtifactId !== null);
}

export async function runBattle(
  campaignId: Id,
  encounter: Artifact & { kind: 'encounter' },
): Promise<SeedReport | null> {
  try {
    const sessionId = await resolveSessionId(campaignId);
    const report = await seedBattleFromEncounter(campaignId, sessionId, encounter.id);
    toastSuccess('Battle seeded — open Play and press “Show battle”');
    if (report.statless.length > 0) {
      // Loud, user-visible (AGENTS rule 2) — the tokens ARE on the board but
      // carry no HP and never enter initiative.
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

/** The header/card action with the replace-confirmation built in. */
export function RunBattleButton({
  campaignId,
  encounter,
}: {
  campaignId: Id;
  encounter: Artifact & { kind: 'encounter' };
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const activeSessionId = usePlayStore((state) => state.stateOf(campaignId).activeSessionId);
  const existingBattle = useLiveQuery(
    async () => (activeSessionId === null ? undefined : getBattleBySession(activeSessionId)),
    [activeSessionId],
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
        void runBattle(campaignId, encounter);
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
