import type * as OpenRouterModule from '@/llm/openrouter';

/**
 * THE ONE WAY a test mocks the OpenRouter client (docs/17 row 424, docs/18 §2).
 *
 * The mocked module is the REAL `@/llm/openrouter` with the test's fakes laid
 * over it — never a hand-listed export object. Why, measured: 83 test files
 * mocked this module, most of them by ENUMERATING its exports (14 drifting
 * variants). Row 420 added `listImageModels` for the top bar, none of the
 * hand-listed factories carried it, and every test that rendered the app shell
 * crashed into the error boundary (module-reader 72 failures, canvas-module-
 * actions 20, provenance-display 10, ipad-overscroll 6, reader-encounter-roster
 * 4). With the real module underneath, a new export is simply there.
 *
 * Vitest hoists `vi.mock` above the imports, so the factory cannot close over
 * a static import of this helper; the mock factory reaches it through a
 * dynamic `import('../helpers/openrouterMock')` and passes its own
 * `importOriginal` plus the fakes (`{ chat: vi.fn() }`) — the one spelling is
 * in every converted test, e.g. `tests/features/module-reader.test.tsx`.
 *
 * Pinned by `tests/architecture/one-openrouter-mock.test.ts`, which reds a
 * hand-listed (or differently spelled) mock of the module by file.
 */
export async function openrouterMock(
  importOriginal: <T>() => Promise<T>,
  overrides: Partial<typeof OpenRouterModule>,
): Promise<typeof OpenRouterModule> {
  return { ...(await importOriginal<typeof OpenRouterModule>()), ...overrides };
}
