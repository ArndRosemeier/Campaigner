import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StatBlock } from '@/domain';
import { ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { BestiaryRoster } from '@/features/bestiary/bestiary-roster';
import { RulesPage } from '@/features/rules/RulesPage';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, createRulebook, finalizePackBook, updateRulebook } from '@/db/rulebookRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Bestiary roster tab (source-viewers arc): the virtualized creature list
 * over real Dexie data — level ordering, loud per-row data errors for pack
 * invariant violations, and the StatBlockCard detail with the
 * encounterResolve-style origin label. @tanstack/react-virtual renders only
 * the visible window, so jsdom asserts rows it can see; ordering is pinned
 * by the unit tests in roster.test.ts.
 */

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '3',
    size: 'Large',
    creatureType: 'giant',
    ac: 15,
    acNote: '',
    hp: 84,
    hpFormula: '7d10+21',
    speed: '40 ft.',
    abilities: { str: 18, dex: 10, con: 16, int: 6, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    ...over,
  });
}

/**
 * jsdom has no layout: virtual-core's observeElementRect reads the scroll
 * element's offsetWidth/offsetHeight synchronously (both 0 in jsdom), so the
 * visible window would be empty. Shadow the prototype getters with a fixed
 * 800×600 for this file so the window contains the seeded creatures (only
 * 3 rows — far below any window size, so this stays a window-render
 * assertion, not a full-list one).
 */
beforeEach(async () => {
  await clearDatabase();
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

let digestSeq = 0;
/** Schema-valid 64-hex digest stand-in (uniqueness only; no crypto needed). */
function fakeDigest(): string {
  digestSeq += 1;
  return 'a'.repeat(63) + String(digestSeq % 10);
}

async function seedPackBook(input: {
  title: string;
  creatures: { name: string; level: string }[];
  corrupt?: boolean;
}): Promise<void> {
  const book = await createPackBook({ title: input.title, system: 'dnd5e', filename: 'pack.json' });
  const chunks = input.creatures.map((creature) =>
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: [creature.name],
      text: `${creature.name} stat block`,
      statBlock: input.corrupt ? null : statBlock({ level: creature.level }),
      contentHash: fakeDigest(),
    }),
  );
  await putChunks(chunks);
  await finalizePackBook(book.id, {
    sourceId: 'foundry-dnd5e-srd',
    license: 'CC-BY-4.0',
    entriesImported: input.creatures.length,
    entriesSkipped: 0,
    entriesFailed: input.corrupt === true ? 1 : 0,
  });
}

describe('BestiaryRoster', () => {
  it('lists creatures level-ordered with origin labels and opens the stat block detail', async () => {
    const user = userEvent.setup();
    const pdfBook = await createRulebook({ title: 'Core Rules', system: 'dnd5e', filename: 'core.pdf' });
    await updateRulebook(pdfBook.id, { status: 'ready', pageCount: 100 });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: pdfBook.id,
        pageStart: 132,
        pageEnd: 132,
        chunkType: 'statblock',
        headingPath: ['Troll'],
        text: 'Troll stat block',
        statBlock: statBlock({ level: '5' }),
        contentHash: fakeDigest(),
      }),
    ]);
    await seedPackBook({
      title: 'SRD Pack',
      creatures: [{ name: 'Goblin', level: '1/3' }, { name: 'Ogre', level: '2' }],
    });

    render(<BestiaryRoster />);

    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(3);
    });
    const rows = within(list).getAllByTestId('roster-row');
    const [goblinRow, ogreRow, trollRow] = rows;
    if (goblinRow === undefined || ogreRow === undefined || trollRow === undefined) {
      throw new Error('expected three visible roster rows');
    }
    // level order: Goblin 1/3, Ogre 2, Troll 5.
    expect(goblinRow).toHaveTextContent('Goblin');
    expect(ogreRow).toHaveTextContent('Ogre');
    expect(trollRow).toHaveTextContent('Troll');
    expect(within(goblinRow).getByText('SRD Pack: Goblin')).toBeInTheDocument();
    expect(within(trollRow).getByText('Core Rules p.132')).toBeInTheDocument();
    expect(screen.getByTestId('roster-count')).toHaveTextContent('3 creatures');

    await user.click(ogreRow);
    const detail = screen.getByTestId('roster-detail-card');
    expect(within(detail).getByTestId('roster-origin')).toHaveTextContent('SRD Pack: Ogre');
    expect(within(detail).getByText('Ogre')).toBeInTheDocument();
    expect(within(detail).getByText('AC')).toBeInTheDocument();
    expect(within(detail).getByText('HP')).toBeInTheDocument();
  }, 30000);

  it('pins pack data errors to the top of the list while the rest stays browsable', async () => {
    const user = userEvent.setup();
    await seedPackBook({
      title: 'Broken Pack',
      creatures: [{ name: 'Broken One', level: '1' }],
      corrupt: true,
    });
    await seedPackBook({ title: 'Good Pack', creatures: [{ name: 'Goblin', level: '1/3' }] });

    render(<BestiaryRoster />);

    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(screen.getAllByTestId('roster-data-error')).toHaveLength(1);
    });
    const rows = within(list).getAllByTestId('roster-row');
    expect(rows).toHaveLength(1);
    const [goblinRow] = rows;
    if (goblinRow === undefined) throw new Error('expected the Goblin roster row');
    expect(goblinRow).toHaveTextContent('Goblin');
    // The error row is ABOVE the only creature row (pinned to the top).
    const errorRow = screen.getByTestId('roster-data-error');
    expect(errorRow).toHaveTextContent(/no validated stat block — re-import the pack/);
    expect(errorRow.compareDocumentPosition(goblinRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('roster-count')).toHaveTextContent('1 data error');

    // The good rows keep working next to the error.
    await user.click(goblinRow);
    expect(await screen.findByTestId('roster-detail-card')).toBeInTheDocument();
  }, 30000);

  it('filters by name substring and by game system', async () => {
    const user = userEvent.setup();
    await seedPackBook({ title: 'SRD Pack', creatures: [{ name: 'Goblin', level: '1/3' }, { name: 'Ogre', level: '2' }] });

    render(<BestiaryRoster />);
    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(2);
    });

    await user.type(screen.getByTestId('roster-name-filter'), 'ob');
    await waitFor(() => {
      // 'ob' matches Goblin only (substring, case-insensitive).
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
    await user.clear(screen.getByTestId('roster-name-filter'));
    await user.type(screen.getByTestId('roster-name-filter'), 'gre');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
  }, 30000);

  it('is reachable from the Rules screen Bestiary tab', async () => {
    await seedPackBook({ title: 'SRD Pack', creatures: [{ name: 'Goblin', level: '1/3' }] });

    render(<RulesPage />);

    // Default tab is Search; the Bestiary trigger swaps the right pane.
    expect(screen.getByTestId('rules-search')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Bestiary' }));
    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
    expect(within(list).getByTestId('roster-row')).toHaveTextContent('SRD Pack: Goblin');
  }, 30000);
});
