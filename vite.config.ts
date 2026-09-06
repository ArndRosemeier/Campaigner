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
  // llm (20 of 28 — see jsdom stragglers above)
  'tests/llm/{campaignGrounding,draftSchemas,encounter-items,encounter-roster,encounterRun,encounterVision,image-caps,image-timeout,imageGen-fallback,imagePromptDraft}.test.ts',
  'tests/llm/{jsonReply,language,modelFallback,openrouter,openrouterErrors,openrouter-stream,persona-extras,retry-hardening,schemaTolerances,treasureGuidance}.test.ts',
  // db (all 17 — m2kinds/battleSeed are .tsx but pure-Dexie, no rendering)
  'tests/db/**/*.test.ts',
  'tests/db/{m2kinds,battleSeed}.test.tsx',
  // domain (12 of 13 — encounterMap draws on canvas)
  'tests/domain/{artifact-ownership,battle-engine,battle-pointer-frame,create-defaults,encounterNeonDetector,encounter-location-kind,entityNormalization}.test.ts',
  'tests/domain/{itemData,module,pc-artifact,settings-onboarding,wikiGraph}.test.ts',
  // lib (8 of 13 — file-picker/globalErrors touch window, imageAspect/
  // imageIntake use canvas, graphLayout renders)
  'tests/lib/{equal,exportImport,mdToPdfmake,modulePdf,parallel,pdfExport,progress,wikilinks}.test.ts',
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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
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
      // 6 workers on the 8-core dev box (peak ~480-490MB RSS per worker,
      // ~3GB tree) measured the full suite 84.8s -> 58.1s with no timeouts;
      // 4 workers left half the machine idle.
      maxWorkers: 6,
      testTimeout: 20_000,
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: nodeTestGlobs,
          },
        },
        {
          extends: true,
          test: {
            name: 'jsdom',
            environment: 'jsdom',
            include: ['tests/**/*.test.{ts,tsx}'],
            exclude: [...configDefaults.exclude, ...nodeTestGlobs],
          },
        },
      ],
    },
  };
});
