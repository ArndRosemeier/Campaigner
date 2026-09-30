import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { gameSystemSchema, type GameSystem } from '@/domain/gameSystem';

export const campaignSchema = z.object({
  ...BaseEntitySchema.shape,
  name: z.string().min(1),
  description: z.string(),
  system: gameSystemSchema,
  /** The campaign's cover image (picker card art), or null. Additive
   * `.default(null)` so rows written before covers parse at the read
   * boundary — NO Dexie version bump, NO index changes. */
  coverImageId: z.uuid().nullable().default(null),
});

export type Campaign = z.infer<typeof campaignSchema>;

/** Input for creating a new campaign; identity/timestamps are stamped by the factory. */
export interface NewCampaign {
  name: string;
  description?: string;
  system: GameSystem;
}
