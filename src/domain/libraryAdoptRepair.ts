import type { LibraryAdoptReport } from '@/domain/settings';
import { plural } from '@/domain/plural';

/**
 * THE ONE sentence the library-adoption migration becomes (docs/17 row 257).
 *
 * The Dexie upgrade that copies a shared library artifact into every campaign
 * that referenced it runs inside a version change, before React mounts, so it
 * writes what it did into settings and AppShell says it once. Adoption is a
 * real change to the owner's campaigns — they now own copies instead of citing
 * the library — so the report states the counts in the open and NAMES every
 * reference it could not repoint, with the reason. It never says "some".
 *
 * Copy rules it obeys (the `formatMobCopyRepair` convention):
 * - counts are shown only when non-zero, in the order the owner would ask;
 * - `unresolved` is printed BY NAME with its reason, because "2 references
 *   could not be adopted" is the silent-loss shape AGENTS rule 1 forbids;
 * - a report that changed nothing says so plainly rather than reading as an
 *   error.
 */
export function formatLibraryAdopt(report: LibraryAdoptReport): string {
  const fresh = report.adopted.filter((entry) => !entry.reused);
  const parts: string[] = [];
  if (fresh.length > 0) {
    parts.push(
      `copied ${plural(fresh.length, 'library entry', 'library entries')} into the campaigns that referenced them`,
    );
  }
  if (report.repointed > 0) {
    parts.push(
      `pointed ${plural(report.repointed, 'reference', 'references')} at the campaign's own copy`,
    );
  }
  if (parts.length === 0 && report.unresolved.length === 0) {
    return 'No module or campaign referenced a shared library entry, so nothing needed copying.';
  }
  const head =
    parts.length === 0
      ? 'Library references were checked.'
      : `Library entries now travel with their campaigns: ${parts.join('; ')}.`;
  if (report.unresolved.length === 0) return head;
  // Expected (a gone library row) and unexpected (a thrown conversion) are told
  // apart deliberately, exactly as the mob-copy report does: the first is work
  // the retry can heal, the second is a defect the owner must be able to report.
  const expected = report.unresolved.filter((entry) => !entry.unexpected);
  const unexpected = report.unresolved.filter((entry) => entry.unexpected);
  const sentences: string[] = [];
  if (expected.length > 0) {
    const detail = expected
      .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
      .join('; ');
    const count = expected.length;
    sentences.push(
      `${plural(count, 'reference', 'references')} could NOT be copied and ${
        count === 1 ? 'keeps pointing at the library' : 'keep pointing at the library'
      } — ${detail}.`,
    );
  }
  if (unexpected.length > 0) {
    const detail = unexpected
      .map((entry) => `“${entry.name}” (${entry.where}): ${entry.reason}`)
      .join('; ');
    const count = unexpected.length;
    sentences.push(
      `${plural(count, 'reference', 'references')} could not be copied because the conversion threw an unexpected error — this is a defect, not a missing library row, so please report it — ${detail}.`,
    );
  }
  return `${head} ${sentences.join(' ')}`;
}
