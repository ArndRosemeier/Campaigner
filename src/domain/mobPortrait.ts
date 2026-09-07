import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Global mob portrait cache (docs/11 D5 amendment, slice A): ONE canonical
 * portrait per rulebook stat-block chunk, generated once and reused across
 * all campaigns/modules. Key = chunkId only (cross-book duplicates stay
 * separate naturally — different chunks, different slots).
 *
 * The row is a SHARED-BLOB POINTER: `imageId` names ONE `images` row stored
 * at global scope (`campaignId: null`). The cached blob is NEVER-DELETED
 * while the cache record exists — explicitly immune to campaign
 * `pruneUnreferencedImages` and the global `deleteImageIfUnreferenced` path
 * (see imageRepo). Renders CLONE the bytes into per-artifact campaign-scoped
 * covers; the cached row itself is never attached to an artifact.
 *
 * CANONICAL-ONLY (binding, owner-raised flavor problem): the cache holds
 * portraits grounded on the chunk's text + the chunk's canonical creature
 * name (last `headingPath` element) — never roster/artifact flavor. It is
 * written ONLY by canonical generations (the citing entry used the canonical
 * name, case-insensitive); a flavored citation gets its local flavored cover
 * and nothing else — no write, no overwrite, no behind-the-back canonical
 * generation. A chunk cited only ever flavored keeps an empty slot and
 * per-campaign behavior is unchanged.
 */
export const mobPortraitCacheSchema = z.object({
  ...BaseEntitySchema.shape,
  /** The cited stat-block chunk — the ONLY key (unique `&chunkId` index). */
  chunkId: z.uuid(),
  /** The global-scope shared-blob image row (`campaignId: null`). */
  imageId: z.uuid(),
});

export type MobPortraitCacheEntry = z.infer<typeof mobPortraitCacheSchema>;
