import { describe, expect, it } from 'vitest';

import {
  artifactSchema,
  createArtifact,
  createModule,
  moduleSchema,
  type Artifact,
  type Module,
} from '@/domain';
import { layoutGraph, layoutWikiGraph } from '@/lib/graphLayout';
import type { WikiGraph } from '@/domain/wikiGraph';

/**
 * Graph layouts: the relations layout (06-MILESTONES M2) and the derived
 * wiki-link layout (13-WIKI-GRAPH) — deterministic kind/module/phantom rows.
 * The GraphPage UI tests live in tests/features/graph-page.test.tsx.
 */

describe('layoutGraph', () => {
  const campaignId = '11111111-1111-4111-8111-111111111111';
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const MISSING = '00000000-0000-4000-8000-0000000000ff';

  function artifact(
    id: string,
    kind: 'npc' | 'location',
    name: string,
    links: { targetId: string; relation: string }[] = [],
  ): Artifact {
    return artifactSchema.parse({ ...createArtifact({ campaignId, kind, name, links }), id });
  }

  it('clusters kinds into rows and spaces nodes deterministically', () => {
    const a = artifact(A, 'npc', 'Zeta');
    const b = artifact(B, 'npc', 'Alpha');
    const c = artifact(C, 'location', 'Docks');
    const layout = layoutGraph([a, b, c]);

    const alpha = layout.nodes.find((node) => node.name === 'Alpha');
    const zeta = layout.nodes.find((node) => node.name === 'Zeta');
    const docks = layout.nodes.find((node) => node.name === 'Docks');
    expect(alpha?.x).toBeLessThan(zeta?.x ?? 0);
    expect(alpha?.y).toBe(zeta?.y);
    expect(docks?.y).not.toBe(alpha?.y);
    // Same input → same output (deterministic).
    expect(layoutGraph([a, b, c])).toEqual(layout);
  });

  it('drops dangling links and keeps valid ones with relations', () => {
    const a = artifact(A, 'npc', 'Alpha', [{ targetId: C, relation: 'located-in' }]);
    const b = artifact(B, 'npc', 'Beta', [{ targetId: MISSING, relation: 'ally-of' }]);
    const c = artifact(C, 'location', 'Docks');
    const layout = layoutGraph([a, b, c]);
    expect(layout.edges).toEqual([{ from: A, to: C, relation: 'located-in' }]);
    expect(layoutGraph([a, b, c]).edges).toHaveLength(1);
  });
});

describe('layoutWikiGraph', () => {
  const campaignId = '11111111-1111-4111-8111-111111111111';
  const MODULE_ID = '00000000-0000-4000-8000-0000000000a1';

  function moduleRow(): Module {
    return moduleSchema.parse({
      ...createModule({
        campaignId,
        title: 'Ashen Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
      id: MODULE_ID,
    });
  }

  function wikiGraphFixture(): WikiGraph {
    const grimm = createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });
    const docks = createArtifact({ campaignId, kind: 'location', name: 'The Docks' });
    return {
      nodes: [
        {
          key: 'name:seggel',
          names: ['Seggel'],
          artifact: undefined,
          status: 'unresolved',
          mentions: 1,
          mentionsByDocument: [],
        },
        {
          key: grimm.id,
          names: ['Grimm'],
          artifact: grimm,
          status: 'resolved',
          mentions: 3,
          mentionsByDocument: [],
        },
        {
          key: docks.id,
          names: ['The Docks'],
          artifact: docks,
          status: 'resolved',
          mentions: 1,
          mentionsByDocument: [],
        },
      ],
      edges: [
        { moduleId: MODULE_ID, to: grimm.id, weight: 3 },
        { moduleId: MODULE_ID, to: docks.id, weight: 1 },
        { moduleId: MODULE_ID, to: 'name:seggel', weight: 1 },
      ],
      modules: [moduleRow()],
      truncated: 0,
    };
  }

  it('rows module hubs first, one row per kind, phantoms last', () => {
    const graph = wikiGraphFixture();
    const layout = layoutWikiGraph(graph);
    const hub = layout.nodes.find((node) => node.group === 'module');
    const grimm = layout.nodes.find((node) => node.label === 'Grimm');
    const docks = layout.nodes.find((node) => node.label === 'The Docks');
    const phantom = layout.nodes.find((node) => node.group === 'phantom');
    expect(hub).toBeDefined();
    expect(grimm).toBeDefined();
    expect(docks).toBeDefined();
    expect(phantom).toBeDefined();
    // Hubs on top; kind rows in ARTIFACT_KINDS order (npc before location);
    // phantoms last.
    expect(hub?.y).toBeLessThan(grimm?.y ?? 0);
    expect(grimm?.y).toBeLessThan(docks?.y ?? 0);
    expect(docks?.y).toBeLessThan(phantom?.y ?? 0);
    expect(layout.edges).toEqual(
      graph.edges.map((edge) => ({ from: edge.moduleId, to: edge.to, weight: edge.weight })),
    );
    // Same input → same output (deterministic).
    expect(layoutWikiGraph(graph)).toEqual(layout);
  });
});
