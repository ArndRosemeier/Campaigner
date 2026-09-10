import type { AnyArtifact, Id } from '@/domain';
import { seedBattleFromEncounter, type SeedReport } from '@/db/battleSeed';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Seeds a module's live battle from an encounter — the ACTION behind
 * `RunBattleButton` (`run-battle.tsx`, which owns the resume/replace button
 * and the navigation) and behind the battle surface's destructive re-seed.
 * A statless roster member toasts loudly (AGENTS rule 1: never dummy numbers).
 */
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
