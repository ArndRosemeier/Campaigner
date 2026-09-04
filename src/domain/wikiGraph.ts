import type { AnyArtifact, ArtifactKind } from '@/domain/artifact';
import type { Id } from '@/domain/entity';
import type { Module } from '@/domain/module';

import type { WikiLinkResolution } from '@/lib/wikilinks';
import { extractWikiLinks, resolveWikiLink, WIKI_LINK_PATTERN } from '@/lib/wikilinks';

/**
 * The derived wiki-link graph (13-WIKI-GRAPH): the REAL graph behind a
 * campaign — the [[wiki-link]] mentions in module prose (`spine.premise` +
 * `parts[].markdown`), resolved exactly the way the reader resolves them
 * (conventions of 5b28bc2: pool = campaign artifacts + global library, module
 * context tier-0). Nothing here touches storage — pure derivation from the
 * passed rows, reusable by the Graph page today and by the follow-up
 * backlinks panel + orphan report (their raw material is
 * `mentionsByDocument`).
 *
 * Graph shape (13-WIKI-GRAPH §2): bipartite, because module prose has no
 * owning entity — a module hub node per module with mentions, one edge per
 * (module, mentioned name) with `weight` = the wiki-link token count, and one
 * entity node per distinct RESOLUTION TARGET: resolved/ambiguous names merge
 * onto the winning artifact's node (aliases included), unresolved names stay
 * phantom nodes keyed `name:<lowercase>` — the campaign's to-do list, never
 * artifacts. The same written name may resolve differently per module
 * (module-tier entities); each resolution target gets its own node, so the
 * graph never claims a resolution the reader would not make.
 */

/** One node of the derived graph: an entity (resolved/ambiguous) or a phantom. */
export interface WikiGraphNode {
  /** The winning artifact's id (resolved/ambiguous) or `name:<lowercase>` (phantom). */
  key: string;
  /** The wiki-link names that resolve here, first-seen spelling first. */
  names: string[];
  /** The winning artifact; undefined for phantom nodes. */
  artifact: AnyArtifact | undefined;
  /** Mirrors `resolveWikiLink`: 'resolved' | 'unresolved' | 'ambiguous'. */
  status: 'resolved' | 'unresolved' | 'ambiguous';
  /** Total wiki-link mentions across the filtered scope. */
  mentions: number;
  /** Per-document mention lists — the backlinks consumer's raw material. */
  mentionsByDocument: WikiGraphMention[];
}

/** Mentions of one node in one document of one module. */
export interface WikiGraphMention {
  moduleId: Id;
  /** 'premise' or 'part-<planIndex>' — the entity panel's convention. */
  where: string;
  count: number;
}

/** One edge of the derived graph: a module's prose mentions a node. */
export interface WikiGraphEdge {
  /** Source module hub (also the per-edge module provenance). */
  moduleId: Id;
  /** Target node key. */
  to: string;
  /** Wiki-link mentions of the target in that module's prose. */
  weight: number;
}

/** The derived graph for a scope: entity nodes, weighted edges, hub modules. */
export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  /** Modules that actually contribute prose in scope (the hub nodes). */
  modules: Module[];
  /** Entity nodes hidden by the cap — the visible truncation note's count. */
  truncated: number;
}

/**
 * The entity-node cap (13-WIKI-GRAPH decision 7): the N most-mentioned
 * entities render; the rest are dropped behind the visible truncation note.
 * Module hubs are never capped (bounded by the campaign's module count).
 */
export const WIKI_GRAPH_NODE_CAP = 120;

/** Node scope for the kind filter: one resolved kind, or phantoms only. */
export type WikiGraphKindFilter = ArtifactKind | 'unresolved';

export interface WikiGraphFilters {
  /** Prose scope: one module, or every module (undefined). */
  moduleId?: Id | undefined;
  /** Node scope: one resolved artifact kind, phantoms only, or everything. */
  kind?: WikiGraphKindFilter | undefined;
  /** Entity-node cap; defaults to WIKI_GRAPH_NODE_CAP. */
  cap?: number | undefined;
}

/**
 * Builds the derived wiki-link graph for the given scope. `pool` must be the
 * reader's resolution pool — campaign artifacts + global library (5b28bc2) —
 * assembled by the caller: this module stays IO-free. Deterministic for the
 * same inputs (modules ordered by title, nodes by first appearance,
 * cap ranking by mentions desc then name).
 */
export function buildWikiGraph(
  modules: readonly Module[],
  pool: readonly AnyArtifact[],
  filters: WikiGraphFilters = {},
): WikiGraph {
  const cap = filters.cap ?? WIKI_GRAPH_NODE_CAP;
  const scoped = modules.filter(
    (module) => filters.moduleId === undefined || module.id === filters.moduleId,
  );
  // Deterministic regardless of the caller's row order (the repo lists
  // modules newest-first): title, then id.
  const ordered = [...scoped].sort(
    (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );

  /** Accumulating node state, keyed by node key. */
  const nodes = new Map<string, {
    key: string;
    names: string[];
    artifact: AnyArtifact | undefined;
    status: 'resolved' | 'unresolved' | 'ambiguous';
    mentionsByDocument: Map<string, WikiGraphMention>;
  }>();
  /** moduleId → (node key → weight). */
  const edgeWeights = new Map<Id, Map<string, number>>();

  for (const module of ordered) {
    const resolutions = new Map<string, WikiLinkResolution>();
    let moduleWeights = edgeWeights.get(module.id);
    if (moduleWeights === undefined) {
      moduleWeights = new Map<string, number>();
      edgeWeights.set(module.id, moduleWeights);
    }
    for (const document of moduleDocuments(module)) {
      // The name set comes from the same extractor the reader uses; the
      // per-name COUNT comes from the shared token pattern (extractWikiLinks
      // dedupes per text, which is wrong for counting mentions).
      const links = extractWikiLinks(document.markdown);
      if (links.length === 0) continue;
      const tokenCounts = countTokens(document.markdown);
      for (const link of links) {
        const lower = link.name.toLowerCase();
        const count = tokenCounts.get(lower);
        if (count === undefined) continue; // extractWikiLinks only returns tokened names
        const resolution = resolveOnce(resolutions, link.name, module.id, pool);
        const nodeKey =
          resolution.artifact !== undefined ? resolution.artifact.id : `name:${lower}`;

        const node = nodes.get(nodeKey);
        if (node === undefined) {
          nodes.set(nodeKey, {
            key: nodeKey,
            names: [link.name],
            artifact: resolution.artifact,
            status: resolution.artifact === undefined ? 'unresolved' : resolution.status,
            mentionsByDocument: new Map<string, WikiGraphMention>(),
          });
        } else {
          if (!node.names.some((name) => name.toLowerCase() === lower)) node.names.push(link.name);
          // A path that resolved within-tier ambiguously marks the node ⚠ —
          // the same tooltip semantics the reader gives its chips.
          if (resolution.status === 'ambiguous') node.status = 'ambiguous';
        }
        const stored = nodes.get(nodeKey);
        if (stored === undefined) continue; // set above — keeps narrowing honest

        moduleWeights.set(nodeKey, (moduleWeights.get(nodeKey) ?? 0) + count);
        const mentionKey = `${module.id}|${document.where}`;
        const mention = stored.mentionsByDocument.get(mentionKey);
        if (mention === undefined) {
          stored.mentionsByDocument.set(mentionKey, {
            moduleId: module.id,
            where: document.where,
            count,
          });
        } else {
          mention.count += count;
        }
      }
    }
  }

  // Assemble nodes (insertion order = first appearance in document order).
  const allNodes: WikiGraphNode[] = [...nodes.values()].map((node) => {
    const mentionsByDocument = [...node.mentionsByDocument.values()];
    return {
      key: node.key,
      names: [...node.names],
      artifact: node.artifact,
      status: node.status,
      mentions: mentionsByDocument.reduce((sum, mention) => sum + mention.count, 0),
      mentionsByDocument,
    };
  });

  // Kind filter first — the cap ranks only what the scope keeps.
  let kept =
    filters.kind === undefined
      ? allNodes
      : filters.kind === 'unresolved'
        ? allNodes.filter((node) => node.status === 'unresolved')
        : allNodes.filter((node) => node.artifact?.kind === filters.kind);

  // Cap: most-mentioned first, ties by display name then key — deterministic.
  const ranked = [...kept].sort(
    (a, b) =>
      b.mentions - a.mentions ||
      wikiGraphNodeLabel(a).localeCompare(wikiGraphNodeLabel(b)) ||
      a.key.localeCompare(b.key),
  );
  kept = ranked.slice(0, Math.max(0, cap));
  const truncated = ranked.length - kept.length;

  // Edges survive only into kept nodes; hubs survive only with an edge left.
  const keptKeys = new Set(kept.map((node) => node.key));
  const hubIds = new Set<Id>();
  const edges: WikiGraphEdge[] = [];
  for (const [moduleId, targets] of edgeWeights) {
    for (const [nodeKey, weight] of targets) {
      if (!keptKeys.has(nodeKey)) continue;
      hubIds.add(moduleId);
      edges.push({ moduleId, to: nodeKey, weight });
    }
  }

  return {
    nodes: kept,
    edges,
    modules: ordered.filter((module) => hubIds.has(module.id)),
    truncated,
  };
}

/** The node's label: the artifact's canonical name, else the first spelling. */
export function wikiGraphNodeLabel(node: WikiGraphNode): string {
  return node.artifact?.name ?? node.names[0] ?? node.key;
}

/** A module's prose documents in reading order (entity panel's convention). */
function moduleDocuments(module: Module): { where: string; markdown: string }[] {
  return [
    { where: 'premise', markdown: module.spine?.premise ?? '' },
    ...module.parts
      .slice()
      .sort((a, b) => a.planIndex - b.planIndex)
      .map((part) => ({ where: `part-${String(part.planIndex)}`, markdown: part.markdown })),
  ];
}

/** Counts wiki-link token occurrences per written name (case-insensitive). */
function countTokens(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of markdown.matchAll(WIKI_LINK_PATTERN)) {
    const name = (match[1] ?? '').trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Resolves one written name once per module (the reader's context). */
function resolveOnce(
  cache: Map<string, WikiLinkResolution>,
  name: string,
  moduleId: Id,
  pool: readonly AnyArtifact[],
): WikiLinkResolution {
  const key = name.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolution = resolveWikiLink(name, pool, { moduleId });
  cache.set(key, resolution);
  return resolution;
}
