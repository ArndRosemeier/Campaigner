import { modulePath } from '@/app/routes';
import type { Id } from '@/domain';
import type { WikiGraphMention, WikiGraphNode } from '@/domain/wikiGraph';

/**
 * Display helpers shared by the wiki-graph consumers (14-BACKLINKS-ORPHANS):
 * the Mentions panel on the artifact editor and the Graph page's link-health
 * report. Pure — route building and copy formatting stay out of the domain
 * module, and both surfaces render the reader's conventions identically.
 */

/** Renders the derivation's `where` convention for people: "Premise" or
 * "Part N" (planIndex + 1 — the reader's numbering, same as the entity
 * panel's proposals dialog). The derivation only produces the two
 * documented shapes; anything else renders verbatim rather than invented. */
export function whereLabel(where: string): string {
  if (where === 'premise') return 'Premise';
  const match = /^part-(\d+)$/.exec(where);
  return match !== null ? `Part ${String(Number(match[1]) + 1)}` : where;
}

/** Deep link to the reader location of one mention: `#part-<planIndex>` for
 * a part (the reader scrolls there), the plain reader for the premise. */
export function mentionRoute(campaignId: string, mention: WikiGraphMention): string {
  const match = /^part-(\d+)$/.exec(mention.where);
  return match !== null
    ? modulePath(campaignId, mention.moduleId, Number(match[1]))
    : modulePath(campaignId, mention.moduleId);
}

/** Deep link to a graph node's FIRST reader location — the phantom
 * click-through of 13 §4 and the report's unresolved rows (14 §4). A node
 * without mentions cannot come out of the derivation; one that does is a
 * loud error, never a silent fallback to some other page. */
export function nodeFirstMentionRoute(campaignId: string, node: WikiGraphNode): string {
  const first = node.mentionsByDocument[0];
  if (first === undefined) {
    throw new Error(`Graph node "${node.key}" has no mentions to link to`);
  }
  return mentionRoute(campaignId, first);
}

/** The title of the module a mention belongs to. A mention's `moduleId`
 * always comes from the same module list the derivation saw — a miss is a
 * loud error, never a placeholder. */
export function mentionModuleTitle(
  modules: readonly { readonly id: Id; readonly title: string }[],
  moduleId: Id,
): string {
  const title = modules.find((module) => module.id === moduleId)?.title;
  if (title === undefined) {
    throw new Error(`A wiki-graph mention references the unknown module ${moduleId}`);
  }
  return title;
}

/** One line summarizing a node's per-document mentions, grouped per module:
 * "Ashen Vault — Premise ×2, Part 1 ×1 · Bell Harbor — Part 3 ×1".
 * `mentionsByDocument` arrives module-consecutive (document order), so
 * consecutive grouping is exact. */
export function mentionSummaryText(
  node: WikiGraphNode,
  modules: readonly { readonly id: Id; readonly title: string }[],
): string {
  const parts: string[] = [];
  let currentModuleId: Id | undefined;
  let documents: string[] = [];
  const flush = (): void => {
    if (currentModuleId !== undefined && documents.length > 0) {
      parts.push(`${mentionModuleTitle(modules, currentModuleId)} — ${documents.join(', ')}`);
    }
  };
  for (const mention of node.mentionsByDocument) {
    if (mention.moduleId !== currentModuleId) {
      flush();
      currentModuleId = mention.moduleId;
      documents = [];
    }
    documents.push(`${whereLabel(mention.where)} ×${String(mention.count)}`);
  }
  flush();
  return parts.join(' · ');
}
