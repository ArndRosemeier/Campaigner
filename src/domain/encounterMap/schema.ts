import { z } from 'zod';

export const encounterMapAspectSchema = z.enum(['4:3', '16:9', '1:1']);
export type EncounterMapAspect = z.infer<typeof encounterMapAspectSchema>;

export const encounterRoomSizeSchema = z.enum(['small', 'medium', 'large']);
export type EncounterRoomSize = z.infer<typeof encounterRoomSizeSchema>;

export const layoutRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type LayoutRect = z.infer<typeof layoutRectSchema>;

export const encounterMapRoomBriefSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string(),
  size: encounterRoomSizeSchema,
  monsterIndexes: z.array(z.number().int().nonnegative()),
  adjacentRoomIds: z.array(z.uuid()),
});
export type EncounterMapRoomBrief = z.infer<typeof encounterMapRoomBriefSchema>;

export const encounterMapBriefSchema = z.object({
  theme: z.string(),
  aspect: encounterMapAspectSchema,
  entryRoomId: z.uuid(),
  rosterCounts: z.array(z.number().int().positive()),
  rooms: z.array(encounterMapRoomBriefSchema).min(1).max(9),
});
export type EncounterMapBrief = z.infer<typeof encounterMapBriefSchema>;

export const layoutRoomSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  rects: z.array(layoutRectSchema).min(1).max(3),
  mobsRect: layoutRectSchema,
  description: z.string(),
  monsterIndexes: z.array(z.number().int().nonnegative()),
  spawn: z.boolean(),
});
export type LayoutRoom = z.infer<typeof layoutRoomSchema>;

export const layoutCorridorSchema = z.object({
  a: z.uuid(),
  b: z.uuid(),
  rects: z.array(layoutRectSchema).min(1),
});
export type LayoutCorridor = z.infer<typeof layoutCorridorSchema>;

export const encounterLayoutSchema = z.object({
  gridW: z.number().int().min(12).max(40),
  gridH: z.number().int().min(12).max(40),
  theme: z.string(),
  rooms: z.array(layoutRoomSchema).min(1).max(9),
  corridors: z.array(layoutCorridorSchema),
});
export type EncounterLayout = z.infer<typeof encounterLayoutSchema>;

export interface MonsterPlacement {
  roomId: string;
  monsterIndex: number;
  instanceIndex: number;
  /** Grid-cell center, normalized to the layout dimensions. */
  x: number;
  y: number;
}
