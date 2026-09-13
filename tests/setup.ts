import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// jsdom has neither IndexedDB nor ResizeObserver; the app (Dexie) and the
// resizable workspace panes (react-resizable-panels) need them in tests.
class ResizeObserverStub {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  observe(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  unobserve(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}

// Base UI's ScrollArea calls `viewport.getAnimations()` shortly after mount;
// jsdom has no Web Animations API.
if (typeof Element !== 'undefined' && !('getAnimations' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    value: () => [] as Animation[],
    configurable: true,
    writable: true,
  });
}

// cmdk (quick-find palette) scrolls the highlighted item into view; jsdom
// lacks Element.scrollIntoView.
if (typeof Element !== 'undefined' && !('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    value: () => {},
    configurable: true,
    writable: true,
  });
}

// sonner's toast swipe handler calls `event.target.setPointerCapture(...)` on
// pointerdown (dist/index.mjs:750) BEFORE it checks whether the target is a
// button, so ANY pointer interaction with a rendered toast — `userEvent.click`
// on the toast's close button included — throws under jsdom, which implements
// none of the pointer-capture API. A no-op is the honest "no pointer capture in
// jsdom" answer (the swipe geometry those calls exist for needs layout, which
// jsdom has none of). Without this, a test that clicks a toast fails with
// three unhandled errors and a non-zero exit while every assertion passes — a
// trap, not a real failure. Only the method sonner actually calls is stubbed
// (`hasPointerCapture` / `releasePointerCapture` appear nowhere in sonner or in
// `src/`); add the others the same way if something starts calling them.
if (typeof Element !== 'undefined' && !('setPointerCapture' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    value: () => {},
    configurable: true,
    writable: true,
  });
}

// CodeMirror 6 measures text with DOM Range.getClientRects/getBoundingClientRect
// (editor measurement runs on requestAnimationFrame after doc updates); jsdom
// implements neither on Range, so an rAF-scheduled measure crashes the worker
// with an uncaught exception. An empty rect list is the honest "no layout"
// answer — CM6 falls back to its char-size heuristics.
if (typeof Range !== 'undefined') {
  if (!('getClientRects' in Range.prototype)) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      // An empty rect list (length 0) is the honest "no layout" answer —
      // CM6 iterates it and falls back to its char-size heuristics.
      value: () => ({ length: 0, item: () => null }) as unknown as DOMRectList,
      configurable: true,
      writable: true,
    });
  }
  if (!('getBoundingClientRect' in Range.prototype)) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Console-hygiene guard (docs/08-TESTING.md §Console guard).
 *
 * Every `console.error` / `console.warn` emitted while a test runs fails that
 * test, unless the message matches an allowlist entry below. This turns the
 * whole suite into a detector for the class of bugs that only surface as
 * console noise in the browser (Base UI composition warnings, React
 * key/ref/prop warnings, jsdom gaps, silent `console.error` fallbacks that
 * 00-OVERVIEW forbids) — without anyone clicking through the UI.
 *
 * Each allowlist entry needs a concrete `why`. An entry is only allowed to
 * match a *documented, intentional* noise source — never to paper over a
 * regression.
 */
type NoiseLevel = 'error' | 'warn';
interface NoiseEntry {
  level: NoiseLevel;
  text: string;
}

/** One recorded console line, flattened for matching and reporting. */
const noise: NoiseEntry[] = [];

function describeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

const realConsoleError = console.error.bind(console);
const realConsoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  noise.push({ level: 'error', text: args.map(describeArg).join(' ') });
  realConsoleError(...args);
};
console.warn = (...args: unknown[]) => {
  noise.push({ level: 'warn', text: args.map(describeArg).join(' ') });
  realConsoleWarn(...args);
};

/**
 * Intentional console noise. `file` scoping is required unless the source is
 * genuinely app-wide; both patterns must match for an entry to apply.
 */
const ALLOWED_NOISE: readonly {
  file: RegExp | undefined;
  message: RegExp;
  why: string;
}[] = [
  {
    file: undefined,
    message: /React Router Future Flag Warning/,
    why: 'react-router v6 prints one opt-in notice per created router; behavior is intentionally unchanged until a planned v7 migration (05-UI pins v6).',
  },
  {
    file: undefined,
    message: /standardFontDataUrl/,
    why: 'pdfjs warns that standard font data cannot be loaded under vitest (no worker/asset URLs to fetch). Text extraction does not use it — the pipeline tests assert extracted content directly.',
  },
  {
    file: /global-errors\.test\./,
    message: /\[campaigner\] render crash:|The above error occurred in|render exploded|Not implemented:/,
    why: 'the test deliberately crashes rendering (and jsdom not-implemented noise from the stubbed location) to verify the global error boundary is loud.',
  },
  {
    file: /ingestFiles\.test\./,
    message: /Indexing all PDF objects/,
    why: 'the ingest-failure test deliberately feeds pdfjs a truncated PDF ("%PDF" header, no body); pdfjs warns while scanning for a recoverable xref and the ingest then fails loudly \u2014 the warning is the expected trace of the loud failure under test.',
  },
  {
    file: /entity-panel\.test\.|entity-batch-fixed-cast\.test\.|moduleGen-cast\.test\.|stop-orchestration\.test\./,
    message:
      /\[campaigner\] (entity-batch (failure|summary|detail)|\w+ batch: \d+ of \d+ failed)/,
    why: 'the batch-failure reporting seam (features/modules/entity-batch-report, docs/17 row 131) DELIBERATELY writes down every failure: one pasteable line plus its live object the moment the failure happens, then the batch headline and the pasteable summary line. These four files drive REAL failing batches or a real refused cast, through the panel button, through `runEntityBatch` itself, through the module-gen cast finalize and through a stop-orchestration failure — so the records are the code under test working, not a regression. Scoped per file on purpose: a fifth file that starts driving a failing batch will fail with this message rather than silently joining the allowance, and the files that PIN the records spy on `console.error` instead (a spy is not noise). The seam stays completely silent for a batch with no failures, which is pinned too.',
  },
];

function isAllowed(entry: NoiseEntry, file: string): boolean {
  return ALLOWED_NOISE.some(
    (rule) =>
      (rule.file === undefined || rule.file.test(file)) && rule.message.test(entry.text),
  );
}

beforeEach(() => {
  noise.length = 0;
});

afterEach((ctx) => {
  cleanup();
  // `localStorage` exists only under jsdom; the node-environment project
  // (DOM-free test dirs) must not hit a ReferenceError in this shared hook.
  if (typeof localStorage !== 'undefined') localStorage.clear();
  if (noise.length === 0) return;
  const file = ctx.task.file.name.replace(/^.*[\\/]/, '');
  const unexpected = noise.filter((entry) => !isAllowed(entry, file));
  if (unexpected.length === 0) return;
  const shown = unexpected.slice(0, 6).map((entry) => `  [${entry.level}] ${entry.text}`);
  const hidden = unexpected.length - shown.length;
  throw new Error(
    [
      `Console noise leaked into ${file} > ${ctx.task.name} (${unexpected.length} entr${unexpected.length === 1 ? 'y' : 'ies'}) — fix the source or extend ALLOWED_NOISE with a documented why (docs/08-TESTING.md):`,
      ...shown,
      hidden > 0 ? `  … and ${hidden} more` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
});
