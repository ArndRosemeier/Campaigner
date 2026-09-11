import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_WORKERS, testMaxWorkers } from '../../vite.config';

/**
 * The resource bound is a config DEFAULT, not an instruction to remember.
 *
 * Owner-directed (docs/17-DECISION-LEDGER.md row 94: "Second time something
 * like that happened. Please put a rule up to not use up all resources.").
 * Real incident, twice: a writer ran the BARE `vitest run`, and the second
 * time the harness restarted mid-turn leaving that unbounded run alive — 8
 * processes, 7 workers — still burning the box shared with the owner's own
 * desktop until the dispatcher reaped it.
 *
 * These pin the MECHANISM, not the intention: the bare form is bounded, the
 * bound is raised only when something asks explicitly, and a nonsense value
 * fails loudly instead of falling back (AGENTS binding rule 1). A rule that
 * depends on every future writer remembering an environment variable is what
 * failed here twice; the default is therefore the rule.
 */
const ORIGINAL = process.env.CAMPAIGNER_TEST_WORKERS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.CAMPAIGNER_TEST_WORKERS;
  } else {
    process.env.CAMPAIGNER_TEST_WORKERS = ORIGINAL;
  }
});

describe('the test worker bound', () => {
  it('is small by default, so a bare `vitest run` cannot use up the box', () => {
    delete process.env.CAMPAIGNER_TEST_WORKERS;

    expect(DEFAULT_TEST_WORKERS).toBe(2);
    expect(testMaxWorkers()).toBe(DEFAULT_TEST_WORKERS);
  });

  it('treats blank and whitespace-only values as unset', () => {
    process.env.CAMPAIGNER_TEST_WORKERS = '   ';

    expect(testMaxWorkers()).toBe(DEFAULT_TEST_WORKERS);
  });

  it('raises the bound only when a run asks for it explicitly', () => {
    process.env.CAMPAIGNER_TEST_WORKERS = '4';

    expect(testMaxWorkers()).toBe(4);
  });

  it('fails loudly on a value that is not a positive integer', () => {
    for (const bad of ['0', '-2', 'two', '2.5', '  1 2']) {
      process.env.CAMPAIGNER_TEST_WORKERS = bad;

      expect(() => testMaxWorkers()).toThrow(
        /CAMPAIGNER_TEST_WORKERS must be a positive integer/,
      );
    }
  });
});
