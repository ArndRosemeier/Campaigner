import { z } from 'zod';

import { BaseEntitySchema, type Id } from '@/domain/entity';

/**
 * Module PDF deliverable (07-MILESTONE-3 M3-D): a publishable adventure-module
 * PDF built from an explicit, user-curated outline — never derived implicitly
 * from the artifact tree. Node set mirrors a commercial module's skeleton:
 * chapter (Kapitel, page-break banner), part (Teil, group header), artifact
 * nodes with per-facet include toggles, interstitial text, and auto-generated
 * back matter galleries (NPC gallery / treasure ledger).
 */

export const deliverableAudienceSchema = z.enum(['gm', 'player']);

export type DeliverableAudience = z.infer<typeof deliverableAudienceSchema>;

export const artifactIncludeSchema = z.object({
  body: z.boolean(),
  data: z.boolean(),
  statBlocks: z.boolean(),
  images: z.boolean(),
});

export type ArtifactInclude = z.infer<typeof artifactIncludeSchema>;

export const outlineNodeSchema: z.ZodType<OutlineNode> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chapter'),
    title: z.string(),
    children: z.array(z.lazy(() => outlineNodeSchema)),
  }),
  z.object({
    type: z.literal('part'),
    title: z.string(),
    children: z.array(z.lazy(() => outlineNodeSchema)),
  }),
  z.object({
    type: z.literal('artifact'),
    artifactId: z.uuid(),
    include: artifactIncludeSchema,
  }),
  z.object({ type: z.literal('text'), markdown: z.string() }),
  z.object({ type: z.literal('gallery'), gallery: z.enum(['npcs', 'treasure']) }),
]);

export type OutlineNode =
  | { type: 'chapter'; title: string; children: OutlineNode[] }
  | { type: 'part'; title: string; children: OutlineNode[] }
  | { type: 'artifact'; artifactId: Id; include: ArtifactInclude }
  | { type: 'text'; markdown: string }
  | { type: 'gallery'; gallery: 'npcs' | 'treasure' };

export const deliverableSchema = z.object({
  ...BaseEntitySchema.shape,
  campaignId: z.uuid(),
  title: z.string().min(1),
  subtitle: z.string(),
  /** player: secrets / GM-only nodes / tactics+treasure stripped at render. */
  audience: deliverableAudienceSchema,
  coverImageId: z.uuid().nullable(),
  outline: z.array(outlineNodeSchema),
});

export type Deliverable = z.infer<typeof deliverableSchema>;

export type NewDeliverable = Omit<Deliverable, 'id' | 'createdAt' | 'updatedAt'>;

export const FULL_INCLUDE: ArtifactInclude = {
  body: true,
  data: true,
  statBlocks: true,
  images: true,
};

/** Empty default for artifact nodes created in the outline editor. */
export function fullInclude(): ArtifactInclude {
  return { ...FULL_INCLUDE };
}
