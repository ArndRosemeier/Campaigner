import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { gameSystemSchema } from '@/domain/gameSystem';
import { statBlockSchema } from '@/domain/statblock';

export const rulebookStatusSchema = z.enum(['processing', 'ready', 'error']);

export type RulebookStatus = z.infer<typeof rulebookStatusSchema>;

export const rulebookSchema = z.object({
  ...BaseEntitySchema.shape,
  /** User-editable; defaults to the PDF filename. */
  title: z.string().min(1),
  system: gameSystemSchema,
  filename: z.string(),
  pageCount: z.number().int().nonnegative(),
  status: rulebookStatusSchema,
  errorMessage: z.string(),
  // The original PDF bytes are NOT stored (size); only extracted content.
});

export type Rulebook = z.infer<typeof rulebookSchema>;

export const chunkTypeSchema = z.enum(['section', 'statblock', 'table']);

export type ChunkType = z.infer<typeof chunkTypeSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 hex digest');

export const ruleChunkSchema = z.object({
  ...BaseEntitySchema.shape,
  bookId: z.uuid(),
  /** 1-based inclusive page range. */
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  chunkType: chunkTypeSchema,
  /** e.g. ['Chapter 9: Combat', 'Grappling']. */
  headingPath: z.array(z.string()),
  /** Cleaned plain text of the chunk. */
  text: z.string(),
  /** Parsed, when chunkType === 'statblock'. */
  statBlock: statBlockSchema.nullable(),
  /** SHA-256 hex of `text`, for the embedding cache. */
  contentHash: sha256HexSchema,
});

export type RuleChunk = z.infer<typeof ruleChunkSchema>;
