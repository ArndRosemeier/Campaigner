import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage, deleteImage } from '@/db/imageRepo';
import { imageBlob } from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * Smoke test (07-MILESTONE-3 M3-A): fake-indexeddb must round-trip Blob
 * values — the whole images table depends on it. If this fails, image blobs
 * can't be stored under the test harness (real IndexedDB clones Blobs fine).
 */
describe('images table blob round-trip', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('stores and returns bytes + mime type unchanged', async () => {
    const campaign = await createCampaign({ name: 'Images', system: 'generic-d20' });
    const original = new Blob(['\x89PNG fake bytes'], { type: 'image/png' });
    const stored = await createImage({
      campaignId: campaign.id,
      blob: original,
      mimeType: 'image/png',
      width: 32,
      height: 64,
      source: 'uploaded',
    });

    expect(stored.mimeType).toBe('image/png');
    expect(stored.width).toBe(32);
    expect(stored.height).toBe(64);
    expect(stored.source).toBe('uploaded');
    expect(stored.prompt).toBe('');
    expect(stored.model).toBe('');

    const loaded = await getImage(stored.id);
    if (loaded === undefined) throw new Error('stored image not found');
    // Note: fake-indexeddb's structured clone yields a cross-realm
    // Uint8Array, so instanceof is not reliable here — content equality is
    // what matters (real IndexedDB round-trips Uint8Array natively).
    expect(loaded.bytes.constructor.name).toBe('Uint8Array');
    expect(new TextDecoder().decode(loaded.bytes)).toBe('\x89PNG fake bytes');
    expect(loaded.mimeType).toBe('image/png');

    // imageBlob rebuilds a displayable Blob from the stored bytes.
    const blob = imageBlob(loaded);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('\x89PNG fake bytes');

    await deleteImage(stored.id);
    expect(await getImage(stored.id)).toBeUndefined();
  });

  it('keeps generated metadata alongside the blob', async () => {
    const campaign = await createCampaign({ name: 'Gen', system: 'generic-d20' });
    const stored = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['webp'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 800,
      height: 600,
      prompt: 'a lighthouse',
      model: 'google/gemini-2.5-flash-image',
      source: 'generated',
    });
    const loaded = await getImage(stored.id);
    expect(loaded?.prompt).toBe('a lighthouse');
    expect(loaded?.model).toBe('google/gemini-2.5-flash-image');
    expect(loaded?.source).toBe('generated');
  });
});
