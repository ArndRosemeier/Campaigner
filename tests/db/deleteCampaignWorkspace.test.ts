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
import { createCampaign as addCampaign, getCampaign, updateCampaign } from '@/db/campaignRepo';
import { deleteCampaignWorkspace } from '@/db/maintenance';
import {
  countModuleVersions,
  listModuleVersions,
  listOrphanedModuleVersions,
} from '@/db/moduleVersionRepo';
import { ensureBattle, getBattleByModule } from '@/db/battleRepo';
import { createImage } from '@/db/imageRepo';
import { createModule } from '@/db/moduleRepo';
import { createPersona } from '@/db/personaRepo';
import { createRun } from '@/db/runRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { countChunksByBook, putChunks } from '@/db/chunkRepo';
import { getEmbedding, putEmbedding } from '@/db/embeddingRepo';
import { getBookPdf, putBookPdf } from '@/db/pdfRepo';
import { db } from '@/db/db';
import {
  createModule as buildModule,
  newId,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type Id,
  type StatBlock,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase, expectNotFound, seedModuleVersion } from './helpers';

/**
 * Per-campaign "Clear workspace" (`db/maintenance.deleteCampaignWorkspace`):
 * deletes EVERYTHING under one campaign — modules (parts, board canvas and
 * chat threads live on the rows), artifacts of every kind INCLUDING `pc`
 * (unlike `removeAllGeneratedContent`, which keeps the Party), battles, runs
 * and runs — while the campaign row itself (the premise) and the
 * global rulebook ingests survive. One transaction, rows re-listed inside;
 * a mid-clear failure rolls everything back loudly.
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

describe('deleteCampaignWorkspace — one campaign cleared, premise kept', () => {
  it('deletes modules, every artifact kind including PCs, and runs — campaign B keeps everything', async () => {
    const campaign = await addCampaign({
      name: 'Emberfall',
      description: 'A valley of ash.',
      system: 'dnd5e',
    });
    const other = await addCampaign({ name: 'Neighbour', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const pc = await addPc(campaign.id, 'Serren');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
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
    const personaId = await makePersona();
    const run = await createRun({
      campaignId: campaign.id,
      personaId,
      autonomy: 'manual',
      userBrief: 'brief',
      targetArtifactId: npc.id,
      placementModuleId: moduleId,
    });
    const battle = await ensureBattle(campaign.id, moduleId);
    // Campaign B's everything — must survive byte-identical.
    const neighbourModule = await makeModule(other.id, 'Neighbour Vault');
    const neighbourArt = await createArtifact({ campaignId: other.id, kind: 'note', name: 'Neighbour note' });
    const neighbourPc = await addPc(other.id, 'Neighbour PC');
    const otherRun = await createRun({
      campaignId: other.id,
      personaId,
      autonomy: 'manual',
      userBrief: 'other brief',
    });
    const rowBefore = JSON.stringify(await getCampaign(campaign.id));

    const cleared = await deleteCampaignWorkspace(campaign.id);

    expect(cleared.artifacts).toBe(4);
    expect(cleared.byKind).toEqual([
      { kind: 'encounter', count: 1 },
      { kind: 'note', count: 1 },
      { kind: 'npc', count: 1 },
      { kind: 'pc', count: 1 },
    ]);
    expect(cleared.modules).toBe(1);
    expect(cleared.battles).toBe(1);
    expect(cleared.runs).toBe(1);

    // Campaign A's workspace is gone — modules (with parts/canvas/threads on
    // the rows), artifacts with revisions, battles, runs.
    expect(await db.modules.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(0);
    for (const id of [pc, npc.id, note.id, encounter.id]) {
      expect(await db.revisions.where('artifactId').equals(id).count()).toBe(0);
    }
    expect(await getBattleByModule(moduleId)).toBeUndefined();
    expect(await db.battles.get(battle.id)).toBeUndefined();
    expect(await db.runs.get(run.id)).toBeUndefined();
    // The campaign row itself is byte-identical — premise kept.
    expect(JSON.stringify(await getCampaign(campaign.id))).toBe(rowBefore);

    // Campaign B keeps everything.
    expect(await getArtifact(neighbourArt.id)).toBeDefined();
    expect(await getArtifact(neighbourPc)).toBeDefined();
    expect(await db.modules.get(neighbourModule)).toBeDefined();
    expect(await db.runs.get(otherRun.id)).toBeDefined();
  });

  it('keeps rulebook ingests, the campaign cover, settings, personas and the global library', async () => {
    const campaign = await addCampaign({ name: 'Kept', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Doomed Vault');
    await updateSettings({
      lastModule: { campaignId: campaign.id, moduleId, name: 'Doomed Vault' },
    });
    const personaId = await makePersona();
    // Source material: a rulebook with a chunk, an embedding and retained
    // PDF bytes — global rows, expensive to rebuild, not workspace output.
    const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'b.pdf' });
    const text = 'Grappling rules text.';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 12,
        pageEnd: 12,
        chunkType: 'section',
        headingPath: ['Chapter 1'],
        text,
        statBlock: null,
        contentHash: await sha256Hex(text),
      }),
    ]);
    const hash = await sha256Hex(text);
    await putEmbedding({ contentHash: hash, model: 'test-model', vector: [0.1, 0.2] });
    await putBookPdf({
      bookId: book.id,
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'b.pdf',
      mimeType: 'application/pdf',
    });
    // A published library entry with its own image: global rows (campaignId
    // null) must never be touched.
    const libraryNpc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Lib Goblin' });
    const libraryImage = await attachOneImage(libraryNpc.id, campaign.id);
    await publishToLibrary(libraryNpc.id);
    // The campaign's own cover: the row survives, so its pinned blob must too.
    const cover = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['cover'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    await updateCampaign(campaign.id, { coverImageId: cover.id });

    await deleteCampaignWorkspace(campaign.id);

    expect(await countChunksByBook(book.id)).toBe(1);
    expect(await getEmbedding(hash)).toBeDefined();
    expect(await getBookPdf(book.id)).toBeDefined();
    expect(await getAnyArtifact(libraryNpc.id)).toBeDefined();
    expect(await db.images.get(libraryImage)).toBeDefined();
    expect(await db.images.get(cover.id)).toBeDefined();
    expect((await getCampaign(campaign.id))?.coverImageId).toBe(cover.id);
    expect(await db.personas.get(personaId)).toBeDefined();
    expect((await db.settings.get('settings'))?.lastModule).toBeNull();
  });
});

describe('deleteCampaignWorkspace — durable module versions go with their modules', () => {
  it("sweeps every cleared module's version rows and leaves another campaign intact", async () => {
    const campaign = await addCampaign({ name: 'Undo', system: 'dnd5e' });
    const other = await addCampaign({ name: 'Neighbour', system: 'dnd5e' });
    const first = await makeModule(campaign.id, 'Ember Vault');
    const second = await makeModule(campaign.id, 'Second Vault');
    const kept = await makeModule(other.id, 'Kept Vault');
    await seedModuleVersion(first, 'Chat: one');
    await seedModuleVersion(first, 'Chat: two');
    await seedModuleVersion(second, 'Generate parts');
    await seedModuleVersion(kept, 'Chat: other campaign');

    await deleteCampaignWorkspace(campaign.id);

    // The cleared modules are gone and take their whole stack with them (the
    // Versions menu for them is gone too — nothing could ever read or prune
    // those rows again).
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
    const residue = await makeModule(campaign.id, 'Vault cleared by an older build');
    await seedModuleVersion(residue, 'Chat: orphaned');
    await seedModuleVersion(live, 'Chat: live');
    // The exact state a pre-sweep "Clear workspace" left behind: the module
    // row is gone (a bulk delete that predates the sweep), its version rows
    // stayed. A module-keyed sweep cannot reach these — the id IS what is
    // missing — so the orphan door has to.
    await db.modules.delete(residue);
    expect(await listOrphanedModuleVersions()).toEqual([residue]);

    await deleteCampaignWorkspace(campaign.id);

    expect(await listOrphanedModuleVersions()).toEqual([]);
    expect(await db.moduleVersions.count()).toBe(0);
  });
});

describe('deleteCampaignWorkspace — failure discipline', () => {
  it('a mid-clear failure rolls the whole clear back and rejects loudly', async () => {
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
        throw new Error('simulated clear failure');
      }
      await realDeleteArtifact(id);
    });

    await expect(deleteCampaignWorkspace(campaign.id)).rejects.toThrow(/simulated clear failure/);

    // Everything rolled back: modules, battles, runs, and ALL doomed
    // artifacts (including the ones whose delete "succeeded") with revisions.
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
    const campaign = await addCampaign({ name: 'Rollback', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    await seedModuleVersion(moduleId, 'Chat: pre-failure one');
    await seedModuleVersion(moduleId, 'Chat: pre-failure two');

    // The injected failure lands AFTER the version sweep and the module-row
    // delete: the settings read is this clear's next-to-last step (only the
    // image prune follows), and nothing else in the transaction reads
    // settings. Both being intact afterwards is therefore the transaction's
    // doing, never a sweep that simply never ran.
    const settingsSpy = vi
      .spyOn(db.settings, 'get')
      .mockRejectedValueOnce(new Error('simulated post-sweep failure'));

    await expect(deleteCampaignWorkspace(campaign.id)).rejects.toThrow(
      /simulated post-sweep failure/,
    );
    settingsSpy.mockRestore();

    expect(await db.modules.get(moduleId)).toBeDefined();
    expect(await countModuleVersions(moduleId)).toBe(2);
    expect(await listOrphanedModuleVersions()).toEqual([]);
  });

  it('throws NotFoundError for an unknown campaign instead of reporting a no-op', async () => {
    await expectNotFound(deleteCampaignWorkspace(newId()));
  });
});
