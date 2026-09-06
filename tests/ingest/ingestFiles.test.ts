import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { PDF_MAX_BYTES } from '@/domain';
import { getBookPdf } from '@/db/pdfRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { clearDatabase } from '../db/helpers';
import { ingestPdf } from '@/ingest/ingestFiles';

/**
 * Ingest retention (source-viewers arc): a successful ingest retains the
 * original bytes in `pdfFiles`; a failed ingest retains nothing; the
 * per-PDF size cap rejects loudly BEFORE any book row exists. Tests run the
 * pipeline inline (no Worker in jsdom) against the committed fixture PDF.
 */

const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

function fixtureFile(name = 'sample-rulebook.pdf'): File {
  return new File([new Uint8Array(fixtureBytes)], name, { type: 'application/pdf' });
}

describe('ingestPdf retention', () => {
  beforeEach(clearDatabase);

  it('retains the original bytes, filename and mime type on success', async () => {
    const result = await ingestPdf(fixtureFile(), 'dnd5e');
    expect(result.book.status).toBe('ready');

    const pdf = await getBookPdf(result.book.id);
    expect(pdf).toBeDefined();
    expect(pdf?.filename).toBe('sample-rulebook.pdf');
    expect(pdf?.mimeType).toBe('application/pdf');
    expect(pdf?.sizeBytes).toBe(fixtureBytes.byteLength);
    expect(Array.from(pdf?.bytes ?? [])).toEqual(Array.from(fixtureBytes));
  }, 30000);

  it('retains nothing when the ingest fails (error book, no bytes)', async () => {
    // A "%PDF" header with no body is a loud pipeline failure.
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'broken.pdf', {
      type: 'application/pdf',
    });
    await expect(ingestPdf(file, 'dnd5e')).rejects.toThrow();

    const books = await listRulebooks();
    expect(books).toHaveLength(1); // the error row stays for its message
    const book = books[0];
    if (book === undefined) throw new Error('error book row is missing');
    expect(book.status).toBe('error');
    expect(await getBookPdf(book.id)).toBeUndefined();
  }, 30000);

  it('rejects an oversized file loudly before creating any book row', async () => {
    const file = fixtureFile('huge.pdf');
    Object.defineProperty(file, 'size', { value: PDF_MAX_BYTES + 1 });

    await expect(ingestPdf(file, 'dnd5e')).rejects.toThrow(/import limit is 250 MB/);
    expect(await listRulebooks()).toHaveLength(0);
  });
});
