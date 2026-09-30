import { createImage } from '@/db/imageRepo';
import { newId, packRooms, type EncounterLayout, type Id } from '@/domain';

/**
 * The shared BATTLE MAP fixtures (docs/17 row 328): a map-role image and a
 * single-arena layout, used by BOTH the db-level pins
 * (`tests/db/battleRepo.test.ts`) and the battle-surface pins
 * (`tests/features/battle-surface.test.tsx`). ONE copy lives here — the
 * test-tree duplication tripwire (`no-duplicate-implementations`) reds a second
 * spelling, which is exactly how these two copies were caught.
 */

/** A stored `role: 'map'` image — what the encounter's single map slot names. */
export async function createMapImage(campaignId: Id, seed: number): Promise<Id> {
  const image = await createImage({
    campaignId,
    blob: new Blob([new Uint8Array([seed])], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 100,
    height: 80,
    source: 'uploaded',
    role: 'map',
  });
  return image.id;
}

/**
 * A one-room arena layout at the given aspect. The ASPECT is the point: it
 * changes `gridW`/`gridH`, so a test can prove a board's `mapLayout` really
 * moved rather than merely being re-stamped with the same numbers.
 */
export function adoptionArenaLayout(aspect: '4:3' | '16:9' | '1:1'): EncounterLayout {
  const room = newId();
  return packRooms({
    theme: 'Adoption arena',
    aspect,
    entryRoomId: room,
    rosterCounts: [1],
    rooms: [
      {
        id: room,
        name: 'Arena',
        description: '',
        size: 'medium',
        monsterIndexes: [0],
        adjacentRoomIds: [],
        key: '',
        keyTreasure: '',
      },
    ],
  });
}
