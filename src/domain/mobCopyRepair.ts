import type { MobCopyRepairReport } from '@/domain/settings';
import { plural } from '@/domain/plural';

/**
 * The ONE sentence the mob-copy migration becomes (docs/17 row 248).
 *
 * The Dexie upgrade that turns a library CITATION into an authored COPY cannot
 * reach a toast (it runs inside a version change, before React mounts), so it
 * writes what it did into settings and AppShell reads it once. The copy is a
 * real change to the owner's encounters — the numbers no longer follow the
 * installed book — so the report states the counts in the open, NAMES every mob
 * it could not convert together with the reason, and never says "some".
 *
 * Copy rules it obeys:
 * - counts are always shown when non-zero, in the order the owner would ask
 *   about them (roster mobs, cast NPCs);
 * - `unconverted` is printed BY NAME with its reason, because "2 mobs could not
 *   be converted" is the silent-loss shape AGENTS rule 1 forbids — and those
 *   rows are the ones a later pack install will heal;
 * - a report that changed nothing says so plainly rather than reading as an
 *   error.
 */
export function formatMobCopyRepair(report: MobCopyRepairReport): string {
  const parts: string[] = [];
  if (report.rosterMobsCopied > 0) {
    parts.push(
      `copied the stats of ${plural(report.rosterMobsCopied, 'encounter roster mob', 'encounter roster mobs')} onto the mob itself`,
    );
  }
  if (report.npcCreaturesCopied > 0) {
    parts.push(
      `copied the borrowed stats of ${plural(report.npcCreaturesCopied, 'cast NPC', 'cast NPCs')} onto the NPC`,
    );
  }
  if (parts.length === 0 && report.unconverted.length === 0) {
    return 'No mob still pointed at a bestiary creature, so nothing needed copying.';
  }
  const head =
    parts.length === 0
      ? 'Mobs were converted to carry their own stats.'
      : `Mobs now carry their own stats: ${parts.join('; ')}.`;
  if (report.unconverted.length === 0) return head;
  const detail = report.unconverted
    .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
    .join('; ');
  const count = report.unconverted.length;
  return `${head} ${plural(count, 'mob', 'mobs')} could NOT be copied and ${
    count === 1 ? 'keeps its citation' : 'keep their citations'
  } — install the missing pack and it ${
    count === 1 ? 'will be copied' : 'they will be copied'
  } on the next launch — ${detail}.`;
}
