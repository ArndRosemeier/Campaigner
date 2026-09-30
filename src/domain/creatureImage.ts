import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * The PRESENTATION TIER (owner-ratified core-mob arc, docs/11 D5 amendment):
 * per-campaign portraits for creatures that are CITED but NOT OWNED — an
 * encounter's generic zombie, a battle token, a prose mention.
 *
 * A creature is not an artifact (docs/18 §4), so its portrait has nowhere of
 * its own to live. This table is where the campaign's copy of that portrait
 * lives: ONE row per campaign per creature identity, pointing at ONE
 * campaign-scoped `images` blob (the cover the board renders). The bytes are
 * CLONED from the global canonical slot (`mobPortraits`, keyed by the same
 * identity) through the ONE cover-clone mechanism — the library's own art is
 * never attached, so a campaign's edits and deletes can never touch it.
 *
 * Identity, never an id (docs/11 D6): the key is `domain/creature`'s
 * `CreatureIdentity.key` — a library creature's chunk, or an invented mob's
 * content hash. One creature, one look: a creature cited by six encounters has
 * ONE row here, and nothing has to exist in the artifact tables for it to.
 */
export const creatureImageSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  /** `CreatureIdentity.key` — the ONE portrait key (see `domain/creature`). */
  creatureKey: z.string().min(1),
  /** The campaign-scoped image row the board and the panels render. */
  imageId: z.uuid(),
});

export type CreatureImage = z.infer<typeof creatureImageSchema>;
