import type { AnyArtifact, Module, OutlineNode } from '@/domain';
import { fullInclude } from '@/domain';
import { extractWikiLinks, resolveWikiLink, type WikiLinkContext } from '@/lib/wikilinks';

/**
 * "Seed from module" (08-MODULE-DESIGNER M4-D): maps a Module onto a
 * Deliverable outline — spine premise → intro text node, each part → chapter
 * with a text node of the part markdown, plus artifact nodes for every
 * resolved entity of that part (deduped across the whole module; first
 * occurrence wins).
 *
 * `context` carries the module id so resolution tiers the module's own
 * entities first — the same pool semantics the reader renders with. The
 * M6-D rule is unchanged below: a RESOLVED library row still never becomes
 * an outline node implicitly.
 */
export function seedOutlineFromModule(
  module: Module,
  artifacts: readonly AnyArtifact[],
  context?: WikiLinkContext,
): OutlineNode[] {
  const outline: OutlineNode[] = [];
  if (module.spine !== null && module.spine.premise.trim() !== '') {
    outline.push({ type: 'text', markdown: module.spine.premise });
  }

  const seen = new Set<string>();
  const parts = module.parts.slice().sort((a, b) => a.planIndex - b.planIndex);
  for (const part of parts) {
    const planTitle = module.spine?.partPlan[part.planIndex]?.title ?? `Part ${part.planIndex + 1}`;
    const children: OutlineNode[] = [{ type: 'text', markdown: part.markdown }];
    for (const link of extractWikiLinks(part.markdown)) {
      const resolution = resolveWikiLink(link.name, artifacts, context);
      const artifact = resolution.artifact;
      // Library rows are never pulled into a deliverable implicitly; users
      // may add them explicitly through the artifact picker (M6-D).
      if (artifact?.campaignId === undefined || artifact.campaignId === null || seen.has(artifact.id)) continue;
      seen.add(artifact.id);
      children.push({ type: 'artifact', artifactId: artifact.id, include: fullInclude() });
    }
    outline.push({ type: 'chapter', title: planTitle, children });
  }
  return outline;
}
