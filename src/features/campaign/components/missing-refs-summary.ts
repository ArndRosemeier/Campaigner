/**
 * The missing-refs banner's one line of prose (docs/17 row 155): pure, no
 * React, no database — the banner feeds it the strands it resolved and gets
 * back the sentence the GM reads. It lives beside the banner rather than inside
 * it so the sentence itself can be pinned directly, shape by shape.
 */

/** One entry the library cannot satisfy: what the banner reports per strand. */
export interface MissingRefStrand {
  /** The encounter artifact the entry belongs to (drives the "across N"). */
  encounter: string;
  /** The creature the citation names — `''` when it names none. */
  creature: string;
  /** The book the citation recorded, when it recorded one. */
  bookTitle?: string | undefined;
}

/** How many names the one line lists before the honest `(+N more)` — the COUNT
 * itself is never capped. */
export const MISSING_REF_NAME_CAP = 4;

/** Normalized comparison key for a name list (the alias-merge precedent: the
 * comparison trims and casefolds, the printed name does not). */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Deduplicated display names in a deterministic order (locale order of the
 * comparison key, the printed name breaking a tie) — the same strands always
 * print the same list in the same order. */
function distinctNames(values: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const key = nameKey(value);
    if (key === '' || byKey.has(key)) continue;
    byKey.set(key, value.trim());
  }
  return [...byKey.entries()]
    .sort(([leftKey, left], [rightKey, right]) =>
      leftKey === rightKey ? left.localeCompare(right) : leftKey.localeCompare(rightKey),
    )
    .map(([, display]) => display);
}

/** A bounded, deterministic name list: the first `MISSING_REF_NAME_CAP` names,
 * then an honest `(+N more)` — never a silent truncation, because the remainder
 * IS how much is missing. */
function nameList(names: readonly string[]): string {
  const listed = names.slice(0, MISSING_REF_NAME_CAP).join(', ');
  const rest = names.length - MISSING_REF_NAME_CAP;
  return rest > 0 ? `${listed} (+${String(rest)} more)` : listed;
}

/** `«A», «B»` — the house quoting convention for a book's title. */
function packList(titles: readonly string[]): string {
  const rest = titles.length - MISSING_REF_NAME_CAP;
  return `${titles
    .slice(0, MISSING_REF_NAME_CAP)
    .map((title) => `«${title}»`)
    .join(', ')}${rest > 0 ? ` (+${String(rest)} more)` : ''}`;
}

/**
 * THE banner's one line of prose, for every strand shape (docs/17 row 155):
 * the count sentence it has always carried, then the creatures, then the pack
 * when one is recorded — and, when none is, the plain statement that it was not
 * recorded when the citation was written.
 *
 * `[]` yields `''`: a campaign with nothing stranded renders no banner at all,
 * so an empty list is a caller that has already answered the question (the
 * `null` state) and must not print a sentence claiming a gap.
 */
export function missingRefsSummary(strands: readonly MissingRefStrand[]): string {
  if (strands.length === 0) return '';
  const entries = strands.length;
  const encounters = new Set(strands.map((strand) => strand.encounter)).size;
  const head =
    entries === 1
      ? "1 encounter entry cites a stat block missing from this library — it shows 'missing ref'."
      : `${String(entries)} encounter entries across ${String(encounters)} ${
          encounters === 1 ? 'encounter cites' : 'encounters cite'
        } stat blocks missing from this library — they show 'missing ref'.`;

  const creatures = distinctNames(strands.map((strand) => strand.creature));
  const unnamed = strands.filter((strand) => nameKey(strand.creature) === '').length;
  const creatureSentence = creatures.length === 0 ? '' : ` Missing: ${nameList(creatures)}.`;
  const unnamedSentence =
    unnamed === 0
      ? ''
      : ` ${String(unnamed)} of them ${unnamed === 1 ? 'names' : 'name'} no creature.`;

  const packs = distinctNames(
    strands.flatMap((strand) => (strand.bookTitle === undefined ? [] : [strand.bookTitle])),
  );
  const unrecorded = strands.filter((strand) => strand.bookTitle === undefined).length;
  const packSentence =
    packs.length === 0
      ? entries === 1
        ? ' The pack was not recorded when this citation was written.'
        : ' The packs were not recorded when these citations were written.'
      : ` The missing ${packs.length === 1 ? 'pack is' : 'packs are'} ${packList(packs)}.` +
        (unrecorded === 0
          ? ''
          : ` ${String(unrecorded)} of ${String(entries)} ${
              entries === 1 ? 'citation' : 'citations'
            } ${unrecorded === 1 ? 'does' : 'do'} not record which pack ${
              unrecorded === 1 ? 'it was' : 'they were'
            } written from.`);

  return `${head}${creatureSentence}${unnamedSentence}${packSentence}`;
}

