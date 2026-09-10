import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Durable module document versions (owner-directed, 08-MODULE-DESIGNER
 * §Module canvas versions; docs/17 ledger row 63): the simple undo for AI
 * changes. ONE row per AI change holding the WHOLE module parts document
 * BYTE-EXACT as it was immediately BEFORE that change — the same document
 * shape `modulePartsDocument` assembles and splits (`==========` separators +
 * `[Part <n> of <total> — <title>]` labels, every planned part, spine premise
 * excluded). Never a second document format: a restore re-splits the stored
 * text through the existing split/save seam.
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
});

export type ModuleDocumentVersion = z.infer<typeof moduleDocumentVersionSchema>;

/** "1 saved version" / "3 saved versions" (toasts + dialog copy). */
export function savedVersionsNoun(count: number): string {
  return count === 1 ? 'saved version' : 'saved versions';
}
