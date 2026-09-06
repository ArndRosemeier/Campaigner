import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { PDF_MAX_BYTES, pdfBlob } from '@/domain';
import { db } from '@/db/db';
import { putBookPdf, getBookPdf, hasBookPdf, deleteBookPdf, pdfBackupStats } from '@/db/pdfRepo';
import { createRulebook, deleteRulebook } from '@/db/rulebookRepo';
import { clearDatabase } from './helpers';

/**
 * Retained rulebook PDF bytes (source-viewers arc): one row per book
 * (`&bookId` unique), written by ingest, deleted with the book, and
 * summarized for the backup note without deserializing payloads.
 */

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

async function makeBook(title: string): Promise<string> {
  const book = await createRulebook({ title, system: 'dnd5e', filename: `${title}.pdf` });
  return book.id;
}

describe('pdfRepo', () => {
  beforeEach(clearDatabase);

  it('round-trips retained bytes and rebuilds the blob at the boundary', async () => {
    const bookId = await makeBook('Core Rulebook');
    await putBookPdf({ bookId, bytes: BYTES, filename: 'core.pdf', mimeType: 'application/pdf' });

    const pdf = await getBookPdf(bookId);
    if (pdf === undefined) throw new Error('retained pdf row is missing');
    expect(pdf.bookId).toBe(bookId);
    expect(pdf.filename).toBe('core.pdf');
    expect(pdf.mimeType).toBe('application/pdf');
    expect(pdf.sizeBytes).toBe(BYTES.byteLength);
    expect(Array.from(pdf.bytes)).toEqual(Array.from(BYTES));

    const blob = pdfBlob(pdf);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe(BYTES.byteLength);
  });

  it('keeps ONE row per book: a second put replaces via the unique bookId index', async () => {
    const bookId = await makeBook('Bestiary');
    await putBookPdf({ bookId, bytes: BYTES, filename: 'a.pdf', mimeType: 'application/pdf' });
    const bigger = new Uint8Array(BYTES.byteLength + 4);
    bigger.set(BYTES);
    await putBookPdf({ bookId, bytes: bigger, filename: 'b.pdf', mimeType: 'application/pdf' });

    const pdf = await getBookPdf(bookId);
    expect(pdf?.filename).toBe('b.pdf');
    expect(pdf?.sizeBytes).toBe(bigger.byteLength);
    expect(await db.pdfFiles.count()).toBe(1);
  });

  it('reports absence as undefined/false — the viewer loud-absent state', async () => {
    const bookId = await makeBook('Old Book');
    expect(await getBookPdf(bookId)).toBeUndefined();
    expect(await hasBookPdf(bookId)).toBe(false);
  });

  it('deletes by book and summarizes backup stats from sizeBytes', async () => {
    const bookA = await makeBook('Book A');
    const bookB = await makeBook('Book B');
    await putBookPdf({ bookId: bookA, bytes: BYTES, filename: 'a.pdf', mimeType: 'application/pdf' });
    await putBookPdf({ bookId: bookB, bytes: BYTES, filename: 'b.pdf', mimeType: 'application/pdf' });

    expect(await pdfBackupStats()).toEqual({ count: 2, totalBytes: BYTES.byteLength * 2 });

    await deleteBookPdf(bookA);
    expect(await getBookPdf(bookA)).toBeUndefined();
    expect(await pdfBackupStats()).toEqual({ count: 1, totalBytes: BYTES.byteLength });
  });

  it('deleting the book cascades the retained bytes', async () => {
    const bookId = await makeBook('Doomed');
    await putBookPdf({ bookId, bytes: BYTES, filename: 'doomed.pdf', mimeType: 'application/pdf' });
    expect(await hasBookPdf(bookId)).toBe(true);

    await deleteRulebook(bookId);

    expect(await getBookPdf(bookId)).toBeUndefined();
    expect(await hasBookPdf(bookId)).toBe(false);
  });

  it('exposes the cap constant at a generous 250 MB', () => {
    expect(PDF_MAX_BYTES).toBe(250 * 1024 * 1024);
  });
});
