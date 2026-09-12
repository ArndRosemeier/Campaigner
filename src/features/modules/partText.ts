import type { Id, Module, TextOrigin } from '@/domain';
import { patchModulePartText } from '@/db/moduleRepo';
import { promoteSecondModuleUses } from '@/db/artifactAutoPromote';

/**
 * THE one part-text save path (18-ARCHITECTURE §2.3, 08-MODULE-DESIGNER
 * §M4-A): every human-adopted part-text write — the reader's hand edit, the
 * canvas rewrite's Apply and Discard — funnels through here. The row write
 * itself (`patchModulePartText`) re-reads the module INSIDE the transaction
 * (stale-snapshot lost-update guard) and stamps `status: 'ready'` +
 * `edited: true`; the post-save `promoteSecondModuleUses` scan promotes
 * second-module wikilink uses to campaign level, loudly (10 D12). Never
 * route a part-text write anywhere else and never skip the promote scan.
 *
 * PROVENANCE (docs/17 row 93): `writerModel` is passed ONLY by a model write
 * (the canvas chat's applied batch, whose turn knows the model that served
 * it). A hand edit omits it, and `patchModulePartText` then CARRIES the id
 * already on the row — the owner's edits must not erase which model wrote the
 * text (owner decision).
 *
 * AUTHORSHIP (docs/17 row 113): that same argument — supplied or omitted —
 * is what records the part's `origin`, in the row write below and nowhere
 * else. A model write (a chat apply, an accepted proposal, an auto-accepted
 * one) records `'model'`, so the normalization pass applies its link
 * rewrites to it directly; an omitted id records `'human'`, whose rewrites
 * keep waiting for consent. `authorship` states the origin for the writes
 * whose TEXT does not change the answer — the board's Apply (the engine's own
 * text stays the model's) and its Discard (the previous text comes back with
 * the authorship it had, captured before the rewrite overwrote the row).
 */
export async function saveModulePartText(
  moduleId: Id,
  planIndex: number,
  markdown: string,
  writerModel?: string,
  authorship?: TextOrigin | null,
): Promise<Module> {
  const saved = await patchModulePartText(moduleId, planIndex, markdown, writerModel, authorship);
  await promoteSecondModuleUses(moduleId, [markdown]);
  return saved;
}
