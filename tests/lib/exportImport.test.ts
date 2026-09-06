import 'fake-indexeddb/auto';

import { unzipSync } from 'fflate';
import { strFromU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, listRevisions } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { updateArtifact } from '@/db/artifactRepo';
import { listCampaigns } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { newId } from '@/domain';
import {
  buildCampaignExport,
  buildExport,
  buildZip,
  exportFileName,
  importExport,
  importZip,
} from '@/lib/exportImport';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

/**
 * Export/import round-trip (06-MILESTONES M2): whole-campaign and selection
 * JSON, zip bundle, and re-id'd zod-validated import.
 */

beforeEach(clearDatabase);

describe('export/import', () => {
  it('round-trips a whole campaign through JSON with revisions intact', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grimm',
      tags: ['goblin'],
      summary: 'A goblin boss.',
      body: 'Original body.',
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
      },
    });
    await updateArtifact(artifact.id, { body: 'Edited body.' });

    const exported = await buildCampaignExport(campaign.id);
    expect(exported.campaign?.name).toBe('Emberfall');
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]?.revisions).toHaveLength(2);

    const json = JSON.parse(JSON.stringify(exported)) as unknown;
    const result = await importExport(json);
    expect(result.createdArtifacts).toBe(1);
    expect(result.campaignId).not.toBe(campaign.id);

    const campaigns = await listCampaigns();
    expect(campaigns).toHaveLength(2);
    const importedCampaign = campaigns.find((row) => row.id === result.campaignId);
    expect(importedCampaign?.name).toBe('Emberfall');

    const importedArtifacts = await db.artifacts
      .where('campaignId')
      .equals(result.campaignId)
      .toArray();
    const imported = importedArtifacts[0];
    expect(imported?.id).not.toBe(artifact.id);
    expect(imported?.body).toBe('Edited body.');
    expect(imported?.currentRevision).toBe(2);
    const revisions = await listRevisions(imported?.id ?? newId());
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.snapshot.body).sort()).toEqual([
      'Edited body.',
      'Original body.',
    ]);
  });

  it('exports only the selection when artifact ids are given', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const keep = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keep' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'Drop' });

    const exported = await buildCampaignExport(campaign.id, [keep.id]);
    expect(exported.artifacts).toHaveLength(1);
    expect(exported.artifacts[0]?.name).toBe('Keep');
    expect(exportFileName(exported)).toContain('emberfall');
  });

  it('builds a zip bundle containing a manifest and per-artifact files', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grimm' });
    const exported = await buildCampaignExport(campaign.id);
    const zip = buildZip(exported);
    const files = Object.keys(unzipSync(zip));
    expect(files).toContain('campaigner-export.json');
    expect(files.some((name) => name.startsWith('artifacts/npc/'))).toBe(true);

    const manifest = JSON.parse(
      strFromU8(unzipSync(zip)['campaigner-export.json'] ?? new Uint8Array()),
    ) as { format: string; artifacts: unknown[] };
    expect(manifest.format).toBe('campaigner-export');
    expect(manifest.artifacts).toHaveLength(1);
  });

  it('rejects invalid import payloads (missing format marker)', async () => {
    await expect(importExport({ artifacts: [] })).rejects.toThrow();
  });

  it('imports a single-artifact export as a fresh campaign', async () => {
    const artifact = await createArtifact({
      campaignId: newId(),
      kind: 'note',
      name: 'Loose note',
    });
    const exported = buildExport(null, [{ ...artifact, revisions: [] }]);
    const result = await importExport(JSON.parse(JSON.stringify(exported)));
    expect(result.createdArtifacts).toBe(1);
    const campaign = (await listCampaigns()).find((row) => row.id === result.campaignId);
    expect(campaign?.name).toBe('Imported campaign');
  });

  it('zip round-trips an image; plain JSON omits image binaries (M3-A)', async () => {
    const campaign = await createCampaign({ name: 'Imagery', system: 'generic-d20' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['fake-webp-bytes'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 120,
      height: 80,
      prompt: 'a tower',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Tower',
    });
    await updateArtifact(artifact.id, {
      imageIds: [image.id],
      coverImageId: image.id,
    });

    // Plain JSON: no images field at all.
    const plainExport = await buildCampaignExport(campaign.id);
    expect(plainExport.images).toBeUndefined();

    // Zip: images ride as binary files, JSON keeps metadata only.
    const zipExport = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(zipExport.images).toHaveLength(1);
    expect(zipExport.images?.[0]?.dataBase64).not.toBeNull();
    const zip = buildZip(zipExport);
    const files = unzipSync(zip);
    const imageFile = Object.keys(files).find((name) =>
      name.startsWith(`images/${image.id}.`),
    );
    expect(imageFile).toBe(`images/${image.id}.webp`);
    if (imageFile === undefined) throw new Error('image file missing from zip');
    expect(new TextDecoder().decode(files[imageFile])).toBe('fake-webp-bytes');
    // The zip manifest itself omits the inline payload.
    const manifest = JSON.parse(
      strFromU8(files['campaigner-export.json'] ?? new Uint8Array()),
    ) as { images?: { dataBase64: string | null }[] };
    expect(manifest.images?.[0]?.dataBase64).toBeNull();

    // Import the zip: the image comes back with its id preserved so the
    // imported artifact's imageIds/coverImageId references resolve.
    const result = await importZip(zip);
    const importedArtifacts = await db.artifacts
      .where('campaignId')
      .equals(result.campaignId)
      .toArray();
    expect(importedArtifacts[0]?.imageIds).toEqual([image.id]);
    expect(importedArtifacts[0]?.coverImageId).toBe(image.id);
    const restored = await getImage(image.id);
    expect(restored).toBeDefined();
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe(
      'fake-webp-bytes',
    );
    expect(restored?.mimeType).toBe('image/webp');
    expect(restored?.source).toBe('generated');
  });

  it('inline-image JSON import restores the blob from dataBase64', async () => {
    const campaign = await createCampaign({ name: 'Inline', system: 'generic-d20' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['inline-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 10,
      height: 10,
      source: 'uploaded',
    });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Note',
    });
    await updateArtifact(artifact.id, { imageIds: [image.id] });

    const exported = await buildCampaignExport(campaign.id, undefined, { images: true });
    expect(exported.images?.[0]?.dataBase64).not.toBeNull();
    const result = await importExport(JSON.parse(JSON.stringify(exported)));
    const restored = await getImage(image.id);
    expect(restored?.campaignId).toBe(result.campaignId);
    expect(new TextDecoder().decode(restored?.bytes ?? new Uint8Array())).toBe('inline-bytes');
  });
});

/**
 * Import atomicity (F9 remainder): the whole import — campaign row, images,
 * artifacts, revisions — is ONE rw transaction over the four touched tables
 * (the same contract as backup.ts's restore). A failure halfway through
 * (a revision row failing validation) must roll back everything, never
 * strand a half-imported campaign the picker would offer forever after.
 */
describe('importExport atomicity', () => {
  beforeEach(clearDatabase);

  it('rolls the whole import back when an artifact write fails mid-import', async () => {
    const campaign = await createCampaign({ name: 'Source', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'A' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'B' });
    const exported = await buildCampaignExport(campaign.id);
    const json = JSON.parse(JSON.stringify(exported)) as unknown;

    let addCalls = 0;
    const target = db as unknown as {
      artifacts: { add: (...args: unknown[]) => unknown };
    };
    const originalAdd = target.artifacts.add;
    target.artifacts.add = (...args: unknown[]) => {
      addCalls += 1;
      if (addCalls === 2) return Promise.reject(new Error('injected failure'));
      return originalAdd.apply(target.artifacts, args);
    };
    const revisionsBefore = await db.revisions.count();
    try {
      await expect(importExport(json)).rejects.toThrow('injected failure');
    } finally {
      target.artifacts.add = originalAdd;
    }

    // Nothing persisted: no campaign, no artifacts, and the revision count
    // is unchanged (the source artifacts' own revision-1 rows only).
    expect(await listCampaigns()).toHaveLength(1); // only the source campaign
    expect(await db.artifacts.where('campaignId').notEqual(campaign.id).count()).toBe(0);
    expect(await db.revisions.count()).toBe(revisionsBefore);
  });

  it('issues exactly one rw transaction over campaigns+images+artifacts+revisions', async () => {
    const campaign = await createCampaign({ name: 'Tx shape', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'note', name: 'N' });
    const exported = await buildCampaignExport(campaign.id);
    const json = JSON.parse(JSON.stringify(exported)) as unknown;

    const calls: unknown[][] = [];
    const original = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const target = db as unknown as {
      transaction: (...args: unknown[]) => unknown;
    };
    target.transaction = (...args: unknown[]) => {
      calls.push(args);
      return original(...args);
    };
    try {
      await importExport(json);
    } finally {
      target.transaction = original;
    }
    const importTxs = calls.filter(
      (args) =>
        args[0] === 'rw' &&
        Array.isArray(args[1]) &&
        (args[1] as { name: string }[]).some((table) => table.name === 'artifacts'),
    );
    expect(importTxs).toHaveLength(1);
    const importTx = importTxs[0];
    if (importTx === undefined) throw new Error('import transaction missing');
    const tables = (importTx[1] as { name: string }[]).map((table) => table.name);
    for (const name of ['campaigns', 'images', 'artifacts', 'revisions']) {
      expect(tables).toContain(name);
    }
  });
});
