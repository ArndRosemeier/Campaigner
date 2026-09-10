/**
 * The module reader's two find surfaces, deliberately paired (08-MODULE-DESIGNER
 * M4-A/M4-C): `findDraftMatches` returns STRING offsets for the part-draft
 * textarea (selection + splice) while `findMatches` walks RENDERED DOM text via
 * TreeWalker for `ReaderSearch` (chip text and markdown both count). They share
 * the same non-overlapping loop semantics — the second is not an implementation
 * of a different behavior.
 */

export interface DraftMatch {
  start: number;
  end: number;
}

/** String-offset matches of `needle` in `haystack`, in document order. */
export function findDraftMatches(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): DraftMatch[] {
  if (needle === '') return [];
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const query = caseSensitive ? needle : needle.toLowerCase();
  const matches: DraftMatch[] = [];
  let index = source.indexOf(query);
  while (index !== -1) {
    matches.push({ start: index, end: index + query.length });
    index = source.indexOf(query, index + query.length);
  }
  return matches;
}

/** Splices `replacement` over one match (offsets from `findDraftMatches`). */
export function replaceDraftMatch(value: string, match: DraftMatch, replacement: string): string {
  return value.slice(0, match.start) + replacement + value.slice(match.end);
}

/**
 * Replaces every match back-to-front (so earlier offsets stay valid) and
 * reports how many were replaced. Empty needle is a no-op, never a wipe.
 */
export function replaceAllDraftMatches(
  value: string,
  needle: string,
  replacement: string,
  caseSensitive: boolean,
): { text: string; count: number } {
  const matches = findDraftMatches(value, needle, caseSensitive);
  if (matches.length === 0) return { text: value, count: 0 };
  let text = value;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match === undefined) throw new Error('replaceAllDraftMatches: match index out of range');
    text = replaceDraftMatch(text, match, replacement);
  }
  return { text, count: matches.length };
}

export interface TextMatch {
  node: Text;
  offset: number;
}

/** Collects the matches of `needle` (case-insensitive) in document order.
 * The part-draft editor (`part-text-editor.tsx`) carries the string-offset
 * counterpart (`findDraftMatches` above) because textarea content is not
 * walkable DOM text. */
export function findMatches(container: HTMLElement, needle: string): TextMatch[] {
  const matches: TextMatch[] = [];
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    const text = current.nodeValue?.toLowerCase() ?? '';
    let index = text.indexOf(lower);
    while (index !== -1) {
      matches.push({ node: current as Text, offset: index });
      index = text.indexOf(lower, index + lower.length);
    }
    current = walker.nextNode();
  }
  return matches;
}
