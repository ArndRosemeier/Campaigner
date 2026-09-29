import { render } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';

import { assembleModuleDocument } from '@/domain/moduleDocument';
import { WikiMarkdown } from '@/features/campaign/components/wiki-markdown';
import {
  applyChatCommandsToDocument,
  applyChatCommandsToSnapshot,
} from '@/features/modules/canvas/chatApply';
import {
  lastReplacementDecorations,
  lastReplacementField,
  normalizeReplacementRanges,
  ReplacementTracker,
  setLastReplacementEffect,
} from '@/features/modules/canvas/lastReplacement';
import type { CanvasEditCommand } from '@/llm/canvasChat';

/**
 * docs/17 row 405: the last chat turn highlights EVERY range it changed, in
 * FINAL-doc coordinates, through ONE list type / normaliser / tracker.
 */
const PLAN = [{ title: 'One' }, { title: 'Two' }];
const DOC = assembleModuleDocument({
  levels: [
    { number: 0, text: 'The premise.' },
    { number: 1, text: 'Rain here.\nRain there.' },
    { number: 2, text: 'Fog elsewhere.' },
  ],
});

function texts(doc: string, ranges: readonly { from: number; to: number }[]): string[] {
  return ranges.map((range) => doc.slice(range.from, range.to));
}

function viaSnapshot(commands: CanvasEditCommand[]) {
  return applyChatCommandsToSnapshot({ commands, partPlan: PLAN, doc: DOC });
}

describe('normalizeReplacementRanges', () => {
  it('sorts, drops empty ranges, merges overlapping and adjacent ones', () => {
    expect(
      normalizeReplacementRanges([
        { from: 20, to: 25 },
        { from: 5, to: 5 },
        { from: 0, to: 4 },
        { from: 4, to: 8 },
        { from: 6, to: 10 },
      ]),
    ).toEqual([
      { from: 0, to: 10 },
      { from: 20, to: 25 },
    ]);
  });
  it('the tracker maps earlier marks through a later write', () => {
    const tracker = new ReplacementTracker();
    tracker.record(20, [{ from: 10, to: 12, insert: 'XX' }]); // mark 10..12
    tracker.record(20, [{ from: 0, to: 2, insert: 'ABCDE' }]); // +3 before it
    expect(tracker.ranges()).toEqual([
      { from: 0, to: 5 },
      { from: 13, to: 15 },
    ]);
  });
});

describe('every range the turn changed is reported (applier)', () => {
  it('two commands in different levels report BOTH ranges on the final doc', () => {
    const result = viaSnapshot([
      { search: 'Rain here.', replace: 'Heavy rain.', all: false },
      { search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false },
    ]);
    expect(texts(result.doc, result.lastApplied)).toEqual(['Heavy rain.', 'Mist elsewhere.']);
  });

  it('OFFSET SHIFT: a later command that LENGTHENS text before an earlier range keeps the earlier mark on its characters', () => {
    const result = viaSnapshot([
      { search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false },
      { search: 'Rain here.', replace: 'A much, much longer rainy opening.', all: false },
    ]);
    expect(texts(result.doc, result.lastApplied)).toEqual([
      'A much, much longer rainy opening.',
      'Mist elsewhere.',
    ]);
  });

  it('OFFSET SHIFT: a later command that SHORTENS text before an earlier range', () => {
    const result = viaSnapshot([
      { search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false },
      { search: 'Rain here.', replace: 'R.', all: false },
    ]);
    expect(texts(result.doc, result.lastApplied)).toEqual(['R.', 'Mist elsewhere.']);
  });

  it('all="true" highlights every occurrence', () => {
    const result = viaSnapshot([{ search: 'Rain', replace: 'Downpour of', all: true }]);
    expect(texts(result.doc, result.lastApplied)).toEqual(['Downpour of', 'Downpour of']);
  });

  it('level commands highlight the level text and survive a later shift', () => {
    const result = viaSnapshot([
      { kind: 'replace_level', level: 2, replace: 'Fog, replaced whole.' },
      { search: 'Rain here.', replace: 'Way longer rain here, friends.', all: false },
    ]);
    expect(texts(result.doc, result.lastApplied)).toEqual([
      'Way longer rain here, friends.',
      'Fog, replaced whole.',
    ]);
  });

  it('adjacent edits merge into ONE mark', () => {
    const result = viaSnapshot([
      { search: 'Rain', replace: 'Mist', all: true },
      { search: ' here.', replace: ' now.', all: false },
    ]);
    // "Mist now." — the two writes touch each other.
    expect(texts(result.doc, result.lastApplied)).toContain('Mist now.');
    expect(result.lastApplied).toHaveLength(2); // "Mist now." and the second Mist
  });

  it('state-free failure: nothing applied reports no ranges', () => {
    expect(viaSnapshot([{ search: 'nope nope', replace: 'x', all: false }]).lastApplied).toEqual([]);
  });

  it('editor and snapshot handles agree on the ranges (one tracker)', () => {
    const commands: CanvasEditCommand[] = [
      { search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false },
      { search: 'Rain', replace: 'Downpour', all: true },
    ];
    const host = document.createElement('div');
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [history()] }),
      parent: host,
    });
    const editor = applyChatCommandsToDocument({ commands, partPlan: PLAN, view });
    const snapshot = viaSnapshot(commands);
    expect(view.state.doc.toString()).toBe(snapshot.doc);
    expect(editor.lastApplied).toEqual(snapshot.lastApplied);
    view.destroy();
  });
});

describe('the editor field renders one mark per range, identity-gated', () => {
  function mount(doc: string) {
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [lastReplacementField, lastReplacementDecorations()],
      }),
      parent: document.createElement('div'),
    });
  }
  function decorated(view: EditorView): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    for (const source of view.state.facet(EditorView.decorations)) {
      const set = typeof source === 'function' ? source(view) : source;
      set.between(0, view.state.doc.length, (from, to) => {
        out.push({ from, to });
      });
    }
    return out;
  }

  it('renders every range on the final doc, and none after a hand edit', () => {
    const result = viaSnapshot([
      { search: 'Fog elsewhere.', replace: 'Mist elsewhere.', all: false },
      { search: 'Rain here.', replace: 'A much longer rainy opening.', all: false },
    ]);
    const view = mount(result.doc);
    view.dispatch({ effects: setLastReplacementEffect.of({ doc: result.doc, ranges: result.lastApplied }) });
    expect(decorated(view)).toEqual(result.lastApplied);
    expect(decorated(view)).toHaveLength(2);
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });
    expect(decorated(view)).toEqual([]);
    view.destroy();
  });
});

describe('the rendered preview washes every range', () => {
  it('WikiMarkdown accepts a list and washes each piece', () => {
    const value = 'one two three four';
    const rendered = render(
      <WikiMarkdown
        value={value}
        artifacts={[]}
        highlight={[
          { from: 0, to: 3 },
          { from: 8, to: 13 },
        ]}
      />,
    );
    const marks = [...rendered.container.querySelectorAll('[data-testid="replacement-highlight"]')];
    expect(marks.map((mark) => mark.textContent)).toEqual(['one', 'three']);
    expect(rendered.container.textContent).toBe(value);
  });
});
