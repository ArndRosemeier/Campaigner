import {
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

/**
 * Canvas suggestion machinery (08-MODULE-DESIGNER §Module canvas): an AI
 * proposal is a CM6 StateField entry — NEVER a doc mutation — rendered with
 * decorations per the TipTap suggestion spec (decorations never mutate the
 * document; accept/reject controls sit at the range end). Ranges re-map on
 * user edits; typing INSIDE a proposed range invalidates it loudly (marimo
 * semantics); Accept = ONE dispatch `{changes}` with `isolateHistory: 'full'`
 * (a single undo unit); streaming chunk updates ride
 * `Transaction.addToHistory.of(false)` so tokens never pollute undo.
 *
 * Block proposals (`wholePart: true` — canvas v3: a whole part's SECTION
 * range; the editor doc is the whole module) are the SAME machinery rendered
 * NO-DIFF per the Board precedent (docs/08): a block replace widget shows
 * the proposed markdown AS-IS, "Show previous" flips the widget to the
 * original, Apply = accept (persist + ledger), Discard = drop (doc
 * untouched). Invalidation is the uniform span rule: edits inside the
 * section invalidate it; edits elsewhere re-map it.
 */

export interface CanvasSuggestion {
  id: string;
  from: number;
  to: number;
  /** The exact doc span the proposal replaces (captured at propose time). */
  originalText: string;
  proposedText: string;
  instruction: string;
  status: 'pending' | 'accepted' | 'rejected';
  /** True while streamed tokens are still arriving (ghost shows …). */
  streaming: boolean;
  /** Block no-diff proposal: covers a whole part's SECTION range (canvas
   * v3 — the editor doc is the whole module) and renders as a block
   * replace widget with Show previous. Invalidation stays the uniform span
   * rule (edits inside the section kill it). */
  wholePart: boolean;
}

/** The input shape of a fresh proposal (the field stamps status pending). */
export interface CanvasSuggestionInput {
  id: string;
  from: number;
  to: number;
  originalText: string;
  proposedText: string;
  instruction: string;
  streaming: boolean;
  wholePart: boolean;
}

let suggestionSeq = 0;

/** Collision-free suggestion id (no crypto dependency — jsdom-safe). */
export function newSuggestionId(): string {
  suggestionSeq += 1;
  return `suggestion-${String(suggestionSeq)}`;
}

// --- state effects -------------------------------------------------------------

export const proposeSuggestionEffect = StateEffect.define<CanvasSuggestionInput>();
export const dropSuggestionEffect = StateEffect.define<string>();
/** Streaming progress: replaces the proposed text of one suggestion. */
export const setSuggestionTextEffect = StateEffect.define<{
  id: string;
  text: string;
  streaming: boolean;
}>();
/** Page-level review toggle for whole-part proposals (Show previous). */
export const setShowPreviousEffect = StateEffect.define<boolean>();
/** Removes the suggestion in the SAME dispatch that applies its changes. */
export const acceptSuggestionEffect = StateEffect.define<string>();

// --- remap + invalidation ------------------------------------------------------

interface ChangeSegment {
  fromA: number;
  toA: number;
}

/**
 * Pure remap/invalidation rule (exported for tests): one suggestion survives
 * a change set when (a) no removed range intersects the proposal's span
 * interior-or-boundary-inside, and (b) no insertion lands STRICTLY inside
 * the span — edge insertions re-map outside instead (marimo semantics:
 * typing inside the proposal invalidates it). Canvas v3: the rule is
 * UNIFORM over ranges — block section proposals (`wholePart`, a whole
 * part's section range) follow the same span rule, so edits in OTHER parts
 * re-map (never kill) them and only edits inside the proposed section
 * invalidate.
 */
export function suggestionSurvives(
  suggestion: CanvasSuggestion,
  segments: readonly ChangeSegment[],
): boolean {
  for (const { fromA, toA } of segments) {
    const isDeletion = toA > fromA;
    const insertionInside = fromA > suggestion.from && fromA < suggestion.to;
    const deletionOverlaps =
      isDeletion && toA > suggestion.from && fromA < suggestion.to;
    if (insertionInside || deletionOverlaps) return false;
  }
  return true;
}

function remapSuggestions(
  suggestions: readonly CanvasSuggestion[],
  changes: { iterChanges: (fn: (fromA: number, toA: number) => void) => void; mapPos: (pos: number, assoc?: number) => number },
): readonly CanvasSuggestion[] {
  const segments: ChangeSegment[] = [];
  changes.iterChanges((fromA, toA) => {
    segments.push({ fromA, toA });
  });
  const next: CanvasSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestionSurvives(suggestion, segments)) continue;
    // Edge insertions stay OUTSIDE the span: the start associates forward
    // (after an insertion at `from`), the end associates backward (before
    // an insertion at `to`).
    const from = changes.mapPos(suggestion.from, 1);
    const to = changes.mapPos(suggestion.to, -1);
    next.push({ ...suggestion, from, to });
  }
  return next;
}

// --- state fields ---------------------------------------------------------------

/** Every pending suggestion, in insertion order. */
export const canvasSuggestionField = StateField.define<readonly CanvasSuggestion[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(proposeSuggestionEffect)) {
        next = [...next, { ...effect.value, status: 'pending' as const }];
      } else if (effect.is(dropSuggestionEffect) || effect.is(acceptSuggestionEffect)) {
        next = next.filter((suggestion) => suggestion.id !== effect.value);
      } else if (effect.is(setSuggestionTextEffect)) {
        next = next.map((suggestion) =>
          suggestion.id === effect.value.id
            ? { ...suggestion, proposedText: effect.value.text, streaming: effect.value.streaming }
            : suggestion,
        );
      }
    }
    if (tr.docChanged) {
      next = remapSuggestions(next, tr.changes);
    }
    return next;
  },
});

/** Whole-part "Show previous" toggle (drives the replace widget content). */
export const canvasShowPreviousField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setShowPreviousEffect)) return effect.value;
    }
    return value;
  },
});

/** All pending suggestions of an editor state (empty when none). */
export function pendingSuggestions(state: EditorState): readonly CanvasSuggestion[] {
  return state.field(canvasSuggestionField, false) ?? [];
}

// --- widgets ---------------------------------------------------------------------

class SuggestionGhostWidget extends WidgetType {
  suggestion: CanvasSuggestion;
  showPrevious: boolean;

  constructor(suggestion: CanvasSuggestion, showPrevious: boolean) {
    super();
    this.suggestion = suggestion;
    this.showPrevious = showPrevious;
  }

  override eq(other: SuggestionGhostWidget): boolean {
    return (
      other.suggestion.id === this.suggestion.id &&
      other.suggestion.proposedText === this.suggestion.proposedText &&
      other.suggestion.streaming === this.suggestion.streaming &&
      other.showPrevious === this.showPrevious
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = this.suggestion.wholePart
      ? 'cm-suggestion-wholepart block rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm leading-relaxed whitespace-pre-wrap text-emerald-900 dark:text-emerald-100'
      : 'cm-suggestion-ghost rounded border border-emerald-500/40 bg-emerald-500/5 px-1 text-emerald-800 dark:text-emerald-200';
    wrap.dataset.suggestionId = this.suggestion.id;
    wrap.dataset.testid = this.suggestion.wholePart
      ? 'canvas-wholepart-preview'
      : 'canvas-suggestion-ghost';
    const body = document.createElement('span');
    body.className = 'whitespace-pre-wrap';
    const text = this.showPrevious ? this.suggestion.originalText : this.suggestion.proposedText;
    body.textContent =
      text === '' && this.suggestion.streaming && !this.showPrevious
        ? '…'
        : text;
    if (this.suggestion.streaming && !this.showPrevious) {
      wrap.dataset.streaming = 'true';
      wrap.title = 'The proposal is still streaming — Stop or wait for it to finish';
    } else {
      wrap.dataset.streaming = 'false';
    }
    if (this.showPrevious) wrap.dataset.showPrevious = 'true';
    wrap.appendChild(body);
    wrap.appendChild(suggestionActions(this.suggestion, view));
    return wrap;
  }

  override ignoreEvent(): boolean {
    // The action buttons own their clicks; CM must not turn them into
    // selection changes.
    return true;
  }
}

function suggestionActions(suggestion: CanvasSuggestion, view: EditorView): HTMLElement {
  const actions = document.createElement('span');
  actions.className = 'cm-suggestion-actions ml-1 inline-flex items-center gap-1 align-middle';
  // While the proposal is still streaming the decision controls are
  // disabled — accepting a half-arrived replacement would be a partial
  // apply (the sealed reply is the authoritative text).
  const disabledWhileStreaming = suggestion.streaming;
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = 'Accept';
  accept.disabled = disabledWhileStreaming;
  accept.className =
    'rounded border border-emerald-500/60 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-200';
  accept.dataset.testid = 'canvas-suggestion-accept';
  accept.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  accept.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    acceptSuggestion(view, suggestion.id);
  });
  const reject = document.createElement('button');
  reject.type = 'button';
  reject.textContent = 'Reject';
  reject.disabled = disabledWhileStreaming;
  reject.className =
    'rounded border border-destructive/50 bg-destructive/5 px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50';
  reject.dataset.testid = 'canvas-suggestion-reject';
  reject.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  reject.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    rejectSuggestion(view, suggestion.id);
  });
  actions.append(accept, reject);
  return actions;
}

function buildSuggestionDecorations(state: EditorState): DecorationSet {
  const suggestions = pendingSuggestions(state);
  if (suggestions.length === 0) return Decoration.none;
  const showPrevious = state.field(canvasShowPreviousField, false) ?? false;
  const ranges: { from: number; to: number; decoration: Decoration }[] = [];
  for (const suggestion of suggestions) {
    if (suggestion.wholePart) {
      if (suggestion.from < suggestion.to) {
        ranges.push({
          from: suggestion.from,
          to: suggestion.to,
          decoration: Decoration.replace({
            widget: new SuggestionGhostWidget(suggestion, showPrevious),
            block: true,
          }),
        });
      } else {
        // Empty part document: a block replace needs a non-empty range —
        // render the preview as a point widget instead.
        ranges.push({
          from: suggestion.from,
          to: suggestion.from,
          decoration: Decoration.widget({
            widget: new SuggestionGhostWidget(suggestion, showPrevious),
            side: 1,
            block: true,
          }),
        });
      }
      continue;
    }
    ranges.push({
      from: suggestion.from,
      to: suggestion.to,
      decoration: Decoration.mark({
        class:
          'cm-suggestion-original text-destructive/70 line-through decoration-destructive/60',
        attributes: { 'data-suggestion-id': suggestion.id },
      }),
    });
    ranges.push({
      from: suggestion.to,
      to: suggestion.to,
      decoration: Decoration.widget({
        widget: new SuggestionGhostWidget(suggestion, false),
        side: 1,
      }),
    });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges.map((r) => r.decoration.range(r.from, r.to)));
}

/**
 * The suggestion decorations, computed from the two state fields (a facet
 * source, NOT a view plugin: CM6 forbids block decorations from plugins, and
 * the whole-part proposal renders a full-doc block replace widget).
 */
const suggestionDecorationSource = EditorView.decorations.compute(
  [canvasSuggestionField, canvasShowPreviousField],
  (state) => buildSuggestionDecorations(state),
);

/** The suggestion decoration extension (marks + widgets + action keys). */
export function suggestionDecorations(): Extension {
  return [
    suggestionDecorationSource,
    // Marimo's license-clean keymaps: Mod-y accepts the suggestion at the
    // cursor, Mod-u rejects it.
    keymap.of([
      { key: 'Mod-y', run: (view) => acceptSuggestionAtCursor(view) },
      { key: 'Mod-u', run: (view) => rejectSuggestionAtCursor(view) },
    ]),
  ];
}

// --- commands --------------------------------------------------------------------

function suggestionAtCursor(view: EditorView): CanvasSuggestion | undefined {
  const head = view.state.selection.main.head;
  return pendingSuggestions(view.state).find(
    (suggestion) => head >= suggestion.from && head <= suggestion.to,
  );
}

/** Accepts the suggestion under the cursor (Mod-y). */
export function acceptSuggestionAtCursor(view: EditorView): boolean {
  const suggestion = suggestionAtCursor(view);
  if (suggestion === undefined) return false;
  return acceptSuggestion(view, suggestion.id);
}

/** Rejects the suggestion under the cursor (Mod-u). */
export function rejectSuggestionAtCursor(view: EditorView): boolean {
  const suggestion = suggestionAtCursor(view);
  if (suggestion === undefined) return false;
  rejectSuggestion(view, suggestion.id);
  return true;
}

/**
 * Accept = ONE dispatch: the replacement changes land together with the
 * accept effect, isolated as a FULL history unit — exactly one undo step
 * from the accepted state back to the pre-accept document, however many
 * streaming/typing steps preceded it.
 */
export function acceptSuggestion(view: EditorView, id: string): boolean {
  const suggestion = pendingSuggestions(view.state).find((entry) => entry.id === id);
  if (suggestion === undefined) return false;
  view.dispatch({
    changes: { from: suggestion.from, to: suggestion.to, insert: suggestion.proposedText },
    effects: acceptSuggestionEffect.of(id),
    annotations: isolateHistory.of('full'),
    userEvent: 'canvas.suggestion.accept',
  });
  return true;
}

/** Reject = drop the field entry; the document is never touched. */
export function rejectSuggestion(view: EditorView, id: string): boolean {
  const suggestion = pendingSuggestions(view.state).find((entry) => entry.id === id);
  if (suggestion === undefined) return false;
  view.dispatch({
    effects: dropSuggestionEffect.of(id),
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'canvas.suggestion.reject',
  });
  return true;
}

/**
 * Proposes a suggestion (dispatch only — the field owns the state).
 * Streaming chunk updates MUST go through `streamSuggestionText`, whose
 * dispatches are excluded from history.
 */
export function proposeSuggestion(view: EditorView, input: CanvasSuggestionInput): void {
  view.dispatch({
    effects: proposeSuggestionEffect.of(input),
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'canvas.suggestion.propose',
  });
}

/** Streams one chunk into the suggestion overlay (doc untouched, no undo). */
export function streamSuggestionText(view: EditorView, id: string, text: string): void {
  view.dispatch({
    effects: setSuggestionTextEffect.of({ id, text, streaming: true }),
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'canvas.suggestion.stream',
  });
}

/** Seals a streamed proposal: final text, streaming over. */
export function sealSuggestionText(view: EditorView, id: string, text: string): void {
  view.dispatch({
    effects: setSuggestionTextEffect.of({ id, text, streaming: false }),
    annotations: Transaction.addToHistory.of(false),
    userEvent: 'canvas.suggestion.seal',
  });
}

/**
 * Invalidation detection for the page's loud toast: a suggestion that
 * vanished across an update WITHOUT an explicit accept/drop effect was
 * invalidated by typing inside its range (the field's own rule).
 */
export function invalidatedSuggestionIds(update: ViewUpdate): string[] {
  if (!update.docChanged) return [];
  const explicit = update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(dropSuggestionEffect) || effect.is(acceptSuggestionEffect)),
  );
  if (explicit) return [];
  const before = update.startState.field(canvasSuggestionField, false) ?? [];
  const after = update.state.field(canvasSuggestionField, false) ?? [];
  return before
    .filter((entry) => !after.some((kept) => kept.id === entry.id))
    .map((entry) => entry.id);
}
