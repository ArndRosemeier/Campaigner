import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BestiaryFetchSection } from '@/features/settings/bestiary-fetch-section';
import { clearPackTreeCache } from '@/ingest/packFetch';
import { Toaster } from '@/components/ui/sonner';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

import { baseNpc } from '../ingest/packs/fixtures';

/**
 * Settings "Bestiary packs" card (16-BESTIARY-FETCH §5/§9): curated recipes
 * render, the advanced toggle lists the repo on demand, a fetch lands a ready
 * provenance-stamped book in Dexie, and failures are loud and named.
 */

const PF2E_LIST_URL = 'https://api.github.com/repos/foundryvtt/pf2e/git/trees/v14-dev?recursive=1';
const HEAD_LIST_URL = 'https://api.github.com/repos/foundryvtt/pf2e/git/trees/HEAD?recursive=1';
/** Raw file URL at the NEWEST ref (the chain's first attempt). */
const RAW = (path: string): string =>
  `https://raw.githubusercontent.com/foundryvtt/pf2e/HEAD/${path}`;
/** Raw file URL at the pinned VERIFIED ref (the chain's fallback target). */
const RAW_PINNED = (path: string): string =>
  `https://raw.githubusercontent.com/foundryvtt/pf2e/v14-dev/${path}`;

const TREE = {
  sha: 'tree-sha',
  truncated: false,
  tree: [
    { path: 'packs/pf2e/npc-gallery/acolyte-of-nethys.json', type: 'blob' },
    { path: 'packs/pf2e/npc-gallery/priest-of-pharasma.json', type: 'blob' },
    { path: 'packs/pf2e/npc-gallery/_folders.json', type: 'blob' },
    { path: 'packs/pf2e/blog-bestiary/raven.json', type: 'blob' },
  ],
};

function mockFetch(routes: Record<string, Response | Error>): ReturnType<typeof vi.fn> {
  return vi.fn((url: string | URL | Request) => {
    const key = typeof url === 'string' ? url : url instanceof Request ? url.url : url.href;
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected fetch: ${key}`);
    if (route instanceof Error) return Promise.reject(route);
    return Promise.resolve(route);
  });
}

beforeEach(async () => {
  await db.open();
  await clearDatabase();
  // The fetcher caches the repo tree per module; tests must not share it.
  clearPackTreeCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BestiaryFetchSection', () => {
  it('renders the curated recipes, pinned refs and licenses without any network', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    render(<BestiaryFetchSection />);

    expect(await screen.findByText('Pathfinder Monster Core')).toBeInTheDocument();
    expect(screen.getByText('(492 creatures)')).toBeInTheDocument();
    expect(screen.getByText('D&D 5e SRD Monsters')).toBeInTheDocument();
    expect(screen.getByText('(337 creatures)')).toBeInTheDocument();
    // Two-ref badge (16 §1.1 amendment, decision 6): the fallback story is
    // visible before any fetch — newest (HEAD) first, then the verified ref.
    expect(screen.getByTestId('ref-foundry-pf2e')).toHaveTextContent(
      'foundryvtt/pf2e: newest (HEAD) → verified v14-dev',
    );
    expect(screen.getByTestId('ref-foundry-dnd5e-srd')).toHaveTextContent(
      'foundryvtt/dnd5e: newest (HEAD) → verified 6.0.x',
    );
    expect(screen.getAllByText(/Community Use Policy/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CC-BY-4\.0/).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches & imports a curated pack into a ready, provenance-stamped book', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [PF2E_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [HEAD_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response(
          JSON.stringify(baseNpc('Acolyte of Nethys')),
          { status: 200 },
        ),
        [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(
          JSON.stringify(baseNpc('Priest of Pharasma')),
          { status: 200 },
        ),
      }),
    );
    render(<BestiaryFetchSection />);
    const toaster = render(<Toaster />);
    void toaster;

    await user.click(await screen.findByTestId('fetch-packs/pf2e/npc-gallery'));

    // The import report (same component as the /rules dialog) appears…
    expect(await screen.findByTestId('pack-import-report')).toBeInTheDocument();
    expect(screen.getByText('2 imported')).toBeInTheDocument();
    // …and the book is in Dexie, ready, with fetch provenance from the NEWEST
    // ref (healthy → single pass, no fallback attempt).
    await waitFor(async () => {
      const books = await db.rulebooks.toArray();
      expect(books).toHaveLength(1);
      const book = books[0];
      expect(book?.title).toBe('NPC Gallery');
      expect(book?.status).toBe('ready');
      expect(book?.packMeta?.sourceRef).toBe('HEAD');
      expect(book?.packMeta?.attemptedRefs).toEqual(['HEAD']);
      expect(book?.packMeta?.sourceUrl).toBe(
        'https://github.com/foundryvtt/pf2e/tree/HEAD/packs/pf2e/npc-gallery',
      );
      expect(typeof book?.packMeta?.fetchedAt).toBe('number');
      expect(book?.packMeta?.license).toContain('Community Use Policy');
    });
    expect(await screen.findByText(/Fetched & imported “NPC Gallery”/)).toBeInTheDocument();
  });

  it('lists every pack in the repo when the advanced toggle goes on', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch({ [PF2E_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }) }),
    );
    render(<BestiaryFetchSection />);

    expect(screen.queryByTestId('fetch-packs/pf2e/blog-bestiary')).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('full-list-foundry-pf2e'));

    // The repo listing appears next to the curated rows; `_`-only/metadata
    // content never becomes a fetchable row.
    expect(await screen.findByTestId('fetch-packs/pf2e/blog-bestiary')).toBeInTheDocument();
    expect(screen.getByText('(1 creature)')).toBeInTheDocument();
    expect(screen.getByTestId('fetch-packs/pf2e/npc-gallery')).toBeInTheDocument();
  });

  it('fails loudly — and creates no book — when every download fails on both refs', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [PF2E_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [HEAD_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response('nope', {
          status: 404,
          statusText: 'Not Found',
        }),
        [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response('nope', {
          status: 404,
          statusText: 'Not Found',
        }),
        [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response('nope', {
          status: 404,
          statusText: 'Not Found',
        }),
        [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response('nope', {
          status: 404,
          statusText: 'Not Found',
        }),
      }),
    );
    render(<BestiaryFetchSection />);
    render(<Toaster />);

    await user.click(await screen.findByTestId('fetch-packs/pf2e/npc-gallery'));

    // The newest attempt is below threshold → the verified ref's downloads run
    // too; both all-fail → the combined loud error names BOTH refs (16 §1.1).
    expect(await screen.findByTestId('error-foundry-pf2e')).toHaveTextContent(
      /no valid entries from any ref in the chain, no pack book was created/s,
    );
    expect(screen.getByTestId('error-foundry-pf2e')).toHaveTextContent(
      'newest (HEAD): 0/2 valid — all 2 downloads failed',
    );
    expect(screen.getByTestId('error-foundry-pf2e')).toHaveTextContent(
      'verified (v14-dev): 0/2 valid — all 2 downloads failed',
    );
    // Loud on both surfaces: the card's named error line AND a toast.
    expect(await screen.findByText(/Bestiary pack fetch failed/)).toBeInTheDocument();
    expect((await screen.findAllByText(/no valid entries from any ref/)).length).toBeGreaterThanOrEqual(1);
    expect(await db.rulebooks.count()).toBe(0);
  });

  it('throws loudly with no book when BOTH refs validate zero entries (all-fail edge, 16 §1.1)', async () => {
    // The live Monster Core drift scenario taken to its end: the newest ref's
    // documents all fail validation (0/2 < 0.5), so the verified snapshot runs
    // too — and its documents are equally unusable → all-fail semantics: a
    // loud named error, no book.
    const user = userEvent.setup();
    const broken = baseNpc('Acolyte of Nethys');
    const system = broken.system as Record<string, unknown>;
    delete (system.details as Record<string, unknown>).level;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [PF2E_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [HEAD_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
        [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
        [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
        [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
      }),
    );
    render(<BestiaryFetchSection />);
    render(<Toaster />);

    await user.click(await screen.findByTestId('fetch-packs/pf2e/npc-gallery'));

    // The card's named error leads with the newest attempt's representative
    // failure (the first document's zod issue), then names BOTH attempts.
    expect(await screen.findByTestId('error-foundry-pf2e')).toHaveTextContent(
      /npc-gallery\/acolyte-of-nethys\.json \(Acolyte of Nethys\): document 0:/s,
    );
    expect(screen.getByTestId('error-foundry-pf2e')).toHaveTextContent(
      /pack fetch failed for "NPC Gallery" — no valid entries from any ref in the chain, no pack book was created\. newest \(HEAD\): 0\/2 valid.*verified \(v14-dev\): 0\/2 valid/s,
    );
    // All-fail semantics: NO book at all (not even an error book).
    expect(await db.rulebooks.count()).toBe(0);
  });

  it('reports a verified-ref fallback loudly in the report and toast (format drift)', async () => {
    // The ratified scenario: the newest ref's format is unusable (0/2), the
    // verified snapshot imports 2/2 — the book comes from v14-dev and the
    // report AND toast name BOTH attempts.
    const user = userEvent.setup();
    const broken = baseNpc('Acolyte of Nethys');
    const system = broken.system as Record<string, unknown>;
    delete (system.details as Record<string, unknown>).level;
    vi.stubGlobal(
      'fetch',
      mockFetch({
        [PF2E_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [HEAD_LIST_URL]: new Response(JSON.stringify(TREE), { status: 200 }),
        [RAW('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
        [RAW('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(
          JSON.stringify(broken),
          { status: 200 },
        ),
        [RAW_PINNED('packs/pf2e/npc-gallery/acolyte-of-nethys.json')]: new Response(
          JSON.stringify(baseNpc('Acolyte of Nethys')),
          { status: 200 },
        ),
        [RAW_PINNED('packs/pf2e/npc-gallery/priest-of-pharasma.json')]: new Response(
          JSON.stringify(baseNpc('Priest of Pharasma')),
          { status: 200 },
        ),
      }),
    );
    render(<BestiaryFetchSection />);
    render(<Toaster />);

    await user.click(await screen.findByTestId('fetch-packs/pf2e/npc-gallery'));

    expect(await screen.findByTestId('pack-import-report')).toBeInTheDocument();
    expect(screen.getByTestId('pack-import-fetch-note')).toHaveTextContent(
      'newest (HEAD): 0/2 valid — format drift suspected; imported the verified snapshot (v14-dev) instead: 2/2',
    );
    // Loud on BOTH surfaces: the report note above AND the success toast.
    expect(
      (await screen.findAllByText(/format drift suspected; imported the verified snapshot/)).length,
    ).toBeGreaterThanOrEqual(2);
    // The book is from the verified snapshot, with the attempt trail stamped.
    await waitFor(async () => {
      const books = await db.rulebooks.toArray();
      expect(books).toHaveLength(1);
      expect(books[0]?.packMeta?.sourceRef).toBe('v14-dev');
      expect(books[0]?.packMeta?.attemptedRefs).toEqual(['HEAD', 'v14-dev']);
      expect(books[0]?.status).toBe('ready');
    });
  });

  it('names the GitHub rate limit when the repo listing is rejected', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      mockFetch({ [PF2E_LIST_URL]: new Response('rate limited', { status: 403 }) }),
    );
    render(<BestiaryFetchSection />);
    render(<Toaster />);

    await user.click(await screen.findByTestId('full-list-foundry-pf2e'));

    expect(await screen.findByTestId('error-foundry-pf2e')).toHaveTextContent(
      '60 requests/hour per IP',
    );
    expect(await screen.findByText(/Could not list the repo packs/)).toBeInTheDocument();
  });
}, 30000);
