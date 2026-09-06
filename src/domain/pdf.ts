import { z } from 'zod';

import { BaseEntitySchema } from '@/domain/entity';

/**
 * Stored rulebook PDFs (source-viewers arc): the ORIGINAL bytes of a
 * PDF-origin book are retained at ingest so the in-app viewer can render
 * them — delete + reimport never needs the original file again. Bytes live
 * in their own table (`pdfFiles`, one row per book via the unique `&bookId`
 * index), never inside the rulebook row: `listRulebooks()` runs in live
 * queries and search/roster hot paths, and Dexie deserializes whole records
 * — a multi-megabyte payload there would clone on every read (same reasoning
 * as images, 07-MILESTONE-3 M3-A). A book without a `pdfFiles` row has no
 * retained bytes — the viewer shows that state loudly; there is no attach
 * affordance (owner-ratified cut).
 *
 * Payloads are stored as `Uint8Array` bytes, not Blobs: structured clone
 * (IndexedDB and fake-indexeddb in tests) round-trips typed arrays reliably,
 * while Blob instances do not survive cloning. Consumers rebuild a Blob via
 * `pdfBlob()` at the boundary.
 */
export const storedPdfSchema = z.object({
  ...BaseEntitySchema.shape,
  /** The ingested book these bytes belong to (unique — one PDF per book). */
  bookId: z.uuid(),
  /** The original PDF file bytes, exactly as ingested. */
  bytes: z.custom<Uint8Array<ArrayBuffer>>((value) => value instanceof Uint8Array),
  /** The ingested file's name (may differ from the editable book title). */
  filename: z.string().min(1),
  /** `application/pdf`; kept explicit so `pdfBlob()` needs no guessing. */
  mimeType: z.string().min(1),
  /** `bytes.byteLength` at write time — the backup note reads this, not the blob. */
  sizeBytes: z.number().int().positive(),
});

export type StoredPdf = z.infer<typeof storedPdfSchema>;

/** Rebuilds a renderable Blob from a stored pdf row. */
export function pdfBlob(pdf: StoredPdf): Blob {
  return new Blob([pdf.bytes], { type: pdf.mimeType });
}

/** Per-PDF ingest cap (source-viewers arc): fails loudly BEFORE the
 * multi-minute extraction pipeline runs on a pathological file. Generous
 * enough for every published rulebook PDF, small enough to catch garbage. */
export const PDF_MAX_BYTES = 250 * 1024 * 1024;
