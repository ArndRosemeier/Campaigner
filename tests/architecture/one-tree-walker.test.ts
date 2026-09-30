import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { rawSourceText } from '../helpers/sourceCode';

/**
 * THE one file-tree walk for tests (docs/17 row 427, docs/18 §2).
 *
 * Every source scan used to carry its own directory walker — recursive
 * `sourceFiles`/`walk`/`srcFiles` bodies, inline recursive `readdirSync`, async
 * `readdir` recursions — about fifty copies of ONE idea: "the files of this
 * tree, named as the repo names them". Each built its paths with
 * `path.join`/`path.relative`, which answer with the PLATFORM separator, so on
 * the owner's Windows box fourteen architecture pins (and more beyond) printed
 * `src\lib\x.ts` against expectations spelled `src/lib/x.ts` and were red at an
 * unchanged base, while Linux stayed green. The copies are folded onto
 * `tests/helpers/sourceCode.ts` (`repoFiles` / `namesUnder` / `namesWith` /
 * `readTree`, beside `CODE` and `rawSourceText`), whose paths are `/`-separated
 * on every host; this pin keeps it ONE.
 *
 * WHAT REDS IT: a directory listing — a `readdirSync`, `readdir`,
 * `opendirSync` or `opendir` call — anywhere under `tests/` except the helper. A
 * genuine exception (a test ABOUT the file system) is declared by name in
 * `EXCEPTIONS` with its reason. `tests/fixtures/**` is out of scope (captured
 * data, not scans). The scan reads RAW text, comments included, so the needle
 * is assembled at runtime and this file cannot match itself. The helper is
 * read from disk: `import.meta.glob` never lists the module that declares it,
 * so `rawSourceText()` cannot see its own home.
 */

const HELPER = 'tests/helpers/sourceCode.ts';

/** Files allowed to list a directory themselves, each with its reason. None today. */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

const DIR = ['read', 'dir'].join('');
const OPEN = ['open', 'dir'].join('');
const LISTING = new RegExp(`\\b(?:${DIR}|${OPEN})(?:Sync)?\\s*\\(`, 'g');

describe('one file-tree walk in tests/ (SOURCE SCAN, docs/17 row 427)', () => {
  it('lists directories only inside the shared helper', async () => {
    const raw = await rawSourceText();
    const testFiles = Object.keys(raw).filter(
      (file) => file.startsWith('tests/') && !file.startsWith('tests/fixtures/'),
    );
    // Non-vacuity: the scan sees the whole test tree, this file included.
    expect(testFiles.length).toBeGreaterThan(300);
    expect(testFiles).toContain('tests/architecture/one-tree-walker.test.ts');

    const listers = testFiles
      .filter((file) => (raw[file]?.match(LISTING) ?? []).length > 0)
      .sort();
    expect(listers).toEqual(Object.keys(EXCEPTIONS).sort());
    // Non-vacuity for the needle: the helper really carries its ONE listing.
    expect(readFileSync(HELPER, 'utf8').match(LISTING) ?? []).toHaveLength(1);
    for (const [file, reason] of Object.entries(EXCEPTIONS)) {
      expect(reason.length, `no reason for ${file}`).toBeGreaterThan(20);
    }
  });

  it('the needle sees every listing spelling it names', () => {
    for (const spelling of [
      `${DIR}Sync(root)`,
      `await ${DIR}(dir, {})`,
      `fs.${DIR}Sync (dir)`,
      `${OPEN}Sync(dir)`,
    ]) {
      expect(spelling.match(LISTING), spelling).not.toBeNull();
    }
  });
});
