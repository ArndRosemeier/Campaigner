import { ChangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
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
 * Own file, not a fork of the suggestions field: one value, no remap
 * (identity-gated instead), no widgets — background marks only.
 *
 * ONE turn can change SEVERAL places (several commands, `all="true"`), so the
 * value carries a LIST of ranges (docs/17 row 405). This file is also the ONE
 * home of the range list's two pure operations: `normalizeReplacementRanges`
 * (sort, drop empty, merge overlapping/adjacent) and `ReplacementTracker`
 * (records each write of a turn and maps the earlier marks through it with
 * CM6's ChangeSet, so every range is in FINAL-doc coordinates).
 */

export interface ReplacementRange {
  from: number;
  to: number;
}

/** Sort, drop empty, MERGE overlapping/adjacent ranges (two edits in one sentence = one mark). */
export function normalizeReplacementRanges(ranges: readonly ReplacementRange[]): ReplacementRange[] {
  const sorted = ranges.filter((range) => range.to > range.from).sort((a, b) => a.from - b.from);
  const merged: ReplacementRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

/**
 * The turn's changed ranges in the coordinates of the doc AFTER the latest
 * write. Commands apply in sequence and each replacement shifts later offsets,
 * so every `record` maps the marks so far through that write's ChangeSet and
 * then adds the write's own post-apply ranges.
 */
export class ReplacementTracker {
  private marks: ReplacementRange[] = [];

  /** One write: simultaneous, non-overlapping `changes` against a doc of `docLength`. */
  record(docLength: number, changes: readonly { from: number; to: number; insert: string }[]): void {
    const set = ChangeSet.of(
      [...changes].sort((a, b) => a.from - b.from),
      docLength,
    );
    this.marks = this.marks.map((mark) => ({
      from: set.mapPos(mark.from, 1),
      to: set.mapPos(mark.to, -1),
    }));
    set.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      this.marks.push({ from: fromB, to: toB });
    }, true);
  }

  /** Marks a range that is already in post-write coordinates (a whole level's text). */
  add(range: ReplacementRange): void {
    this.marks.push({ from: range.from, to: range.to });
  }

  ranges(): ReplacementRange[] {
    return normalizeReplacementRanges(this.marks);
  }
}

export interface LastReplacement {
  /** Normalised whole-document ranges of the last chat turn's replacements. */
  ranges: readonly ReplacementRange[];
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
  return EditorView.decorations.compute(['doc', lastReplacementField], (state) => {
    const replacement = state.field(lastReplacementField, false) ?? null;
    if (replacement === null) return Decoration.none;
    if (state.doc.toString() !== replacement.doc) return Decoration.none;
    const mark = Decoration.mark({
      class: 'cm-last-replacement rounded-sm bg-amber-300/40 dark:bg-amber-400/25',
      attributes: { 'data-testid': 'canvas-last-replacement' },
    });
    return Decoration.set(
      replacement.ranges
        .filter((range) => range.from >= 0 && range.to > range.from && range.to <= state.doc.length)
        .map((range) => mark.range(range.from, range.to)),
    );
  });
}
