import { describe, expect, it } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { cursorCharForward, defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

import type { AnyArtifact, Artifact, Id } from '@/domain';
import {
  acceptSuggestion,
  acceptSuggestionAtCursor,
  canvasShowPreviousField,
  canvasSuggestionField,
  newSuggestionId,
  pendingSuggestions,
  proposeSuggestion,
  rejectSuggestion,
  sealSuggestionText,
  setShowPreviousEffect,
  streamSuggestionText,
  suggestionDecorations,
  suggestionSurvives,
} from '@/features/modules/canvas/suggestions';
import { wikiLinkDecorations } from '@/features/modules/canvas/wikiDecorations';
import { canvasThemeSpec } from '@/features/modules/canvas/canvasTheme';

/**
 * Canvas editor SUBSTRATE pins (08-MODULE-DESIGNER §Module canvas, commit 1):
 * the CM6 document is the truth, wiki-link chips are kind-colored mark
 * decorations with atomic ranges, and the suggestion machinery behaves per
 * the TipTap spec + marimo semantics — decorations never mutate the doc,
 * typing inside a proposal invalidates it (edge edits re-map instead),
 * Accept is ONE undo unit, streaming chunks never enter history.
 *
 * A raw EditorView (no React) keeps these pins direct; the page-level flows
 * live in module-canvas.test.tsx.
 */

let fixtureSeq = 0;

/** Minimal valid `note` artifact (the only kind with an empty data payload). */
function makeNote(fields: { name: string; moduleId?: string | null }): Artifact {
  fixtureSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(fixtureSeq).padStart(12, '0')}`,
    createdAt: 1000,
    updatedAt: 2000 + fixtureSeq,
    campaignId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    moduleId: fields.moduleId ?? null,
    kind: 'note',
    name: fields.name,
    tags: [],
    aliases: [],
    summary: `Summary of ${fields.name}.`,
    body: '',
    links: [],
    currentRevision: 1,
    imageIds: [],
    coverImageId: null,
    data: {},
  };
}

const MODULE_ID = '11111111-1111-4111-8111-111111111111' as Id;

function extensions(artifacts: readonly AnyArtifact[]): Extension[] {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    // The state fields MUST be registered (the decorations plugin reads
    // them with a safe fallback — a missing field renders nothing).
    canvasSuggestionField,
    canvasShowPreviousField,
    wikiLinkDecorations(artifacts, MODULE_ID),
    suggestionDecorations(),
  ];
}

function mountEditor(
  doc: string,
  options: { artifacts?: readonly AnyArtifact[] } = {},
): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: extensions(options.artifacts ?? []),
    }),
    parent: host,
  });
  return { view, host };
}

interface ProposeInput {
  from: number;
  to: number;
  originalText: string;
  proposedText: string;
  wholePart?: boolean;
  instruction?: string;
}

function propose(view: EditorView, input: ProposeInput): string {
  const id = newSuggestionId();
  proposeSuggestion(view, {
    id,
    from: input.from,
    to: input.to,
    originalText: input.originalText,
    proposedText: input.proposedText,
    instruction: input.instruction ?? 'test instruction',
    streaming: false,
    wholePart: input.wholePart ?? false,
  });
  return id;
}

describe('canvas theme', () => {
  it('colors EVERYTHING from app CSS variables — no hardcoded light chrome (owner: white-on-white)', () => {
    // jsdom computes no styles, so the pin is on the spec: the editor
    // chrome (background, text, caret, selection, active line) must all
    // derive from --card/--foreground/--muted/--primary so the editor
    // follows the app theme in light AND dark.
    const flattened = JSON.stringify(canvasThemeSpec);
    expect(canvasThemeSpec['&']).toMatchObject({
      backgroundColor: 'var(--card)',
      color: 'var(--card-foreground)',
    });
    expect(flattened).toContain('var(--foreground)');
    expect(flattened).toContain('var(--muted)');
    expect(flattened).toContain('var(--primary)');
    // No raw hex/oklch color literals in the chrome — those are what made
    // the unthemed mount a white slab.
    expect(flattened).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(flattened).not.toMatch(/oklch\(/u);
    // The markdown highlight style rides the same constraint (checked via
    // the extension's spec, exported for pinning through the theme array).
  });
});

describe('wiki-link decorations', () => {
  it('marks resolved links with the kind palette and data attributes (module tier-0)', () => {
    const moduleOwned = makeNote({ name: 'Ember Key', moduleId: MODULE_ID });
    const campaignRow = makeNote({ name: 'Ember Key', moduleId: null });
    const { host, view } = mountEditor('The [[Ember Key]] glows.', {
      artifacts: [campaignRow, moduleOwned],
    });
    try {
      const chip = host.querySelector('[data-wiki-name="Ember Key"]');
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute('data-wiki-status')).toBe('resolved');
      // tier-0: the module-owned row wins — its kind palette applies.
      expect(chip?.className).toContain('bg-neutral-500/10');
      expect(view.state.doc.toString()).toBe('The [[Ember Key]] glows.');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('marks unresolved links dashed and never mutates the doc', () => {
    const { host, view } = mountEditor('The [[Ghost Name]] lurks.', { artifacts: [] });
    try {
      const chip = host.querySelector('[data-wiki-name="Ghost Name"]');
      expect(chip?.getAttribute('data-wiki-status')).toBe('unresolved');
      expect(chip?.className).toContain('border-dashed');
      expect(view.state.doc.toString()).toBe('The [[Ghost Name]] lurks.');
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('treats a wiki-link token as one atomic editing unit', () => {
    const row = makeNote({ name: 'Ember Key' });
    const { view } = mountEditor('The [[Ember Key]] glows.', { artifacts: [row] });
    try {
      const tokenStart = view.state.doc.toString().indexOf('[[');
      view.dispatch({ selection: { anchor: tokenStart } });
      expect(cursorCharForward(view)).toBe(true);
      // One command lands AFTER the whole token (atomic), not on the '['.
      expect(view.state.selection.main.head).toBeGreaterThan(
        view.state.doc.toString().indexOf(']]'),
      );
    } finally {
      view.destroy();
    }
  });
});

describe('suggestion machinery', () => {
  it('renders a span proposal as struck original + ghost + accept/reject, doc untouched', () => {
    const doc = 'The gate opens at dawn.';
    const { host, view } = mountEditor(doc);
    try {
      propose(view, { from: 4, to: 8, originalText: 'gate', proposedText: 'portcullis' });
      expect(view.state.doc.toString()).toBe(doc);
      expect(host.querySelector('[data-testid="canvas-suggestion-ghost"]')?.textContent).toContain(
        'portcullis',
      );
      expect(host.querySelector('[data-testid="canvas-suggestion-accept"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="canvas-suggestion-reject"]')).not.toBeNull();
      expect(host.querySelector('.cm-suggestion-original')).not.toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it('reject leaves the doc untouched and drops the field entry', () => {
    const doc = 'The gate opens at dawn.';
    const { view } = mountEditor(doc);
    try {
      const id = propose(view, { from: 4, to: 8, originalText: 'gate', proposedText: 'portcullis' });
      expect(rejectSuggestion(view, id)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(pendingSuggestions(view.state)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it('typing INSIDE a proposed range invalidates it; edge edits re-map it', () => {
    const doc = 'The old gate opens at dawn.';
    const { view } = mountEditor(doc);
    try {
      const id = propose(view, { from: 8, to: 12, originalText: 'gate', proposedText: 'portcullis' });

      // Insert strictly inside → invalidate (loud toast is the page's job).
      view.dispatch({ changes: { from: 10, to: 10, insert: 'X' } });
      expect(pendingSuggestions(view.state)).toHaveLength(0);

      // Edge insertion at the span start stays OUTSIDE (re-maps).
      const id2 = propose(view, { from: 8, to: 12, originalText: 'gate', proposedText: 'portcullis' });
      view.dispatch({ changes: { from: 8, to: 8, insert: 'new ' } });
      const remapped = pendingSuggestions(view.state).find((entry) => entry.id === id2);
      expect(remapped?.from).toBe(12);
      expect(remapped?.to).toBe(16);

      // Deletion overlapping the span → invalidate.
      view.dispatch({ changes: { from: 13, to: 15, insert: '' } });
      expect(pendingSuggestions(view.state)).toHaveLength(0);
      expect(id).toBeTruthy();
    } finally {
      view.destroy();
    }
  });

  it('block SECTION proposals follow the span rule: edits outside re-map, edits inside kill', () => {
    // Canvas v3: the editor doc is the WHOLE module — a whole-part (block)
    // proposal covers that part's section range and must survive edits in
    // OTHER parts (uniform span rule), dying only on interior edits.
    const sectionA = 'Part one text.';
    const doc = `${sectionA}\n\n==========\n\n[Part 2 of 2 — B]\nPart two text.`;
    const { view } = mountEditor(doc);
    try {
      const sectionAEnd = sectionA.length;
      const id = propose(view, {
        from: 0,
        to: sectionAEnd,
        originalText: sectionA,
        proposedText: 'Rewritten part one.',
        wholePart: true,
      });

      // An edit in ANOTHER part (inside part two's section) re-maps — the
      // proposal survives.
      view.dispatch({ changes: { from: doc.length, to: doc.length, insert: 'x' } });
      const remapped = pendingSuggestions(view.state).find((entry) => entry.id === id);
      expect(remapped).toBeDefined();
      expect(remapped?.from).toBe(0);
      expect(remapped?.to).toBe(sectionAEnd);

      // An edit strictly INSIDE the proposed section kills it.
      view.dispatch({ changes: { from: 5, to: 5, insert: 'X' } });
      expect(pendingSuggestions(view.state)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it('suggestionSurvives: boundary rules (pure)', () => {
    const suggestion = {
      id: 's',
      from: 5,
      to: 9,
      originalText: 'gate',
      proposedText: 'portcullis',
      instruction: '',
      status: 'pending' as const,
      streaming: false,
      wholePart: false,
    };
    // Insert at the start / end edges → survives.
    expect(suggestionSurvives(suggestion, [{ fromA: 5, toA: 5 }])).toBe(true);
    expect(suggestionSurvives(suggestion, [{ fromA: 9, toA: 9 }])).toBe(true);
    // Insert strictly inside → dies.
    expect(suggestionSurvives(suggestion, [{ fromA: 7, toA: 7 }])).toBe(false);
    // Deletion overlapping the interior → dies.
    expect(suggestionSurvives(suggestion, [{ fromA: 8, toA: 12 }])).toBe(false);
    // Deletion ending exactly at the start → survives.
    expect(suggestionSurvives(suggestion, [{ fromA: 2, toA: 5 }])).toBe(true);
  });

  it('accept = ONE undo unit; streaming chunks are absent from history', () => {
    const doc = 'The gate opens.';
    const { view } = mountEditor(doc);
    try {
      const id = propose(view, { from: 4, to: 8, originalText: 'gate', proposedText: 'portcullis' });
      // Streaming never touches the doc nor history…
      streamSuggestionText(view, id, 'portcull');
      streamSuggestionText(view, id, 'portcullis');
      expect(view.state.doc.toString()).toBe(doc);
      expect(undo(view)).toBe(false);
      const ghost = document.querySelector('[data-testid="canvas-suggestion-ghost"]');
      expect(ghost?.textContent).toContain('portcullis');
      // …and sealing keeps the same properties.
      sealSuggestionText(view, id, 'portcullis');
      expect(undo(view)).toBe(false);

      // Accept is exactly ONE history unit.
      expect(acceptSuggestion(view, id)).toBe(true);
      expect(view.state.doc.toString()).toBe('The portcullis opens.');
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(undo(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it('accept at cursor (Mod-y command) accepts the suggestion under the head', () => {
    const doc = 'The gate opens.';
    const { view } = mountEditor(doc);
    try {
      propose(view, { from: 4, to: 8, originalText: 'gate', proposedText: 'portcullis' });
      view.dispatch({ selection: { anchor: 5 } });
      expect(acceptSuggestionAtCursor(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('The portcullis opens.');
      expect(pendingSuggestions(view.state)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it('whole-part proposal renders no-diff (replace widget), Show previous flips, accept applies', () => {
    const doc = 'Old whole part.';
    const { host, view } = mountEditor(doc);
    try {
      const id = propose(view, {
        from: 0,
        to: doc.length,
        originalText: doc,
        proposedText: 'Brand new part.',
        wholePart: true,
      });
      const preview = host.querySelector('[data-testid="canvas-wholepart-preview"]');
      expect(preview?.textContent).toContain('Brand new part.');
      expect(view.state.doc.toString()).toBe(doc);

      view.dispatch({ effects: setShowPreviousEffect.of(true) });
      expect(
        host.querySelector('[data-testid="canvas-wholepart-preview"]')?.textContent,
      ).toContain('Old whole part.');
      view.dispatch({ effects: setShowPreviousEffect.of(false) });
      expect(
        host.querySelector('[data-testid="canvas-wholepart-preview"]')?.textContent,
      ).toContain('Brand new part.');
      expect(view.state.field(canvasShowPreviousField)).toBe(false);

      expect(acceptSuggestion(view, id)).toBe(true);
      expect(view.state.doc.toString()).toBe('Brand new part.');
      expect(pendingSuggestions(view.state)).toHaveLength(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
