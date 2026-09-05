import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';
import { gameSystemSchema } from '@/domain/gameSystem';
import { statBlockSchema } from '@/domain/statblock';

export const rulebookStatusSchema = z.enum(['processing', 'ready', 'error']);

export type RulebookStatus = z.infer<typeof rulebookStatusSchema>;

export const rulebookOriginSchema = z.enum(['pdf', 'pack']);

export type RulebookOrigin = z.infer<typeof rulebookOriginSchema>;

/**
 * Import report of a bestiary pack book (12-BESTIARY-PACKS §4): the adapter
 * that produced it, its license string (shown in the UI), and the per-entry
 * outcome counts. `null` for PDF books.
 */
export const packMetaSchema = z.object({
  /** Adapter id that produced the import, e.g. 'foundry-pf2e'. */
  sourceId: z.string().min(1),
  /** License string shown in the UI, taken verbatim from the adapter. */
  license: z.string(),
  entriesImported: z.number().int().nonnegative(),
  /** Non-creature documents skipped by design (folders, non-NPC docs). */
  entriesSkipped: z.number().int().nonnegative(),
  /** Entries that failed creature mapping/validation (reported, never silent). */
  entriesFailed: z.number().int().nonnegative(),
  // Provenance of a FETCHED pack (16-BESTIARY-FETCH §7) — absent for manual
  // file imports; all optional, so old backups parse unchanged (no migration).
  /** The ref the pack was ACTUALLY imported from: 'HEAD' (newest) or the
   *  pinned verified ref when the chain fell back (16 §1.1 amendment). */
  sourceRef: z.string().min(1).optional(),
  /** Human-browsable upstream URL of the fetched pack. */
  sourceUrl: z.string().min(1).optional(),
  /** When the pack was downloaded (epoch ms). */
  fetchedAt: z.number().int().positive().optional(),
  /** The ref chain that produced this book, in attempt order (16 §1.1
   *  amendment): ['HEAD'] when the newest ref imported, ['HEAD', 'v14-dev']
   *  when the fetch fell back to the verified snapshot. Additive + optional —
   *  old backups parse unchanged. */
  attemptedRefs: z.array(z.string().min(1)).optional(),
});

export type PackMeta = z.infer<typeof packMetaSchema>;

/** The fetch-provenance subset, stamped by `packFetch` on fetched books. */
export type PackProvenance = Pick<
  PackMeta,
  'sourceRef' | 'sourceUrl' | 'fetchedAt' | 'attemptedRefs'
>;

export const rulebookSchema = z.object({
  ...BaseEntitySchema.shape,
  /** User-editable; defaults to the PDF filename. */
  title: z.string().min(1),
  system: gameSystemSchema,
  filename: z.string(),
  pageCount: z.number().int().nonnegative(),
  status: rulebookStatusSchema,
  errorMessage: z.string(),
  /** How the book entered the library: PDF ingest or bestiary pack import. */
  origin: rulebookOriginSchema.default('pdf'),
  /** Pack import report — null for PDF books (defaults keep old rows valid). */
  packMeta: packMetaSchema.nullable().default(null),
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

/**
 * A chunk as produced by the ingestion worker: everything except identity,
 * book linkage and timestamps, which the main thread adds when persisting
 * (02-INGESTION.md "RuleChunkDraft").
 */
export type RuleChunkDraft = Omit<RuleChunk, 'id' | 'createdAt' | 'updatedAt' | 'bookId'>;

/** Pre-hash chunk output of the pure chunker (worker computes contentHash). */
export type UnhashedChunk = Omit<RuleChunkDraft, 'contentHash'>;
