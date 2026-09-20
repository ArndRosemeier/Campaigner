import type { CleanCutReport } from '@/domain/settings';
import { plural } from '@/domain/plural';

/**
 * THE ONE sentence the clean-cut purge becomes (docs/17 row 278).
 *
 * The Dexie upgrade that removes every campaign-scoped row runs before React
 * mounts, so it writes what it did into `settings.cleanCut` and AppShell says it
 * ONCE. The owner's acceptance criterion is that he can SEE what happened —
 * "old campaigns get cleanly deleted ... I just don't want to get stuck in an
 * error state" — so the sentence NAMES the counts (never "some data"), states
 * that the library and settings were kept, and names the
 * `libraryLegacyCitationsDropped` count when it is non-zero: that count is the
 * instrument that reveals whether a surviving library row carried an
 * unconvertible citation (readable only from the owner's browser, inventory
 * §f.9/§f.11).
 *
 * A report that removed nothing (a second launch, a fresh install) says so
 * plainly rather than reading as an error.
 */
export function formatCleanCut(report: CleanCutReport): string {
  const removed: string[] = [];
  const add = (count: number, singular: string, pluralForm: string): void => {
    if (count > 0) removed.push(plural(count, singular, pluralForm));
  };
  add(report.campaignsPurged, 'campaign', 'campaigns');
  add(report.modulesPurged, 'module', 'modules');
  add(report.battlesPurged, 'battle', 'battles');
  add(report.runsPurged, 'run', 'runs');
  add(report.artifactsPurged, 'campaign entry', 'campaign entries');

  const dropped =
    report.libraryLegacyCitationsDropped === 0
      ? ''
      : ` It also dropped ${plural(
          report.libraryLegacyCitationsDropped,
          'unreadable library citation',
          'unreadable library citations',
        )} from the kept library.`;

  if (removed.length === 0) {
    return `This build starts from a clean base — there was no older campaign data to remove. Your rulebook library, portraits, personas, idea boards and settings were kept.${dropped}`;
  }
  return `This update starts from a clean base: ${removed.join(', ')} removed. Your rulebook library, portraits, personas, idea boards and settings were kept.${dropped}`;
}
