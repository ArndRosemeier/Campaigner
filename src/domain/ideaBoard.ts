import { z } from 'zod';
import { BaseEntitySchema, stampNewEntity } from '@/domain/entity';

export const ideaBoardMessageSchema = BaseEntitySchema.pick({ id: true, createdAt: true }).extend({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1),
  modelUsed: z.string().min(1).nullable(),
});
export type IdeaBoardMessage = z.infer<typeof ideaBoardMessageSchema>;
export const ideaBoardVersionSchema = BaseEntitySchema.pick({ id: true, createdAt: true }).extend({
  document: z.string(),
  modelUsed: z.string().min(1).nullable(),
});
export const ideaBoardReplySchema = z.object({
  reply: z.string().min(1),
  document: z.string().min(1).nullable(),
});
export const ideaBoardSchema = BaseEntitySchema.extend({
  document: z.string(),
  messages: z.array(ideaBoardMessageSchema).default([]),
  versions: z.array(ideaBoardVersionSchema).default([]),
  model: z.string().default(''),
  modelUsed: z.string().min(1).nullable().default(null),
});
export type IdeaBoard = z.infer<typeof ideaBoardSchema>;
/** The fields a draft edit may carry (identity and timestamps are never patched). */
export type IdeaBoardPatch = Partial<
  Pick<IdeaBoard, 'document' | 'messages' | 'versions' | 'model' | 'modelUsed'>
>;
export function newIdeaBoard(now = Date.now()): IdeaBoard {
  return ideaBoardSchema.parse({ ...stampNewEntity(now), document: '', messages: [] });
}
/** One global board; corrupt multi-row restores are refused before any wipe. */
export function parseIdeaBoards(rows: unknown[]): IdeaBoard[] {
  if (rows.length > 1) throw new Error('Idea Board contains multiple boards; restore a backup with at most one board.');
  return rows.map((row) => ideaBoardSchema.parse(row));
}
