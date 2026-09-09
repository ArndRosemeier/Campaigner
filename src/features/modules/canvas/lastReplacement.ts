import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/**
 * The last-replacement highlight for the canvas editor (preview-default
 * arc): the LAST chat-applied replacement renders as a background mark over
 * the whole-document editor doc. Set ONLY by chat application — whole-doc
 * offsets plus the post-apply doc string identity — and rendered WHILE AND
 * ONLY WHILE the current doc text is byte-identical to that stored string
 * (any hand edit, proposal accept or next apply clears/replaces the page
 * state, so the stored identity never goes stale; the field re-checks the
 * identity itself as a belt so a lagging page can never leave a stale mark).
 *
 * Own file, not a fork of the suggestions field: one value (not a list),
 * no remap (identity-gated instead), no widgets — a single background mark.
 */

export interface LastReplacement {
  /** Whole-document offsets of the last applied replacement. */
  from: number;
  to: number;
  /** The post-apply doc string — the mark renders only on byte-identity. */
  doc: string;
}

/** Replaces the highlight (null clears it). */
export const setLastReplacementEffect = StateEffect.define<LastReplacement | null>();

/** The current highlight (null = none). */
export const lastReplacementField = StateField.define<LastReplacement | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLastReplacementEffect)) return effect.value;
    }
    return value;
  },
});

/**
 * The background-mark extension: one mark over the stored range, rendered
 * only while the live doc is byte-identical to the stored post-apply doc.
 * Computed from the state field via a facet (the suggestion-decorations
 * precedent — a facet source, never a view plugin).
 */
export function lastReplacementDecorations(): Extension {
  return EditorView.decorations.compute([lastReplacementField], (state) => {
    const replacement = state.field(lastReplacementField, false) ?? null;
    if (replacement === null) return Decoration.none;
    if (state.doc.toString() !== replacement.doc) return Decoration.none;
    if (replacement.from < 0 || replacement.to <= replacement.from) return Decoration.none;
    if (replacement.to > state.doc.length) return Decoration.none;
    return Decoration.set([
      Decoration.mark({
        class: 'cm-last-replacement rounded-sm bg-amber-300/40 dark:bg-amber-400/25',
        attributes: { 'data-testid': 'canvas-last-replacement' },
      }).range(replacement.from, replacement.to),
    ]);
  });
}
