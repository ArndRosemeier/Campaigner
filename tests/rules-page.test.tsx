import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { ROUTES } from '@/app/routes';
import type * as IngestFiles from '@/ingest/ingestFiles';
import { defaultSettings, newId, ruleChunkSchema, spellDataSchema, type RuleChunk } from '@/domain';
import { saveSettings } from '@/db/settingsRepo';
import { createPackBook, createRulebook, failPackBook, finalizePackBook, getRulebook, updateRulebook } from '@/db/rulebookRepo';
import { INTERRUPTED_PDF_IMPORT_MESSAGE } from '@/ingest/ingestReconcile';
import { countChunksByBook, putChunks } from '@/db/chunkRepo';
import { clearDatabase } from './db/helpers';
import { expectBlockedReason, expectBlockedReasonMenuItem } from './helpers/blocked-reason';
import { flushAsyncUpdates } from './helpers/flush';
import { baseNpc, encodeJson, folderDoc } from './ingest/packs/fixtures';

/**
 * Rules screen (T4): PDF import through the UI with the committed fixture,
 * then rename/delete flows — backed by the real Dexie database. The bestiary
 * pack import (12-BESTIARY-PACKS §6) runs the real adapter + Dexie flow with
 * fixture creature documents.
 */

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

const fixturePath = join(import.meta.dirname, 'fixtures', 'sample-rulebook.pdf');
const fixtureBytes = readFileSync(fixturePath);

function fixtureFile(): File {
  return new File([new Uint8Array(fixtureBytes)], 'sample-rulebook.pdf', {
    type: 'application/pdf',
  });
}

function importFixture(): void {
  const input = screen.getByTestId('import-input');
  Object.defineProperty(input, 'files', { value: [fixtureFile()] });
  fireEvent.change(input);
}

function packFile(name: string, doc: Record<string, unknown>): File {
  return new File([new Uint8Array(encodeJson(doc))], name, { type: 'application/json' });
}

function importPackFiles(files: File[]): void {
  const input = screen.getByTestId('pack-import-input');
  Object.defineProperty(input, 'files', { value: files });
  fireEvent.change(input);
}

/**
 * The DELAYED CAUSE of the transient-reason-popup race, kept in-tree so this
 * pin stays falsifiable (docs/08-TESTING §"a negative DOM assertion on transient
 * UI", ledger 124).
 *
 * A Base UI menu places FOCUS on the held item's wrapper as it opens and
 * `BlockedControl` opens the reason on focus BY DESIGN (docs/05 §Why a control
 * cannot act), so the reason POPUP can already be mounted when a reason pin
 * looks — with no hover from the test. Draining the app's own scheduled work
 * here is what an extra async turn (or a slower machine) does on its own:
 * MEASURED on the pre-fix tree, one injected async turn at exactly this site
 * made the pin fail 3 runs of 3, on the wrapper's own popup. This is the suite's
 * drain seam, not a sleep and not a retry; `dismissOpenPopup` in
 * `tests/helpers/blocked-reason` is what makes the pin hold with the app's focus
 * already landed.
 */
async function settleAppFocus(): Promise<void> {
  await flushAsyncUpdates();
}

vi.mock('@/ingest/ingestFiles', async (importOriginal) => {
  // A passthrough mock: the four import tests in this file drive the REAL
  // ingest; the reason pins hold one call with `mockImplementationOnce`.
  const actual = await importOriginal<typeof IngestFiles>();
  return { ...actual, ingestPdf: vi.fn(actual.ingestPdf) };
});
vi.mock('@/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embeddingsActive: vi.fn(() => Promise.resolve(true)),
  ensureEmbeddings: vi.fn(),
}));

const { ingestPdf } = await import('@/ingest/ingestFiles');
const { ensureEmbeddings } = await import('@/search');
const ingestMock = vi.mocked(ingestPdf);
const ensureMock = vi.mocked(ensureEmbeddings);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A minimal valid chunk row for the ready book (the embed path needs one). */
function chunk(bookId: string): RuleChunk {
  const hash = 'a'.repeat(64);
  return {
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'section',
    headingPath: ['Chapter 1'],
    text: 'The bell tolls over the drowned quarter.',
    statBlock: null,
    contentHash: hash,
  };
}

/** A valid `spell` chunk row — the card's live spell lane (docs/17 row 204). */
function spellChunk(bookId: string, name: string): RuleChunk {
  return ruleChunkSchema.parse({
    ...chunk(bookId),
    id: newId(),
    chunkType: 'spell',
    headingPath: ['Spells', name],
    text: `${name}\nSpell 1\nA spell description.`,
    spellData: spellDataSchema.parse({
      system: 'pathfinder2e',
      rank: 0,
      cantrip: true,
      traditions: ['arcane', 'primal'],
      traits: [],
      rarity: 'common',
      cast: { time: '', range: '', target: '', duration: '' },
      heightening: null,
      heighteningEntries: [],
      heighteningUnparsed: [],
      publication: null,
    }),
  });
}

beforeEach(async () => {
  await clearDatabase();
  ingestMock.mockClear();
  ensureMock.mockClear();
  // These tests exercise the Rules screen, not the first-run wizard — seed
  // the onboarding state as finished so the wizard's one-time auto-open
  // (fresh status + zero campaigns) never overlays the page here. The
  // wizard's own auto-open behavior is covered in
  // tests/features/onboarding-wizard.test.tsx.
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
  });
});
afterEach(cleanup);

describe('rules screen', () => {
  it('imports a PDF through the UI and lists the ready book with chunks', async () => {
    renderAppAt(ROUTES.rules);

    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument();
    importFixture();

    const title = await screen.findByText('sample-rulebook');
    const card = title.closest('li') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByText('ready')).toBeInTheDocument();
    });
    expect(within(card).getByText(/\d+ chunks?/)).toBeInTheDocument();
    expect(await screen.findByText(/Imported “sample-rulebook”/)).toBeInTheDocument();
  }, 30000);

  it('renames a book from the card menu', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

    await user.click(screen.getByRole('button', { name: 'Menu for sample-rulebook' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const titleInput = await screen.findByLabelText('Rulebook title');
    await user.clear(titleInput);
    await user.type(titleInput, 'Core Rulebook');
    await user.click(screen.getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('Core Rulebook')).toBeInTheDocument();
    expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
  }, 30000);

  it('deletes a book after confirming, removing it from the list', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

    await user.click(screen.getByRole('button', { name: 'Menu for sample-rulebook' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument();
  }, 30000);

  it('deletes a book from the visible card button, removing its chunks', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);
    importFixture();

    await screen.findByText('sample-rulebook', {}, { timeout: 10000 });
    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    }, { timeout: 15000 });

    // The card carries its own visible delete affordance (no menu needed).
    await user.click(screen.getByRole('button', { name: 'Delete sample-rulebook' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('sample-rulebook')).not.toBeInTheDocument();
    });
    // Drain the delete's live-query cascade inside act before plain reads.
    await flushAsyncUpdates();
    // The chunks are gone with the book, not orphaned.
    const { db } = await import('@/db/db');
    const { listRulebooks } = await import('@/db/rulebookRepo');
    expect(await listRulebooks()).toHaveLength(0);
    expect(await db.chunks.count()).toBe(0);
    await flushAsyncUpdates();
  }, 30000);

  it('re-imports from a reconciled interrupted import (the retry path from the wedged state)', async () => {
    // The row exactly as the start-up reconcile leaves it (docs/17 row 266):
    // 'error' with the named sentence, which is the status this menu item is
    // shown on — before the reconcile the same row said `processing…` and
    // offered NOTHING, which is the defect.
    const wedged = await createRulebook({
      title: 'torn-scan',
      system: 'generic-d20',
      filename: 'torn.pdf',
    });
    await updateRulebook(wedged.id, {
      status: 'error',
      errorMessage: INTERRUPTED_PDF_IMPORT_MESSAGE,
    });

    renderAppAt(ROUTES.rules);

    const title = await screen.findByText('torn-scan', {}, { timeout: 10000 });
    const card = title.closest('li') as HTMLElement;
    expect(within(card).getByText(INTERRUPTED_PDF_IMPORT_MESSAGE)).toBeInTheDocument();

    // Retry… is the row's way forward, and it is NOT gated by the import flag.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Menu for torn-scan' }));
    await screen.findByTestId(`retry-book-${wedged.id}`, {}, { timeout: 10000 });

    // Choosing the PDF (the hidden input the menu item clicks) re-imports it
    // through the REAL ingest — the recovery actually recovers.
    const retryInput = card.querySelector('input[type="file"]');
    if (retryInput === null) throw new Error('the retry file input is missing');
    Object.defineProperty(retryInput, 'files', { value: [fixtureFile()] });
    fireEvent.change(retryInput);

    expect(await screen.findByText(/Re-imported “sample-rulebook”/, {}, { timeout: 15000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('sample-rulebook')).toBeInTheDocument();
    }, { timeout: 15000 });
    await flushAsyncUpdates();
  }, 30000);

  it('imports a bestiary pack through the dialog and lists it with the Pack badge', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);

    await user.click(screen.getByTestId('import-pack'));
    const dialog = screen.getByTestId('pack-import-dialog');

    // The adapter select lists the registered adapters only.
    expect(within(dialog).getByLabelText('Pack source')).toHaveTextContent(
      'Pathfinder 2e (Foundry VTT PF2e system packs)',
    );
    importPackFiles([
      packFile('age-of-ashes-goblin.json', baseNpc('Goblin Warrior')),
      packFile('_folders.json', folderDoc()),
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    // The import report names all three counts; the folder doc counts as skipped.
    const report = await within(dialog).findByTestId('pack-import-report', {}, { timeout: 15000 });
    expect(report).toHaveTextContent('1 imported');
    expect(report).toHaveTextContent('1 skipped');
    expect(report).toHaveTextContent('0 failed');
    // The per-lane breakdown (docs/17 row 204) names SPELLS explicitly — the
    // muddled `sections`/`creatures` noun is gone from this report.
    expect(within(report).getByTestId('pack-import-lanes')).toHaveTextContent(
      '0 spells · 1 stat block · 0 items · 0 sections',
    );
    // The report names the system the pack went in AS (docs/17 row 209), beside
    // the lanes and from the adapter's own declaration.
    expect(within(report).getByTestId('pack-import-system')).toHaveTextContent(
      'stored as Pathfinder 2e',
    );

    // The success TOAST carries the same breakdown, through the same seam, plus
    // the stored-system line.
    expect(
      await screen.findByText(
        /Imported “age-of-ashes-goblin” \(0 spells · 1 stat block · 0 items · 0 sections.*stored as Pathfinder 2e/,
      ),
    ).toBeInTheDocument();

    // Row 149 (docs/12 §5): the re-import consequence is stated where the user
    // meets it — a saved citation is bound to the EXACT stored text, so a
    // re-import that changes an entry's text leaves it reading `missing ref`
    // until the creature is re-picked. One sentence, in the existing report,
    // and the same sentence on every surface that reuses this component.
    expect(within(report).getByTestId('pack-import-rereimport-note')).toHaveTextContent(
      're-pick the creature there to repair them',
    );
    expect(within(report).getByTestId('pack-import-rereimport-note')).toHaveTextContent(
      'missing ref (<creature>)',
    );

    // Close the dialog (it aria-hides the book list while open).
    await user.keyboard('{Escape}');

    const title = await screen.findByText('age-of-ashes-goblin', {}, { timeout: 15000 });
    await waitFor(() => {
      expect(within(title.closest('li') as HTMLElement).getByText('ready')).toBeInTheDocument();
    });
    const card = (await screen.findByText('age-of-ashes-goblin')).closest('li') as HTMLElement;
    expect(within(card).getByText('Pack')).toBeInTheDocument();
    expect(within(card).getByText('1 chunk')).toBeInTheDocument();
    // The card states the same per-lane breakdown beside the total.
    expect(within(card).getByTestId('book-lanes')).toHaveTextContent(
      '0 spells · 1 stat block · 0 items · 0 sections',
    );

    // The license lives in the book menu, shown verbatim from the adapter.
    await user.click(within(card).getByRole('button', { name: 'Menu for age-of-ashes-goblin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'License' }));
    expect(await screen.findByTestId('pack-license')).toHaveTextContent(/Pathfinder Second Edition/);
  }, 30000);

  it('partitions a pack book\'s chunks into lanes on its card, naming the spells LIVE (docs/17 row 204)', async () => {
    const book = await createPackBook({
      title: 'PF2e Rules Text',
      system: 'pathfinder2e',
      filename: 'rules.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e-rules',
      license: 'ORC',
      entriesImported: 4,
      entriesSkipped: 0,
      entriesFailed: 0,
      sectionsImported: 4,
    });
    await putChunks([
      chunk(book.id),
      chunk(book.id),
      chunk(book.id),
      spellChunk(book.id, 'Acid Splash'),
    ]);

    renderAppAt(ROUTES.rules);

    const card = (await screen.findByText('PF2e Rules Text')).closest('li') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByText('4 chunks')).toBeInTheDocument();
    });
    // `sectionsImported` was 4 and MIXED the spell in; the card partitions it:
    // the one spell is named and `sections` is the non-spell remainder. The
    // SPELL lane is counted from the STORED chunk, so a book the spells arc
    // (row 181) already imported — whose `packMeta` carries no spell count —
    // still reads right instead of a false `0 spells`.
    expect(within(card).getByTestId('book-lanes')).toHaveTextContent(
      '1 spell · 0 stat blocks · 0 items · 3 sections',
    );
  }, 30000);

  it('marks the book error and toasts when a pack selection has zero valid entries', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.rules);

    await user.click(screen.getByTestId('import-pack'));
    const dialog = screen.getByTestId('pack-import-dialog');
    importPackFiles([packFile('only-folders.json', folderDoc())]);
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    // Loud failure: a toast names the reason, and the book lands as error —
    // never an empty ready book.
    expect(
      await screen.findByText(/Could not import the bestiary pack/, {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    const title = await screen.findByText('only-folders', {}, { timeout: 15000 });
    const card = title.closest('li') as HTMLElement;
    await waitFor(() => {
      expect(within(card).getByText('error')).toBeInTheDocument();
    });
    expect(within(card).getByText(/no valid creature entries/)).toBeInTheDocument();
  }, 30000);

  it('states why the import/embed controls are held: the page-wide import, the per-book embed, the delete icon and both menu items', async () => {
    const user = userEvent.setup();
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'complete' as const, stepState: [] },
      embeddingsEnabled: true,
      openRouterApiKey: 'test-key',
    });
    const ready = await createRulebook({
      title: 'emberfall-core',
      system: 'generic-d20',
      filename: 'core.pdf',
    });
    await updateRulebook(ready.id, { status: 'ready' });
    await putChunks([chunk(ready.id)]);
    const broken = await createRulebook({
      title: 'torn-scan',
      system: 'generic-d20',
      filename: 'torn.pdf',
    });
    await updateRulebook(broken.id, { status: 'error', errorMessage: 'No extractable text' });

    const pendingImport = deferred<never>();
    ingestMock.mockImplementationOnce(() => pendingImport.promise);
    renderAppAt(ROUTES.rules);
    await screen.findByText('emberfall-core', {}, { timeout: 10000 });

    // A PDF import in flight — the real input, a real .pdf file, a held ingest.
    const input = screen.getByTestId('import-input');
    Object.defineProperty(input, 'files', {
      value: [new File(['%PDF-1.4'], 'core.pdf', { type: 'application/pdf' })],
    });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByTestId('import-pdfs')).toBeDisabled();
    });

    const IMPORT_REASON =
      'A PDF import is running right now — one import runs at a time here; wait for it to finish.';
    await expectBlockedReason(user, 'import-pdfs', IMPORT_REASON);
    await expectBlockedReason(user, 'import-pack', IMPORT_REASON);
    // The card's delete icon is held by the same page-wide flag, and says so.
    await expectBlockedReason(user, `delete-book-${ready.id}`, IMPORT_REASON);
    // The failed book's "Retry…" starts ANOTHER import — same flag, same reason.
    await user.click(screen.getByRole('button', { name: 'Menu for torn-scan' }));
    await screen.findByTestId(`retry-book-${broken.id}`, {}, { timeout: 10000 });
    await settleAppFocus();
    await expectBlockedReasonMenuItem(user, `retry-book-${broken.id}`, IMPORT_REASON);
    await user.keyboard('{Escape}');

    // The import lands: both the hold and its reason go with it.
    pendingImport.resolve({ book: ready, chunkCount: 0, emptyPages: 0 } as never);
    await waitFor(() => {
      expect(screen.getByTestId('import-pdfs')).toBeEnabled();
    });
    expect(screen.queryByTestId('import-pdfs-reason')).toBeNull();

    // Embedding is THIS book's own run, so its menu item states the embed.
    const pendingEmbed = deferred<never>();
    // The run has to report its first progress tick BEFORE it is held: only a
    // tick populates `embedProgress[book.id]`, which is the flag the item's own
    // gate reads (`embedding === embed !== undefined`).
    ensureMock.mockImplementation((_chunks, onProgress) => {
      onProgress?.(1, 1);
      return pendingEmbed.promise;
    });
    await user.click(screen.getByRole('button', { name: 'Menu for emberfall-core' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Embed whole book' }));
    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: 'Menu for emberfall-core' }));
    await screen.findByTestId(`embed-book-${ready.id}`, {}, { timeout: 10000 });
    await settleAppFocus();
    await expectBlockedReasonMenuItem(
      user,
      `embed-book-${ready.id}`,
      'This book is being embedded right now — wait for it to finish.',
    );
    pendingEmbed.resolve(undefined as never);
    await flushAsyncUpdates();
  }, 40_000);
});

/**
 * A FAILED PACK IMPORT IS REMOVABLE, AND ITS CARD NEVER OFFERS THE PDF PICKER
 * (docs/17 row 369, docs/18 §5(b)/(d) — the deferral row 277 named and left).
 *
 * The owner's report: an import of ~2000 spells failed part-way (his iPad
 * slept) and there was *"NO WAY to recover. Can't even remove all spells and
 * try again."* The removal ALREADY existed and worked — `deleteRulebook`
 * deletes the book's chunks by `bookId` in ONE transaction, with no refcount,
 * no in-use check and no status gate, so it already reclaims a partial/`error`
 * pack — but it was INVISIBLE on the failed pack (the Spells page lists only
 * READY books) and the one control the failure copy led to was `Retry…`, a
 * PDF-ONLY picker that would birth a PDF book and leave the failed pack row in
 * place. These are the owner-visible half of the fix: the pack card offers the
 * removal it already had, the copy states the ORDER (remove, then import
 * again), and the picker is gated on ORIGIN so the PDF lane is untouched.
 */
describe('a failed pack import is removable, with its own remedies (docs/17 row 369)', () => {
  it('offers a PACK error card its Remove and NEVER the PDF picker', async () => {
    const user = userEvent.setup();
    const pack = await createPackBook({
      title: 'half-imported-pack',
      system: 'dnd5e',
      filename: 'pack.json',
    });
    await failPackBook(pack.id, 'chunk persist failed at batch 3');

    renderAppAt(ROUTES.rules);

    const title = await screen.findByText('half-imported-pack', {}, { timeout: 10000 });
    const packCard = title.closest('li');
    if (packCard === null) throw new Error('the pack card must render');
    await waitFor(() => {
      expect(within(packCard).getByText('error')).toBeInTheDocument();
    });

    // THE COPY NAMES BOTH REMEDIES, IN THE RIGHT ORDER (remove, then import):
    // a pack re-imported before the failed one is removed leaves TWO books —
    // there is no cross-book dedup of re-imports (docs/12 §9).
    const remedy = within(packCard).getByTestId(`pack-error-remedy-${pack.id}`);
    expect(remedy).toHaveTextContent('Remove this failed import first');
    expect(remedy).toHaveTextContent('import the pack again');
    const text = remedy.textContent;
    expect(text.indexOf('Remove this failed import first')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Remove this failed import first')).toBeLessThan(
      text.indexOf('import the pack again'),
    );

    // The REAL remedy is on the card: the SAME confirm the trash icon opens
    // (both are `setMenuAction('delete')` → `DeleteDialog` → `deleteRulebook`).
    await user.click(
      within(packCard).getByRole('button', { name: 'Menu for half-imported-pack' }),
    );
    const remove = await screen.findByTestId(`remove-book-${pack.id}`, {}, { timeout: 10000 });
    expect(remove).toHaveTextContent('Remove failed import…');

    // THE PICKER PATH IS ABSENT, not merely unused: no `Retry…` item for this
    // book and no file input anywhere in its card.
    expect(screen.queryByTestId(`retry-book-${pack.id}`)).not.toBeInTheDocument();
    expect(packCard.querySelectorAll('input[type="file"]')).toHaveLength(0);
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();
  }, 30000);

  it('a PDF error card KEEPS its Retry picker — the gate is on ORIGIN, not a removal of the control', async () => {
    const user = userEvent.setup();
    const pdf = await createRulebook({
      title: 'torn-scan',
      system: 'generic-d20',
      filename: 'torn.pdf',
    });
    await updateRulebook(pdf.id, {
      status: 'error',
      errorMessage: INTERRUPTED_PDF_IMPORT_MESSAGE,
    });

    renderAppAt(ROUTES.rules);

    const title = await screen.findByText('torn-scan', {}, { timeout: 10000 });
    const card = title.closest('li');
    if (card === null) throw new Error('the PDF card must render');
    await user.click(within(card).getByRole('button', { name: 'Menu for torn-scan' }));

    expect(
      await screen.findByTestId(`retry-book-${pdf.id}`, {}, { timeout: 10000 }),
    ).toBeInTheDocument();
    // …and the PACK remedies are not offered to it.
    expect(screen.queryByTestId(`remove-book-${pdf.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`pack-error-remedy-${pdf.id}`)).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();

    // The picker itself is really there, accepting PDFs only.
    const picker = card.querySelector('input[type="file"]');
    expect(picker).not.toBeNull();
    expect(picker?.getAttribute('accept')).toBe('application/pdf,.pdf');
    await flushAsyncUpdates();
  }, 30000);

  it('removes a HALF-IMPORTED pack — the book row AND every one of its 500 chunks, in two batches', async () => {
    const user = userEvent.setup();
    const pack = await createPackBook({
      title: 'half-imported-pack',
      system: 'dnd5e',
      filename: 'pack.json',
    });
    // The 250×2 shape a mid-persist interruption leaves (docs/17 row 369):
    // `packImport` persists batches of 250, EACH its own transaction, so an
    // interrupted run leaves 1..k batches under a book that never finalized.
    await putChunks(Array.from({ length: 250 }, () => chunk(pack.id)));
    await putChunks(Array.from({ length: 250 }, () => chunk(pack.id)));
    await failPackBook(pack.id, 'chunk persist failed at batch 3');

    // A SECOND book, so the removal is proven scoped by `bookId` rather than a
    // table clear.
    const keeper = await createPackBook({
      title: 'keep-me',
      system: 'dnd5e',
      filename: 'keep.json',
    });
    await finalizePackBook(keeper.id, {
      sourceId: 'foundry-dnd5e-srd',
      license: 'CC-BY-4.0',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    await putChunks([chunk(keeper.id)]);

    // THE PARTIAL STATE IS REAL BEFORE THE REMOVAL RUNS — the state the
    // scoping records that NO test has ever built: 500 chunks under an `error`
    // book whose `packMeta` was never written (so the counts are lost).
    expect(await countChunksByBook(pack.id)).toBe(500);
    const failed = await getRulebook(pack.id);
    expect(failed?.status).toBe('error');
    expect(failed?.packMeta).toBeNull();

    renderAppAt(ROUTES.rules);
    const title = await screen.findByText('half-imported-pack', {}, { timeout: 10000 });
    const card = title.closest('li');
    if (card === null) throw new Error('the pack card must render');

    // The card's OWN Remove, through the ONE confirm dialog the trash opens.
    await user.click(
      within(card).getByRole('button', { name: 'Menu for half-imported-pack' }),
    );
    await user.click(await screen.findByTestId(`remove-book-${pack.id}`, {}, { timeout: 10000 }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('half-imported-pack');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('half-imported-pack')).not.toBeInTheDocument();
    });
    await flushAsyncUpdates();

    // The book row AND every one of its chunks are gone…
    expect(await getRulebook(pack.id)).toBeUndefined();
    expect(await countChunksByBook(pack.id)).toBe(0);
    // …and the OTHER book is untouched.
    expect((await getRulebook(keeper.id))?.status).toBe('ready');
    expect(await countChunksByBook(keeper.id)).toBe(1);
    await flushAsyncUpdates();
  }, 30000);
});
