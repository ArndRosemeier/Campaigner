import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';

import { assembleModulePartsDocument } from '@/domain/modulePartsDocument';
import {
  applyChatCommands,
  applyChatCommandsToDocument,
  applyChatCommandsToSnapshot,
  stringChatHandle,
} from '@/features/modules/canvas/chatApply';
import type { CanvasChatOutcome } from '@/features/modules/canvas/chatStore';
import type { CanvasEditCommand } from '@/llm/canvasChat';

/**
 * THE differential pin the applier fold owes (AGENTS §Centralization
 * obligation 2; docs/17 row 150): the canvas chat applies one reply's edit
 * commands onto TWO documents — the whole-document EDITOR (a CodeMirror view,
 * one transaction per command) and the PREVIEW SNAPSHOT STRING (pure
 * splices). Those were two byte-identical implementations (166 of 192 code
 * lines verbatim) and this file is the "exactly one" pin: every case runs
 * BOTH entry points over the same input and requires
 *
 *   - the same resulting document text,
 *   - the same `docChanged` / `lastApplied`,
 *   - the same outcome fields (`kind`, `command`, `targetParts`,
 *     `occurrences`, `from`, `to`, `before`, `reason`, `closest`,
 *     `failureFrom`, `reported`) — ids excluded, they are a counter,
 *   - the same THROWN error (message + name) when the scaffolding breaks.
 *
 * ## What this file CANNOT prove
 *
 * - A byte-identical SECOND copy is invisible to behaviour: if someone
 *   re-introduces `applyChatCommandsToSnapshot`'s old body beside the shared
 *   applier and both stay byte-identical, this differential stays GREEN. That
 *   is the honest limit of a behavioural pin, and it is exactly why the
 *   SOURCE SCAN at the bottom of this file exists — that is the half that
 *   goes red when a copy is born.
 * - The fuzz uses a FIXED seed (and a bounded case count, for the shared
 *   host's sake), so it covers the input SHAPES its generator can spell. It
 *   cannot cover an unimagined shape; the hand-built table and the
 *   pre-existing per-surface pins carry the rest.
 * - No test can stop a future author from re-copying the turn controller (or
 *   the applier) into a third file — the source scan is a GUARD, not a proof.
 */
describe('chat apply is ONE implementation — editor view vs preview string (DIFFERENTIAL)', () => {
  const PLAN = [{ title: 'Open Part' }, { title: 'Middle Part' }, { title: 'Other Part' }];
  const DOC = assembleModulePartsDocument({
    partPlan: PLAN,
    parts: [
      { planIndex: 0, markdown: 'Rain here.\nRain there.' },
      { planIndex: 1, markdown: 'Fog elsewhere.' },
    ],
  }).document;

  /** One editor view reused for every case (reset per case — mounting 300 of them is waste). */
  function mountView(): { view: EditorView; host: HTMLElement } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [history()] }),
      parent: host,
    });
    return { view, host };
  }

  function resetView(view: EditorView, doc: string): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  }

  /** Outcome ids are a monotonic counter, not content — compare everything else. */
  function comparable(outcomes: readonly CanvasChatOutcome[]): unknown[] {
    return outcomes.map((outcome) => {
      const { id, ...rest } = outcome;
      void id;
      return rest;
    });
  }

  interface Run {
    doc: string;
    docChanged: boolean;
    lastApplied: { from: number; to: number } | null;
    outcomes: unknown[];
    threw: string | null;
  }

  function runEditor(view: EditorView, doc: string, commands: CanvasEditCommand[]): Run {
    resetView(view, doc);
    try {
      const result = applyChatCommandsToDocument({ commands, partPlan: PLAN, view });
      return {
        doc: view.state.doc.toString(),
        docChanged: result.docChanged,
        lastApplied: result.lastApplied,
        outcomes: comparable(result.outcomes),
        threw: null,
      };
    } catch (error) {
      // A mid-batch throw is LOUD and leaves the already-applied commands in
      // the doc (the editor keeps them as unsaved edits) — so the partial
      // document is part of what the two surfaces must agree on.
      const failure = error as Error;
      return {
        doc: view.state.doc.toString(),
        docChanged: false,
        lastApplied: null,
        outcomes: [],
        threw: `${failure.name}: ${failure.message}`,
      };
    }
  }

  function runSnapshot(doc: string, commands: CanvasEditCommand[]): Run {
    // The string side of the SAME seam: the string handle over the one core.
    // (`applyChatCommandsToSnapshot` is exactly this pair — the adapter-agreement
    // pin below holds the public entry point to it.)
    const handle = stringChatHandle(doc);
    try {
      const result = applyChatCommands({ commands, partPlan: PLAN, handle });
      return {
        doc: handle.text(),
        docChanged: result.docChanged,
        lastApplied: result.lastApplied,
        outcomes: comparable(result.outcomes),
        threw: null,
      };
    } catch (error) {
      const failure = error as Error;
      return {
        doc: handle.text(),
        docChanged: false,
        lastApplied: null,
        outcomes: [],
        threw: `${failure.name}: ${failure.message}`,
      };
    }
  }

  /** Runs one case through BOTH paths and requires them to be indistinguishable. */
  function expectAgreement(view: EditorView, doc: string, commands: CanvasEditCommand[], label: string): void {
    const editor = runEditor(view, doc, commands);
    const snapshot = runSnapshot(doc, commands);
    expect(snapshot, `${label}: document text`).toEqual(editor);
  }

  // --- hand-built cases (the audit's five, plus the shapes that diverge in prose) ---

  const HAND_BUILT: { label: string; doc: string; commands: CanvasEditCommand[] }[] = [
    {
      label: 'one replace',
      doc: DOC,
      commands: [{ search: 'Rain here.', replace: 'Longer rainy opening.', all: false }],
    },
    {
      label: 'replace-all across parts of one section',
      doc: DOC,
      commands: [{ search: 'Rain', replace: 'Mist', all: true }],
    },
    {
      label: 'two commands, ranges resolved per command',
      doc: DOC,
      commands: [
        { search: 'Rain here.', replace: 'Longer rainy opening.', all: false },
        { search: 'Rain there.', replace: 'Closing rain.', all: false },
      ],
    },
    {
      label: 'zero matches (loud, closest candidate)',
      doc: DOC,
      commands: [{ search: 'Rain hammer the stones today.', replace: 'x', all: false }],
    },
    {
      label: 'multi-match without all (loud, total count)',
      doc: DOC,
      commands: [{ search: 'e', replace: 'E', all: false }],
    },
    {
      label: 'empty search (loud guard)',
      doc: DOC,
      commands: [{ search: '   ', replace: 'x', all: false }],
    },
    {
      label: 'empty-part label-anchor fill',
      doc: DOC,
      commands: [
        {
          search: '[Part 3 of 3 — Other Part]',
          replace: '[Part 3 of 3 — Other Part]\n\nEmbers, at last.',
          all: false,
        },
      ],
    },
    {
      label: 'prompt scaffolding echoed into the replace text (loud hygiene failure)',
      doc: DOC,
      commands: [
        {
          search: 'Fog elsewhere.',
          replace: 'The artifact "name" field must be exactly the name of the artifact.',
          all: false,
        },
      ],
    },
    {
      label: 'a replace that fakes the scaffolding (throws on the NEXT split)',
      doc: DOC,
      commands: [
        { search: 'Fog elsewhere.', replace: 'Fog elsewhere.', all: false },
        { search: 'Rain here.', replace: 'Rain here.\n\n==========\n\n', all: false },
        { search: 'Embers', replace: 'Embers!', all: false },
      ],
    },
    {
      label: 'nothing to do (empty command list)',
      doc: DOC,
      commands: [],
    },
  ];

  // --- deterministic fuzz (FIXED seed, bounded count) -----------------------------

  /** mulberry32 — a small deterministic PRNG; the seed is the whole contract. */
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEARCHES = [
    'Rain here.',
    'Rain there.',
    'Fog elsewhere.',
    'Rain',
    'e',
    'zzz not present',
    '   ',
    '[Part 2 of 3 — Middle Part]',
    'Fog',
    '==========',
    'here.\nRain',
  ];
  const REPLACES = [
    'Mist',
    'Mist.',
    '',
    'Longer rainy opening.',
    'The artifact "name" field must be exactly the name of the artifact.',
    'Rain here.\n\n==========\n\n',
    '[Part 3 of 3 — Other Part]\n\nEmbers.',
  ];
  const FUZZ_CASES = 300;

  const FUZZ: { label: string; doc: string; commands: CanvasEditCommand[] }[] = (() => {
    const random = mulberry32(0x5eed150);
    const cases: { label: string; doc: string; commands: CanvasEditCommand[] }[] = [];
    for (let index = 0; index < FUZZ_CASES; index += 1) {
      const count = 1 + Math.floor(random() * 4);
      const commands: CanvasEditCommand[] = [];
      for (let command = 0; command < count; command += 1) {
        commands.push({
          search: SEARCHES[Math.floor(random() * SEARCHES.length)] ?? 'Rain',
          replace: REPLACES[Math.floor(random() * REPLACES.length)] ?? 'Mist',
          all: random() < 0.5,
        });
      }
      cases.push({ label: `fuzz #${String(index)}`, doc: DOC, commands });
    }
    return cases;
  })();

  const CASES = [...HAND_BUILT, ...FUZZ];

  it('runs every case through BOTH paths and finds them indistinguishable', () => {
    // The count is ASSERTED so a generator that silently empties out cannot
    // turn this pin into a no-op.
    expect(HAND_BUILT).toHaveLength(10);
    expect(FUZZ).toHaveLength(300);
    expect(CASES).toHaveLength(310);

    const { view, host } = mountView();
    try {
      for (const testCase of CASES) {
        expectAgreement(view, testCase.doc, testCase.commands, testCase.label);
      }
    } finally {
      host.remove();
    }
  });

  it('holds the two PUBLIC entry points to their handles over the one core', () => {
    // The differential above pins the two HANDLES. This pins the plumbing:
    // `applyChatCommandsToDocument` IS `editorChatHandle` + the core, and
    // `applyChatCommandsToSnapshot` IS `stringChatHandle` + the core, for the
    // same table (throwing cases compared by their error contract).
    const { view, host } = mountView();
    try {
      for (const testCase of CASES) {
        resetView(view, testCase.doc);
        const viaDocument = ((): Run => {
          try {
            const result = applyChatCommandsToDocument({
              commands: testCase.commands,
              partPlan: PLAN,
              view,
            });
            return {
              doc: view.state.doc.toString(),
              docChanged: result.docChanged,
              lastApplied: result.lastApplied,
              outcomes: comparable(result.outcomes),
              threw: null,
            };
          } catch (error) {
            const failure = error as Error;
            return {
              doc: view.state.doc.toString(),
              docChanged: false,
              lastApplied: null,
              outcomes: [],
              threw: `${failure.name}: ${failure.message}`,
            };
          }
        })();
        const viaSnapshotEntry = ((): Run => {
          try {
            const result = applyChatCommandsToSnapshot({
              commands: testCase.commands,
              partPlan: PLAN,
              doc: testCase.doc,
            });
            return {
              doc: result.doc,
              docChanged: result.docChanged,
              lastApplied: result.lastApplied,
              outcomes: comparable(result.outcomes),
              threw: null,
            };
          } catch (error) {
            const failure = error as Error;
            return {
              doc: testCase.doc,
              docChanged: false,
              lastApplied: null,
              outcomes: [],
              threw: `${failure.name}: ${failure.message}`,
            };
          }
        })();
        const handleRun = runEditor(view, testCase.doc, testCase.commands);
        const stringRun = runSnapshot(testCase.doc, testCase.commands);
        expect(viaDocument, `${testCase.label}: applyChatCommandsToDocument`).toEqual(handleRun);
        expect(viaSnapshotEntry, `${testCase.label}: applyChatCommandsToSnapshot`).toEqual({
          ...stringRun,
          // The preview ENTRY POINT has no handle to read a partial document
          // from when the batch throws mid-way (it returns nothing but the
          // throw) — that surface difference is the caller's, and it is
          // compared on the error contract alone.
          doc: stringRun.threw === null ? stringRun.doc : testCase.doc,
        });
      }
    } finally {
      host.remove();
    }
  });

  it('is non-vacuous: the table really applies, really fails, really throws, really repeats', () => {    const { view, host } = mountView();
    try {
      const runs = CASES.map((testCase) => runEditor(view, testCase.doc, testCase.commands));
      const applied = runs.filter((run) => run.docChanged).length;
      const failed = runs.filter((run) => run.outcomes.length > 0 && !run.docChanged).length;
      const threw = runs.filter((run) => run.threw !== null).length;
      const partialOnThrow = runs.filter((run) => run.threw !== null && run.doc !== DOC).length;
      expect(applied).toBeGreaterThan(50);
      expect(failed).toBeGreaterThan(20);
      expect(threw).toBeGreaterThan(0);
      // A throw really can leave partial edits behind — otherwise the partial-
      // document comparison above would be vacuous.
      expect(partialOnThrow).toBeGreaterThan(0);
    } finally {
      host.remove();
    }
  });
});

// --- the "exactly one applier" SOURCE SCAN --------------------------------------

/**
 * The behavioural half above cannot see a byte-identical copy (both would
 * agree, forever). This is the half that CAN: it fails the moment a second
 * applier implementation is written into the canvas feature — the shape the
 * fold just deleted. It reads source TEXT, so it is red on the re-copy and
 * green on any behaviour-only change; that is deliberate.
 */
describe('the chat applier is the ONLY one (SOURCE SCAN)', () => {
  const CANVAS_DIR = join(process.cwd(), 'src', 'features', 'modules', 'canvas');
  const APPLIER = join(CANVAS_DIR, 'chatApply.ts');

  function canvasSources(): string[] {
    return readdirSync(CANVAS_DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => join(CANVAS_DIR, name));
  }

  it('declares the applier, its outcome builders and its snippet cap EXACTLY once', () => {
    const files = canvasSources();
    // Non-vacuity: the canvas directory holds the surfaces this scan is about.
    expect(files.length).toBeGreaterThan(15);

    const counts = (pattern: RegExp): string[] =>
      files.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => relative(process.cwd(), file));

    expect(counts(/export function applyChatCommands\(/)).toEqual([relative(process.cwd(), APPLIER)]);
    expect(counts(/export function applyChatCommandsToDocument\(/)).toEqual([relative(process.cwd(), APPLIER)]);
    expect(counts(/export function applyChatCommandsToSnapshot\(/)).toEqual([relative(process.cwd(), APPLIER)]);
    expect(counts(/function failedOutcome\(/)).toEqual([relative(process.cwd(), APPLIER)]);
    expect(counts(/function appliedOutcome\(/)).toEqual([relative(process.cwd(), APPLIER)]);
    expect(counts(/MAX_CARD_SNIPPET =/)).toEqual([relative(process.cwd(), APPLIER)]);
    // The applier's own sentences — a second copy brings its own copy of these.
    expect(counts(/the search text does not appear in the current document/)).toEqual([
      relative(process.cwd(), APPLIER),
    ]);
    expect(counts(/export interface ChatDocumentHandle/)).toEqual([relative(process.cwd(), APPLIER)]);
  });

  it('routes BOTH surfaces through the one applier handle seam', () => {
    const applier = readFileSync(APPLIER, 'utf8');
    expect(applier).toContain('editorChatHandle');
    expect(applier).toContain('stringChatHandle');
    // The preview surface re-exports the one applier; it declares nothing.
    const preview = readFileSync(join(CANVAS_DIR, 'snapshotChat.ts'), 'utf8');
    expect(preview).toContain("from '@/features/modules/canvas/chatApply'");
    expect(preview).not.toContain('const MAX_CARD_SNIPPET');
    expect(preview).not.toContain('function failedOutcome');
    expect(preview).not.toContain('function appliedOutcome');
  });

  it('leaves the per-part ladder with exactly ONE caller outside the llm module', () => {
    const srcDir = join(process.cwd(), 'src');
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (full === join(srcDir, 'llm', 'canvasChat.ts')) continue; // the declaration
        if (readFileSync(full, 'utf8').includes('resolveCanvasEditAcrossParts(')) {
          callers.push(relative(process.cwd(), full));
        }
      }
    };
    walk(srcDir);
    expect(callers).toEqual([relative(process.cwd(), APPLIER)]);
  });
});
