import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Durable module document versions (owner-directed, 08-MODULE-DESIGNER
 * §Module canvas versions; docs/17 ledger rows 63 and 357): the simple undo
 * for AI changes. ONE row per AI change holding the WHOLE module text
 * BYTE-EXACT as it was immediately BEFORE that change — the parts document in
 * `docText` (the same shape `modulePartsDocument` assembles and splits:
 * `==========` separators + `[Part <n> of <total> — <title>]` labels, every
 * planned part) AND the spine premise in its own `premise` field beside it.
 *
 * THE TWO HALVES STAY TWO FIELDS ON PURPOSE. "The whole module" is premise +
 * parts (the ONE `moduleFullText` reading), and the parts document
 * deliberately EXCLUDES the premise — that is the editor's and the chat's
 * document format, and it stays exactly what it was. Folding the premise into
 * `docText` would be a second document format and would break the split
 * contract; folding the two fields into one JSON blob would be a format the
 * split seam cannot read. So a restore re-splits `docText` through the
 * existing split/save seam AND puts `premise` back through the one
 * spine-subfield seam (docs/17 row 357; the owner's decision, verbatim:
 * *"Please make undoable"*).
 *
 * DURABLE by owner decision — these rows live in Dexie and survive reload
 * (the session-only per-part ledger in `canvasStore.ts` stays exactly as it
 * is: session review state, never history; this stack is separate and
 * parallel to it).
 *
 * Bounded growth: at most `MODULE_VERSION_CAP` rows per module, oldest
 * pruned first (the repository owns the prune, the menu states the
 * retention). Never silently unbounded, never silently empty.
 */
export const MODULE_VERSION_CAP = 25;

/**
 * What produced the change a snapshot PRECEDES. The menu labels an entry with
 * this + the honest change label, so a reader can never mistake "before the
 * chat turn" for "before generation".
 */
export const MODULE_VERSION_SOURCES = [
  'chat',
  'refine',
  'rewrite',
  'restore',
  'generation',
  'normalization',
] as const;

export const moduleVersionSourceSchema = z.enum(MODULE_VERSION_SOURCES);

export type ModuleVersionSource = z.infer<typeof moduleVersionSourceSchema>;

/** Menu copy for each source (user-facing, 00-OVERVIEW terminology). */
export const MODULE_VERSION_SOURCE_LABELS: Readonly<Record<ModuleVersionSource, string>> = {
  chat: 'Chat',
  refine: 'Refine',
  rewrite: 'Rewrite',
  restore: 'Restore',
  generation: 'Generation',
  normalization: 'Name normalization',
};

export const moduleDocumentVersionSchema = z.object({
  ...BaseEntitySchema.shape,
  /** The owning module — the ONLY key a version is listed/cleared by. */
  moduleId: z.uuid(),
  /** The kind of AI change this snapshot was taken before. */
  source: moduleVersionSourceSchema,
  /** What changed, in honest words ("Chat: make the rain heavier",
   * "Rewrite part 2 — Under the Docks", "Restore from 14:32:07"). */
  label: z.string(),
  /** The WHOLE module parts document, byte-exact, as it was pre-change. */
  docText: z.string(),
  /**
   * The module's spine PREMISE, byte-exact, as it was immediately before the
   * change — the OTHER half of the undo (docs/17 row 357, the owner's
   * *"Please make undoable"*).
   *
   * ADDITIVE and TOLERANT ON READ: a row written before this field existed
   * carries no key and parses as `null` (no Dexie index, no migration), and
   * such a row still restores EXACTLY what it always restored — the parts,
   * with the premise left as it stands.
   *
   * `null` therefore means NOT CAPTURED, never "the premise was empty": an
   * actually-empty premise is captured as `''`. The Versions menu states which
   * of the two an entry is (`moduleVersionPremiseNote`), so an absent premise
   * is never drawn as an empty box that reads like content.
   */
  premise: z.string().nullable().default(null),
});

export type ModuleDocumentVersion = z.infer<typeof moduleDocumentVersionSchema>;

/** "1 saved version" / "3 saved versions" (toasts + dialog copy). */
export function savedVersionsNoun(count: number): string {
  return count === 1 ? 'saved version' : 'saved versions';
}

/**
 * The stored premise could not be put back (docs/17 row 357). A restore whose
 * premise half fails is LOUD and writes NO part: the caller toasts this (its
 * message names the cause) and never reports a half-restored document as a
 * success. `name` is stable for callers that branch on the failure class, like
 * `ModulePartsDocumentError` beside it.
 */
export class ModuleVersionPremiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleVersionPremiseError';
  }
}

/** How much of a stored premise the Versions menu previews before eliding. */
export const MODULE_VERSION_PREMISE_NOTE_CAP = 80;

/**
 * The Versions menu's honest note about an entry's PREMISE half (docs/17 row
 * 357) — ONE formatter, so the menu and its pins cannot drift:
 * - `null` (a row written before versions carried a premise) SAYS SO, rather
 *   than showing an empty box that reads like content;
 * - a captured premise is previewed, capped, and rendered on ONE line by the
 *   menu's own `truncate` span — the bytes are NOT reshaped here (no pattern
 *   over the owner's or the model's prose, AGENTS rule 5: a preview is
 *   presentation, and the stylesheet is what collapses the newlines);
 * - a captured EMPTY premise reads `(empty)` — that IS its captured content,
 *   and it is not the same thing as "none was captured".
 */
export function moduleVersionPremiseNote(premise: string | null): string {
  if (premise === null) return 'no premise captured — saved before versions carried it';
  if (premise.trim() === '') return 'premise: (empty)';
  const preview =
    premise.length > MODULE_VERSION_PREMISE_NOTE_CAP
      ? `${premise.slice(0, MODULE_VERSION_PREMISE_NOTE_CAP)}…`
      : premise;
  return `premise: ${preview}`;
}
