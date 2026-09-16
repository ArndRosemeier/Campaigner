import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { spellsPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { saveSettings } from '@/db/settingsRepo';
import {
  defaultSettings,
  ruleChunkSchema,
  spellDataSchema,
  stampNewEntity,
  type Id,
  type RuleChunk,
  type SpellData,
} from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * The campaign's spell list (docs/17 row 182, docs/12 §15): a real Dexie
 * library read through the page, pinned for the owner-visible behaviour —
 * same-system filtering (a dnd5e book must never surface in a PF2e campaign),
 * rank ordering with cantrips first, the loud per-row data error, tradition
 * multi-filtering, chip→detail with the licence line, and the PER-SYSTEM
 * empty states (docs/17 row 181's named follow-up).
 */

const LICENSE_LINE = 'Source: Pathfinder Core Rulebook (OGL)';

function spellData(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: 'pathfinder2e',
    rank: 1,
    cantrip: false,
    traditions: ['arcane'],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
    ...over,
  });
}

let seq = 0;
function chunk(
  bookId: Id,
  name: string,
  over: Partial<RuleChunk> = {},
  data: SpellData | null = spellData(),
): RuleChunk {
  seq += 1;
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'spell',
    headingPath: ['Spells', name],
    text: [
      name,
      'Spell 1',
      'Cast 2',
      'A spell description.',
      LICENSE_LINE,
    ].join('\n'),
    statBlock: null,
    contentHash: 'a'.repeat(63) + String(seq % 10),
    spellData: data,
    ...over,
  });
}

async function readyBook(title: string, system: 'pathfinder2e' | 'dnd5e'): Promise<Id> {
  const book = await createPackBook({ title, system, filename: 'pack.json' });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-pack',
    license: 'CC-BY-4.0',
    entriesImported: 1,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  return finished.id;
}

function renderSpells(campaignId: Id): void {
  window.history.replaceState(null, '', spellsPath(campaignId));
  render(<RouterProvider router={createAppRouter()} />);
}

beforeEach(async () => {
  await clearDatabase();
  await saveSettings({
    ...defaultSettings(),
    onboarding: { status: 'complete' as const, stepState: [] },
  });
});
afterEach(cleanup);

describe('spells page — campaign system scoping and ordering', () => {
  it('shows only the campaign system spells, never a cross-system book row', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const pf2eBook = await readyBook('PF2e Rules', 'pathfinder2e');
    const dndBook = await readyBook('D&D SRD', 'dnd5e');
    await putChunks([
      chunk(pf2eBook, 'Fireball', {}, spellData({ rank: 3, traditions: ['arcane', 'primal'] })),
      chunk(dndBook, 'Eldritch Blast', {}, spellData({ system: 'dnd5e', rank: 0, cantrip: true })),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');

    expect(await screen.findByText('Fireball')).toBeInTheDocument();
    // The dnd5e book's spell is not merely hidden by a filter — it is absent
    // from the DOM, because the book-id intersection dropped it.
    expect(screen.queryByText('Eldritch Blast')).not.toBeInTheDocument();
    expect(screen.getByTestId('spells-count')).toHaveTextContent('1 spell');
  });

  it('orders by rank with cantrips first and shows the corrupt row loudly', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const book = await readyBook('PF2e Rules', 'pathfinder2e');
    await putChunks([
      chunk(book, 'Zeta', {}, spellData({ rank: 3 })),
      chunk(book, 'Alpha', {}, spellData({ rank: 1 })),
      chunk(book, 'Ignition', {}, spellData({ rank: 0, cantrip: true })),
      chunk(book, 'Broken', {}, null),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');

    await waitFor(() => {
      expect(screen.getAllByTestId('spell-chip')).toHaveLength(3);
    });
    expect(screen.getAllByTestId('spell-chip').map((chip) => chip.textContent)).toEqual([
      'Ignition',
      'Alpha',
      'Zeta',
    ]);
    const error = screen.getByTestId('spell-data-error');
    expect(error).toHaveTextContent(/has no validated spell payload — re-import the rules pack/);
    expect(screen.getByTestId('spells-count')).toHaveTextContent('3 spells');
    expect(screen.getByTestId('spells-count')).toHaveTextContent('1 data error');
  });
});

describe('spells page — tradition filter and detail', () => {
  it('narrows by tradition (multi-select union) and explains an empty match', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const book = await readyBook('PF2e Rules', 'pathfinder2e');
    await putChunks([
      chunk(book, 'Force Barrage', {}, spellData({ traditions: ['arcane'] })),
      chunk(book, 'Heal', {}, spellData({ traditions: ['divine', 'primal'] })),
      chunk(book, 'Guidance', {}, spellData({ traditions: ['divine'] })),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    expect(await screen.findAllByTestId('spell-chip')).toHaveLength(3);

    await user.click(screen.getByTestId('spell-tradition-primal'));
    await waitFor(() => {
      expect(screen.getAllByTestId('spell-chip').map((chip) => chip.textContent)).toEqual(['Heal']);
    });

    await user.click(screen.getByTestId('spell-tradition-arcane'));
    await waitFor(() => {
      expect(screen.getAllByTestId('spell-chip').map((chip) => chip.textContent)).toEqual([
        'Force Barrage',
        'Heal',
      ]);
    });

    // Uncheck everything but a tradition no spell carries → the filter-empty
    // state, never a silent blank list.
    await user.click(screen.getByTestId('spell-tradition-primal'));
    await user.click(screen.getByTestId('spell-tradition-arcane'));
    await user.click(screen.getByTestId('spell-tradition-occult'));
    expect(await screen.findByTestId('spells-filter-empty')).toHaveTextContent(
      'No spells match the selected traditions.',
    );
  });

  it('opens the detail card on a chip click and shows the licence line', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const book = await readyBook('PF2e Rules', 'pathfinder2e');
    await putChunks([
      chunk(
        book,
        'Acid Splash',
        {},
        spellData({
          rank: 0,
          cantrip: true,
          traditions: ['arcane', 'primal'],
          traits: ['acid', 'attack', 'cantrip'],
          cast: { time: '2', range: '30 feet', target: '1 creature', duration: '' },
          heighteningEntries: [
            { kind: 'fixed', rank: 3, text: 'The initial damage increases to 2d6.' },
          ],
          heighteningUnparsed: ['Heightened (special) something odd.'],
        }),
      ),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    expect(screen.queryByTestId('spell-detail-card')).not.toBeInTheDocument();

    await user.click(await screen.findByTestId('spell-chip'));

    const card = await screen.findByTestId('spell-detail-card');
    expect(within(card).getByRole('heading', { name: 'Acid Splash' })).toBeInTheDocument();
    // A cantrip prints as a cantrip, never as a rank number.
    expect(card).toHaveTextContent('Cantrip');
    expect(within(card).getByTestId('spell-traditions')).toHaveTextContent('arcane');
    expect(within(card).getByTestId('spell-traditions')).toHaveTextContent('primal');
    expect(within(card).getByTestId('spell-traits')).toHaveTextContent('acid');
    // Cast facts, the heightening entry VERBATIM, and the unparsed line loudly.
    expect(card).toHaveTextContent('30 feet');
    expect(within(card).getByTestId('spell-heightening')).toHaveTextContent('Heightened (3rd)');
    expect(within(card).getByTestId('spell-heightening')).toHaveTextContent(
      'The initial damage increases to 2d6.',
    );
    expect(within(card).getByTestId('spell-heightening-unparsed')).toHaveTextContent(
      'Heightened (special) something odd.',
    );
    // THE LICENCE: the stored rules text's own Source line reaches the card.
    expect(within(card).getByTestId('spell-description')).toHaveTextContent(LICENSE_LINE);
  });
});

describe('spells page — empty states per system', () => {
  it('says spells are not imported for D&D 5e', async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-not-imported');
    expect(notice).toHaveTextContent('Spells are not imported for D&D 5e');
    expect(screen.queryByTestId('spell-list')).not.toBeInTheDocument();
  });

  it('names the missing Pathfinder 2e rules material and offers the import remedy', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-material');
    expect(notice).toHaveTextContent('No spells imported for Pathfinder 2e');
    expect(screen.getByTestId('spells-import-remedy')).toHaveAttribute('href', '/rules');
  });
});
