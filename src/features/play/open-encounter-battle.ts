import type { AnyArtifact, Id } from '@/domain';
import { getBattleForEncounter } from '@/db/battleRepo';
import { runBattle } from '@/features/play/run-battle-seed';

/**
 * THE open-or-seed seam for one encounter's battle (docs/17 row 298).
 *
 * Owner-directed (2026-09-18, row 254, NOT repealed): a press NEVER re-seeds a
 * battle that exists — every existing board OPENS as-is and keeps its state;
 * starting fresh is the IN-BATTLE Reseed alone. `RunBattleButton` carried that
 * rule inline until an encounter link in the module TEXT needed the SAME act
 * ("bring me straight to the battle map"); the rule now lives here once, and
 * three callers go through it:
 *
 *  - `features/play/run-battle.RunBattleButton` (the encounter card's button),
 *  - `features/modules/ModuleReaderPage.openArtifact` (an `[[Encounter]]` chip
 *    in the module prose — every OTHER kind keeps the peek modal),
 *  - `features/play/battle/BattleSurface`'s empty state (a deep link is no
 *    longer a dead end).
 *
 * The returned key names the battle's OWN encounter — the campaign's ADOPTED
 * COPY when the clicked encounter was a LIBRARY row (docs/17 row 268) — because
 * the battle is keyed to that row and the battle route must name the same one.
 * `null` means the seed FAILED and was already reported loudly by `runBattle`
 * (AGENTS rules 1/2); the caller must not navigate.
 *
 * A prose click may seed because the seed is LOCAL (no model or image call),
 * idempotent (an existing board is opened, never replaced) and confirmed by the
 * seed toast — the named trade in docs/18 §5.
 */
export interface OpenEncounterBattleArgs {
  campaignId: Id;
  moduleId: Id;
  encounter: AnyArtifact & { kind: 'encounter' };
}

export async function openEncounterBattle({
  campaignId,
  moduleId,
  encounter,
}: OpenEncounterBattleArgs): Promise<Id | null> {
  // A battle exists for this encounter: OPEN it. Never seed over it — its
  // state is the table's, and only the in-battle Reseed may replace it. The
  // key is the battle's OWN (the campaign-owned encounter), so the route
  // resolves it without a second hop.
  const existing = await getBattleForEncounter(campaignId, encounter.id);
  if (existing !== undefined) {
    return existing.encounterArtifactId ?? encounter.id;
  }
  // No battle yet for this encounter: seed it. The seed answers the row it
  // keyed the battle to — the adopted copy when the encounter was a LIBRARY
  // row — and the route must name that key.
  const report = await runBattle(campaignId, moduleId, encounter);
  if (report === null) return null;
  return report.battle.encounterArtifactId ?? encounter.id;
}
