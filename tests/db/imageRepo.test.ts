import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage, deleteImage, setImageFavourited } from '@/db/imageRepo';
import { db } from '@/db/db';
import { imageBlob, isImageFavourite, sortGalleryImages, storedImageSchema } from '@/domain';
import type { StoredImage } from '@/domain';
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

/**
 * Gallery favourites (owner request, docs/17 row 366): ONE additive nullable
 * timestamp on the image row carries BOTH the flag and the order — non-null
 * means favourited, the VALUE orders the favourites newest-first — and the
 * sort is the whole feature. Nothing here picks, deletes, prints or caches.
 */
describe('gallery favourites are ONE nullable timestamp (docs/17 row 366)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  /** Three stored rows in the gallery's own order (the artifact's imageIds). */
  async function seedThreeRows(): Promise<[StoredImage, StoredImage, StoredImage]> {
    const campaign = await createCampaign({ name: 'Favourite gallery', system: 'generic-d20' });
    const rows: StoredImage[] = [];
    for (const width of [11, 22, 33]) {
      rows.push(
        await createImage({
          campaignId: campaign.id,
          blob: new Blob([`bytes-${String(width)}`], { type: 'image/webp' }),
          mimeType: 'image/webp',
          width,
          height: 40,
          source: 'uploaded',
        }),
      );
    }
    const [first, second, third] = rows;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('seedThreeRows must create three image rows');
    }
    return [first, second, third];
  }

  it('is ADDITIVE: a row written before the field parses and reads as a non-favourite', async () => {
    const [first] = await seedThreeRows();
    // A pre-change row carries NO key at all — not a null one.
    const beforeField: Record<string, unknown> = { ...first };
    delete beforeField.favouritedAt;

    // …parses, and a missing key answers `undefined` — the nullish shape the
    // ONE favourite reading treats as "not a favourite".
    expect(storedImageSchema.parse(beforeField).favouritedAt).toBeUndefined();

    // …and a raw Dexie read of that stored row stays keyless, which the ONE
    // favourite reading treats as "not a favourite" (never an error).
    await db.images.put(beforeField as unknown as StoredImage);
    const loaded = await getImage(first.id);
    if (loaded === undefined) throw new Error('the pre-change image row must still read');
    expect('favouritedAt' in loaded).toBe(false);
    expect(isImageFavourite(loaded)).toBe(false);
  });

  it("with NOTHING favourited the order is exactly today's — and the non-favourites are never re-sorted", async () => {
    const [first, second, third] = await seedThreeRows();

    // The strongest pin of the slice: flag off, the gallery's order is the
    // input order, unchanged.
    expect(sortGalleryImages([first, second, third]).map((row) => row.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    // Favouriting the LAST row lifts it above the two it followed, and the
    // other two keep their own relative order.
    expect(
      sortGalleryImages([first, second, { ...third, favouritedAt: 1_000 }]).map((row) => row.id),
    ).toEqual([third.id, first.id, second.id]);
  });

  it('among favourites a NEWER favourite sorts above an EARLIER one', async () => {
    const [first, second, third] = await seedThreeRows();
    const earlier = { ...first, favouritedAt: 1_000 };
    const newer = { ...second, favouritedAt: 2_000 };

    expect(sortGalleryImages([earlier, newer, third]).map((row) => row.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);
    // Swap the two stamps and the two favourites swap with them — the VALUE is
    // the order, not the position in the gallery.
    expect(
      sortGalleryImages([{ ...first, favouritedAt: 2_000 }, { ...second, favouritedAt: 1_000 }, third]).map(
        (row) => row.id,
      ),
    ).toEqual([first.id, second.id, third.id]);
  });

  it('un-favouriting puts the image back where it was — non-favourites keep their order', async () => {
    const [first, second, third] = await seedThreeRows();
    const favourited = { ...third, favouritedAt: 5_000 };

    expect(sortGalleryImages([first, second, favourited]).map((row) => row.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
    expect(sortGalleryImages([first, second, third]).map((row) => row.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it('setImageFavourited stamps NOW once and clears back to null, through the repo seam', async () => {
    const [first] = await seedThreeRows();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    try {
      await setImageFavourited(first.id, true);
      expect((await getImage(first.id))?.favouritedAt).toBe(1_700_000_000_123);
      await setImageFavourited(first.id, false);
      expect((await getImage(first.id))?.favouritedAt).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });
});
