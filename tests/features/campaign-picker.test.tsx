import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign, listCampaigns } from '@/db/campaignRepo';
import { getCampaign } from '@/db/campaignRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { db } from '@/db/db';
import {
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { buildCampaignExport } from '@/lib/exportImport';
import { clearDatabase } from '../db/helpers';

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
        {/* Absorbs the post-import navigation to the new campaign's workspace. */}
        <Route path="*" element={<div data-testid="navigated-away" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('CampaignPickerPage', () => {
  it('shows the empty-state hero when there are no campaigns', async () => {
    renderPicker();
    expect(await screen.findByText('No campaigns yet')).toBeDefined();
  });

  it('lists campaigns with system badge and artifact count', async () => {
    await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    renderPicker();

    expect(await screen.findByText('Emberfall')).toBeDefined();
    expect(screen.getByText('D&D 5e')).toBeDefined();
    expect(screen.getByText(/0 artifacts/)).toBeDefined();
  });

  it('creates a campaign through the dialog', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByTestId('new-campaign'));
    await user.type(screen.getByLabelText('Campaign name'), 'The Sunless Sea');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('The Sunless Sea')).toBeDefined();
    // The dialog closes (after its exit transition) and resets its fields.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    });
  });

  it('shows the description snippet on the card only when it is non-empty', async () => {
    await createCampaign({ name: 'Emberfall', description: 'A sunless sea.', system: 'dnd5e' });
    await createCampaign({ name: 'Barren', system: 'dnd5e' });
    renderPicker();

    const describedCard = (await screen.findByText('Emberfall')).closest('li');
    const bareCard = screen.getByText('Barren').closest('li');
    if (describedCard === null || bareCard === null) throw new Error('campaign card missing');
    expect(within(describedCard).getByText('A sunless sea.')).toBeInTheDocument();
    // An empty description renders no snippet — not even a placeholder.
    expect(within(bareCard).queryByText('A sunless sea.')).toBeNull();
  });

  it('edits name and description from the card menu and persists both', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    renderPicker();
    await screen.findByText('Emberfall');

    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit campaign…' }));
    const dialog = await screen.findByTestId('edit-campaign-dialog');
    // The game system is shown read-only: battles/stat blocks depend on it.
    expect(within(dialog).getByLabelText('Game system (fixed)')).toBeDisabled();

    await user.clear(within(dialog).getByLabelText('Campaign name'));
    await user.type(within(dialog).getByLabelText('Campaign name'), 'Emberfall II');
    await user.type(within(dialog).getByLabelText('Campaign description'), 'A sunless sea.');
    await user.click(within(dialog).getByTestId('save-campaign'));

    // The card refreshes via the live summaries query…
    expect(await screen.findByText('Emberfall II')).toBeDefined();
    expect(await screen.findByText('A sunless sea.')).toBeDefined();
    // …and the row is updated in the DB.
    await waitFor(async () => {
      expect((await getCampaign(campaign.id))?.description).toBe('A sunless sea.');
    });
  });
});

/**
 * Import missing-dependency gate (07-MILESTONE-3 M3-E slice B): parse-first
 * analysis opens the dep-summary dialog; Abort (default) imports nothing,
 * Import anyway lands the campaign with `missing ref` encounters.
 */
describe('CampaignPickerPage import dependencies', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  /** A campaign whose encounter cites a pack statblock — returned as JSON text. */
  async function seedPackBackedExport(): Promise<{ json: string; campaignId: string }> {
    const campaign = await createCampaign({ name: 'Dep source', system: 'pathfinder2e' });
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 120,
      entriesSkipped: 3,
      entriesFailed: 0,
    });
    const text = 'Goblin Warrior stat block';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: statBlockSchema.parse({
          system: 'pathfinder2e',
          level: '1',
          size: 'Small',
          creatureType: 'humanoid',
          ac: 15,
          acNote: '',
          hp: 7,
          hpFormula: '2d6',
          speed: '25 ft.',
          abilities: { str: 10, dex: 12, con: 10, int: 8, wis: 10, cha: 8 },
          saves: '',
          skills: '',
          senses: '',
          languages: '',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const [chunk] = await db.chunks.toArray();
    if (chunk === undefined) throw new Error('chunk missing');
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: {
        difficulty: 'medium',
        levelHint: '1',
        monsters: [
          {
            name: 'Goblin Warrior',
            count: 2,
            notes: '',
            treasure: '',
            source: { type: 'rulebook', chunkId: chunk.id },
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      } as never,
    });
    const exported = await buildCampaignExport(campaign.id);
    return { json: JSON.stringify(exported), campaignId: campaign.id };
  }

  function uploadJson(json: string): void {
    const input = screen.getByTestId('import-input');
    Object.defineProperty(input, 'files', {
      value: [new File([json], 'dep.json', { type: 'application/json' })],
    });
    fireEvent.change(input);
  }

  it('opens the dep-summary dialog on unmet citations; Abort imports nothing', async () => {
    const user = userEvent.setup();
    const { json } = await seedPackBackedExport();
    // The book is gone here — every citation is an L0-miss.
    await db.chunks.clear();
    await db.rulebooks.clear();
    renderPicker();
    await screen.findByText('Dep source');

    uploadJson(json);
    const dialog = await screen.findByTestId('import-deps-dialog');
    expect(within(dialog).getByText('Import needs missing rulebook content')).toBeInTheDocument();
    expect(within(dialog).getByTestId('import-deps-match-level')).toHaveTextContent('missing');
    expect(within(dialog).getByText('Goblin ambush')).toBeInTheDocument();
    expect(within(dialog).getByText('Goblin Warrior')).toBeInTheDocument();
    // The resolve path names the Rules install surface explicitly + deep-links it.
    const rulesLink = within(dialog).getByTestId('import-deps-rules-link');
    expect(rulesLink.getAttribute('href')).toBe(ROUTES.rules);
    // ASCII quotes around 'missing ref' (no curly-quote mojibake).
    const description = within(dialog).getByText(/encounters below will show/).textContent;
    expect(description).toContain("'missing ref'");
    expect(description).not.toContain('‘');
    expect(description).not.toContain('’');

    await user.click(within(dialog).getByTestId('import-deps-abort'));
    await waitFor(() => {
      expect(screen.queryByTestId('import-deps-dialog')).toBeNull();
    });
    // Abort-before-tx: the source campaign stands alone.
    expect(await listCampaigns()).toHaveLength(1);
  });

/**
 * Import-failure toasts (error-humanization arc): every failure toast
 * carries MITIGATION, not just cause — and never a raw JSON dump. The
 * dep-summary DIALOG already covers missing deps (above); these pins cover
 * the toast paths (unparseable bytes, schema rejects).
 */
describe('CampaignPickerPage import failure toasts', () => {
  const toastErrorMock = vi.mocked(toast.error);

  beforeEach(clearDatabase);
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function uploadFile(name: string, text: string, type: string): void {
    renderPicker();
    const input = screen.getByTestId('import-input');
    Object.defineProperty(input, 'files', {
      value: [new File([text], name, { type })],
    });
    fireEvent.change(input);
  }

  it('unparseable bytes toast the cause PLUS the version mitigation', async () => {
    // The seam logs the full raw error to the console (one click away in
    // devtools) — mocked here per the no-console-noise test rule, and the
    // assertion below pins that the log happened.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    uploadFile('dep.json', 'this is not json{{{', 'application/json');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    const [title, options] = toastErrorMock.mock.calls[0] as [
      string,
      { description?: string },
    ];
    expect(title).toBe('Import failed — is this a Campaigner export?');
    expect(options.description).toContain('same version');
    // A SyntaxError is not Zod-shaped: no console dump, cause + mitigation.
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('schema rejects toast a grouped summary, never raw JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    uploadFile('dep.json', '{"format":"nope"}', 'application/json');

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    const [title, options] = toastErrorMock.mock.calls[0] as [
      string,
      { description?: string },
    ];
    expect(title).toBe('Import failed — is this a Campaigner export?');
    const description = options.description ?? '';
    expect(description).toContain('same version');
    expect(description).not.toContain('"code"');
    // The full raw ZodError went to the console, not the toast.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

  it('Import anyway lands the campaign with `missing ref` encounters', async () => {
    const user = userEvent.setup();
    const { json, campaignId } = await seedPackBackedExport();
    await db.chunks.clear();
    await db.rulebooks.clear();
    renderPicker();
    await screen.findByText('Dep source');

    uploadJson(json);
    const dialog = await screen.findByTestId('import-deps-dialog');
    await user.click(within(dialog).getByTestId('import-deps-import-anyway'));

    await waitFor(async () => {
      expect(await listCampaigns()).toHaveLength(2);
    });
    // Import-anyway follows the clean path: toast + navigation to the workspace.
    await screen.findByTestId('navigated-away');
    await waitFor(() => {
      expect(screen.queryByTestId('import-deps-dialog')).toBeNull();
    });
    const imported = await db.artifacts
      .where('campaignId')
      .notEqual(campaignId)
      .filter((artifact) => artifact.kind === 'encounter')
      .toArray();
    expect(imported).toHaveLength(1);
    const encounter = imported[0];
    if (encounter?.kind !== 'encounter') throw new Error('imported encounter missing');
    const first = encounter.data.monsters[0];
    if (first === undefined) throw new Error('imported roster entry missing');
    expect((await resolveMonsterEntryWithRepos(first)).origin).toBe('missing ref');
  });
});
