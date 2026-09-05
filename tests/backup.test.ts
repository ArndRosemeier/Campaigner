import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { createModule } from '@/db/moduleRepo';
import { createModule as buildModule } from '@/domain';
import { db } from '@/db/db';
import { getSettings, updateSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { backupFileName, buildBackup, importBackup } from '@/lib/backup';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { unzipSync, zipSync } from 'fflate';
import { clearDatabase } from './db/helpers';

/**
 * Full-app backup (M4-C): buildBackup zips every table (API key excluded),
 * importBackup replaces the database while preserving the LOCAL key.
 */

beforeEach(async () => {
  await clearDatabase();
});

describe('app backup', () => {
  it('round-trips the entire database as a zip', async () => {
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Kael',
      body: '# Kael',
    });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    await updateSettings({ openRouterApiKey: 'sk-local-key' });
    const module = await createModule(
      buildModule({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: 'A flooded vault beneath a watchtower.',
        levelMin: 1,
        levelMax: 3,
        tone: '',
        sizeDial: 'standard',
      }),
    );

    const { bytes } = await buildBackup();

    // Wipe everything, then restore from the backup.
    await clearDatabase();
    const result = await importBackup(bytes);

    const artifacts = await db.artifacts.toArray();
    const restoredArtifact = artifacts.find((row) => row.name === 'Kael');
    expect(restoredArtifact?.body).toBe('# Kael');
    expect((await db.campaigns.toArray()).some((row) => row.name === 'Ember')).toBe(true);
    expect((await db.modules.toArray()).some((row) => row.title === 'The Drowned Vault')).toBe(
      true,
    );
    expect(await db.personas.count()).toBeGreaterThan(0);

    // The image binary rides the zip and comes back byte-identical.
    const restoredImage = await db.images.get(image.id);
    expect(restoredImage?.bytes.byteLength).toBe(image.bytes.byteLength);
    expect(Array.from(restoredImage?.bytes ?? [])).toEqual(Array.from(image.bytes));

    // The restored settings carry NO API key from the file.
    const settings = await getSettings();
    expect(settings.openRouterApiKey).toBe('');
    void module;

    expect(result.totalRows).toBeGreaterThan(0);
    expect(restoredArtifact?.id).toBe(artifact.id); // ids are preserved wholesale
  });

  it('never exports the API key and preserves the local key on restore', async () => {
    await updateSettings({
      openRouterApiKey: 'sk-secret-local',
      defaultChatModel: 'test/model',
    });

    const { bytes } = await buildBackup();
    const entries = unzipSync(bytes);
    const manifestText = new TextDecoder().decode(entries['campaigner-backup.json'] ?? new Uint8Array());
    expect(manifestText).not.toContain('sk-secret-local');
    expect(manifestText).toContain('campaigner-backup');

    // A different machine restores: its own key survives, the file's (empty)
    // key does not clobber it.
    await clearDatabase();
    await updateSettings({ openRouterApiKey: 'sk-other-machine' });
    await importBackup(bytes);
    const settings = await getSettings();
    expect(settings.openRouterApiKey).toBe('sk-other-machine');
    expect(settings.defaultChatModel).toBe('test/model');
  });

  it('fails loudly on a foreign zip and on a backup missing image binaries', async () => {
    await expect(importBackup(new TextEncoder().encode('not a zip'))).rejects.toThrow();

    await seedBuiltInPersonas();
    await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createImage({
      campaignId: (await db.campaigns.toArray())[0]?.id ?? '',
      blob: new Blob(['x'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      source: 'uploaded',
    });
    const { bytes } = await buildBackup();
    // Strip the image binary from the zip: the manifest still references it.
    const entries = unzipSync(bytes);
    const stripped: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(entries)) {
      if (path.startsWith('images/')) continue;
      stripped[path] = content;
    }
    await expect(importBackup(zipSync(stripped))).rejects.toThrow(/missing the binary/);
  });

  it('round-trips a pack rulebook with origin, packMeta and fetch provenance unchanged', async () => {
    const book = await createPackBook({ title: 'PF2e Bestiary', system: 'pathfinder2e', filename: 'bestiary.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 7,
      entriesSkipped: 1,
      entriesFailed: 0,
      // 16-BESTIARY-FETCH §7: fetched books carry provenance; the §1.1
      // amendment adds the additive attempt trail.
      sourceRef: 'v14-dev',
      sourceUrl: 'https://github.com/foundryvtt/pf2e/tree/v14-dev/packs/pf2e/npc-gallery',
      fetchedAt: 1757100000000,
      attemptedRefs: ['HEAD', 'v14-dev'],
    });

    const { bytes } = await buildBackup();
    await clearDatabase();
    await importBackup(bytes);

    const restored = await db.rulebooks.get(book.id);
    expect(restored?.origin).toBe('pack');
    expect(restored?.status).toBe('ready');
    expect(restored?.packMeta).toEqual({
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 7,
      entriesSkipped: 1,
      entriesFailed: 0,
      sourceRef: 'v14-dev',
      sourceUrl: 'https://github.com/foundryvtt/pf2e/tree/v14-dev/packs/pf2e/npc-gallery',
      fetchedAt: 1757100000000,
      attemptedRefs: ['HEAD', 'v14-dev'],
    });
  });

  it('still restores pre-provenance pack rows (additive packMeta fields, no migration)', async () => {
    const book = await createPackBook({ title: 'Old Pack', system: 'dnd5e', filename: 'srd.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-dnd5e-srd',
      license: 'SRD 5.2, CC-BY-4.0',
      entriesImported: 3,
      entriesSkipped: 0,
      entriesFailed: 0,
    });

    const { bytes } = await buildBackup();
    await clearDatabase();
    await importBackup(bytes);

    const restored = await db.rulebooks.get(book.id);
    expect(restored?.packMeta).toEqual({
      sourceId: 'foundry-dnd5e-srd',
      license: 'SRD 5.2, CC-BY-4.0',
      entriesImported: 3,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    expect(restored?.packMeta?.sourceRef).toBeUndefined();
    expect(restored?.packMeta?.fetchedAt).toBeUndefined();
  });

  it('names the file after the export date', () => {
    expect(backupFileName(Date.UTC(2026, 1, 3))).toBe('campaigner-backup-2026-02-03.zip');
  });
});
