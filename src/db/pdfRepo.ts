import { stampNewEntity, type Id, type StoredPdf } from '@/domain';
import { storedPdfSchema } from '@/domain/pdf';
import { db } from '@/db/db';

/**
 * Retained rulebook PDF bytes (source-viewers arc): CRUD for the `pdfFiles`
 * table — one row per book (`&bookId` unique). Written once by `ingestPdf`
 * on success; deleted with the book (`deleteRulebook` cascade). Backup
 * excludes the bytes ALWAYS (owner-ratified — the PDF is a convenience copy
 * of a file the user owns on disk; chunks/embeddings carry the real data).
 */

export interface NewBookPdf {
  bookId: Id;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** Stores (or replaces) the retained PDF bytes of a book. `put` upserts by
 * PRIMARY key only — a fresh row carrying an existing bookId would violate
 * the unique `&bookId` index (ConstraintError), so a replace reuses the
 * original row's identity (id + createdAt) and overwrites the payload. */
export async function putBookPdf(input: NewBookPdf): Promise<StoredPdf> {
  const existing = await db.pdfFiles.where('bookId').equals(input.bookId).first();
  const pdf = storedPdfSchema.parse({
    ...(existing === undefined
      ? stampNewEntity()
      : { id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() }),
    bookId: input.bookId,
    bytes: input.bytes,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });
  await db.pdfFiles.put(pdf);
  return pdf;
}

/** The retained PDF bytes of a book, when the book was ingested after
 * retention landed. `undefined` = no retained bytes (viewer absent state). */
export async function getBookPdf(bookId: Id): Promise<StoredPdf | undefined> {
  return db.pdfFiles.where('bookId').equals(bookId).first();
}

/** Whether the book has retained PDF bytes (viewer gating). */
export async function hasBookPdf(bookId: Id): Promise<boolean> {
  const row = await db.pdfFiles.where('bookId').equals(bookId).limit(1).toArray();
  return row.length > 0;
}

/** Deletes the retained bytes of one book (cascade inside `deleteRulebook`). */
export async function deleteBookPdf(bookId: Id): Promise<void> {
  await db.pdfFiles.where('bookId').equals(bookId).delete();
}

/** Retention stats for the backup note: how many PDFs (and how many bytes)
 * a backup will NOT carry. Reads `sizeBytes`, never deserializes payloads. */
export async function pdfBackupStats(): Promise<{ count: number; totalBytes: number }> {
  const rows = await db.pdfFiles.toArray();
  return {
    count: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
  };
}
