import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

// DOM-free test files run in the node environment: a fresh jsdom window
// costs ~0.75s of fixed worker time per file, and these files never touch
// the DOM. vitest 4 removed environmentMatchGlobs; test.projects is the
// supported split. nodeTestGlobs is shared by both projects (include for
// node, exclude for jsdom), so a file runs exactly once in exactly one
// project. The jsdom project keeps the catch-all include: anything not
// listed here defaults to jsdom, and a file should be added here only
// after verifying it passes under `--environment=node`.
//
// Verified jsdom stragglers (NOT listed, must stay jsdom): llm's
// chainRunner, encounterCartographer, imageRun, moduleGen,
// moduleGen-auto-spine, runEngine, runEngine-grounding and
// runEngine-grounding-expansion drive assertions through @testing-library
// waitFor, which needs a DOM container; domain/encounterMap and
// lib/imageAspect + lib/imageIntake use canvas; lib/file-picker and
// lib/globalErrors touch window; features/module-post-generation's
// real-chain Dexie timing only settles under jsdom.
const nodeTestGlobs = [
  // llm (21 of 29 — see jsdom stragglers above)
  'tests/llm/{campaignGrounding,canvasChat,draftSchemas,encounter-items,encounter-roster,encounterRun,encounterVision,image-caps,image-timeout,imageGen-fallback,imagePromptDraft}.test.ts',
  'tests/llm/{jsonReply,language,modelFallback,openrouter,openrouterErrors,openrouter-stream,persona-extras,retry-hardening,schemaTolerances,treasureGuidance}.test.ts',
  // db (all 17 — m2kinds/battleSeed are .tsx but pure-Dexie, no rendering)
  'tests/db/**/*.test.ts',
  'tests/db/{m2kinds,battleSeed}.test.tsx',
  // domain (12 of 13 — encounterMap draws on canvas)
  'tests/domain/{artifact-ownership,battle-engine,battle-pointer-frame,create-defaults,encounterNeonDetector,encounter-location-kind,entityNormalization}.test.ts',
  'tests/domain/{itemData,module,pc-artifact,settings-onboarding,wikiGraph}.test.ts',
  // lib (8 of 13 — file-picker/globalErrors touch window, imageAspect/
  // imageIntake use canvas, graphLayout renders)
  'tests/lib/{equal,exportImport,mdToPdfmake,modulePdf,parallel,pdfExport,progress,stopEpoch,wikilinks}.test.ts',
  // ingest (all 11, incl. packs/)
  'tests/ingest/**/*.test.ts',
  // search (both), bestiary roster (bestiary-roster.tsx renders)
  'tests/search/**/*.test.ts',
  'tests/bestiary/roster.test.ts',
  // features pure helpers (module-post-generation needs jsdom, see above)
  'tests/features/{dice-math,mention-view,persona-request,seed-from-module}.test.ts',
  // root-level DOM-free files (walkthrough uses waitFor)
  'tests/{backup,pwa-assets,search}.test.ts',
];

/**
 * The worker budget a test run uses when nothing says otherwise.
 *
 * TWO, not the dev box's six, and that is deliberate (owner-directed,
 * `docs/17-DECISION-LEDGER.md` row 94): a resource bound that depends on every
 * writer REMEMBERING an environment variable is not a bound. Real incident,
 * twice — a writer ran the bare form, and the second time an interrupted turn
 * left that unbounded run (7 workers, 8 processes) alive straight through a
 * harness restart on a box shared with the owner's own desktop. With this
 * default, `pnpm exec vitest run` cannot exceed two workers whatever anyone
 * forgets; raising it is an explicit act by whoever owns the machine's load.
 */
export const DEFAULT_TEST_WORKERS = 2;

/**
 * The worker budget for a test run — the ONE bound that actually binds.
 *
 * `maxWorkers` must be set at the root AND in every project: vitest resolves a
 * project's own value ahead of the root config, and `extends: true` copies the
 * root value into each project, so a CLI `--maxWorkers=N` (which lands on the
 * root) is silently ignored and both projects keep running the file-level
 * value. MEASURED on this shared 8-core box: `pnpm exec vitest run
 * --maxWorkers=2` runs 6 CPU-busy workers and 10 alive — i.e. the flag the
 * agent rules used to prescribe was never a bound, and two writers meant up to
 * twelve workers. The bound lives in the config (and, to raise it, in the
 * environment):
 *
 *   CAMPAIGNER_TEST_WORKERS=4 pnpm exec vitest run
 *
 * A value that is present but not a positive integer is a loud error rather
 * than a silent fallback (AGENTS rule 1).
 */
export function testMaxWorkers(): number {
  const raw = process.env.CAMPAIGNER_TEST_WORKERS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_TEST_WORKERS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `CAMPAIGNER_TEST_WORKERS must be a positive integer (got "${raw}") — ` +
        `unset it to use the default of ${String(DEFAULT_TEST_WORKERS)}.`,
    );
  }
  return parsed;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const maxWorkers = testMaxWorkers();
  const fromEnv = process.env.CAMPAIGNER_BASE?.trim();
  const base =
    fromEnv && fromEnv.length > 0
      ? fromEnv.endsWith('/')
        ? fromEnv
        : `${fromEnv}/`
      : mode === 'domainfactory'
        ? '/Campaigner/'
        : '/';

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    worker: {
      format: 'es',
    },
    test: {
      globals: true,
      setupFiles: ['tests/setup.ts'],
      css: false,
      // jsdom + PDF/image suites are memory-heavy; unbounded workers caused
      // event-loop starvation and false 5s timeouts on constrained CI/dev VMs.
      // Historical measurement on this 8-core box, when the machine was
      // exclusively ours: 6 workers (peak ~480-490MB RSS per worker, ~3GB tree)
      // ran the full suite 84.8s -> 58.1s. The default is now 2 because the box
      // is shared with the owner's desktop; raise it deliberately with
      // CAMPAIGNER_TEST_WORKERS for a run that owns the machine (see
      // testMaxWorkers above). The CLI flag does NOT work here, and this value
      // is repeated in each project for that reason.
      maxWorkers,
      testTimeout: 20_000,
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: nodeTestGlobs,
            maxWorkers,
          },
        },
        {
          extends: true,
          test: {
            name: 'jsdom',
            environment: 'jsdom',
            include: ['tests/**/*.test.{ts,tsx}'],
            exclude: [...configDefaults.exclude, ...nodeTestGlobs],
            maxWorkers,
          },
        },
      ],
    },
  };
});
