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
 * THREE identity keys, in order — the first two are proofs, the third is a
 * named basis:
 *
 * 1. PROVENANCE — a FETCHED book stamps `packMeta.sourceUrl` as
 *    `https://github.com/<owner>/<repo>/tree/<ref>/<recipeId>` (`packFetch.ts`),
 *    so the recipe's `id` is the URL's TAIL inside the source's own repo. That
 *    is a proof, not a resemblance.
 * 2. TITLE — a MANUAL file/zip import carries no provenance at all, so the
 *    honest fallback is the book's `title` against the recipe's `label`, both
 *    read through the app's ONE comparable form (`domain/artifactAlias
 *    .comparableName` — NFC, trim, case fold).
 * 3. FOLDER — a manual import's title is the FILE/zip base name
 *    (`packImport.derivePackTitle`), and for a pack saved from this repo that
 *    name is the upstream FOLDER (`packs/pf2e/spells` → `spells`), which a long
 *    human label ("Spells — ranks, cantrips, focus, rituals") never equals. So
 *    the recipe id's TAIL is a second loose key, and a match is reported as
 *    imported WITH ITS BASIS NAMED (`via: 'folder'`, docs/17 row 281) — never
 *    silently, and never as the false "not imported" the owner reported. It is
 *    consulted AFTER the lookalike arm on purpose: when the folder name is
 *    merely the label's own loose form, every folder match is already a
 *    lookalike, and a lookalike is not a proof (below).
 *
 * WHEN NONE OF THEM PROVES IT the card says the state is UNKNOWN rather than
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
      kind: 'imported';
      candidate: PackSourceCandidate;
      /** The title matched the recipe's upstream FOLDER name instead (docs/17 row 281). */
      via: 'folder';
      /**
       * The upstream folder name the book's title matched — the BASIS the card
       * NAMES, so a folder-key match is never asserted silently.
       */
      folderName: string;
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

/**
 * The recipe id's TAIL — the upstream folder name a manual import's derived
 * title carries (docs/17 row 281, `packs/pf2e/spells` → `spells`). `split`
 * always yields at least one element, so the guard can only be reached for an
 * empty id and is never a different value.
 */
function recipeFolderName(recipe: PackRecipe): string {
  return recipe.id.split('/').pop() ?? recipe.id;
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

  // The upstream FOLDER key (docs/17 row 281). Reached only when the lookalike
  // arm found nothing, i.e. only when the folder name is an INDEPENDENT key
  // from the label — otherwise every folder match would already be a lookalike
  // above, whose UNKNOWN answer is the one that stands.
  const folderName = recipeFolderName(recipe);
  const folderKey = looseTitleKey(folderName);
  const folderMatches = candidates.filter(
    (candidate) => looseTitleKey(candidate.summary.book.title) === folderKey,
  );
  if (folderMatches.length > 1) {
    return { kind: 'unknown', reason: 'ambiguous', candidates: folderMatches };
  }
  const folderMatch = folderMatches[0];
  if (folderMatch !== undefined) {
    return {
      kind: 'imported',
      candidate: folderMatch,
      via: 'folder',
      folderName,
      systemMismatch: folderMatch.summary.book.system !== expectedSystem,
    };
  }
  return { kind: 'not-imported' };
}
