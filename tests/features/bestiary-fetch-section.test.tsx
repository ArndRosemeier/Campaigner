import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BestiaryFetchSection } from '@/features/settings/bestiary-fetch-section';
import { clearPackTreeCache } from '@/ingest/packFetch';
import { Toaster } from '@/components/ui/sonner';
import { db } from '@/db/db';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { newId, ruleChunkSchema, spellDataSchema, type RuleChunk } from '@/domain';
import type { GameSystem } from '@/domain/gameSystem';
import { clearDatabase } from '../db/helpers';
import { expectBlockedReason, expectSelfEvidentBlock } from '../helpers/blocked-reason';

import { baseNpc } from '../ingest/packs/fixtures';

/**
 * Settings "Bestiary packs" card (16-BESTIARY-FETCH §5/§9): curated recipes
 * render, the advanced toggle lists the repo on demand, a fetch lands a ready
 * provenance-stamped book in Dexie, failures are loud and named, and every row
 * states its LIBRARY-DERIVED import state (docs/17 row 210 — provenance first,
 * title fallback, UNKNOWN rather than a guess, plus the system-mismatch
 * surface).
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

// --- The imported-state pins (docs/17 row 210) ------------------------------

/** The curated pf2e creature recipe every state pin is written against. */
const MONSTER_CORE = 'packs/pf2e/pathfinder-monster-core';
const MONSTER_CORE_LABEL = 'Pathfinder Monster Core';

/** A valid `section` chunk — the non-spell rules lane. */
function sectionChunk(bookId: string): RuleChunk {
  return ruleChunkSchema.parse({
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
    contentHash: 'a'.repeat(64),
  });
}

/** A valid `spell` chunk row — the row's LIVE spell lane (docs/17 row 204). */
function spellRow(bookId: string, name: string): RuleChunk {
  return ruleChunkSchema.parse({
    ...sectionChunk(bookId),
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

/**
 * A ready pack book in the real library, the way an import leaves one:
 * `entriesImported: 3` = 2 stat blocks + 1 rules-text section, so the lane
 * breakdown of a book with one stored `spell` chunk is
 * `1 spell · 2 stat blocks · 0 items · 0 sections`.
 */
async function seedPackBook(options: {
  title: string;
  sourceId: string;
  system?: GameSystem;
  provenance?: { sourceUrl: string; fetchedAt: number };
}): Promise<string> {
  const book = await createPackBook({
    title: options.title,
    system: options.system ?? 'pathfinder2e',
    filename: 'pack.zip',
  });
  await finalizePackBook(book.id, {
    sourceId: options.sourceId,
    license: 'test license',
    entriesImported: 3,
    entriesSkipped: 0,
    entriesFailed: 0,
    sectionsImported: 1,
    ...(options.provenance === undefined
      ? {}
      : {
          sourceRef: 'HEAD',
          sourceUrl: options.provenance.sourceUrl,
          fetchedAt: options.provenance.fetchedAt,
          attemptedRefs: ['HEAD'],
        }),
  });
  return book.id;
}

/** The provenance URL a fetch of `recipeId` from this source stamps. */
function fetchUrl(recipeId: string): string {
  return `https://github.com/foundryvtt/pf2e/tree/HEAD/${recipeId}`;
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
    // The fetch toast carries the per-lane breakdown (docs/17 row 204): the
    // fetched creature pack names 0 spells explicitly, through the SAME
    // formatter the manual-import toast and the book card use.
    expect(
      await screen.findByText(
        /Fetched & imported “NPC Gallery” \(0 spells · 2 stat blocks · 0 items · 0 sections/,
      ),
    ).toBeInTheDocument();
    // The report reuses the same breakdown element.
    expect(screen.getByTestId('pack-import-lanes')).toHaveTextContent(
      '0 spells · 2 stat blocks · 0 items · 0 sections',
    );
    // The fetch report names the system the book went in as (docs/17 row 209),
    // through the SAME spelling seam the manual report uses.
    expect(screen.getByTestId('pack-import-system')).toHaveTextContent('stored as Pathfinder 2e');
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

/**
 * WHY a fetch button is held while a fetch runs (docs/18 §2.3, docs/05 §Why a
 * control cannot act; docs/17 row 99): one fetch runs at a time across the whole
 * card, the pressed row's own label flips to "Fetching…" but EVERY OTHER row
 * goes dead with no word — and so does the row itself once its label is the only
 * thing that changed shape.
 */
describe('BestiaryFetchSection blocked-control reasons', () => {
  const RUNNING =
    'A pack fetch is already running — one fetch runs at a time here; wait for it to finish.';

  it('a fetch in flight states why on the pressed row AND on the rows it is holding back', async () => {
    const user = userEvent.setup();
    // Every request hangs until `offline` is set, and then every request FAILS —
    // so the chain's fallback ref attempt fails too and the run ends loudly.
    let offline = false;
    const rejecters: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        if (offline) return Promise.reject(new Error('offline'));
        return new Promise<Response>((_resolve, reject) => {
          rejecters.push(() => {
            reject(new Error('offline'));
          });
        });
      }),
    );
    render(<BestiaryFetchSection />);

    const pressed = await screen.findByTestId('fetch-packs/pf2e/npc-gallery');
    await user.click(pressed);
    await waitFor(() => {
      expect(screen.getByTestId('fetch-packs/pf2e/npc-gallery')).toBeDisabled();
    });

    await expectBlockedReason(user, 'fetch-packs/pf2e/npc-gallery', RUNNING);
    // A DIFFERENT curated recipe, held by the same one-at-a-time flag.
    await expectBlockedReason(user, 'fetch-packs/pf2e/equipment', RUNNING);

    // The run ends loudly on both refs: the reason goes with the hold.
    offline = true;
    for (const reject of rejecters.splice(0)) reject();
    await waitFor(
      () => {
        expect(screen.getByTestId('fetch-packs/pf2e/npc-gallery')).toBeEnabled();
      },
      { timeout: 15000 },
    );
    expect(screen.queryByTestId('fetch-packs/pf2e/npc-gallery-reason')).toBeNull();
  }, 30_000);

  it('SELF-EVIDENT: the advanced repo listing states its own state in place, so the switch carries no reason', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<BestiaryFetchSection />);

    const toggle = await screen.findByTestId('full-list-foundry-pf2e');
    await user.click(toggle);
    // The state IS on screen, beside its own control: the switch reads as on and
    // the line directly below it says the listing is running.
    await waitFor(() => {
      expect(screen.getByTestId('listing-foundry-pf2e')).toHaveTextContent(
        'Listing every pack in the repo…',
      );
    });
    expectSelfEvidentBlock('full-list-foundry-pf2e', 'aria-disabled');
  }, 30_000);
});

/**
 * Every recipe row states its import state, DERIVED FROM THE LIBRARY
 * (docs/17 row 210) — the owner: *"When something is already imported (spells
 * in my example) in settings, the fetch & import button should somehow
 * indicate that fact. Right now its invisible which led to me confusion."*
 *
 * Each pin seeds the REAL library (real Dexie rows through the real repos) and
 * asserts the rendered state line, so the derivation is exercised end to end
 * through the live read — never a stored flag and never a mocked predicate.
 */
describe('BestiaryFetchSection imported state (docs/17 row 210)', () => {
  it('pin 1 — a FETCHED pack (provenance sourceUrl) reads imported, with when and the lanes, and offers Re-import', async () => {
    // The title is deliberately NOT the recipe label: provenance is the ONLY
    // key that can identify this book, so this pin reds if that key is lost.
    const bookId = await seedPackBook({
      title: 'Monster Core (renamed by owner)',
      sourceId: 'foundry-pf2e',
      provenance: {
        sourceUrl: fetchUrl(MONSTER_CORE),
        fetchedAt: Date.UTC(2026, 8, 16, 11, 4),
      },
    });
    await putChunks([sectionChunk(bookId), spellRow(bookId, 'Acid Splash')]);

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    await waitFor(() => {
      expect(state).toHaveTextContent(
        'Imported — fetched 2026-09-16T11:04:00.000Z · 1 spell · 2 stat blocks · 0 items · 0 sections',
      );
    });
    // The spell lane is the number that would have told the owner immediately,
    // and it comes from row 204's ONE formatter over the LIVE count.
    expect(state).toHaveTextContent('1 spell');
    const button = screen.getByTestId(`fetch-${MONSTER_CORE}`);
    expect(button).toHaveTextContent('Re-import');
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleName(`Re-import ${MONSTER_CORE_LABEL}`);
  }, 30_000);

  it('pin 2 — a MANUAL import is identified by the TITLE fallback, with its own when', async () => {
    const bookId = await seedPackBook({ title: MONSTER_CORE_LABEL, sourceId: 'foundry-pf2e' });
    const book = await db.rulebooks.get(bookId);
    if (book === undefined) throw new Error('seeded pack book missing');

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    // No provenance exists, so the honest "when" is the row's own last-update
    // stamp, and the line says exactly that instead of claiming a fetch.
    await waitFor(() => {
      expect(state).toHaveTextContent(
        `Imported — updated ${new Date(book.updatedAt).toISOString()} · 0 spells · 2 stat blocks · 0 items · 1 section`,
      );
    });
    expect(screen.getByTestId(`fetch-${MONSTER_CORE}`)).toHaveTextContent('Re-import');
  }, 30_000);

  it('pin 3 — an unimported recipe reads not imported and keeps Fetch & import', async () => {
    // A ready pack book of ANOTHER adapter proves the library answer landed.
    await seedPackBook({
      title: 'D&D 5e SRD Monsters',
      sourceId: 'foundry-dnd5e-srd',
      system: 'dnd5e',
    });

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    await waitFor(() => {
      expect(state).toHaveTextContent('Not imported yet.');
    });
    const button = screen.getByTestId(`fetch-${MONSTER_CORE}`);
    expect(button).toHaveTextContent('Fetch & import');
    expect(button).toBeEnabled();
  }, 30_000);

  it('pin 4 — TWO matching books read UNKNOWN (ambiguous), never a pick', async () => {
    await seedPackBook({ title: MONSTER_CORE_LABEL, sourceId: 'foundry-pf2e' });
    await seedPackBook({ title: MONSTER_CORE_LABEL, sourceId: 'foundry-pf2e' });

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    await waitFor(() => {
      expect(state).toHaveTextContent(
        'Import state unknown — 2 books in the library match this pack (“Pathfinder Monster Core”, “Pathfinder Monster Core”), so which one to report cannot be decided.',
      );
    });
    // Never a pick: no lane breakdown is stated for an ambiguous identity.
    expect(state).not.toHaveTextContent(/\d+ spells? ·/);
    // …and the action is not disabled, and claims no prior import.
    const button = screen.getByTestId(`fetch-${MONSTER_CORE}`);
    expect(button).toHaveTextContent('Fetch & import');
    expect(button).toBeEnabled();
  }, 30_000);

  it('pin 5 — a matched book stored under another system states the mismatch and the correction', async () => {
    // Matched by BOTH keys on purpose (title = label, provenance stamped), so
    // this pin isolates the MISMATCH surface from the identity key.
    await seedPackBook({
      title: MONSTER_CORE_LABEL,
      sourceId: 'foundry-pf2e',
      system: 'dnd5e',
      provenance: {
        sourceUrl: fetchUrl(MONSTER_CORE),
        fetchedAt: Date.UTC(2026, 8, 16, 11, 4),
      },
    });

    render(<BestiaryFetchSection />);

    const mismatch = await screen.findByTestId(`import-system-mismatch-${MONSTER_CORE}`);
    expect(mismatch).toHaveTextContent(
      'System mismatch: the matched book is stored as D&D 5e, but this source imports Pathfinder 2e — a Pathfinder 2e campaign will not see its content. Use “Set system” on the Rules page to correct it.',
    );
    // The imported state is still stated — the mismatch is additive.
    expect(screen.getByTestId(`import-state-${MONSTER_CORE}`)).toHaveTextContent(
      /^Imported — fetched /,
    );
  }, 30_000);

  it('never says "not imported" while the library read is unanswered', async () => {
    render(<BestiaryFetchSection />);

    // Synchronously after render the live read has not answered: the row says
    // so instead of claiming absence (AGENTS rule 1).
    expect(screen.getByTestId(`import-state-${MONSTER_CORE}`)).toHaveTextContent(
      'Checking the library…',
    );
    await waitFor(() => {
      expect(screen.getByTestId(`import-state-${MONSTER_CORE}`)).toHaveTextContent(
        'Not imported yet.',
      );
    });
  }, 30_000);

  it('a lookalike book that proves nothing reads UNKNOWN (unidentified), not "not imported"', async () => {
    // A manual import's derived title is the zip/file base name — the pack
    // folder SLUG, not the recipe's human label — so the library clearly looks
    // like this pack but cannot prove it.
    const slugTitle = 'pathfinder-monster-core';
    await seedPackBook({ title: slugTitle, sourceId: 'foundry-pf2e' });

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    await waitFor(() => {
      expect(state).toHaveTextContent(
        `Import state unknown — 1 book in the library looks like this pack (“${slugTitle}”) but carries neither provenance nor a matching title, so none is proven to be this pack.`,
      );
    });
    expect(state).not.toHaveTextContent('Not imported yet.');
    expect(screen.getByTestId(`fetch-${MONSTER_CORE}`)).toBeEnabled();
  }, 30_000);

  it('pin 6 — the button label reflects the state and every recipe stays enabled', async () => {
    await seedPackBook({ title: MONSTER_CORE_LABEL, sourceId: 'foundry-pf2e' });

    render(<BestiaryFetchSection />);

    const state = await screen.findByTestId(`import-state-${MONSTER_CORE}`);
    await waitFor(() => {
      expect(state).toHaveTextContent(/^Imported — updated /);
    });
    // The identified recipe offers the documented remedy, enabled.
    const reimport = screen.getByTestId(`fetch-${MONSTER_CORE}`);
    expect(reimport).toHaveTextContent('Re-import');
    expect(reimport).toBeEnabled();
    // A sibling with no matching book keeps the original action, also enabled.
    const fresh = screen.getByTestId('fetch-packs/pf2e/pathfinder-bestiary');
    expect(fresh).toHaveTextContent('Fetch & import');
    expect(fresh).toBeEnabled();
  }, 30_000);
});
