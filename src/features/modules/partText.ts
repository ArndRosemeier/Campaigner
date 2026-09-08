import type { Id, Module } from '@/domain';
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
 */
export async function saveModulePartText(
  moduleId: Id,
  planIndex: number,
  markdown: string,
): Promise<Module> {
  const saved = await patchModulePartText(moduleId, planIndex, markdown);
  await promoteSecondModuleUses(moduleId, [markdown]);
  return saved;
}
