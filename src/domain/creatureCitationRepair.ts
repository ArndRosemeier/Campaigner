import type { CreatureCitationRepairReport } from '@/domain/settings';

/**
 * The ONE sentence the core-mob arc's migration report becomes (docs/11 D7).
 *
 * The Dexie upgrade that retired the hidden bestiary creature rows cannot
 * reach a toast (it runs inside a version change, before React mounts), so it
 * writes what it did into settings and the app shell reads it once. That
 * report is the owner's only account of a rewrite that touched their
 * encounters — so it states the counts in the open, NAMES anything it could
 * not convert, and never says "some". Pure and total: the shell only renders.
 *
 * Copy rules it obeys:
 * - counts are always shown when they are non-zero, in the order the owner
 *   would ask about them (citations rewritten, rows deleted, portraits kept,
 *   authored text lost);
 * - `unconverted` is printed BY NAME with its reason, because "3 entries could
 *   not be converted" is exactly the silent-loss shape AGENTS rule 1 forbids;
 * - a report that changed nothing says so plainly rather than reading as an
 *   error.
 */
export function formatCreatureCitationRepair(report: CreatureCitationRepairReport): string {
  const parts: string[] = [];
  if (report.citationsRewritten > 0) {
    parts.push(
      `rewrote ${plural(report.citationsRewritten, 'encounter roster citation', 'encounter roster citations')} that pointed at a bestiary creature row into bestiary citations`,
    );
  }
  if (report.emptyRowsDeleted > 0) {
    parts.push(
      `removed ${plural(report.emptyRowsDeleted, 'leftover bestiary creature row', 'leftover bestiary creature rows')}`,
    );
  }
  if (report.coversCarriedForward > 0) {
    parts.push(
      `kept ${plural(report.coversCarriedForward, 'portrait', 'portraits')} by moving ${report.coversCarriedForward === 1 ? 'it' : 'them'} onto the creature`,
    );
  }
  if (report.authoredRowsRemoved.length > 0) {
    parts.push(
      `deleted ${plural(report.authoredRowsRemoved.length, 'retired creature row that carried authored text', 'retired creature rows that carried authored text')} (${report.authoredRowsRemoved.join(', ')})`,
    );
  }
  if (parts.length === 0 && report.unconverted.length === 0) {
    return 'Bestiary creature rows were retired and no encounter needed changing.';
  }
  const head =
    parts.length === 0
      ? 'Bestiary creature rows were retired.'
      : `Bestiary creature rows were retired: ${parts.join('; ')}.`;
  if (report.unconverted.length === 0) return head;
  const detail = report.unconverted
    .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
    .join('; ');
  const count = report.unconverted.length;
  return `${head} ${plural(count, 'citation', 'citations')} could NOT be converted and ${
    count === 1 ? 'was' : 'were'
  } left as they were — ${detail}.`;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}
