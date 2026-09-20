import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import { spellsPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, createRulebook, failPackBook, finalizePackBook, updateRulebook } from '@/db/rulebookRepo';
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
  it('names the missing D&D 5e material and offers the import remedy (the 5e lane exists now)', async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-material');
    expect(notice).toHaveTextContent('No spells imported for D&D 5e');
    expect(notice).toHaveTextContent('D&D 5e SRD spells pack');
    expect(screen.getByTestId('spells-import-remedy')).toHaveAttribute('href', '/rules');
    // The old "spells are not imported for D&D 5e" claim is GONE: the lane
    // exists, so a dnd5e campaign with no imported spells says exactly that.
    expect(screen.queryByTestId('spells-not-imported')).not.toBeInTheDocument();
  });

  it('names the missing Pathfinder 2e rules material and offers the import remedy', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-material');
    expect(notice).toHaveTextContent('No spells imported for Pathfinder 2e');
    expect(screen.getByTestId('spells-import-remedy')).toHaveAttribute('href', '/rules');
  });

  it('names the RE-IMPORT remedy when ready books of the system carry no spell data (docs/12 §15.4)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const book = await readyBook('PF2e Rules', 'pathfinder2e');
    // A pre-arc rules pack: honest `section` chunks with no `spellData` — the
    // library that needs RE-IMPORTING, not a missing pack. The distinction is
    // read from the ready book the page already loaded, never guessed.
    await putChunks([chunk(book, 'Cat Fall', { chunkType: 'section' }, null)]);

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-spell-data');
    expect(notice).toHaveTextContent('No spell data in your Pathfinder 2e library');
    expect(notice).toHaveTextContent('Re-import the Pathfinder 2e rules-text pack');
    expect(screen.getByTestId('spells-import-remedy')).toHaveAttribute('href', '/rules');
    // It is NOT the no-material state: a ready book of this system exists.
    expect(screen.queryByTestId('spells-no-material')).not.toBeInTheDocument();
  });

  it('keeps the FILTERED empty state when spells exist but the filter excludes them', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const book = await readyBook('PF2e Rules', 'pathfinder2e');
    await putChunks([chunk(book, 'Force Barrage', {}, spellData({ traditions: ['arcane'] }))]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    expect(await screen.findAllByTestId('spell-chip')).toHaveLength(1);

    await user.click(screen.getByTestId('spell-tradition-occult'));

    expect(await screen.findByTestId('spells-filter-empty')).toHaveTextContent(
      'No spells match the selected traditions.',
    );
    // Neither corpus-level empty state appears while a spell list exists.
    expect(screen.queryByTestId('spells-no-material')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spells-no-spell-data')).not.toBeInTheDocument();
  });
});

/**
 * A same-system book that is NOT ready is NAMED (docs/17 row 277).
 *
 * The page read READY books only, so a same-system book that was still
 * importing — or that had failed — made it claim "No spells imported for
 * <system>", i.e. told the owner to import what was already importing. The
 * stated empty state now names those books and each one's own situation; a
 * READY book still takes today's path, and a book of another system never
 * triggers it.
 */
describe('spells page — a same-system book that is not ready is named (row 277)', () => {
  it('names a still-importing same-system book instead of claiming nothing is imported', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    await createPackBook({
      title: 'PF2e Rules Pack',
      system: 'pathfinder2e',
      filename: 'pack.json',
    });

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-not-ready');
    expect(notice).toHaveTextContent('PF2e Rules Pack');
    expect(notice).toHaveTextContent('still importing');
    expect(notice).toHaveTextContent('the spell list appears here when the import finishes');
    // The defect this closes: the old copy said exactly this while the pack WAS
    // importing.
    expect(screen.queryByTestId('spells-no-material')).not.toBeInTheDocument();
    expect(screen.getByTestId('spells-import-remedy')).toHaveAttribute('href', '/rules');
  });

  it('names a FAILED pack import and points at the pack remedy', async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    const pack = await createPackBook({
      title: 'SRD Spells',
      system: 'dnd5e',
      filename: 'pack.json',
    });
    await failPackBook(pack.id, 'no valid spell entries in the pack selection (0 skipped, 3 failed)');

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-not-ready');
    expect(notice).toHaveTextContent('No spells imported yet for D&D 5e');
    expect(notice).toHaveTextContent('SRD Spells');
    expect(notice).toHaveTextContent('import this pack again');
    // The remedy is the BOOK's own: a pack is never told to re-pick a PDF.
    expect(notice).not.toHaveTextContent('Retry');
    expect(screen.queryByTestId('spells-no-material')).not.toBeInTheDocument();
  });

  it('names a FAILED PDF import and points at its own Retry control', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const pdf = await createRulebook({
      title: 'Core Rulebook',
      system: 'pathfinder2e',
      filename: 'core.pdf',
    });
    await updateRulebook(pdf.id, { status: 'error', errorMessage: 'extraction failed' });

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-not-ready');
    expect(notice).toHaveTextContent('Core Rulebook');
    expect(notice).toHaveTextContent('"Retry…"');
    expect(notice).not.toHaveTextContent('import this pack again');
  });

  it('a not-ready book of ANOTHER system never triggers the named state', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    await createPackBook({ title: 'SRD Spells', system: 'dnd5e', filename: 'pack.json' });

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-material');
    expect(notice).toHaveTextContent('No spells imported for Pathfinder 2e');
    expect(screen.queryByTestId('spells-not-ready')).not.toBeInTheDocument();
  });

  it("a READY book keeps today's path even while another same-system book imports", async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    await readyBook('PF2e Rules', 'pathfinder2e');
    await createPackBook({
      title: 'PF2e Bestiary',
      system: 'pathfinder2e',
      filename: 'pack.json',
    });

    renderSpells(campaign.id);

    const notice = await screen.findByTestId('spells-no-spell-data');
    expect(notice).toHaveTextContent('Re-import the Pathfinder 2e rules-text pack');
    expect(screen.queryByTestId('spells-not-ready')).not.toBeInTheDocument();
  });
});

describe('spells page — the dnd5e lane and its OWN filter axis (row 194)', () => {
  function dnd5eSpellData(over: Partial<SpellData> = {}): SpellData {
    return spellData({
      system: 'dnd5e',
      rank: 3,
      cantrip: false,
      traditions: [],
      school: 'evo',
      filterAxis: 'school',
      properties: ['vocal', 'somatic'],
      count: undefined,
      ...over,
    } as Partial<SpellData>);
  }

  async function fiveEB(): Promise<Id> {
    return readyBook('SRD Spells', 'dnd5e');
  }

  it('shows a dnd5e campaign its 5e spells with LEVEL wording and the SCHOOL filter, never PF2e traditions', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    const book = await fiveEB();
    await putChunks([
      chunk(book, 'Fire Bolt', {}, dnd5eSpellData({ rank: 0, cantrip: true })),
      chunk(book, 'Fireball', {}, dnd5eSpellData({ rank: 3, school: 'evo' })),
      chunk(book, 'Cure Wounds', {}, dnd5eSpellData({ rank: 1, school: 'abj' })),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    expect(await screen.findAllByTestId('spell-chip')).toHaveLength(3);
    // The rank wording is dnd5e's own.
    expect(screen.getByTestId('spell-list')).toHaveTextContent('Level 3');
    expect(screen.getByTestId('spell-list')).toHaveTextContent('Level 1');
    expect(screen.getByTestId('spell-list')).toHaveTextContent('Cantrip');
    expect(screen.getByTestId('spell-list')).not.toHaveTextContent('Rank 3');
    // The STRIP says which axis it is, and it is the system's own.
    expect(screen.getByTestId('spell-filter-axis')).toHaveTextContent('Schools');
    expect(screen.getByTestId('spell-filter')).not.toHaveTextContent('Traditions');
    expect(screen.queryByTestId('spell-tradition-arcane')).not.toBeInTheDocument();

    // Filtering by a school keeps exactly that school's spells (union).
    await user.click(screen.getByTestId('spell-school-evo'));
    await waitFor(() => {
      expect(screen.getAllByTestId('spell-chip').map((chip) => chip.textContent)).toEqual([
        'Fire Bolt',
        'Fireball',
      ]);
    });
    await user.click(screen.getByTestId('spell-school-abj'));
    await waitFor(() => {
      expect(screen.getAllByTestId('spell-chip')).toHaveLength(3);
    });
    // A school NO spell carries → the filter-empty state names SCHOOLS.
    await user.click(screen.getByTestId('spell-school-evo'));
    await user.click(screen.getByTestId('spell-school-abj'));
    await user.click(screen.getByTestId('spell-school-ill'));
    expect(await screen.findByTestId('spells-filter-empty')).toHaveTextContent(
      'No spells match the selected schools.',
    );
  });

  it("a 5e spell with no school is LISTED honestly and says it has no filter axis", async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    const book = await fiveEB();
    await putChunks([
      chunk(book, 'Mystery Spell', {}, dnd5eSpellData({ rank: 2, school: '' })),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    expect(await screen.findAllByTestId('spell-chip')).toHaveLength(1);
    // It is LISTED, marked on the axis it does not state — never given an
    // invented school and never dropped from the list.
    expect(screen.getByTestId('spell-list')).toHaveTextContent('Mystery Spell');
    expect(screen.getByTestId('spell-list')).toHaveTextContent('no school');
    await userEvent.setup().click(screen.getByTestId('spell-chip'));
    const card = await screen.findByTestId('spell-detail-card');
    expect(card).toHaveTextContent('Mystery Spell');
    expect(within(card).queryByTestId('spell-school')).not.toBeInTheDocument();
  });

  it('a payload that names NO axis (a pre-arc row) is listed and says so', async () => {
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    const book = await fiveEB();
    await putChunks([
      chunk(
        book,
        'Legacy Spell',
        {},
        spellData({ system: 'dnd5e', rank: 2, cantrip: false, filterAxis: null }),
      ),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    const chip = await screen.findByTestId('spell-chip');
    expect(chip).toHaveTextContent('Legacy Spell');
    await userEvent.setup().click(chip);
    const card = await screen.findByTestId('spell-detail-card');
    expect(within(card).getByTestId('spell-no-filter-axis')).toHaveTextContent(
      'names no filter axis',
    );
  });

  it('shows the SCHOOL on the detail card and the source higher-level sentence VERBATIM', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ash', system: 'dnd5e' });
    const book = await fiveEB();
    await putChunks([
      chunk(
        book,
        'Fireball',
        {},
        dnd5eSpellData({
          rank: 3,
          school: 'evo',
          upcast: {
            baseLevel: 3,
            sentence:
              'When you cast this spell using a spell slot of 4th level or higher, the damage increases by 1d6 for each slot level above 3rd.',
            parts: [],
          },
        }),
      ),
    ]);

    renderSpells(campaign.id);
    await screen.findByTestId('spells-page');
    await user.click(await screen.findByTestId('spell-chip'));
    const card = await screen.findByTestId('spell-detail-card');
    expect(within(card).getByTestId('spell-school')).toHaveTextContent('Evocation');
    expect(card).toHaveTextContent('Level 3');
    expect(card).not.toHaveTextContent('Rank 3');
    // VERBATIM — the source's own sentence, never a computed number.
    expect(within(card).getByTestId('spell-upcast')).toHaveTextContent(
      'When you cast this spell using a spell slot of 4th level or higher, the damage increases by 1d6 for each slot level above 3rd.',
    );
  });
});
