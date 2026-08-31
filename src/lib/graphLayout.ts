import type { Artifact, ArtifactKind, Id } from '@/domain';
import { ARTIFACT_KINDS } from '@/domain';

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
