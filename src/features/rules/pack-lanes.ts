import type { PackMeta } from '@/domain/rulebook';
import { GAME_SYSTEM_LABELS } from '@/domain/gameSystem';
import type { GameSystem } from '@/domain/gameSystem';
import type { PackImportResult } from '@/ingest/packImport';

/**
 * THE one per-lane pack report (docs/17 row 204).
 *
 * `PackImportResult.sectionsImported` MIXES journal pages, conditions, feats,
 * SPELLS, actions and class features, so before this module no surface could
 * answer the owner's actual question — "did my import bring spells?" — and the
 * import report had to be read by inference. The four lanes below PARTITION
 * the chunks a pack wrote, and the same arithmetic and the same wording feed
 * every surface that states them: the import toast, the import summary dialog
 * and the book card. A second formatter is the defect this seam exists to
 * prevent; the strings are produced here and nowhere else.
 *
 * `sections` here means the NON-spell rules text: the mixed
 * `sectionsImported` minus the spell lane it contains, so the four lanes add
 * up to the book's chunks rather than double-counting every spell.
 */
export interface PackLaneCounts {
  spells: number;
  statBlocks: number;
  items: number;
  sections: number;
}

/** The report fields the lane arithmetic reads (the import's own numbers). */
type PackLaneReport = Pick<
  PackImportResult,
  'imported' | 'itemsImported' | 'sectionsImported' | 'spellsImported'
>;

/**
 * The four lanes of one import report. `imported` is creatures + items +
 * sections (docs/12 §15.4), so the creature/stat-block lane is its remainder.
 */
export function packLaneCounts(report: PackLaneReport): PackLaneCounts {
  return {
    spells: report.spellsImported,
    statBlocks: report.imported - report.itemsImported - report.sectionsImported,
    items: report.itemsImported,
    sections: report.sectionsImported - report.spellsImported,
  };
}

/**
 * The four lanes of a STORED pack book — the book card's breakdown. The
 * non-spell lanes come from the persisted `packMeta` the import wrote; the
 * SPELL lane is counted LIVE by the caller (`hooks.useRulebookSummaries`),
 * because `spellsImported` did not exist when the spells arc landed (row 181):
 * a book imported since then has spell chunks and no stored spell count, so a
 * `packMeta`-only card would print `0 spells` for a book whose list is full.
 * The live count is what that book's Spells page shows, which is the number
 * this report must mean (AGENTS rule 1).
 */
export function bookPackLaneCounts(packMeta: PackMeta, spellChunkCount: number): PackLaneCounts {
  return packLaneCounts({
    imported: packMeta.entriesImported,
    itemsImported: packMeta.itemsImported ?? 0,
    sectionsImported: packMeta.sectionsImported ?? 0,
    spellsImported: spellChunkCount,
  });
}

/** `1 spell` / `12 spells` — the count agrees with its noun. */
function lane(value: number, singular: string, plural: string): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

/** The compact breakdown every report surface prints, in one spelling. */
export function formatPackLanes(lanes: PackLaneCounts): string {
  return [
    lane(lanes.spells, 'spell', 'spells'),
    lane(lanes.statBlocks, 'stat block', 'stat blocks'),
    lane(lanes.items, 'item', 'items'),
    lane(lanes.sections, 'section', 'sections'),
  ].join(' · ');
}

/**
 * The system an import stored the book AS — the ADAPTER's declared system, in
 * the ONE spelling every report surface uses (docs/17 row 209). It rides
 * beside (never inside) the lane breakdown: the lanes are row 204's ONE
 * formatter, and this is the line that answers "this pack went in as
 * <system>" at the moment of import. A refused entry names the system it
 * claimed and the system the adapter declares in its own failure sentence
 * (`ingest/packImport.systemAgreementFailure`), which the report's existing
 * failure list renders — no second refusal wording lives here.
 */
export function formatPackSystem(system: GameSystem): string {
  return `stored as ${GAME_SYSTEM_LABELS[system]}`;
}
