import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ArtifactRepo from '@/db/artifactRepo';
import {
  attachImagesToArtifact,
  createArtifact,
  getAnyArtifact,
  getArtifact,
  listRevisions,
  publishToLibrary,
  updateArtifact,
} from '@/db/artifactRepo';
import {
  createCampaign as addCampaign,
  describeGeneratedContent,
  getCampaign,
  removeAllGeneratedContent,
} from '@/db/campaignRepo';
import { ensureBattle, getBattleByModule } from '@/db/battleRepo';
import { createImage } from '@/db/imageRepo';
import { createModule } from '@/db/moduleRepo';
import {
  countModuleVersions,
  listModuleVersions,
  listOrphanedModuleVersions,
} from '@/db/moduleVersionRepo';
import { createPersona } from '@/db/personaRepo';
import { createRun } from '@/db/runRepo';
import { createDeliverable } from '@/db/deliverableRepo';
import { updateSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import {
  createModule as buildModule,
  newId,
  statBlockSchema,
  type Id,
  type StatBlock,
} from '@/domain';
import { clearDatabase, expectNotFound, seedModuleVersion } from './helpers';

/**
 * Fresh-generation wipe (owner-ordered "remove all"): `removeAllGeneratedContent`
 * deletes every non-`pc` artifact (revisions scrubbed), every module row,
 * every battle, and the campaign runs/deliverables that would dangle —
 * while the Party, the campaign row, settings, personas and the global
 * library survive. The whole disposal is ONE transaction over every touched
 * table with rows re-listed INSIDE it (the deleteModule precedent): a
 * mid-wipe failure rolls everything back loudly, and the returned counts
 * describe what actually went (never a dialog-open snapshot).
 */

let realDeleteArtifact: (id: string) => Promise<void>;

vi.mock('@/db/artifactRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ArtifactRepo>();
  // Only `deleteArtifact` is replaceable; every other export stays real
  // (createArtifact, listArtifactsByCampaign, … are used by the code under
  // test AND by these tests' fixtures — the moduleDelete.test.ts pattern).
  return { ...actual, deleteArtifact: vi.fn() };
});

const { deleteArtifact } = await import('@/db/artifactRepo');
const deleteArtifactMock = vi.mocked(deleteArtifact);

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 10,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/2',
    proficiency: 2,
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof ArtifactRepo>('@/db/artifactRepo');
  realDeleteArtifact = actual.deleteArtifact;
  await clearDatabase();
  deleteArtifactMock.mockImplementation(realDeleteArtifact);
});

async function makeModule(campaignId: Id, title: string): Promise<Id> {
  const module = await createModule(
    buildModule({
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

async function addPc(campaignId: Id, name: string): Promise<Id> {
  const pc = await createArtifact({
    campaignId,
    kind: 'pc',
    name,
    data: {
      playerName: 'A player',
      statBlock: statBlock(),
      currentHp: 10,
      initiativeOverride: null,
      notes: 'party notes',
    },
  });
  return pc.id;
}

async function attachOneImage(artifactId: Id, campaignId: Id | null): Promise<Id> {
  const updated = await attachImagesToArtifact(artifactId, {
    createImages: [
      {
        campaignId,
        blob: new Blob([`bytes-for-${artifactId}`], { type: 'image/png' }),
        mimeType: 'image/png',
        width: 8,
        height: 8,
        source: 'uploaded',
      },
    ],
  });
  const imageId = updated.imageIds[0];
  if (imageId === undefined) throw new Error('attach did not record the image');
  return imageId;
}

async function makePersona(): Promise<Id> {
  const persona = await createPersona({
    slug: `test-persona-${newId()}`,
    name: 'Test Persona',
    description: '',
    systemPrompt: '',
    producesKind: 'note',
    builtIn: false,
  });
  return persona.id;
}

describe('removeAllGeneratedContent — Party survives, everything generated goes', () => {
  it('deletes every non-pc artifact with revisions scrubbed; PCs stay byte-identical', async () => {
    const campaign = await addCampaign({ name: 'Wipe', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const pc = await addPc(campaign.id, 'Serren');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    // A second revision, to prove revision history is scrubbed too.
    await updateArtifact(npc.id, { body: 'changed' });
    const note = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'note',
      name: 'Module note',
    });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'encounter',
      name: 'Gate fight',
    });
    // The survivor links at a doomed row — the wipe must clean the link, not
    // the survivor.
    await updateArtifact(pc, { links: [{ targetId: npc.id, relation: 'ally' }] });
    const pcRevisionsBefore = await listRevisions(pc);

    const removed = await removeAllGeneratedContent(campaign.id);

    expect(removed.artifacts).toBe(3);
    expect(removed.byKind).toEqual([
      { kind: 'encounter', count: 1 },
      { kind: 'note', count: 1 },
      { kind: 'npc', count: 1 },
    ]);
    expect(removed.pcsKept).toBe(1);
    expect(removed.modules).toBe(1);

    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(await getArtifact(note.id)).toBeUndefined();
    expect(await getArtifact(encounter.id)).toBeUndefined();
    for (const id of [npc.id, note.id, encounter.id]) {
      expect(await db.revisions.where('artifactId').equals(id).count()).toBe(0);
    }
    // The Party row is untouched — content, revisions, and (scrubbed) links.
    const survivor = await getArtifact(pc);
    expect(survivor?.name).toBe('Serren');
    expect(survivor?.links).toEqual([]);
    expect((await listRevisions(pc)).map((row) => row.revision)).toEqual(
      pcRevisionsBefore.map((row) => row.revision),
    );
  });

  it('deletes every module and every battle — even a board holding only PC tokens', async () => {
    const campaign = await addCampaign({ name: 'Boards', system: 'dnd5e' });
    const first = await makeModule(campaign.id, 'First Vault');
    const second = await makeModule(campaign.id, 'Second Vault');
    // The PC exists before the battles, so ensureBattle's normalize-on-write
    // seats a PC token on each board (the scrub path alone would keep them).
    const pc = await addPc(campaign.id, 'Mira');
    const battle = await ensureBattle(campaign.id, first);
    await ensureBattle(campaign.id, second);
    expect(battle.board.tokens.map((token) => token.artifactId)).toEqual([pc]);

    const removed = await removeAllGeneratedContent(campaign.id);

    expect(removed.battles).toBe(2);
    expect(removed.modules).toBe(2);
    expect(await db.modules.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await db.battles.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await getBattleByModule(first)).toBeUndefined();
    expect(await getBattleByModule(second)).toBeUndefined();
  });

  it('keeps the campaign row, settings, personas and the global library', async () => {
    const campaign = await addCampaign({ name: 'Kept', system: 'dnd5e' });
    const other = await addCampaign({ name: 'Neighbour', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Doomed Vault');
    await updateSettings({
      lastModule: { campaignId: campaign.id, moduleId, name: 'Doomed Vault' },
    });
    const personaId = await makePersona();
    // A published library entry with its own image: global rows (campaignId
    // null) must never be touched — the campaign prune cannot even see them.
    const libraryNpc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Lib Goblin' });
    const libraryImage = await attachOneImage(libraryNpc.id, campaign.id);
    await publishToLibrary(libraryNpc.id);
    const neighbourArt = await createArtifact({ campaignId: other.id, kind: 'note', name: 'Neighbour note' });
    const neighbourModule = await makeModule(other.id, 'Neighbour Vault');

    await removeAllGeneratedContent(campaign.id);

    // The published row left the campaign: it is NOT among the doomed rows.
    expect(await getAnyArtifact(libraryNpc.id)).toBeDefined();
    expect(await db.images.get(libraryImage)).toBeDefined();
    expect(await getCampaign(campaign.id)).toBeDefined();
    expect(await db.personas.get(personaId)).toBeDefined();
    expect((await db.settings.get('settings'))?.lastModule).toBeNull();
    // The neighbouring campaign keeps everything.
    expect(await getArtifact(neighbourArt.id)).toBeDefined();
    expect(await db.modules.get(neighbourModule)).toBeDefined();
  });

  it('deletes campaign runs and deliverables — both would dangle into deleted rows', async () => {
    const campaign = await addCampaign({ name: 'Runs', system: 'dnd5e' });
    const other = await addCampaign({ name: 'Other', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Doomed Vault');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Doomed' });
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: campaign.id,
      personaId,
      autonomy: 'manual',
      userBrief: 'brief',
      targetArtifactId: npc.id,
      placementModuleId: moduleId,
    });
    const otherRun = await createRun({
      campaignId: other.id,
      personaId,
      autonomy: 'manual',
      userBrief: 'other brief',
    });
    await createDeliverable({
      campaignId: campaign.id,
      title: 'Doomed outline',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [],
    });
    await createDeliverable({
      campaignId: other.id,
      title: 'Other outline',
      subtitle: '',
      audience: 'gm',
      coverImageId: null,
      outline: [],
    });

    const removed = await removeAllGeneratedContent(campaign.id);

    expect(removed.runs).toBe(1);
    expect(removed.deliverables).toBe(1);
    expect(await db.runs.get(run.id)).toBeUndefined();
    expect(await db.deliverables.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await db.runs.get(otherRun.id)).toBeDefined();
    expect(await db.deliverables.where('campaignId').equals(other.id).count()).toBe(1);
  });

  it('prunes orphaned campaign images; PC and stray-orphan handling stays exact', async () => {
    const campaign = await addCampaign({ name: 'Images', system: 'dnd5e' });
    const pc = await addPc(campaign.id, 'Serren');
    const pcImage = await attachOneImage(pc, campaign.id);
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Doomed' });
    const npcImage = await attachOneImage(npc.id, campaign.id);
    // Never attached to anything — a per-artifact prune collects it.
    const stray = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['stray'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    // A deliverable cover: deliverables die AFTER the artifacts, so only the
    // final sweep can collect this blob — it proves the sweep runs.
    const cover = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['cover'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    await createDeliverable({
      campaignId: campaign.id,
      title: 'Doomed outline',
      subtitle: '',
      audience: 'gm',
      coverImageId: cover.id,
      outline: [],
    });

    const removed = await removeAllGeneratedContent(campaign.id);

    // The per-artifact prunes inside the delete path already collect every
    // campaign orphan (covers and strays are never in any reference set, so
    // the first prune takes them) — the final sweep is defense-in-depth and
    // reports 0 here. The row assertions below are the real proof.
    expect(removed.imagesPruned).toBe(0);
    expect(await db.images.get(pcImage)).toBeDefined();
    expect(await db.images.get(npcImage)).toBeUndefined();
    expect(await db.images.get(stray.id)).toBeUndefined();
    expect(await db.images.get(cover.id)).toBeUndefined();
  });
});

describe('removeAllGeneratedContent — count honesty', () => {
  it('recounts at execution time: rows created after the dialog census are wiped and counted', async () => {
    const campaign = await addCampaign({ name: 'Census', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Early' });
    const census = await describeGeneratedContent(campaign.id);
    expect(census.removableArtifacts).toBe(1);
    expect(census.byKind).toEqual([{ kind: 'npc', count: 1 }]);

    // These land AFTER the dialog counted — the execute path re-lists inside
    // its transaction, so they go with the same pass and the toast counts them.
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Late note' });
    await makeModule(campaign.id, 'Late Vault');

    const removed = await removeAllGeneratedContent(campaign.id);

    expect(removed.artifacts).toBe(2);
    expect(removed.byKind).toEqual([
      { kind: 'note', count: 1 },
      { kind: 'npc', count: 1 },
    ]);
    expect(removed.modules).toBe(1);
    // The stale census still says 1 — proving the toast counts came from the
    // execution-time recount, not the dialog snapshot.
    expect(census.removableArtifacts).toBe(1);
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(0);
  });

  it('describes an empty campaign honestly (nothing removable, Party counted as kept)', async () => {
    const campaign = await addCampaign({ name: 'Empty', system: 'dnd5e' });
    await addPc(campaign.id, 'Solo');

    const census = await describeGeneratedContent(campaign.id);
    expect(census).toEqual({
      byKind: [],
      removableArtifacts: 0,
      pcCount: 1,
      modules: 0,
      battles: 0,
      runs: 0,
      deliverables: 0,
    });

    const removed = await removeAllGeneratedContent(campaign.id);
    expect(removed.artifacts).toBe(0);
    expect(removed.pcsKept).toBe(1);
  });
});

describe('removeAllGeneratedContent — durable module versions go with their modules', () => {
  it("sweeps every wiped module's version rows and leaves another campaign intact", async () => {
    const campaign = await addCampaign({ name: 'Undo', system: 'dnd5e' });
    const other = await addCampaign({ name: 'Neighbour', system: 'dnd5e' });
    const first = await makeModule(campaign.id, 'Ember Vault');
    const second = await makeModule(campaign.id, 'Second Vault');
    const kept = await makeModule(other.id, 'Kept Vault');
    await seedModuleVersion(first, 'Chat: one');
    await seedModuleVersion(first, 'Chat: two');
    await seedModuleVersion(second, 'Generate parts');
    await seedModuleVersion(kept, 'Chat: other campaign');

    const removed = await removeAllGeneratedContent(campaign.id);

    expect(removed.modules).toBe(2);
    expect(await db.modules.get(first)).toBeUndefined();
    expect(await countModuleVersions(first)).toBe(0);
    expect(await countModuleVersions(second)).toBe(0);
    // Another campaign's undo history is structurally untouched.
    const survivor = await listModuleVersions(kept);
    expect(survivor.map((entry) => entry.label)).toEqual(['Chat: other campaign']);
    // Repo-level: NO version row anywhere points at a module that is gone.
    expect(await listOrphanedModuleVersions()).toEqual([]);
  });

  it('collects version rows whose module row is already gone (residue from a pre-sweep wipe)', async () => {
    const campaign = await addCampaign({ name: 'Residue', system: 'dnd5e' });
    const live = await makeModule(campaign.id, 'Live Vault');
    const residue = await makeModule(campaign.id, 'Vault wiped by an older build');
    await seedModuleVersion(residue, 'Chat: orphaned');
    await seedModuleVersion(live, 'Chat: live');
    // The state a pre-sweep wipe left behind: module row gone, its version
    // rows stayed. No module-keyed sweep can reach them (the id is what is
    // missing), so the orphan door has to.
    await db.modules.delete(residue);
    expect(await listOrphanedModuleVersions()).toEqual([residue]);

    await removeAllGeneratedContent(campaign.id);

    expect(await listOrphanedModuleVersions()).toEqual([]);
    expect(await db.moduleVersions.count()).toBe(0);
  });
});

describe('removeAllGeneratedContent — failure discipline', () => {
  it('a mid-wipe failure rolls the whole wipe back and rejects loudly', async () => {
    const campaign = await addCampaign({ name: 'Rollback', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const pc = await addPc(campaign.id, 'Serren');
    // Alphabetical disposal order is deterministic: 'Aaa' first, then 'Bbb'.
    const first = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Aaa' });
    const second = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Bbb' });
    const battle = await ensureBattle(campaign.id, moduleId);
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: campaign.id,
      personaId,
      autonomy: 'manual',
      userBrief: 'brief',
    });

    // The SECOND disposal explodes (the first one really deletes inside the
    // doomed transaction).
    deleteArtifactMock.mockImplementation(async (id) => {
      if (id === second.id) {
        throw new Error('simulated wipe failure');
      }
      await realDeleteArtifact(id);
    });

    await expect(removeAllGeneratedContent(campaign.id)).rejects.toThrow(/simulated wipe failure/);

    // Everything rolled back: modules, battles, runs, and BOTH doomed
    // artifacts (including the one whose delete "succeeded") with revisions.
    expect(await db.modules.get(moduleId)).toBeDefined();
    expect(await db.battles.get(battle.id)).toBeDefined();
    expect(await db.runs.get(run.id)).toBeDefined();
    expect(await getArtifact(first.id)).toBeDefined();
    expect(await getArtifact(second.id)).toBeDefined();
    expect((await listRevisions(first.id)).length).toBeGreaterThan(0);
    expect((await listRevisions(second.id)).length).toBeGreaterThan(0);
    expect(await getArtifact(pc)).toBeDefined();
    expect(await getCampaign(campaign.id)).toBeDefined();
  });

  it('a failure after the module delete rolls the modules AND their versions back together', async () => {
    const campaign = await addCampaign({ name: 'Rollback versions', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    await seedModuleVersion(moduleId, 'Chat: pre-failure one');
    await seedModuleVersion(moduleId, 'Chat: pre-failure two');

    // The injected failure lands AFTER the version sweep and the module-row
    // delete: the settings read is this wipe's next-to-last step (only the
    // image prune follows), and nothing else in the transaction reads
    // settings. Both being intact afterwards is therefore the transaction's
    // doing, never a sweep that simply never ran.
    const settingsSpy = vi
      .spyOn(db.settings, 'get')
      .mockRejectedValueOnce(new Error('simulated post-sweep failure'));

    await expect(removeAllGeneratedContent(campaign.id)).rejects.toThrow(
      /simulated post-sweep failure/,
    );
    settingsSpy.mockRestore();

    expect(await db.modules.get(moduleId)).toBeDefined();
    expect(await countModuleVersions(moduleId)).toBe(2);
    expect(await listOrphanedModuleVersions()).toEqual([]);
  });

  it('throws NotFoundError for an unknown campaign instead of reporting a no-op', async () => {
    await expectNotFound(removeAllGeneratedContent(newId()));
  });
});
