import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createModule as createModuleSchema, encounterDataSchema, newId } from '@/domain';
import type { Id, MonsterEntry } from '@/domain';
import { createArtifact, getAnyArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createDeliverable } from '@/db/deliverableRepo';
import { createModule, deleteModule, getModule, patchModule } from '@/db/moduleRepo';
import {
  modulesReferencingOwnedArtifacts,
  promoteRosterUses,
  promoteSecondModuleUses,
} from '@/db/artifactAutoPromote';
import { clearDatabase } from './helpers';

/**
 * Auto-promote on second-module use (owner-ratified design): module-created
 * artifacts stay module-owned until a SECOND module references one
 * (wikilink, roster, battle use), then they promote to campaign level with a
 * loud toast. Deleting a module whose artifacts are referenced elsewhere
 * promotes the referenced rows instead of stranding or wiping them.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { toastSuccess, toastError } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastErrorMock = vi.mocked(toastError);

let campaignId: Id;
let moduleA: Id;
let moduleB: Id;

/** One artifact outline node of a deliverable (all facets on). */
function artifactNode(artifactId: Id) {
  return {
    type: 'artifact' as const,
    artifactId,
    include: { body: true, data: true, statBlocks: true, images: true },
  };
}

/** One encounter data block (module- or campaign-scoped) carrying a roster. */
function encounterData(monsters: unknown[]) {
  return encounterDataSchema.parse({
    difficulty: 'medium',
    levelHint: '3',
    monsters,
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    layout: null,
    preset: 'standard',
    locationKind: 'other',
    siteShape: 'single',
    budgetAdvisory: '',
  });
}

async function makeModule(title: string): Promise<Id> {
  const module = await createModule(
    createModuleSchema({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  return module.id;
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  campaignId = (await createCampaign({ name: 'Promote campaign', system: 'dnd5e' })).id;
  moduleA = await makeModule('Module A');
  moduleB = await makeModule('Module B');
});

describe('promoteSecondModuleUses (links)', () => {
  it('promotes another module\'s artifact on a wikilink use with a loud toast', async () => {
    const npc = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Goblin King' });

    const promoted = await promoteSecondModuleUses(moduleB, ['The party meets [[Goblin King]] here.']);

    expect(promoted.map((row) => row.id)).toEqual([npc.id]);
    expect((await getAnyArtifact(npc.id))?.moduleId).toBeNull();
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const message = toastSuccessMock.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('Goblin King');
    expect(message).toContain('shared across the campaign');
    expect(message).toContain('Module B');
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('leaves own-module, campaign-level and unresolved names alone (silent)', async () => {
    const own = await createArtifact({ campaignId, moduleId: moduleB, kind: 'npc', name: 'Own Squire' });
    const shared = await createArtifact({ campaignId, kind: 'npc', name: 'Shared Sage' });

    const promoted = await promoteSecondModuleUses(moduleB, [
      '[[Own Squire]] and [[Shared Sage]] meet [[Nobody Here]].',
    ]);

    expect(promoted).toEqual([]);
    expect((await getAnyArtifact(own.id))?.moduleId).toBe(moduleB);
    expect((await getAnyArtifact(shared.id))?.moduleId).toBeNull();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second scan after promotion is a silent no-op', async () => {
    const npc = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Goblin King' });

    await promoteSecondModuleUses(moduleB, ['[[Goblin King]]']);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const second = await promoteSecondModuleUses(moduleB, ['[[Goblin King]]']);

    expect(second).toEqual([]);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect((await getAnyArtifact(npc.id))?.moduleId).toBeNull();
  });

  it('batches several promotions into one toast with a capped name list', async () => {
    const names = ['Alpha Wraith', 'Beta Wraith', 'Gamma Wraith', 'Delta Wraith', 'Epsilon Wraith'];
    for (const name of names) {
      await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name });
    }

    await promoteSecondModuleUses(moduleB, [names.map((name) => `[[${name}]]`).join(' ')]);

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const message = toastSuccessMock.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('and 2 more');
  });

  it('throws loudly for a deleted writer module (never scans for a ghost)', async () => {
    await expect(promoteSecondModuleUses(newId(), ['[[Anything]]'])).rejects.toThrow(
      /no longer exists/,
    );
  });
});

describe('promoteRosterUses (roster)', () => {
  it('promotes npc-ref and mob artifacts owned by another module', async () => {
    const npc = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Orc Brute' });
    const chunkId = newId();
    const mob = await createArtifact({
      campaignId,
      moduleId: moduleA,
      kind: 'npc',
      name: 'Cave Fisher',
      data: { appearance: '', personality: '', statBlock: null, monsterChunkId: chunkId },
    });

    const promoted = await promoteRosterUses(moduleB, [
      { name: 'Orc Brute', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: npc.id } },
      {
        name: 'Cave Fisher',
        count: 2,
        notes: '',
        treasure: '',
        source: { type: 'rulebook', chunkId, mobArtifactId: mob.id },
      },
    ]);

    expect(promoted).toHaveLength(2);
    expect((await getAnyArtifact(npc.id))?.moduleId).toBeNull();
    expect((await getAnyArtifact(mob.id))?.moduleId).toBeNull();
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('ignores owners of the using module (silent no-op)', async () => {
    const own = await createArtifact({ campaignId, moduleId: moduleB, kind: 'npc', name: 'Own Guard' });

    const silent = await promoteRosterUses(moduleB, [
      { name: 'Own Guard', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: own.id } },
    ]);

    expect(silent).toEqual([]);
    expect((await getAnyArtifact(own.id))?.moduleId).toBe(moduleB);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  /**
   * The campaign-level exception (owner-ratified 2026-09-09; supersedes the
   * old pin "campaign-level encounters promote any owner"): a campaign-level
   * use is the ABSENCE of a using module, not a second one, so it refuses to
   * adopt another module's row. The use succeeds; only the scope write is
   * refused, loudly, naming the artifact, its owner and the remedy.
   */
  it('REFUSES to adopt another module\'s row on a campaign-level use, loudly, without moving it', async () => {
    const other = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Wild Mage' });

    const promoted = await promoteRosterUses(null, [
      { name: 'Wild Mage', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: other.id } },
    ]);

    expect(promoted).toEqual([]);
    expect((await getAnyArtifact(other.id))?.moduleId).toBe(moduleA);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const message = toastErrorMock.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('Wild Mage');
    expect(message).toContain('Module A');
    expect(message).toContain('Adopt it from the artifact editor');
  });

  it('a campaign-level use of an already campaign-level row stays silent (no refusal notice)', async () => {
    const shared = await createArtifact({ campaignId, kind: 'npc', name: 'Shared Sage' });

    const promoted = await promoteRosterUses(null, [
      { name: 'Shared Sage', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: shared.id } },
    ]);

    expect(promoted).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('a MODULE-level second use still promotes the same row (the guard is campaign-level only)', async () => {
    const other = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Wild Mage' });

    const promoted = await promoteRosterUses(moduleB, [
      { name: 'Wild Mage', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: other.id } },
    ]);

    expect(promoted.map((row) => row.id)).toEqual([other.id]);
    expect((await getAnyArtifact(other.id))?.moduleId).toBeNull();
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('after a refusal the owning module\'s delete surfaces the reference (the remedy path is coherent end to end)', async () => {
    const other = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Wild Mage' });
    const roster: MonsterEntry[] = [
      { name: 'Wild Mage', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: other.id } },
    ];
    const campaignEncounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Wandering Brawl',
      data: encounterData(roster),
    });
    await promoteRosterUses(campaignEncounter.moduleId, roster);
    expect((await getAnyArtifact(other.id))?.moduleId).toBe(moduleA);

    // The remedy: deleting the owner offers promote-and-keep because the
    // campaign-level encounter still points at the row.
    const referenced = await modulesReferencingOwnedArtifacts(moduleA);
    expect(referenced.map((entry) => entry.artifact.id)).toEqual([other.id]);
    await deleteModule(moduleA, 'promote-referenced');
    expect((await getAnyArtifact(other.id))?.moduleId).toBeNull();
    expect(await getAnyArtifact(campaignEncounter.id)).toBeDefined();
  });
});

describe('modulesReferencingOwnedArtifacts (delete scan)', () => {
  it('unions wikilink edges and roster refs, excluding own-module uses', async () => {
    const linked = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Linked Hag' });
    const rostered = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Roster Ogre' });
    const lonely = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Lonely Imp' });
    // Module B links the hag in its part text and rosters the ogre in a
    // campaign-level encounter's roster (survives the delete).
    await patchModule(moduleB, {
      parts: [{ planIndex: 0, markdown: 'Beware [[Linked Hag]].', status: 'ready', errorMessage: '', edited: true, writerModel: '' }],
    });
    await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Brawl',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [
          { name: 'Roster Ogre', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: rostered.id } },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    const found = await modulesReferencingOwnedArtifacts(moduleA);
    const byId = new Map(found.map((entry) => [entry.artifact.id, entry.via]));

    expect(byId.get(linked.id)).toBe('link');
    expect(byId.get(rostered.id)).toBe('roster');
    expect(byId.has(lonely.id)).toBe(false);
  });

  it('ignores references from the module\'s own encounters and battles', async () => {
    const npc = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Homebody' });
    await createArtifact({
      campaignId,
      moduleId: moduleA,
      kind: 'encounter',
      name: 'Home Fight',
      data: {
        difficulty: 'medium',
        levelHint: '3',
        monsters: [
          { name: 'Homebody', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: npc.id } },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });

    expect(await modulesReferencingOwnedArtifacts(moduleA)).toEqual([]);
  });
});

describe('modulesReferencingOwnedArtifacts — reference kinds the old scan missed', () => {
  it("sees a deliverable outline node (the sweep's own guard reading, shared)", async () => {
    const chapter = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Outline Hero' });
    const lonely = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Uncited Extra' });
    await createDeliverable({
      campaignId,
      title: 'Beneath the Docks',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [
        { type: 'chapter', title: 'Act I', children: [artifactNode(chapter.id)] },
        { type: 'text', markdown: 'nothing to see' },
      ],
    });

    const found = await modulesReferencingOwnedArtifacts(moduleA);
    const byId = new Map(found.map((entry) => [entry.artifact.id, entry.via]));
    expect(byId.get(chapter.id)).toBe('outline');
    expect(byId.has(lonely.id)).toBe(false);
  });

  it("sees artifact links[] entries and artifact body wiki-links (buildWikiGraph reads module prose only)", async () => {
    const related = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Related Sage' });
    const mentioned = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Body Mention' });
    const lonely = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Nowhere Imp' });
    // A campaign-level note: a hand-curated relation to `related` and a
    // wiki-link token to `mentioned` in its BODY.
    await createArtifact({
      campaignId,
      kind: 'note',
      name: 'GM notes',
      body: 'The party consults [[Body Mention]] before the heist.',
      links: [{ targetId: related.id, relation: 'consulted-by' }],
    });

    const found = await modulesReferencingOwnedArtifacts(moduleA);
    const byId = new Map(found.map((entry) => [entry.artifact.id, entry.via]));
    expect(byId.get(related.id)).toBe('relation');
    expect(byId.get(mentioned.id)).toBe('link');
    expect(byId.has(lonely.id)).toBe(false);
  });

  it('sees the global library pool: a published encounter citing a module-owned npc', async () => {
    const { publishToLibrary } = await import('@/db/artifactRepo');
    const hero = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Library Hero' });
    const lonely = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Local Only' });
    // A campaign-scoped encounter citing the hero, then adopted INTO THE
    // LIBRARY: it now outlives every campaign delete, so the reference is
    // invisible to any scan that pools campaign rows only.
    const wanderer = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Wandering Brawl',
      data: encounterData([
        { name: 'Library Hero', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: hero.id } },
      ]),
    });
    await publishToLibrary(wanderer.id);

    const found = await modulesReferencingOwnedArtifacts(moduleA);
    const byId = new Map(found.map((entry) => [entry.artifact.id, entry.via]));
    expect(byId.get(hero.id)).toBe('roster');
    expect(byId.has(lonely.id)).toBe(false);
  });

  it("cascade no longer silently destroys a row a deliverable outline still points at", async () => {
    const chapter = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Outline Hero' });
    await createDeliverable({
      campaignId,
      title: 'Beneath the Docks',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [artifactNode(chapter.id)],
    });
    // Before this arc the scan returned [] here, so the dialog offered plain
    // cascade/keep and the outline node dangled.
    const found = await modulesReferencingOwnedArtifacts(moduleA);
    expect(found.map((entry) => entry.artifact.id)).toEqual([chapter.id]);

    await deleteModule(moduleA, 'promote-referenced');

    expect(await getModule(moduleA)).toBeUndefined();
    // The referenced row survives as a shared campaign row.
    expect((await getAnyArtifact(chapter.id))?.moduleId).toBeNull();
  });
});

describe("deleteModule 'promote-referenced'", () => {
  it('shares referenced rows and cascades the rest, deleting the module', async () => {
    const shared = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Shared Hexer' });
    const doomed = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Doomed Squire' });
    await patchModule(moduleB, {
      parts: [{ planIndex: 0, markdown: 'Hire [[Shared Hexer]].', status: 'ready', errorMessage: '', edited: true, writerModel: '' }],
    });

    await deleteModule(moduleA, 'promote-referenced');

    expect(await getModule(moduleA)).toBeUndefined();
    // Referenced: promoted to campaign level, revisions intact.
    const kept = await getAnyArtifact(shared.id);
    expect(kept?.moduleId).toBeNull();
    // Unreferenced: cascaded with the module.
    expect(await getAnyArtifact(doomed.id)).toBeUndefined();
  });

  it('with no outside references behaves exactly like cascade', async () => {
    const solo = await createArtifact({ campaignId, moduleId: moduleA, kind: 'npc', name: 'Solo Actor' });

    await deleteModule(moduleA, 'promote-referenced');

    expect(await getModule(moduleA)).toBeUndefined();
    expect(await getAnyArtifact(solo.id)).toBeUndefined();
  });
});
