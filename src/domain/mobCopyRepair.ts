import { settingsJournalAfterNotify, type MobCopyRepairReport } from '@/domain/settings';
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
  // The two populations are told apart deliberately (docs/17 row 248's per-row
  // guard): a row the library cannot supply is WORK for the next launch after
  // the pack is installed, while a row whose conversion THREW is a code defect
  // the owner must be able to report — so the second is named as such and its
  // error text is printed, never folded into the bland "could not be copied".
  const expected = report.unconverted.filter((entry) => !entry.unexpected);
  const unexpected = report.unconverted.filter((entry) => entry.unexpected);
  const sentences: string[] = [];
  if (expected.length > 0) {
    const detail = expected
      .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
      .join('; ');
    const count = expected.length;
    sentences.push(
      `${plural(count, 'mob', 'mobs')} could NOT be copied and ${
        count === 1 ? 'keeps its citation' : 'keep their citations'
      } — install the missing pack and it ${
        count === 1 ? 'will be copied' : 'they will be copied'
      } on the next launch — ${detail}.`,
    );
  }
  if (unexpected.length > 0) {
    const detail = unexpected
      .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
      .join('; ');
    const count = unexpected.length;
    sentences.push(
      `${plural(count, 'mob', 'mobs')} could not be copied because the conversion threw an unexpected error — this is a defect, not a missing pack, so please report it — ${detail}.`,
    );
  }
  return `${head} ${sentences.join(' ')}`;
}

/**
 * WHAT THE MOB-COPY JOURNAL KEEPS ONCE THE USER HAS BEEN TOLD (docs/17 row
 * 271, item B4).
 *
 * `null` when no mob is left to heal — nothing left to say, nothing left to
 * retry. Otherwise the report with its HISTORY dropped (the two upgrade
 * counts) and its RETRY WORKLIST kept, because the startup retry is gated on
 * that list and the pointer it heals lives on the row itself. This replaces the
 * old `{ ...report, notified: true }`, which kept the upgrade's counts — and,
 * for the adoption report beside it, the library row ids — forever.
 */
export function retainedMobCopyJournal(
  report: MobCopyRepairReport,
): MobCopyRepairReport | null {
  return settingsJournalAfterNotify(report.unconverted, () => ({
    ...report,
    rosterMobsCopied: 0,
    npcCreaturesCopied: 0,
  }));
}
