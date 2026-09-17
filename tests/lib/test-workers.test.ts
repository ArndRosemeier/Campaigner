import { getHeapStatistics } from 'node:v8';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_WORKERS,
  TEST_WORKER_HEAP_CAP_MB,
  testMaxWorkers,
} from '../../vite.config';

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
 *
 * The MEMORY half of the bound has its own describe below, and it needed a pin
 * of its own kind — count alone cannot notice a cap vitest never applied
 * (ledger row 229).
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

describe('the per-worker heap cap', () => {
  it('is really applied to the worker this file runs in — vitest 4 reads `execArgv`, never `poolOptions`', () => {
    // Vitest 4 flattened `poolOptions`, and this pin is the reason it can never
    // go quiet again (ledger row 229). The pre-4 spelling
    // (`poolOptions.forks.execArgv`) printed ONE deprecation line and applied NO
    // cap, and `poolOptions` is absent from vitest's own types — so neither the
    // suite nor `tsc -b` (which DOES typecheck vite.config.ts) could see that
    // AGENTS §Host hygiene 7's "caps each worker's heap at 1536 MB" had become
    // false. MEASURED on this box while writing the pin: the declared cap →
    // 1584 MB `heap_size_limit`, the dead spelling → 4144 MB, i.e. no cap at all
    // (V8's default for this machine).
    //
    // The probe measures the LIVE limit of the worker the file runs in, so it
    // reds whichever way the cap stops reaching the workers — a resurrected
    // `poolOptions`, a dropped `execArgv`, or a project that stops inheriting it.
    //
    // TWO arms, because either one alone can be masked. The LIMIT is the
    // behaviour that must hold; `process.execArgv` names the mechanism the config
    // itself owns. A run whose env carries a lower headline cap masks the limit
    // arm — the gate runs under `NODE_OPTIONS=--max-old-space-size=1536`, which
    // caps a worker even when the config's `execArgv` is GONE (measured: 1584 MB
    // both ways) — so the execArgv arm is the one that reds in the gate, and the
    // limit arm is the one that reds for a bare run (measured: 4144 MB).
    const limitMb = getHeapStatistics().heap_size_limit / (1024 * 1024);

    // V8 rounds the request up a little (1536 → 1584 measured), so this is a
    // ceiling just above it — and far below the 4144 MB of no cap at all.
    expect(limitMb).toBeLessThan(TEST_WORKER_HEAP_CAP_MB * 1.1);
    expect(process.execArgv).toContain(
      `--max-old-space-size=${String(TEST_WORKER_HEAP_CAP_MB)}`,
    );
  });
});
