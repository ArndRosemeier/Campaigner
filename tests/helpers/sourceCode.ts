/**
 * The ONE source-scan helper for the architecture pins (docs/17 rows 212, 284).
 *
 * WHY IT EXISTS AT ALL, measured rather than stylistic: the hand-rolled
 * recursive walker is a BASELINED multi-site population in the test tree (eight
 * pins grew one each, docs/17 row 212), so a new pin must NOT add a ninth. This
 * is the `import.meta.glob` spelling instead — and the moment a SECOND pin
 * spelled the glob + normalization itself, the duplicate-body tripwire reddened
 * it BY NAME (`one-cast-write-rule.test.ts` vs `one-library-copy.test.ts`, row
 * 284), which is exactly the centralization obligation firing on a copy at
 * birth. It is therefore FOLDED here: one definition of "the `src/` tree,
 * comment-stripped and whitespace-collapsed", and one needle lookup over it.
 */
export const CODE: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }),
  ).map(([path, text]) => [
    path.replace(/^\//, ''),
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' '),
  ]),
);

/** The `src/` files whose CODE contains the needle, sorted. */
export function filesWith(needle: string): string[] {
  return Object.keys(CODE)
    .filter((path) => CODE[path]?.includes(needle) === true)
    .sort();
}
