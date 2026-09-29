import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';

import { assembleModuleDocument, moduleDocumentSections, moduleLevelSeparator } from '@/domain/moduleDocument';
import {
  applyChatCommands,
  applyChatCommandsToDocument,
  applyChatCommandsToSnapshot,
  stringChatHandle,
} from '@/features/modules/canvas/chatApply';
import type { CanvasChatOutcome } from '@/features/modules/canvas/chatStore';
import type { CanvasEditCommand, CanvasLevelEditCommand } from '@/llm/canvasChat';

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
  const DOC = assembleModuleDocument({
    levels: [
      { number: 0, text: 'The premise of the whole module.' },
      { number: 1, text: 'Rain here.\nRain there.' },
      { number: 2, text: 'Fog elsewhere.' },
      { number: 3, text: '' },
    ],
  });

  /** The "starts with nothing" shape: level 0 only, no separators at all. */
  const PREMISE_ONLY_DOC = 'Only the premise so far.';

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
    lastApplied: { from: number; to: number }[];
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
        lastApplied: [],
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
        lastApplied: [],
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
      label: 'empty-level separator-anchor fill',
      doc: DOC,
      commands: [
        {
          search: moduleLevelSeparator(3),
          replace: `${moduleLevelSeparator(3)}\n\nEmbers, at last.`,
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
      label: 'a replace that writes a level header into a level (throws on the NEXT parse)',
      doc: DOC,
      commands: [
        { search: 'Fog elsewhere.', replace: 'Fog elsewhere.', all: false },
        {
          search: 'Rain here.',
          replace: `Rain here.\n\n${moduleLevelSeparator(9)}\n\n`,
          all: false,
        },
        { search: 'Embers', replace: 'Embers!', all: false },
      ],
    },
    {
      label: 'nothing to do (empty command list)',
      doc: DOC,
      commands: [],
    },
    // --- the level-addressed commands (docs/17 row 381): they ride the SAME
    // applier, so both surfaces must agree on them exactly like any edit. ---
    {
      label: 'replace_level 0 replaces the PREMISE through the level path',
      doc: DOC,
      commands: [{ kind: 'replace_level', level: 0, replace: 'A brand new premise.' }],
    },
    {
      label: 'replace_level 2 replaces exactly level 2',
      doc: DOC,
      commands: [{ kind: 'replace_level', level: 2, replace: 'Fog, replaced whole.' }],
    },
    {
      label: 'append_level 3 appends to the EXISTING (empty) level 3',
      doc: DOC,
      commands: [{ kind: 'append_level', level: 3, replace: 'Embers, at last.' }],
    },
    {
      label: 'append_level 4 CREATES level 4 (the app writes the separator)',
      doc: DOC,
      commands: [{ kind: 'append_level', level: 4, replace: '## The Long Watch\nNobody sleeps.' }],
    },
    {
      label: 'append_level 1 creates the FIRST level on a premise-only document',
      doc: PREMISE_ONLY_DOC,
      commands: [{ kind: 'append_level', level: 1, replace: 'The first level.' }],
    },
    {
      label: 'replace_level 9 (out of range) is refused, the document unchanged',
      doc: DOC,
      commands: [{ kind: 'replace_level', level: 9, replace: 'x' }],
    },
    {
      label: 'append_level 5 skips a number and is refused',
      doc: DOC,
      commands: [{ kind: 'append_level', level: 5, replace: 'x' }],
    },
    {
      label: 'a level body carrying a header-shaped line is refused by the seam',
      doc: DOC,
      commands: [
        { kind: 'replace_level', level: 2, replace: `Fog.\n\n${moduleLevelSeparator(9)}\n\n` },
      ],
    },
    {
      label: 'a level command with prompt scaffolding in its text (loud hygiene failure)',
      doc: DOC,
      commands: [
        {
          kind: 'append_level',
          level: 4,
          replace: 'The artifact "name" field must be exactly the name of the artifact.',
        },
      ],
    },
    {
      label: 'multi-command: a bad level target is refused while its siblings still apply',
      doc: DOC,
      commands: [
        { search: 'Rain here.', replace: 'Longer rainy opening.', all: false },
        { kind: 'replace_level', level: 9, replace: 'x' },
        { kind: 'append_level', level: 4, replace: 'A fourth level.' },
      ],
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
    moduleLevelSeparator(2),
    'Fog',
    moduleLevelSeparator(1),
    'here.\nRain',
  ];
  const REPLACES = [
    'Mist',
    'Mist.',
    '',
    'Longer rainy opening.',
    'The artifact "name" field must be exactly the name of the artifact.',
    `Rain here.\n\n${moduleLevelSeparator(9)}\n\n`,
    `${moduleLevelSeparator(3)}\n\nEmbers.`,
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
    expect(HAND_BUILT).toHaveLength(20);
    expect(FUZZ).toHaveLength(300);
    expect(CASES).toHaveLength(320);

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
              lastApplied: [],
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
              lastApplied: [],
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

// --- the level-addressed commands: the CONTRACT the differential cannot state ---

/**
 * The differential above proves the two surfaces AGREE; it cannot say what they
 * should agree ON. These pins state the level-addressed contract itself
 * (docs/17 row 381) on the snapshot surface — the exact document text after an
 * edit, which section the outcome card names, and that a refused target is LOUD
 * and leaves the document BYTE-IDENTICAL.
 *
 * THE EDIT IS THE DOMAIN SEAM'S (`replaceLevelText`/`appendLevelText`): the app
 * writes the canonical `=====Level N=====` line, level 0 is the premise, a new
 * level is exactly `max + 1`. These pins assert the TEXT, not a flag, so a
 * second implementation of any of those rules would have to reproduce this
 * document byte for byte.
 */
describe('the level-addressed commands (docs/17 row 381)', () => {
  const PREMISE = 'The premise of the whole module.';
  const PREMISE_ONLY_DOC = 'Only the premise so far.';
  const BASE = assembleModuleDocument({
    levels: [
      { number: 0, text: PREMISE },
      { number: 1, text: 'Rain here.' },
      { number: 2, text: 'Fog elsewhere.' },
    ],
  });
  const PLAN = [{ title: 'The Gate' }, { title: 'The Docks' }];

  function apply(commands: CanvasEditCommand[], doc: string = BASE) {
    return applyChatCommandsToSnapshot({ commands, partPlan: PLAN, doc });
  }

  function levelTexts(doc: string): string[] {
    return moduleDocumentSections(doc, PLAN).map((section) => section.text);
  }

  it('replace_level 0 replaces the PREMISE and nothing else (level 0 has no separator)', () => {
    const result = apply([{ kind: 'replace_level', level: 0, replace: 'A new premise.' }]);
    expect(result.docChanged).toBe(true);
    expect(result.doc).toBe(
      assembleModuleDocument({
        levels: [
          { number: 0, text: 'A new premise.' },
          { number: 1, text: 'Rain here.' },
          { number: 2, text: 'Fog elsewhere.' },
        ],
      }),
    );
    const outcome = result.outcomes[0];
    expect(outcome?.kind).toBe('applied');
    // planIndex − 1 IS the premise, and the card names it that way.
    expect(outcome?.targetParts).toEqual([{ planIndex: -1, title: 'Premise' }]);
    expect(outcome?.before).toBe(PREMISE);
  });

  it('replace_level N replaces exactly level N', () => {
    const result = apply([{ kind: 'replace_level', level: 2, replace: 'Fog, replaced whole.' }]);
    expect(result.docChanged).toBe(true);
    expect(levelTexts(result.doc)).toEqual([PREMISE, 'Rain here.', 'Fog, replaced whole.']);
    const outcome = result.outcomes[0];
    expect(outcome?.targetParts).toEqual([{ planIndex: 1, title: 'The Docks' }]);
    expect(outcome?.before).toBe('Fog elsewhere.');
  });

  it('append_level N on an EXISTING level appends to it (nothing is replaced)', () => {
    const result = apply([{ kind: 'append_level', level: 1, replace: 'More rain.' }]);
    expect(result.docChanged).toBe(true);
    expect(levelTexts(result.doc)).toEqual([PREMISE, 'Rain here.\n\nMore rain.', 'Fog elsewhere.']);
    const outcome = result.outcomes[0];
    expect(outcome?.kind).toBe('applied');
    expect(outcome?.targetParts).toEqual([{ planIndex: 0, title: 'The Gate' }]);
    // An append replaced NO span: the card carries no before text.
    expect(outcome?.before).toBeNull();
  });

  it('append_level max + 1 CREATES the level and the DOCUMENT TEXT carries the app separator', () => {
    const result = apply([{ kind: 'append_level', level: 3, replace: '## The Long Watch' }]);
    expect(result.docChanged).toBe(true);
    // The TEXT, not just a flag: the app's own canonical separator line.
    expect(result.doc).toContain('=====Level 3=====');
    expect(result.doc).toBe(
      assembleModuleDocument({
        levels: [
          { number: 0, text: PREMISE },
          { number: 1, text: 'Rain here.' },
          { number: 2, text: 'Fog elsewhere.' },
          { number: 3, text: '## The Long Watch' },
        ],
      }),
    );
    const outcome = result.outcomes[0];
    expect(outcome?.kind).toBe('applied');
    // A created level has no plan entry, so its card uses the derived label.
    expect(outcome?.targetParts).toEqual([{ planIndex: 2, title: 'Level 3' }]);
    expect(outcome?.before).toBeNull();
  });

  it('append_level 1 creates the FIRST level on a premise-only document', () => {
    const result = apply([{ kind: 'append_level', level: 1, replace: 'The first level.' }], PREMISE_ONLY_DOC);
    expect(result.docChanged).toBe(true);
    expect(moduleDocumentSections(result.doc, PLAN).map((section) => section.number)).toEqual([0, 1]);
    expect(result.doc).toBe(`${PREMISE_ONLY_DOC}\n\n=====Level 1=====\nThe first level.`);
  });

  it('out of range is LOUD and changes NOTHING — the document stays byte-identical', () => {
    const cases: CanvasLevelEditCommand[] = [
      { kind: 'replace_level', level: 9, replace: 'x' },
      { kind: 'append_level', level: 5, replace: 'x' },
      { kind: 'append_level', level: 4, replace: 'x' },
    ];
    for (const command of cases) {
      const result = apply([command]);
      expect(result.docChanged, JSON.stringify(command)).toBe(false);
      expect(result.doc).toBe(BASE);
      const outcome = result.outcomes[0];
      expect(outcome?.kind).toBe('failed');
      // The refusal NAMES the level and the reason the seam gave.
      expect(outcome?.reason).toContain(`level ${String(command.level)}`);
      expect(outcome?.targetParts).toEqual([]);
    }
  });

  it('a header-shaped body is refused by the seam, loudly and without a write', () => {
    const result = apply([
      { kind: 'append_level', level: 3, replace: `Header below.\n\n${moduleLevelSeparator(9)}` },
    ]);
    expect(result.docChanged).toBe(false);
    expect(result.doc).toBe(BASE);
    const outcome = result.outcomes[0];
    expect(outcome?.kind).toBe('failed');
    expect(outcome?.reason).toContain('looks like a level header');
  });

  it('multi-command: an invalid target is ONE loud card and its siblings still apply', () => {
    const result = apply([
      { search: 'Rain here.', replace: 'Longer rainy opening.', all: false },
      { kind: 'replace_level', level: 9, replace: 'x' },
      { kind: 'append_level', level: 3, replace: 'A third level.' },
    ]);
    // PINNED SEMANTICS: a refusal is PER COMMAND (exactly like a search that
    // does not match) — never a wholesale turn refusal, never a silent drop.
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      'applied',
      'failed',
      'applied',
    ]);
    expect(result.docChanged).toBe(true);
    expect(result.doc).toContain('Longer rainy opening.');
    expect(result.doc).toContain('=====Level 3=====');
  });

  it('the last-replacement highlight anchors on the level that moved', () => {
    const result = apply([{ kind: 'replace_level', level: 2, replace: 'Fog, replaced whole.' }]);
    const section = moduleDocumentSections(result.doc, PLAN).find((entry) => entry.number === 2);
    expect(result.lastApplied).toEqual([{ from: section?.textFrom, to: section?.textTo }]);
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
