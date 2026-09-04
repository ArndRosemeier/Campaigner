import type { Artifact, ArtifactKind, Id } from '@/domain';
import { ARTIFACT_KINDS } from '@/domain';
import type { WikiGraph } from '@/domain/wikiGraph';
import { wikiGraphNodeLabel } from '@/domain/wikiGraph';

/**
 * Graph view of links (06-MILESTONES M2): deterministic layout of artifacts
 * as nodes and outgoing links as edges. Kinds cluster in horizontal rows —
 * stable, readable, and cheap to compute (no force simulation).
 */

export interface GraphNode {
  id: Id;
  name: string;
  kind: ArtifactKind;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: Id;
  to: Id;
  relation: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const ROW_HEIGHT = 120;
const NODE_SPACING = 150;
const MARGIN = 80;

/** Kinds in a fixed row order; a kind with no artifacts is skipped. */
function rowFor(kind: ArtifactKind): number {
  return ARTIFACT_KINDS.indexOf(kind);
}

/**
 * Lays artifacts out by kind rows: nodes ordered by name inside each row,
 * x positions evenly spaced, y per kind row. Edges only between artifacts
 * that both exist in the input (dangling links are dropped).
 */
export function layoutGraph(artifacts: readonly Artifact[]): GraphLayout {
  const byKind = new Map<ArtifactKind, Artifact[]>();
  for (const kind of ARTIFACT_KINDS) byKind.set(kind, []);
  for (const artifact of artifacts) {
    byKind.get(artifact.kind)?.push(artifact);
  }

  const nodes: GraphNode[] = [];
  const usedRows: number[] = [];
  for (const kind of ARTIFACT_KINDS) {
    const group = byKind.get(kind) ?? [];
    if (group.length === 0) continue;
    const row = rowFor(kind);
    usedRows.push(row);
    const sorted = [...group].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    sorted.forEach((artifact, index) => {
      nodes.push({
        id: artifact.id,
        name: artifact.name,
        kind,
        x: MARGIN + index * NODE_SPACING,
        y: MARGIN + row * ROW_HEIGHT,
      });
    });
  }

  const existing = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = [];
  for (const artifact of artifacts) {
    for (const link of artifact.links) {
      if (existing.has(link.targetId)) {
        edges.push({ from: artifact.id, to: link.targetId, relation: link.relation });
      }
    }
  }

  const maxRow = usedRows.length === 0 ? 0 : Math.max(...usedRows);
  const maxPerRow = nodes.reduce((max, node) => {
    return Math.max(max, (node.x - MARGIN) / NODE_SPACING + 1);
  }, 1);

  return {
    nodes,
    edges,
    width: MARGIN * 2 + maxPerRow * NODE_SPACING,
    height: MARGIN * 2 + maxRow * ROW_HEIGHT,
  };
}

// --- Derived wiki-link graph (13-WIKI-GRAPH) ---------------------------------

/** One laid-out node of the derived wiki-link graph. */
export interface WikiLayoutNode {
  /** WikiGraphNode key (artifact id or `name:<lowercase>`), or the module id. */
  key: string;
  label: string;
  /** The row group: a module hub, a resolved artifact kind, or a phantom. */
  group: 'module' | ArtifactKind | 'phantom';
  x: number;
  y: number;
}

/** One laid-out edge: module hub → entity node with its mention weight. */
export interface WikiLayoutEdge {
  /** Source module hub (module id = its node key). */
  from: Id;
  /** Target node key. */
  to: string;
  weight: number;
}

export interface WikiGraphLayout {
  nodes: WikiLayoutNode[];
  edges: WikiLayoutEdge[];
  width: number;
  height: number;
}

/** Row index per group: hubs on top, kind rows in ARTIFACT_KINDS order,
 * phantoms last (they are the to-do list, kept apart from real entities). */
function wikiRowFor(group: WikiLayoutNode['group']): number {
  if (group === 'module') return 0;
  if (group === 'phantom') return ARTIFACT_KINDS.length + 1;
  return ARTIFACT_KINDS.indexOf(group) + 1;
}

/**
 * Lays the derived wiki-link graph out with the same conventions as
 * `layoutGraph`: horizontal rows per group, nodes alphabetical inside a row,
 * x evenly spaced, y per row — deterministic, no force simulation. Edges keep
 * their mention weights for the renderer (thickness / ×N label).
 */
export function layoutWikiGraph(graph: WikiGraph): WikiGraphLayout {
  const rows = new Map<number, WikiLayoutNode[]>();

  const push = (node: WikiLayoutNode): void => {
    const row = wikiRowFor(node.group);
    const list = rows.get(row) ?? [];
    list.push(node);
    rows.set(row, list);
  };

  for (const module of graph.modules) {
    push({ key: module.id, label: module.title, group: 'module', x: 0, y: 0 });
  }
  for (const node of graph.nodes) {
    push({
      key: node.key,
      label: wikiGraphNodeLabel(node),
      group: node.artifact === undefined ? 'phantom' : node.artifact.kind,
      x: 0,
      y: 0,
    });
  }

  const nodes: WikiLayoutNode[] = [];
  for (const [row, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort(
      (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    );
    sorted.forEach((node, index) => {
      nodes.push({
        ...node,
        x: MARGIN + index * NODE_SPACING,
        y: MARGIN + row * ROW_HEIGHT,
      });
    });
  }

  const width = MARGIN * 2 + Math.max(1, ...nodes.map((node) => (node.x - MARGIN) / NODE_SPACING + 1)) * NODE_SPACING;
  const maxRow = nodes.reduce((max, node) => Math.max(max, wikiRowFor(node.group)), 0);

  return {
    nodes,
    edges: graph.edges.map((edge) => ({ from: edge.moduleId, to: edge.to, weight: edge.weight })),
    width,
    height: MARGIN * 2 + maxRow * ROW_HEIGHT,
  };
}
