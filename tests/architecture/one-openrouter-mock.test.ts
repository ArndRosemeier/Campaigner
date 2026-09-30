import { expect, it } from 'vitest';

import { countsIn, rawSourceText } from '../helpers/sourceCode';

/**
 * EVERY MOCK OF THE OPENROUTER CLIENT GOES THROUGH ONE FACTORY (docs/17 row
 * 424, AGENTS §Centralization obligation 2).
 *
 * The defect this exists for: 83 test files mocked `@/llm/openrouter`, most by
 * HAND-LISTING its exports. Row 420 added `listImageModels` for the top bar,
 * no hand-listed factory carried it, and every test rendering the app shell
 * crashed into the error boundary (Linux gate: module-reader 72,
 * canvas-module-actions 20, provenance-display 10, ipad-overscroll 6,
 * reader-encounter-roster 4). The one seam is `tests/helpers/openrouterMock.ts`
 * — the REAL module with the test's fakes laid over it — reached from the
 * hoisted factory through a dynamic import. A hand-listed factory, a bare
 * `importOriginal` spread, a `vi.doMock` or a relative-path mock of the module
 * reds here, naming the file.
 *
 * The scan reads SOURCE CODE (a syntax the tests themselves define), which is
 * why a pattern is legitimate here (AGENTS rule 5).
 */

/** This file carries the synthetic non-vacuity samples below. */
const SELF = 'tests/architecture/one-openrouter-mock.test.ts';

/** Any spelling that mocks the OpenRouter client module. */
const ANY_MOCK = /vi\.(?:do)?[mM]ock\(\s*['"`][^'"`]*llm\/openrouter['"`]/g;

/** The ONE spelling, over whitespace-collapsed text. */
const THE_MOCK =
  /vi\.mock\('@\/llm\/openrouter', async \(importOriginal\) => \(await import\('(?:\.\.?\/)+helpers\/openrouterMock'\)\)\.openrouterMock\(importOriginal, \{/g;

/** How many mocks of the module a file carries, and how many use the factory. */
function mockCounts(text: string): { mocks: number; viaFactory: number } {
  const collapsed = text.replace(/\s+/g, ' ');
  return {
    mocks: collapsed.match(ANY_MOCK)?.length ?? 0,
    viaFactory: collapsed.match(THE_MOCK)?.length ?? 0,
  };
}

it('mocks @/llm/openrouter only through the openrouterMock factory, in every test file', async () => {
  const raw = await rawSourceText();
  const carriers = Object.entries(raw).filter(
    ([path, text]) => path.startsWith('tests/') && path !== SELF && mockCounts(text).mocks > 0,
  );
  // Non-vacuity: the scan sees the population this pin exists for.
  expect(carriers.length).toBeGreaterThanOrEqual(80);
  const offenders = carriers
    .filter(([, text]) => {
      const { mocks, viaFactory } = mockCounts(text);
      return mocks !== viaFactory;
    })
    .map(([path]) => path)
    .sort();
  expect(offenders).toEqual([]);
});

it('defines the factory exactly once', async () => {
  const raw = await rawSourceText();
  // Built at runtime so this file's own text is not a second carrier.
  const definition = ['export async function', 'openrouterMock('].join(' ');
  expect(countsIn(raw, 'tests/', definition)).toEqual([['tests/helpers/openrouterMock.ts', 1]]);
});

it('reds a hand-listed factory and a bare importOriginal spread (the arms differ)', () => {
  const handListed = `vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  listModels: vi.fn(),
}));`;
  const bareSpread = `vi.mock("@/llm/openrouter", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));`;
  const viaFactory = `vi.mock('@/llm/openrouter', async (importOriginal) =>
  (await import('../helpers/openrouterMock')).openrouterMock(importOriginal, { chat: vi.fn() }),
);`;
  expect(mockCounts(handListed)).toEqual({ mocks: 1, viaFactory: 0 });
  expect(mockCounts(bareSpread)).toEqual({ mocks: 1, viaFactory: 0 });
  expect(mockCounts(viaFactory)).toEqual({ mocks: 1, viaFactory: 1 });
});
