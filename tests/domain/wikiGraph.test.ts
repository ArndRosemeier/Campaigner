import { describe, expect, it } from 'vitest';

import {
  anyArtifactSchema,
  createArtifact,
  createModule,
  moduleSchema,
  newId,
  type AnyArtifact,
  type Id,
  type Module,
} from '@/domain';
import { buildWikiGraph, WIKI_GRAPH_NODE_CAP } from '@/domain/wikiGraph';

/**
 * The derived wiki-link graph (13-WIKI-GRAPH): extraction across module
 * prose, resolution with the reader's module-context conventions (5b28bc2 —
 * tier-0 module entities win, globals resolve), mention counts, the phantom
 * set, filters and the cap. The follow-up backlinks/orphan task consumes the
 * same module, so the output shape is pinned here too.
 */

const campaignId = newId();

function moduleWith(input: {
  id?: Id;
  title?: string;
  premise?: string;
  parts?: { planIndex: number; markdown: string }[];
}): Module {
  const draft = createModule({
    campaignId,
    title: input.title ?? 'A Module',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return moduleSchema.parse({
    ...draft,
    id: input.id ?? newId(),
    title: input.title ?? draft.title,
    spine: {
      premise: input.premise ?? '',
      themes: [],
      partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
    },
    parts: (input.parts ?? []).map((part) => ({
      planIndex: part.planIndex,
      markdown: part.markdown,
      status: 'ready' as const,
      errorMessage: '',
      edited: false,
    })),
  });
}

function ownedArtifact(input: {
  name: string;
  kind?: 'npc' | 'location' | 'faction';
  moduleId?: Id | undefined;
  aliases?: string[];
  updatedAt?: number;
}): AnyArtifact {
  const artifact = createArtifact({
    campaignId,
    ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
    kind: input.kind ?? 'npc',
    name: input.name,
    aliases: input.aliases ?? [],
  });
  if (input.updatedAt !== undefined) artifact.updatedAt = input.updatedAt;
  return anyArtifactSchema.parse(artifact);
}

function globalArtifact(input: { name: string; kind?: 'npc' | 'location' }): AnyArtifact {
  const artifact = createArtifact({ campaignId, kind: input.kind ?? 'npc', name: input.name });
  return anyArtifactSchema.parse({ ...artifact, campaignId: null, moduleId: null });
}

describe('buildWikiGraph — extraction and mention counts', () => {
  it('counts every wiki-link token across premise and parts, per module and document', () => {
    const moduleA = moduleWith({
      title: 'Ashen Vault',
      premise: '[[Grimm]] waits. The party meets [[Grimm]] again.',
      parts: [{ planIndex: 0, markdown: 'Grimm ([[Grimm|the jailer]]) guards [[Docks|the docks]].' }],
    });
    const moduleB = moduleWith({
      title: 'Bell Harbor',
      parts: [{ planIndex: 0, markdown: '[[Grimm]] sails from [[Docks]].' }],
    });

    const graph = buildWikiGraph([moduleA, moduleB], []);

    const grimm = graph.nodes.find((node) => node.key === 'name:grimm');
    expect(grimm).toBeDefined();
    expect(grimm?.status).toBe('unresolved');
    expect(grimm?.artifact).toBeUndefined();
    expect(grimm?.names).toEqual(['Grimm']);
    expect(grimm?.mentions).toBe(4);
    expect(grimm?.mentionsByDocument).toEqual([
      { moduleId: moduleA.id, where: 'premise', count: 2 },
      { moduleId: moduleA.id, where: 'part-0', count: 1 },
      { moduleId: moduleB.id, where: 'part-0', count: 1 },
    ]);

    // Edges are per (module, target) with token-count weights; display
    // aliases do not change the target.
    expect(graph.edges).toEqual([
      { moduleId: moduleA.id, to: 'name:grimm', weight: 3 },
      { moduleId: moduleA.id, to: 'name:docks', weight: 1 },
      { moduleId: moduleB.id, to: 'name:grimm', weight: 1 },
      { moduleId: moduleB.id, to: 'name:docks', weight: 1 },
    ]);
    // Hubs are the contributing modules, title-sorted.
    expect(graph.modules.map((module) => module.id)).toEqual([moduleA.id, moduleB.id]);
    expect(graph.truncated).toBe(0);
  });

  it('is deterministic and independent of the caller module order', () => {
    const moduleA = moduleWith({ title: 'Ashen Vault', premise: '[[Grimm]] waits.' });
    const moduleB = moduleWith({ title: 'Bell Harbor', premise: '[[Grimm]] sails.' });
    expect(buildWikiGraph([moduleB, moduleA], [])).toEqual(buildWikiGraph([moduleA, moduleB], []));
  });
});

describe('buildWikiGraph — resolution with module context (5b28bc2)', () => {
  it('resolves tier-0 module entities over same-named campaign rows, and per module', () => {
    const moduleIdA = newId();
    const moduleOwned = ownedArtifact({ name: 'Guide', moduleId: moduleIdA, updatedAt: 1 });
    const campaignRow = ownedArtifact({ name: 'Guide', updatedAt: 2 });
    const moduleA = moduleWith({ id: moduleIdA, title: 'Ashen Vault', premise: '[[Guide]] leads.' });
    const moduleB = moduleWith({ title: 'Bell Harbor', premise: '[[Guide]] follows.' });

    const graph = buildWikiGraph([moduleA, moduleB], [campaignRow, moduleOwned]);

    // Two resolution targets → two nodes, exactly what each module's reader shows.
    const keys = graph.nodes.map((node) => node.key).sort();
    expect(keys).toEqual([campaignRow.id, moduleOwned.id].sort());
    const ownedNode = graph.nodes.find((node) => node.key === moduleOwned.id);
    expect(ownedNode?.artifact?.id).toBe(moduleOwned.id);
    expect(ownedNode?.names).toEqual(['Guide']);
    expect(ownedNode?.mentions).toBe(1);
    // Module A's edge points at its own tier-0 entity.
    expect(graph.edges).toContainEqual({ moduleId: moduleA.id, to: moduleOwned.id, weight: 1 });
    expect(graph.edges).toContainEqual({
      moduleId: moduleB.id,
      to: campaignRow.id,
      weight: 1,
    });
  });

  it('resolves a shared-library name in module text instead of phantomizing it', () => {
    const globalRow = globalArtifact({ name: 'Goblin Warrior' });
    const module = moduleWith({ title: 'Ashen Vault', premise: 'A [[Goblin Warrior]] patrols.' });

    const graph = buildWikiGraph([module], [globalRow]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.key).toBe(globalRow.id);
    expect(graph.nodes[0]?.status).toBe('resolved');
  });

  it('merges alias mentions into the target artifact node and sums their counts', () => {
    const halmund = ownedArtifact({ name: 'Halmund', aliases: ['Guard Halmund'] });
    const module = moduleWith({
      title: 'Ashen Vault',
      premise: '[[Halmund]] stands watch.',
      parts: [{ planIndex: 0, markdown: '[[Guard Halmund]] and [[Halmund]] argue.' }],
    });

    const graph = buildWikiGraph([module], [halmund]);

    expect(graph.nodes).toHaveLength(1);
    const node = graph.nodes[0];
    expect(node?.key).toBe(halmund.id);
    expect(node?.names).toEqual(['Halmund', 'Guard Halmund']);
    expect(node?.mentions).toBe(3);
    expect(graph.edges).toEqual([{ moduleId: module.id, to: halmund.id, weight: 3 }]);
  });

  it('marks within-tier ambiguity on the node while keeping the reader winner', () => {
    const newer = ownedArtifact({ name: 'Twin', updatedAt: 20 });
    const older = ownedArtifact({ name: 'Twin', updatedAt: 10 });
    const module = moduleWith({ title: 'Ashen Vault', premise: '[[Twin]] appears.' });

    const graph = buildWikiGraph([module], [older, newer]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.status).toBe('ambiguous');
    expect(graph.nodes[0]?.artifact?.id).toBe(newer.id);
  });

  it('reuses one node when several modules mention the same global entity (aliases included)', () => {
    const goblin = globalArtifact({ name: 'Goblin Warrior', kind: 'npc' });
    const moduleA = moduleWith({ title: 'Ashen Vault', premise: '[[Goblin Warrior]] attacks.' });
    const moduleB = moduleWith({ title: 'Bell Harbor', parts: [{ planIndex: 2, markdown: '[[Goblin Warrior]] returns.' }] });

    const graph = buildWikiGraph([moduleA, moduleB], [goblin]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.key).toBe(goblin.id);
    expect(graph.edges).toEqual([
      { moduleId: moduleA.id, to: goblin.id, weight: 1 },
      { moduleId: moduleB.id, to: goblin.id, weight: 1 },
    ]);
  });
});

describe('buildWikiGraph — filters', () => {
  const grimm = ownedArtifact({ name: 'Grimm', kind: 'npc' });
  const docks = ownedArtifact({ name: 'The Docks', kind: 'location' });
  const moduleA = moduleWith({
    title: 'Ashen Vault',
    premise: '[[Grimm]] and [[The Docks]] and [[Seggel]].',
  });
  const moduleB = moduleWith({ title: 'Bell Harbor', premise: '[[Grimm]] sails.' });

  it('narrows the prose scope to one module and recomputes counts', () => {
    const graph = buildWikiGraph([moduleA, moduleB], [grimm, docks], { moduleId: moduleB.id });
    expect(graph.modules.map((module) => module.id)).toEqual([moduleB.id]);
    expect(graph.edges).toEqual([{ moduleId: moduleB.id, to: grimm.id, weight: 1 }]);
    expect(graph.nodes.map((node) => node.key)).toEqual([grimm.id]);
    expect(graph.nodes[0]?.mentions).toBe(1);
  });

  it('keeps only resolved nodes of the requested kind, dropping edgeless hubs', () => {
    const graph = buildWikiGraph([moduleA, moduleB], [grimm, docks], { kind: 'location' });
    expect(graph.nodes.map((node) => node.key)).toEqual([docks.id]);
    expect(graph.edges).toEqual([{ moduleId: moduleA.id, to: docks.id, weight: 1 }]);
    expect(graph.modules.map((module) => module.id)).toEqual([moduleA.id]);
  });

  it("keeps only phantom nodes for the 'unresolved' scope", () => {
    const graph = buildWikiGraph([moduleA, moduleB], [grimm, docks], { kind: 'unresolved' });
    expect(graph.nodes.map((node) => node.key)).toEqual(['name:seggel']);
    expect(graph.nodes[0]?.status).toBe('unresolved');
    expect(graph.edges).toEqual([{ moduleId: moduleA.id, to: 'name:seggel', weight: 1 }]);
  });
});

describe('buildWikiGraph — cap and truncation', () => {
  it('keeps the most-mentioned nodes and counts the hidden ones', () => {
    const module = moduleWith({
      title: 'Ashen Vault',
      premise: '[[Big]] [[Big]] [[Big]] [[Middle]] [[Middle]] [[Small]]',
    });
    const graph = buildWikiGraph([module], [], { cap: 2 });
    expect(graph.nodes.map((node) => node.key)).toEqual(['name:big', 'name:middle']);
    expect(graph.truncated).toBe(1);
    expect(graph.edges.every((edge) => edge.to !== 'name:small')).toBe(true);
  });

  it('defaults to the documented WIKI_GRAPH_NODE_CAP', () => {
    const parts = Array.from({ length: WIKI_GRAPH_NODE_CAP + 5 }, (_, index) => ({
      planIndex: index,
      markdown: `[[Name ${String(index)}]]`,
    }));
    const module = moduleWith({ title: 'Ashen Vault', parts });
    const graph = buildWikiGraph([module], []);
    expect(graph.nodes).toHaveLength(WIKI_GRAPH_NODE_CAP);
    expect(graph.truncated).toBe(5);
  });

  it('applies the cap after the kind filter', () => {
    const npcs = Array.from({ length: 4 }, (_, index) =>
      ownedArtifact({ name: `NPC ${String(index)}`, kind: 'npc', updatedAt: index }),
    );
    const location = ownedArtifact({ name: 'The Docks', kind: 'location' });
    const module = moduleWith({
      title: 'Ashen Vault',
      premise: npcs.map((npc) => `[[${npc.name}]]`).join(' ') + ' [[The Docks]]',
    });
    const graph = buildWikiGraph([module], [...npcs, location], { kind: 'npc', cap: 2 });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((node) => node.artifact?.kind === 'npc')).toBe(true);
    expect(graph.truncated).toBe(2);
  });
});

describe('buildWikiGraph — uncapped derivation (14-BACKLINKS-ORPHANS consumers)', () => {
  it('cap: Number.POSITIVE_INFINITY keeps every node and truncates nothing', () => {
    // The backlinks panel and the link-health report pass Infinity so the
    // drawing cap can never silently hide a mention they must surface; the
    // visible caps are their own.
    const parts = Array.from({ length: WIKI_GRAPH_NODE_CAP + 7 }, (_, index) => ({
      planIndex: index,
      markdown: `[[Name ${String(index)}]]`,
    }));
    const module = moduleWith({ title: 'Ashen Vault', parts });
    const graph = buildWikiGraph([module], [], { cap: Number.POSITIVE_INFINITY });
    expect(graph.nodes).toHaveLength(WIKI_GRAPH_NODE_CAP + 7);
    expect(graph.truncated).toBe(0);
  });
});
