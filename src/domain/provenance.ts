/**
 * PROVENANCE (owner request, docs/17 row 93): "put a very small id below
 * generated texts … indicating which model wrote this. And a small id below
 * images indicating the image model."
 *
 * Also the home of the AUTHORSHIP accessors (docs/17 row 113): `origin` is
 * the record of WHO wrote a module-text document, and
 * `textOriginIsMachineWritten` is the ONE place it turns into a verdict.
 *
 * The intent is EXPERIMENT VISIBILITY: the owner is trying models out and
 * wants to look at a passage or an image and see which model produced it.
 * Which makes one thing load-bearing — the id must be the model that ACTUALLY
 * served the write, never the model the settings happen to name:
 *
 *   - `chat()` returns `modelUsed`, and the escalation chain
 *     (`modelFallback.walkModelChain`) plus the contract-repair retries swap
 *     the model mid-call. A step served by the fallback tier was written by
 *     the FALLBACK model; a settings lookup would print a different id than
 *     the text in front of the owner, which is worse than printing nothing
 *     (docs/18 §2.2 the recording seam, §4 the gotcha).
 *   - Images already record this (`storedImageSchema.model` /
 *     `source: 'generated' | 'uploaded'`); the provenance arc adds the TEXT
 *     half and the display surfaces for both.
 *
 * The display rule is ONE function, `recordedWritingModel`, so every surface
 * agrees on what "empty" means:
 *
 *   - `''` / null / undefined → **NOT RECORDED → display NOTHING.** Content
 *     written before the fields existed, hand-authored text, seed data,
 *     uploads and deterministic floor text all land here. The owner's
 *     decision, verbatim: text written before this change has no recorded
 *     model, so show nothing there — never invent, guess or backfill a model
 *     id from the current settings.
 *   - The owner's second decision, verbatim: a hand-edited text KEEPS the
 *     writing model's id. The id answers "which model wrote this", and his
 *     edits must not erase that provenance. That is why the hand-edit seams
 *     (`patchModulePartText`, the artifact editor's autosave) leave the field
 *     alone by omission — only a MODEL write sets it.
 *   - The third decision, verbatim: APP ONLY — never in an exported
 *     module PDF. Player-facing handouts stay clean. The pdfmake builders
 *     (`lib/modulePdf`, `lib/pdfExport`) never receive this value because they
 *     build from domain rows and rendered strings; the exclusion is pinned by
 *     `tests/lib/provenance-export.test.ts`.
 */

import type { TextOrigin } from '@/domain/module';

/** The one display rule: the model id to SHOW, or null when nothing is
 * recorded (which renders nothing at all — never a placeholder, never a
 * settings-derived guess). Whitespace-only values are "not recorded" too. */
export function recordedWritingModel(model: string | null | undefined): string | null {
  const trimmed = (model ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** True when a text/image row carries recorded provenance worth displaying. */
export function hasRecordedWritingModel(model: string | null | undefined): boolean {
  return recordedWritingModel(model) !== null;
}

/**
 * The writing model a re-written part carries. `previous` is the model already
 * recorded on the part being replaced and is carried over ONLY when the new
 * write has none to report (a seam that could not observe its own call) —
 * never when a real model served the write, and never a hand edit (which does
 * not pass through here at all, so it cannot clear the id).
 */
export function partWriterModelFor(nextModelUsed: string, previous?: string): string {
  const next = recordedWritingModel(nextModelUsed);
  if (next !== null) return next;
  return recordedWritingModel(previous) ?? '';
}

/** One labelled scope of a module's text in reading order: the spine premise
 * first, then each part by its plan position. */
export interface ModuleWritingScope {
  /** Stable key: `premise`, or `part-<planIndex>`. */
  id: string;
  /** The scope's display label: `Premise`, `Part 3`. */
  label: string;
  /** The recorded writing model, or null when NOT RECORDED. */
  model: string | null;
}

/**
 * WHO AUTHORED a module-text document (docs/17 row 113).
 *
 * THE ONE decision point. Nothing else may re-derive it — no reader parses
 * `edited`, and NOTHING infers it from a recorded `writerModel` (a hand edit
 * deliberately carries the previous model id forward, so an id is not
 * evidence that a model wrote the CURRENT text).
 *
 * `edited` and `origin` answer different questions and the difference is the
 * whole point of this helper: `edited` is "written outside the generator"
 * (true for a hand edit AND for an auto-accepted model rewrite), `origin` is
 * "who wrote the text now".
 *
 * Returns `true` when the text is NOT machine-written — which is the
 * conservative direction on purpose: `origin: null` (every row written before
 * the field) is reported as human-authored, because the alternative is
 * silently auto-applying a rewrite to text that may have been typed by hand.
 */
export function textOriginIsMachineWritten(origin: TextOrigin | null | undefined): boolean {
  return origin === 'model';
}

/**
 * The origin a write leaves behind when a document's text is replaced but its
 * AUTHORSHIP does not change (a `generating`/`pending`/`failed` slot that
 * holds no new prose, a version restore that puts the recorded text back).
 * `null` stays `null`: an unrecorded row is never upgraded to a verdict.
 */
export function carriedTextOrigin(
  previous: TextOrigin | null | undefined,
): TextOrigin | null {
  return previous ?? null;
}

/**
 * Who to NAME as the writer of one module-text document — the honest label a
 * consent dialog puts on a row, so a rewrite is never attributed to the wrong
 * party.
 *
 * Four outcomes, and no fifth:
 *   - `'you'` — a HUMAN write: the owner typed (or pasted) this text.
 *   - the model id — a model write whose serving model is recorded.
 *   - `'the model'` — a model write whose id is genuinely not recorded (a
 *     legacy row, or a call that reported none): the row still says a model
 *     wrote it, so claim a model, never a name that was never captured.
 *   - `null` — NOT RECORDED origin: the app CANNOT tell, and says so instead
 *     of guessing (the caller renders its own "may have been written by hand"
 *     wording; `textOriginIsMachineWritten` is false, so the text is held).
 */
export function recordedWriterLabel(
  origin: TextOrigin | null | undefined,
  writerModel: string | null | undefined,
): string | null {
  if (origin === null || origin === undefined) return null;
  if (origin === 'human') return 'you';
  return recordedWritingModel(writerModel) ?? 'the model';
}

/**
 * The canvas footer's answer to "who wrote the module text?" (owner decision,
 * docs/17 row 93 amendment: the canvas MUST show it).
 *
 * Three honest outcomes, and no fourth:
 *
 *   - `none` — nothing anywhere is recorded (a module written before the
 *     fields existed, or hand-authored throughout). The caller renders NOTHING;
 *     the owner's rule forbids guessing an id from current settings.
 *   - `single` — EVERY scope is recorded and they are all the SAME id, so one
 *     id is a true statement about the whole text.
 *   - `mixed` — the scopes disagree, or some are recorded and others are not.
 *     The caller must show the per-scope list, so a part written by another
 *     model is never hidden behind the majority id (never a bare "various").
 *
 * A scope that is NOT recorded stays `null` in `scopes` and is reported as
 * such — it is never folded into a neighbour's id.
 */
export type ModuleWritingSummary =
  | { kind: 'none' }
  | { kind: 'single'; model: string }
  | { kind: 'mixed'; scopes: ModuleWritingScope[] };

/** Builds the canvas footer's writing summary from the spine premise's id and
 * the parts' ids IN PLAN ORDER (`planIndex` ascending, the reading order). */
export function moduleWritingSummary(
  premiseModel: string | null | undefined,
  parts: readonly { planIndex: number; writerModel?: string | null | undefined }[],
): ModuleWritingSummary {
  const ordered = [...parts].sort((a, b) => a.planIndex - b.planIndex);
  const scopes: ModuleWritingScope[] = [
    { id: 'premise', label: 'Premise', model: recordedWritingModel(premiseModel) },
    ...ordered.map((part) => ({
      id: `part-${String(part.planIndex)}`,
      label: `Part ${String(part.planIndex + 1)}`,
      model: recordedWritingModel(part.writerModel),
    })),
  ];
  const recorded = scopes.filter((scope) => scope.model !== null);
  if (recorded.length === 0) return { kind: 'none' };
  const first = recorded[0]?.model ?? null;
  const unanimous = scopes.every((scope) => scope.model !== null && scope.model === first);
  if (unanimous && first !== null) return { kind: 'single', model: first };
  return { kind: 'mixed', scopes };
}
