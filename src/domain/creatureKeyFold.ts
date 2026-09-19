import type { CreatureKeyFoldReport } from '@/domain/settings';
import { plural } from '@/domain/plural';

/**
 * The ONE sentence the v22 persisted-creature-key fold becomes (docs/17 row
 * 168).
 *
 * The Dexie upgrade that re-keys `mobPortraits`, `creatureImages` and the
 * creature keys inside `battles` cannot reach a toast (it runs inside a version
 * change, before React mounts), so it writes what it did into settings and the
 * app shell reads it once. That report is the owner's account of a rewrite that
 * touched their portrait slots — so it states the per-population counts in the
 * open, and it NAMES every row a merge dropped (AGENTS rule 1: a slot that
 * vanished without its imageId being recorded is silent loss).
 *
 * Returns `null` when the fold changed nothing, so the shell has ONE decision
 * to make and an ordinary upgrade (no dual-composition data) says nothing at
 * all. Pure and total: the shell only renders.
 */
export function formatCreatureKeyFold(report: CreatureKeyFoldReport): string | null {
  const parts: string[] = [];
  if (report.mobPortraitKeysFolded > 0) {
    parts.push(plural(report.mobPortraitKeysFolded, 'portrait slot', 'portrait slots'));
  }
  if (report.creatureImageKeysFolded > 0) {
    parts.push(plural(report.creatureImageKeysFolded, 'campaign portrait', 'campaign portraits'));
  }
  if (report.battleTokenKeysFolded > 0) {
    parts.push(plural(report.battleTokenKeysFolded, 'battle token', 'battle tokens'));
  }
  if (report.seedFighterKeysFolded > 0) {
    parts.push(plural(report.seedFighterKeysFolded, 'frozen fighter', 'frozen fighters'));
  }
  if (parts.length === 0 && report.mergedRows === 0) return null;
  const head =
    parts.length === 0
      ? 'Creature portraits were folded to one Unicode spelling.'
      : `Creature portraits were folded to one Unicode spelling: ${parts.join(', ')} re-keyed onto the composed form.`;
  if (report.mergedRows === 0) return head;
  const merged = plural(report.mergedRows, 'duplicate slot was', 'duplicate slots were');
  const dropped =
    report.dropped.length === 0
      ? ''
      : ` Dropped ${report.dropped
          .map((entry) => `${entry.table} «${entry.creatureKey}» (image ${entry.imageId})`)
          .join('; ')}.`;
  return `${head} ${merged} merged, keeping the newer portrait.${dropped}`;
}
