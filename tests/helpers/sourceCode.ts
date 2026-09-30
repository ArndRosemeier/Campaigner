import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

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

/**
 * The RAW text of every `src/**` AND `tests/**` TypeScript file, keyed by
 * repo-relative path (docs/17 row 386).
 *
 * WHY IT IS HERE RATHER THAN IN A PIN, and why it is a SECOND view of the tree
 * beside `CODE`: the scan that proves a DELETED format stays deleted must see
 * BOTH trees and must see COMMENTS, because the real drift it exists for was a
 * stale comment naming the deleted seam (`tests/features/module-canvas.test.tsx`
 * carried `assembleModulePartsDocument` in its header while no code used it).
 * `CODE` is `src/`-only and comment-stripped, which is exactly right for "is
 * this seam called anywhere" and exactly wrong for "does this name still exist".
 *
 * LAZY ON PURPOSE: it is a non-eager glob, so the whole test tree is read only
 * when a pin actually asks for it — `CODE`'s eager `src/` glob serves every
 * existing consumer unchanged.
 */
const RAW_MODULES = import.meta.glob(['/src/**/*.{ts,tsx}', '/tests/**/*.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
});

let rawCache: Record<string, string> | undefined;

/** The raw text of both trees, loaded once per test file that needs it. */
export async function rawSourceText(): Promise<Record<string, string>> {
  if (rawCache !== undefined) return rawCache;
  const entries = await Promise.all(
    Object.entries(RAW_MODULES).map(async ([path, load]): Promise<[string, string]> => [
      path.replace(/^\//, ''),
      await load(),
    ]),
  );
  rawCache = Object.fromEntries(entries);
  return rawCache;
}

/**
 * `[path, hits]` per file under `prefix` whose RAW text carries `needle`
 * (docs/17 row 392).
 *
 * ONE definition: the format pin and the pass-0 deletion scan both ask "how
 * many times does this needle appear in the raw tree, and in WHICH files", and
 * a second copy of that little loop is exactly the drift AGENTS rule 4 forbids
 * — the duplication tripwire reddened the first draft of the deletion pin for
 * it, which is how the fold happened.
 */
export function countsIn(
  raw: Record<string, string>,
  prefix: string,
  needle: string,
): [string, number][] {
  return Object.entries(raw)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, text]): [string, number] => [path, text.split(needle).length - 1])
    .filter(([, hits]) => hits > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * A path as the repo NAMES it: relative to the repo root and `/`-separated on
 * every host (docs/17 row 427).
 *
 * WHY IT IS ONE FUNCTION: `path.relative`/`path.join` answer with the PLATFORM
 * separator, so every hand-written walker that built its own paths printed
 * `src\lib\x.ts` on Windows while its pin named `src/lib/x.ts` — fourteen
 * architecture pins were red on the owner's Windows box at an unchanged base for
 * exactly that reason, each through its own copy of the walker.
 */
export function repoPath(file: string): string {
  return relative(process.cwd(), resolve(process.cwd(), file)).split(sep).join('/');
}

/**
 * THE ONE file-tree walk for tests (docs/17 row 427): every FILE under `root`
 * (repo-relative, or absolute for a temp tree) whose name ends with one of
 * `extensions`, as sorted `repoPath`s. Read a listed file with
 * `readFileSync(path, 'utf8')` — the test cwd is the repo root. Pinned as the
 * only `readdirSync` in `tests/` by `tests/architecture/one-tree-walker.test.ts`.
 */
export function repoFiles(root: string, extensions: readonly string[]): string[] {
  return readdirSync(resolve(process.cwd(), root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => repoPath(join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The RAW text of every `repoFiles(root, extensions)` file, keyed by its
 * `repoPath` — the synchronous, any-root sibling of `rawSourceText()`, and the
 * record `countsIn` counts over (docs/17 row 427).
 */
export function readTree(root: string, extensions: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    repoFiles(root, extensions).map((file) => [file, readFileSync(file, 'utf8')]),
  );
}

/**
 * `repoFiles(root, extensions)` named RELATIVE TO `root` (`src/lib/x.ts` under
 * `src` is `lib/x.ts`) — for the pins that name files the way their own
 * declared populations do (docs/17 row 427).
 */
export function namesUnder(root: string, extensions: readonly string[]): string[] {
  const prefix = `${repoPath(root)}/`;
  return repoFiles(root, extensions).map((file) => file.slice(prefix.length));
}

/** The `namesUnder(root, extensions)` files whose RAW text contains `needle`. */
export function namesWith(root: string, extensions: readonly string[], needle: string): string[] {
  const prefix = `${repoPath(root)}/`;
  return namesUnder(root, extensions).filter((name) =>
    readFileSync(`${prefix}${name}`, 'utf8').includes(needle),
  );
}
