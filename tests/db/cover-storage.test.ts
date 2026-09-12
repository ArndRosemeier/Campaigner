import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/db';
import { createArtifact, deleteArtifact } from '@/db/artifactRepo';
import { createCampaign, deleteCampaign, getCampaign } from '@/db/campaignRepo';
import { getImage } from '@/db/imageRepo';
import { createModule as saveModuleRow, deleteModule, getModule } from '@/db/moduleRepo';
import { buildCampaignExport, importExport } from '@/lib/exportImport';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { createModule, newId, type Id } from '@/domain';
import { clearDatabase } from './helpers';

/**
 * Cover storage honesty (cover-generation arc): covers are image rows owned
 * by their campaign — pinned by the reference scans (never GC'd), freed by
 * the delete cascades, carried by export/import, and borrowed by the module
 * PDF cover page.
 */

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

async function seedCover(campaignId: Id, text: string): Promise<Id> {
  const { createImage } = await import('@/db/imageRepo');
  const image = await createImage({
    campaignId,
    blob: blobOf(text),
    mimeType: 'image/png',
    width: 10,
    height: 10,
    prompt: '',
    model: '',
    source: 'generated',
  });
  return image.id;
}

beforeEach(async () => {
  await clearDatabase();
});

describe('cover storage honesty', () => {
  it('legacy rows without coverImageId parse to null at the read boundary (no Dexie bump)', async () => {
    const campaignId = newId();
    const moduleId = newId();
    // Raw puts bypass the factories: pre-cover rows carry no field at all.
    await db.campaigns.put({
      id: campaignId,
      name: 'Legacy',
      description: '',
      system: 'dnd5e',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    await db.modules.put({
      id: moduleId,
      campaignId,
      title: 'Legacy module',
      concept: '',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'sketch',
      spine: null,
      parts: [],
      status: 'draft',
      errorMessage: '',
      createdAt: 1,
      updatedAt: 1,
    } as never);

    expect((await getCampaign(campaignId))?.coverImageId).toBeNull();
    expect((await getModule(moduleId))?.coverImageId).toBeNull();
    // The schemas validate the legacy rows (golden-test pattern).
    const { campaignSchema, moduleSchema } = await import('@/domain');
    expect(campaignSchema.parse(await db.campaigns.get(campaignId)).coverImageId).toBeNull();
    expect(moduleSchema.parse(await db.modules.get(moduleId)).coverImageId).toBeNull();
  });

  it('artifact cascades prune gallery blobs but never covers', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = (
      await saveModuleRow(
        createModule({
          campaignId: campaign.id,
          title: 'Vault',
          concept: 'A vault.',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      )
    ).id;
    const { patchModule } = await import('@/db/moduleRepo');
    const { updateCampaign } = await import('@/db/campaignRepo');
    const moduleCover = await seedCover(campaign.id, 'module-cover');
    const campaignCover = await seedCover(campaign.id, 'campaign-cover');
    await patchModule(moduleId, { coverImageId: moduleCover });
    await updateCampaign(campaign.id, { coverImageId: campaignCover });

    const artifact = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Kael' });
    const gallery = await seedCover(campaign.id, 'gallery');
    const { updateArtifact } = await import('@/db/artifactRepo');
    await updateArtifact(artifact.id, { imageIds: [gallery] });

    await deleteArtifact(artifact.id);

    // The gallery blob is freed; both covers survive the prune.
    expect(await getImage(gallery)).toBeUndefined();
    expect(await getImage(moduleCover)).toBeDefined();
    expect(await getImage(campaignCover)).toBeDefined();
  });

  it('deleteModule frees the module cover in every branch', async () => {
    for (const branch of ['cascade', 'keep', 'promote-referenced'] as const) {
      const campaign = await createCampaign({ name: `Ember ${branch}`, system: 'dnd5e' });
      const moduleId = (
        await saveModuleRow(
          createModule({
            campaignId: campaign.id,
            title: 'Vault',
            concept: 'A vault.',
            levelMin: 1,
            levelMax: 1,
            sizeDial: 'sketch',
          }),
        )
      ).id;
      const cover = await seedCover(campaign.id, `cover-${branch}`);
      const { patchModule } = await import('@/db/moduleRepo');
      await patchModule(moduleId, { coverImageId: cover });

      await deleteModule(moduleId, branch);

      expect(await getModule(moduleId)).toBeUndefined();
      expect(await getImage(cover)).toBeUndefined();
    }
  });

  it('deleteCampaign frees module and campaign covers with the image sweep', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = (
      await saveModuleRow(
        createModule({
          campaignId: campaign.id,
          title: 'Vault',
          concept: 'A vault.',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      )
    ).id;
    const { patchModule } = await import('@/db/moduleRepo');
    const { updateCampaign } = await import('@/db/campaignRepo');
    const moduleCover = await seedCover(campaign.id, 'module-cover');
    const campaignCover = await seedCover(campaign.id, 'campaign-cover');
    await patchModule(moduleId, { coverImageId: moduleCover });
    await updateCampaign(campaign.id, { coverImageId: campaignCover });

    await deleteCampaign(campaign.id);

    expect(await getImage(moduleCover)).toBeUndefined();
    expect(await getImage(campaignCover)).toBeUndefined();
  });

  it('export/import round trip keeps both covers with their binaries', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = (
      await saveModuleRow(
        createModule({
          campaignId: campaign.id,
          title: 'Vault',
          concept: 'A vault.',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      )
    ).id;
    const { patchModule } = await import('@/db/moduleRepo');
    const { updateCampaign } = await import('@/db/campaignRepo');
    const moduleCover = await seedCover(campaign.id, 'module-bytes');
    const campaignCover = await seedCover(campaign.id, 'campaign-bytes');
    await patchModule(moduleId, { coverImageId: moduleCover });
    await updateCampaign(campaign.id, { coverImageId: campaignCover });

    const exported = await buildCampaignExport(campaign.id, undefined, { images: true });
    // Both slots pin their binaries in the export (never silently dropped).
    expect(exported.images?.map((image) => image.id)).toEqual(
      expect.arrayContaining([moduleCover, campaignCover]),
    );
    expect(exported.missingImages ?? []).toEqual([]);

    await clearDatabase();
    const result = await importExport(exported);
    const { listCampaigns } = await import('@/db/campaignRepo');
    const campaigns = await listCampaigns();
    expect(campaigns).toHaveLength(1);
    expect(result.campaignId).toBe(campaigns[0]?.id);
    const importedCampaign = await getCampaign(result.campaignId);
    expect(importedCampaign?.coverImageId).toBe(campaignCover);
    expect((await getImage(importedCampaign?.coverImageId ?? ''))?.campaignId).toBe(
      result.campaignId,
    );
    const { listModulesByCampaign } = await import('@/db/moduleRepo');
    const modules = await listModulesByCampaign(result.campaignId);
    expect(modules).toHaveLength(1);
    expect(modules[0]?.coverImageId).toBe(moduleCover);
    expect(await getImage(modules[0]?.coverImageId ?? '')).toBeDefined();
  });

  it('a cover referenced by nothing but its slot is reported loud, never dropped', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const { updateCampaign } = await import('@/db/campaignRepo');
    // The slot points at a blob that is gone (hand-deleted outside the seam).
    const ghost = newId();
    await updateCampaign(campaign.id, { coverImageId: ghost });

    const exported = await buildCampaignExport(campaign.id);
    // The reference survives on the loud missing-binary note with its referrer.
    expect(exported.missingImages).toEqual([
      { id: ghost, referencedBy: [`campaign:${campaign.id}:cover`] },
    ]);
  });

  it('the module PDF cover page prints the module cover — the module is the document now', () => {
    // The deliverable-carried cover and its `fallbackCoverImageId` are gone
    // with the deliverables concept (docs/17 row 108): the module's OWN
    // `coverImageId` is the one cover slot the module PDF reads.
    const base = createModule({
      campaignId: newId(),
      title: 'Vault PDF',
      concept: 'A module',
      levelMin: 1,
      levelMax: 1,
      sizeDial: 'sketch',
    });
    const moduleArt = 'data:image/jpeg;base64,bW9kdWxl';
    const ownId = newId();

    // No cover: no image on the cover page, and the cover says so loudly.
    expect(JSON.stringify(buildModuleDefinition({ module: base, artifacts: [] }))).not.toContain(
      'image/jpeg',
    );
    // The module's own cover lands on the cover page.
    const withOwn = buildModuleDefinition({
      module: { ...base, coverImageId: ownId },
      artifacts: [],
      images: { dataUrls: { [ownId]: moduleArt }, failures: [] },
    });
    expect(JSON.stringify(withOwn)).toContain(moduleArt);
  });
});
