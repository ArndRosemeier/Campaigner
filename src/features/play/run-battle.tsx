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
 * only play view (M6-E). Owner-ratified resume-by-default (encounter-resume
 * arc): a module whose running battle was seeded from THIS encounter offers
 * "Open battle" — a plain navigation that reattaches the persisted board —
 * and re-seeding becomes an explicit destructive act ("Re-run battle", then
 * the two-step "Replace running battle?" confirm). A battle from a DIFFERENT
 * encounter (or with no provenance) keeps the two-step replace confirm.
 * The artifact editor reuses this exact button — directly for module-owned
 * encounters, inside a module picker for campaign-scoped ones — so the
 * resume/replace split stays one shared implementation. A successful seed
 * NAVIGATES straight to that module's battle table (the toast only confirms
 * the seed — it never tells the user to go open it themselves).
 */
function isRunning(battle: Awaited<ReturnType<typeof getBattleByModule>>): boolean {
  return battle !== undefined && (battle.board.tokens.length > 0 || battle.encounterArtifactId !== null);
}

export async function runBattle(
  campaignId: Id,
  moduleId: Id,
  encounter: AnyArtifact & { kind: 'encounter' },
  /**
   * Toast wording override for the battle surface's destructive re-seed
   * (encounter-resume arc): same REPLACE semantics and the same reseed
   * provenance stamp, but the GM is already standing on the table, so the
   * toast names what actually happened.
   */
  toasts: { successTitle: string; failureTitle: string } = {
    successTitle: 'Battle seeded',
    failureTitle: 'Could not seed the battle',
  },
): Promise<SeedReport | null> {
  try {
    const report = await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
    toastSuccess(toasts.successTitle);
    if (report.statless.length > 0) {
      toastError(
        `No combat stats for: ${report.statless.join('; ')} — they will not roll initiative`,
      );
    }
    return report;
  } catch (error) {
    toastError(toasts.failureTitle, error);
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
   * Fired when a press commits a navigation — a successful seed OR a resume
   * "Open battle" press — so the editor's module picker closes its dialog on
   * it. A press that merely arms the replace confirm does not count. The
   * module view passes nothing.
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
  // Resume-by-default: the running battle carries THIS encounter's
  // provenance, so opening it loses nothing — never seed through it.
  const resumes = existingBattle?.encounterArtifactId === encounter.id;
  return (
    <Button
      size="sm"
      variant={!resumes && confirming ? 'destructive' : 'outline'}
      data-testid="run-battle"
      onClick={() => {
        if (resumes) {
          onRun?.();
          navigate(battlePath(campaignId, moduleId));
          return;
        }
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
      {resumes ? 'Open battle' : confirming ? 'Replace running battle?' : running ? 'Re-run battle' : 'Run battle'}
    </Button>
  );
}
