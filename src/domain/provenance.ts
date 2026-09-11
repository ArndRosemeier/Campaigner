/**
 * PROVENANCE (owner request, docs/17 row 93): "put a very small id below
 * generated texts … indicating which model wrote this. And a small id below
 * images indicating the image model."
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
 *     PDF/deliverable. Player-facing handouts stay clean. The pdfmake builders
 *     (`lib/modulePdf`, `lib/pdfExport`) never receive this value because they
 *     build from domain rows and rendered strings; the exclusion is pinned by
 *     `tests/lib/provenance-export.test.ts`.
 */

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
