import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Global creature portrait cache (docs/11 D5 amendment, slice A; re-keyed on
 * creature IDENTITY by the owner-ratified core-mob arc, docs/11 D6): ONE
 * canonical portrait per creature, generated once and reused across all
 * campaigns/modules. The key is `CreatureIdentity.key` (`domain/creature`) —
 * a library creature's cited chunk, or an invented mob's content hash — so a
 * creature with no artifact at all still has exactly one canonical look.
 *
 * The row is a SHARED-BLOB POINTER: `imageId` names ONE `images` row stored
 * at global scope (`campaignId: null`). The cached blob is NEVER-DELETED
 * while the cache record exists — explicitly immune to campaign
 * `pruneUnreferencedImages` and the global `deleteImageIfUnreferenced` path
 * (see imageRepo). Renders CLONE the bytes into per-campaign presentation rows
 * (`creatureImages`) and artifact covers; the cached row itself is never
 * attached to anything.
 *
 * CANONICAL-ONLY (binding, owner-raised flavor problem): the cache holds
 * portraits grounded on the creature's library text + the creature's canonical
 * name (the last non-empty `headingPath` element) — never roster/artifact
 * flavor. It is written ONLY by canonical generations (the citing entry used
 * the canonical name, case-insensitive); a flavored citation gets its local
 * flavored portrait and nothing else — no write, no overwrite, no
 * behind-the-back canonical generation.
 */
export const mobPortraitCacheSchema = z.object({
  ...BaseEntitySchema.shape,
  /**
   * `CreatureIdentity.key` — the ONLY key (unique `&creatureKey` index), and
   * deliberately NOT a uuid: an invented mob's identity is a content hash over
   * its name and stat block, so no part of the key is an id something could
   * cite or delete.
   */
  creatureKey: z.string().min(1),
  /** The global-scope shared-blob image row (`campaignId: null`). */
  imageId: z.uuid(),
});

export type MobPortraitCacheEntry = z.infer<typeof mobPortraitCacheSchema>;
