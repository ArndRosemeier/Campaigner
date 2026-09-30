import { describe, expect, it } from 'vitest';

import { rawSourceText } from '../helpers/sourceCode';

/**
 * A test that runs a child process against a THROWAWAY git repository passes
 * the isolated environment (docs/17 row 428). Inside the pre-push hook GIT_DIR
 * points at the real repository, and an inherited child `git` wrote the test
 * fixtures into it (commits on the pushing branch, core.bare=true, a [user]
 * section). The count of child-process calls in each such file must equal its
 * count of `isolatedGitEnv(` uses, so a new call without it reds here.
 */
const FILES = [
  'tests/architecture/build-status-payload.test.ts',
  'tests/architecture/version-counter.test.ts',
];

describe('child processes in throwaway-repo tests run with the isolated git env', () => {
  it('every execFileSync in those files passes isolatedGitEnv (docs/scripts calls included)', async () => {
    const raw = await rawSourceText();
    for (const file of FILES) {
      const text = raw[file] ?? '';
      expect(text.length).toBeGreaterThan(0);
      // The node call to scripts/docsOnly.mjs reads stdin only (no git) and is
      // the one declared exception, in version-counter.
      const calls = text.split('execFileSync(').length - 1 - (file.endsWith('version-counter.test.ts') ? 1 : 0);
      const isolated = text.split('isolatedGitEnv(').length - 1;
      expect({ file, isolated }).toEqual({ file, isolated: calls });
    }
  });

  it('no other test file runs git (a new one must be added above)', async () => {
    const raw = await rawSourceText();
    const SELF = 'tests/architecture/isolated-git-env.test.ts';
    // `'git'` may sit on the line after `execFileSync(` — allow whitespace.
    const gitRunners = Object.entries(raw)
      .filter(([path]) => path.startsWith('tests/') && path !== SELF)
      .filter(([, text]) => /execFileSync\(\s*['"]git['"]/.test(text))
      .map(([path]) => path);
    expect(gitRunners.sort()).toEqual([...FILES].sort());
  });
});
