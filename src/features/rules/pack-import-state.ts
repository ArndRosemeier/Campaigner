import { comparableName } from '@/domain/artifactAlias';
import type { GameSystem } from '@/domain/gameSystem';
import type { PackMeta } from '@/domain/rulebook';
import type { PackFetchSource, PackRecipe } from '@/ingest/packFetch';
import type { RulebookSummary } from '@/features/rules/hooks';

/**
 * THE one way to answer "is this fetch recipe already in my library?" — the
 * state the Settings → "Bestiary packs" card states on every recipe row
 * (docs/17 row 210).
 *
 * The owner's report: *"When something is already imported (spells in my
 * example) in settings, the fetch & import button should somehow indicate that
 * fact. Right now its invisible which led to me confusion."* The state is
 * therefore DERIVED FROM THE LIBRARY every time it is read, never stored as a
 * flag: a stored flag goes stale the moment a book is renamed, deleted or
 * re-imported in another tab (AGENTS rule 1), and this is exactly the class of
 * invisible, silently-wrong state the report is about.
 *
 * TWO identity keys, in order, and neither is a guess:
 *
 * 1. PROVENANCE — a FETCHED book stamps `packMeta.sourceUrl` as
 *    `https://github.com/<owner>/<repo>/tree/<ref>/<recipeId>` (`packFetch.ts`),
 *    so the recipe's `id` is the URL's TAIL inside the source's own repo. That
 *    is a proof, not a resemblance.
 * 2. TITLE — a MANUAL file/zip import carries no provenance at all, so the
 *    honest fallback is the book's `title` against the recipe's `label`, both
 *    read through the app's ONE comparable form (`domain/artifactAlias
 *    .comparableName` — NFC, trim, case fold).
 *
 * WHEN NEITHER PROVES IT the card says the state is UNKNOWN rather than
 * guessing (AGENTS rule 1) — two proven matches are AMBIGUOUS (never a pick),
 * and a book whose title merely LOOKS like the recipe's label (letters and
 * digits only, so a manual import's derived slug `pathfinder-monster-core`
 * compares against the label "Pathfinder Monster Core") is UNIDENTIFIED: it
 * might be this pack, so "not imported" would be the lie the report is about.
 *
 * CANDIDATES ARE READY PACK BOOKS FROM THE SAME ADAPTER. A non-`ready` book is
 * not an import (a failed import is an error book), a PDF book is not a pack
 * book, and another adapter's pack is a different import: the `sourceId`
 * restriction also keeps the advanced "list everything" listing honest, where
 * two sources can offer the same repo folder.
 */

/** A ready pack book that could be this recipe, with its `packMeta` narrowed. */
export interface PackSourceCandidate {
  summary: RulebookSummary;
  packMeta: PackMeta;
}

/**
 * The import state of ONE fetch recipe, as the library can prove it. Every
 * branch is renderable: `unknown` carries WHY and WHICH books, so the card can
 * name them instead of inventing an answer.
 */
export type PackSourceImportState =
  /** The live library read has not resolved yet — NOT "not imported". */
  | { kind: 'library-loading' }
  | { kind: 'not-imported' }
  | {
      kind: 'imported';
      candidate: PackSourceCandidate;
      /** Which key proved it: the fetch provenance or the title fallback. */
      via: 'provenance' | 'title';
      systemMismatch: boolean;
    }
  | {
      kind: 'unknown';
      reason: 'ambiguous' | 'unidentified';
      candidates: readonly PackSourceCandidate[];
    };

/**
 * The loose "looks like this pack" form: letters and digits only, Unicode-aware
 * (AGENTS letter-vs-ASCII rule), so a manual import's slug title compares with
 * the recipe's label without either claiming equality. It is deliberately NOT
 * the comparable form: this key asks "could this be the same pack?", never
 * "is it?" — the answer to the second question is `comparableName`.
 */
function looseTitleKey(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Does this book's stamped provenance point at exactly this recipe? */
function provenanceMatches(
  source: PackFetchSource,
  recipe: PackRecipe,
  book: { packMeta: PackMeta },
): boolean {
  const url = book.packMeta.sourceUrl;
  if (url === undefined) return false;
  const repoRoot = `https://github.com/${source.owner}/${source.repo}/tree/`;
  return url.startsWith(repoRoot) && url.endsWith(`/${recipe.id}`);
}

/** The ready pack books of THIS source's adapter, with `packMeta` narrowed. */
function sourceCandidates(
  source: PackFetchSource,
  summaries: readonly RulebookSummary[],
): PackSourceCandidate[] {
  const candidates: PackSourceCandidate[] = [];
  for (const summary of summaries) {
    const { book } = summary;
    if (book.origin !== 'pack' || book.status !== 'ready' || book.packMeta === null) continue;
    if (book.packMeta.sourceId !== source.adapterId) continue;
    candidates.push({ summary, packMeta: book.packMeta });
  }
  return candidates;
}

/**
 * The import state of `recipe` as the live library proves it. `summaries` is
 * the row-204 live read (`hooks.useRulebookSummaries` — the book rows plus the
 * live spell lane), so this function adds no query and no second count.
 */
export function packSourceImportState(
  source: PackFetchSource,
  recipe: PackRecipe,
  expectedSystem: GameSystem,
  summaries: readonly RulebookSummary[] | undefined,
): PackSourceImportState {
  if (summaries === undefined) return { kind: 'library-loading' };
  const candidates = sourceCandidates(source, summaries);

  const identified: { candidate: PackSourceCandidate; via: 'provenance' | 'title' }[] = [];
  for (const candidate of candidates) {
    if (provenanceMatches(source, recipe, candidate)) {
      identified.push({ candidate, via: 'provenance' });
      continue;
    }
    if (comparableName(candidate.summary.book.title) === comparableName(recipe.label)) {
      identified.push({ candidate, via: 'title' });
    }
  }

  if (identified.length > 1) {
    return {
      kind: 'unknown',
      reason: 'ambiguous',
      candidates: identified.map((entry) => entry.candidate),
    };
  }
  const only = identified[0];
  if (only !== undefined) {
    return {
      kind: 'imported',
      candidate: only.candidate,
      via: only.via,
      systemMismatch: only.candidate.summary.book.system !== expectedSystem,
    };
  }

  const lookalikeKey = looseTitleKey(recipe.label);
  const lookalikes = candidates.filter(
    (candidate) => looseTitleKey(candidate.summary.book.title) === lookalikeKey,
  );
  if (lookalikes.length > 0) {
    return { kind: 'unknown', reason: 'unidentified', candidates: lookalikes };
  }
  return { kind: 'not-imported' };
}
