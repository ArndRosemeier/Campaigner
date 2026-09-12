/**
 * Creature-NAME arithmetic (docs/17 row 114): the ONE normalization and the
 * ONE closeness measure used to tell an author WHICH library creatures exist
 * when the name they asked for is not one of them.
 *
 * These are MESSAGE-ONLY helpers. Creature resolution is by EXACT name
 * (trimmed, case-insensitive — `features/modules/entity-batch`), and nothing
 * here may ever be wired into it: a fuzzy match that RESOLVES would silently
 * cast a different creature than the one the module asked for, which is the
 * defect the loud refusal exists to prevent. So the vocabulary is deliberately
 * two-sided: `sameCreatureName` is the STRICT comparison (the resolution's own
 * rule), and `creatureNameSimilarity` is the LOOSE one (a suggestion), with no
 * function that turns the loose answer into a resolution.
 */

import { canonicalCreatureName } from '@/db/mobPortraitCache';

/**
 * Letters NFKD does NOT decompose — a German bestiary heading ("Æther
 * Wraith", "Straße") must still match its ASCII spelling, so they are folded
 * by hand. Everything else with a canonical decomposition (ä, ö, ü, â, é, …)
 * comes apart on its own and then loses its combining mark.
 */
const LIGATURES: ReadonlyMap<string, string> = new Map([
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['ß', 'ss'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['þ', 'th'],
  ['ł', 'l'],
]);

/**
 * The comparable form of a creature name: case-folded, diacritics stripped
 * (an umlaut-typed German name must match the library's own spelling),
 * punctuation (hyphens, apostrophes, periods) and whitespace collapsed to
 * single spaces, and a trailing parenthesized alias — how a library heading
 * may carry its own qualifier, "Zombie (variant)" — removed.
 */
export function normalizeCreatureName(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[æœøßđðþł]/g, (letter) => LIGATURES.get(letter) ?? letter);
  return folded
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The strict comparison the resolution itself applies (trim + case-fold). */
export function sameCreatureName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The library's OWN spelling of a creature a stat-block chunk holds — the
 *  same reading `db/creatureRepo.listLibraryCreatures` pools. */
export function creatureLibraryName(chunk: { headingPath: readonly string[] }): string | null {
  return canonicalCreatureName(chunk);
}

/** The tokens of a normalized name, in order, duplicates kept (a repeated word
 *  is a real signal about a name). */
export function creatureNameTokens(name: string): string[] {
  const normalized = normalizeCreatureName(name);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * Levenshtein distance over two strings — the ONLY edit-distance
 * implementation this app needs, kept private to the similarity measure so no
 * caller can build a resolution rule on it.
 */
function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = new Array<number>(columns).fill(0);
    current[0] = row;
    for (let column = 1; column < columns; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      const deletion = (previous[column] ?? 0) + 1;
      const insertion = (current[column - 1] ?? 0) + 1;
      current[column] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[columns - 1] ?? 0;
}

/**
 * How close two creature names are, in [0, 1] — a SUGGESTION score, never a
 * match. Two independent readings, whichever is stronger:
 *
 * - token overlap (Jaccard over the normalized word sets) — catches a name
 *   written with extra or missing words ("Zombie Schlurfer" vs
 *   "Zombie-Schlurferin");
 * - normalized edit similarity (1 − distance/longest length) — catches a
 *   typo or a morphological variant of a single-word name ("Zombies" vs
 *   "Zombie"), and a query that is a prefix of a longer name.
 *
 * A name with nothing in common with the query scores 0, which is what keeps
 * "say nothing rather than mislead" cheap: the caller applies the threshold.
 */
export function creatureNameSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeCreatureName(left);
  const normalizedRight = normalizeCreatureName(right);
  if (normalizedLeft === '' || normalizedRight === '') return 0;
  const leftTokens = new Set(normalizedLeft.split(' '));
  const rightTokens = new Set(normalizedRight.split(' '));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const union = leftTokens.size + rightTokens.size - shared;
  const overlap = union === 0 ? 0 : shared / union;
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  const distance = editDistance(normalizedLeft, normalizedRight);
  const edit = longest === 0 ? 0 : 1 - distance / longest;
  return Math.max(overlap, edit);
}
