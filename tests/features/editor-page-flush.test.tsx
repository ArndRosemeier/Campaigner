import 'fake-indexeddb/auto';

import type * as Toast from '@/lib/toast';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { defaultArtifactName } from '@/domain/create';
import {
  ArtifactEditor,
  AUTOSAVE_DELAY_MS,
} from '@/features/campaign/components/artifact-editor';
import { clearDatabase } from '../db/helpers';

// The revision dropdown's live query is irrelevant here; the DB state is what
// we assert on (the same mock `editor-autosave.test.tsx` uses).
vi.mock('@/features/campaign/hooks', () => ({ useRevisions: () => undefined }));

// The toast SEAM is mocked (the rest of it stays real) rather than `sonner`:
// `toastError` renders a plain Error's message as the description, so it goes
// through the toast seam exactly as production does — this counts the call the
// editor makes and leaves no console noise for the suite's guard to trip on.
vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof Toast>();
  return {
    ...actual,
    toastError: vi.fn(actual.toastError),
    toastSuccess: vi.fn(actual.toastSuccess),
    toastErrorPersistent: vi.fn(actual.toastErrorPersistent),
  };
});

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

/**
 * The writes the observing pins count, and why they are watched at the ARTIFACT
 * table: the editor reaches the save seam through the `@/db` barrel (`export *
 * as artifactRepo from '@/db/artifactRepo'`), and a namespace re-export is a
 * frozen module object — MEASURED: a `vi.mock('@/db/artifactRepo')` replace was
 * simply never seen (the real write ran and the pins read green for the wrong
 * reason), and assigning over `artifactRepo.updateArtifact` throws "Cannot set
 * property … which has only a getter". `updateArtifact` writes the artifact row
 * first and the revision row in the same transaction, so watching either table
 * observes the real save path.
 *
 * WHY the assertions come after a microtask drain rather than immediately:
 * `saveDraft` awaits `updateArtifact` before the revision row is written (the
 * artifact row IS written synchronously), and the drain advances NO timers —
 * so a count that moved did so because the FLUSH issued the write, never
 * because the 800 ms debounce expired.
 */
const artifactsPut = db.artifacts.put.bind(db.artifacts);
const revisionsPut = db.revisions.put.bind(db.revisions);

function countWrites(source: { writes: number }): () => void {
  db.artifacts.put = (...args: Parameters<typeof artifactsPut>): ReturnType<typeof artifactsPut> => {
    source.writes += 1;
    return artifactsPut(...args);
  };
  db.revisions.put = (...args: Parameters<typeof revisionsPut>): ReturnType<typeof revisionsPut> => {
    source.writes += 1;
    return revisionsPut(...args);
  };
  return () => {
    db.artifacts.put = artifactsPut;
    db.revisions.put = revisionsPut;
  };
}

function refuseRevisionWrites(): () => void {
  // The rejection is what `updateArtifact`'s transaction sees; `PromiseExtended`
  // is the table's own return type (`Promise` plus Dexie's `timeout`), so the
  // cast names exactly the one member this stub does not implement.
  db.revisions.put = ((): Promise<string> =>
    Promise.reject(new Error('IndexedDB is gone'))) as unknown as typeof revisionsPut;
  return () => {
    db.revisions.put = revisionsPut;
  };
}

/**
 * THE ARTIFACT EDITOR'S PAGE-HIDE FLUSH (docs/17 row 111 + row 118,
 * `lib/pageFlush`).
 *
 * Found by the SWEEP, not by a report: the editor autosaves through an 800 ms
 * debounce and flushed the pending draft on UNMOUNT only — so closing,
 * discarding or freezing a tab lost the last edit with no revision to restore
 * it from, exactly the hole the board had. The editor is now the seam's FOURTH
 * registration, and what this file pins, in the owner's terms:
 *
 * 1. an edit still inside the autosave window LANDS when the page goes away
 *    (`pagehide`, and separately the hidden `visibilitychange`);
 * 2. a page with NOTHING pending writes nothing and fires no revision on those
 *    signals — the seam's pending gate, read through the editor's own
 *    deep-compare gate (what keeps a tab switch from churning the 50-revision
 *    cap);
 * 3. ONE save when both signals fire;
 * 4. the IN-APP unmount flush still works (the regression);
 * 5. a failing write still reaches the owner ('Autosave failed').
 *
 * The observation instrument is the ROW: `body` is what the owner typed and
 * the revision count is what the real save seam wrote.
 *
 * WHY there is no `vi.mock('@/db/artifactRepo')` here: the editor reaches the
 * write seam through the `@/db` BARREL (`export * as artifactRepo from
 * '@/db/artifactRepo'`), and a namespace re-export is its own module object —
 * MEASURED: with that mock in place the mocked `updateArtifact` was never
 * called, the REAL write ran, and the pins read as green for the wrong reason.
 * The spy below goes on the object the component actually uses.
 */

describe('the artifact editor flushes a pending autosave when the page goes away', () => {
  beforeEach(clearDatabase);
  afterEach(() => {
    cleanup();
    // The suite has no `restoreMocks` config, so the visibility-state spy a pin
    // installs is restored here: a leaked `hidden` would make a later pin read a
    // document a previous test had hidden.
    vi.restoreAllMocks();
  });

  it('lands an edit still inside the 800 ms window on pagehide', async () => {
    const { id } = await mountEditorWithEdit('Page gone, pagehide');

    // Genuinely inside the window: nothing has been written yet.
    expect((await load(id)).body).toBe('');
    expect(await revisionCount(id)).toBe(1);

    // The write is issued WHILE the pagehide handler runs, so the count is
    // asserted there: a wait alone would pass on the 800 ms timer (MEASURED —
    // with the registration removed the waited pins still went green).
    const writes = { writes: 0 };
    const restore = countWrites(writes);
    try {
      flushPageHide();
      await drain();
      expect(writes.writes).toBeGreaterThan(0);
    } finally {
      restore();
    }
    await waitForRow(id, 'Page gone, pagehide');
    expect((await load(id)).currentRevision).toBe(2);
    expect(await revisionCount(id)).toBe(2);
  });

  it('lands it on visibilitychange → hidden', async () => {
    const { id } = await mountEditorWithEdit('Hidden tab');

    const writes = { writes: 0 };
    const restore = countWrites(writes);
    try {
      hideDocument();
      flushHidden();
      await drain();
      expect(writes.writes).toBeGreaterThan(0);
    } finally {
      restore();
    }
    await waitForRow(id, 'Hidden tab');
    expect(await revisionCount(id)).toBe(2);
  });

  it('writes nothing when no edit is pending', async () => {
    const { id } = await mountEditorWithEdit('Already saved');
    // Let the debounce itself land this one, so the gate has nothing queued.
    await waitForRow(id, 'Already saved');
    expect(await revisionCount(id)).toBe(2);
    const writes = { writes: 0 };
    const restore = countWrites(writes);
    try {
      hideDocument();
      flushHidden();
      await drain();
      flushPageHide();
      await drain();
    } finally {
      restore();
    }
    expect(writes.writes).toBe(0);
    expect(await revisionCount(id)).toBe(2);
    expect((await load(id)).currentRevision).toBe(2);
  });

  it('writes ONCE when both signals fire for one edit', async () => {
    const { id } = await mountEditorWithEdit('Both signals');

    const writes = { writes: 0 };
    const restore = countWrites(writes);
    try {
      hideDocument();
      flushHidden();
      await drain();
      expect(writes.writes).toBeGreaterThan(0);
    } finally {
      restore();
    }
    await waitForRow(id, 'Both signals');
    // The draft now matches the last saved row, so the pagehide a frozen tab
    // produces right after writes nothing at all.
    const after = { writes: 0 };
    const restoreAfter = countWrites(after);
    try {
      flushPageHide();
      await drain();
      expect(after.writes).toBe(0);
    } finally {
      restoreAfter();
    }
    expect(await revisionCount(id)).toBe(2);
  });

  it('still flushes the pending edit on unmount (the in-app route change)', async () => {
    const { id, view } = await mountEditorWithEdit('Left the artifact');

    act(() => {
      view.unmount();
    });
    await waitForRow(id, 'Left the artifact');
    expect(await revisionCount(id)).toBe(2);
  });

  it('reports a failing write on the page-hide flush too', async () => {
    const { id } = await mountEditorWithEdit('Doomed edit');

    // The real save path refuses this one write, so the editor's own loud path
    // is what has to fire — the same one the debounced save uses.
    const restore = refuseRevisionWrites();
    try {
      flushPageHide();
      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith('Autosave failed', expect.any(Error));
      });
    } finally {
      restore();
    }
    // Nothing was written, and the draft is still the owner's to keep.
    expect((await load(id)).body).toBe('');
    expect(await revisionCount(id)).toBe(1);
  });
});

// --- helpers ------------------------------------------------------------------

/**
 * Every wait ends a margin after `AUTOSAVE_DELAY_MS` — never long enough for a
 * SECOND autosave window — so each "exactly one revision" assertion also rules
 * out a duplicate write. The constant comes from the editor rather than being
 * copied here.
 */
const WRITE_LANDED = { timeout: AUTOSAVE_DELAY_MS + 1000, interval: 20 };

async function waitForRow(id: string, body: string): Promise<void> {
  await waitFor(async () => {
    expect((await load(id)).body).toBe(body);
  }, WRITE_LANDED);
}

async function mountEditorWithEdit(bodyText: string): Promise<{
  id: string;
  view: ReturnType<typeof render>;
}> {
  const campaign = await createCampaign({ name: 'Test', description: '', system: 'dnd5e' });
  const artifact = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: defaultArtifactName('npc'),
  });
  const row = await load(artifact.id);
  const view = render(
    <ArtifactEditor
      artifact={row}
      campaignId={campaign.id}
      campaignArtifacts={[]}
      campaignSystem="dnd5e"
    />,
  );
  const body = screen.getByPlaceholderText('Free-text content, written in Markdown…');
  fireEvent.change(body, { target: { value: bodyText } });
  // In-act drain only: real time passes, but far less than AUTOSAVE_DELAY_MS,
  // so the debounce timer is still parked when the caller dispatches.
  await drain();
  return { id: artifact.id, view };
}

async function load(id: string) {
  const row = await getArtifact(id);
  if (row === undefined) throw new Error('artifact missing');
  return row;
}

async function revisionCount(id: string): Promise<number> {
  return db.revisions.where('artifactId').equals(id).count();
}

/** Drains pending microtasks/act updates without advancing the debounce. */
async function drain(rounds = 10): Promise<void> {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.resolve();
    }
  });
}

function hideDocument(): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
}

/**
 * The browser's going-away signals reach the seam WITHOUT act — that is the
 * whole point of the seam — and the editor's flush sets `saveState` on the way
 * out, so the dispatch is wrapped here exactly as React demands of any state
 * update in a test. The wrap is around the dispatch only: what the flush
 * issues (Dexie) is drained by the caller's `waitFor`.
 */
function flushPageHide(): void {
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
}

function flushHidden(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
