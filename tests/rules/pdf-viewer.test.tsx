import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfBookView } from '@/features/rules/pdf-viewer';
import { openPdfDocument } from '@/lib/pdfRuntime';
import { putBookPdf } from '@/db/pdfRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { clearDatabase } from '../db/helpers';

/**
 * PDF viewer (source-viewers arc): the retained bytes open at a page
 * (chunk→page jump), and a book without retained bytes shows the loud
 * absent state with NO attach affordance (owner-ratified cut). jsdom cannot
 * paint (canvas getContext returns null), so the assertions pin the
 * document-level wiring — open, page state, nav chrome — which is what the
 * jump feature consumes; canvas painting itself is a browser-only concern.
 */

const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

beforeEach(clearDatabase);
afterEach(cleanup);

describe('PdfBookView', () => {
  it('renders the retained PDF and opens at the requested page', async () => {
    const { doc, destroy } = await openPdfDocument(new Uint8Array(fixtureBytes));
    const numPages = doc.numPages;
    await destroy();
    expect(numPages).toBeGreaterThanOrEqual(2);

    const book = await createRulebook({ title: 'Core Rules', system: 'dnd5e', filename: 'core.pdf' });
    await putBookPdf({ bookId: book.id, bytes: new Uint8Array(fixtureBytes), filename: 'core.pdf', mimeType: 'application/pdf' });

    const onBack = vi.fn();
    render(<PdfBookView bookId={book.id} initialPage={2} onBack={onBack} />);

    // The header names the book; the viewer opened AT page 2 (jump target).
    expect(await screen.findByText('Core Rules')).toBeInTheDocument();
    const pageInput = await screen.findByTestId('pdf-page-input');
    await waitFor(() => {
      expect(pageInput).toHaveValue('2');
    });
    expect(screen.getByText(`of ${String(numPages)}`)).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  }, 30000);

  it('shows the loud absent state for a book without retained bytes — no attach affordance', async () => {
    const user = userEvent.setup();
    const book = await createRulebook({ title: 'Old Book', system: 'dnd5e', filename: 'old.pdf' });

    const onBack = vi.fn();
    render(<PdfBookView bookId={book.id} onBack={onBack} />);

    expect(await screen.findByTestId('pdf-absent')).toHaveTextContent('No PDF is retained for “Old Book”');
    expect(screen.getByText(/imported before PDF retention/)).toBeInTheDocument();
    // The only exit is back to the library — there is NO way to hand a file
    // to the existing book (no file input, no attach button).
    expect(screen.queryByLabelText(/attach/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attach/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the library' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pdf-viewer')).not.toBeInTheDocument();
  }, 30000);
});
