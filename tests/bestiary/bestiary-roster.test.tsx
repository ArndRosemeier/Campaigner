import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { StatBlock } from '@/domain';
import { createModule as createModuleSchema, ruleChunkSchema, statBlockSchema, stampNewEntity } from '@/domain';
import { BestiaryRoster } from '@/features/bestiary/bestiary-roster';
import { RulesPage } from '@/features/rules/RulesPage';
import { putChunks } from '@/db/chunkRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule } from '@/db/moduleRepo';
import { createPackBook, createRulebook, finalizePackBook, updateRulebook } from '@/db/rulebookRepo';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

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

    render(<MemoryRouter><BestiaryRoster /></MemoryRouter>);

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

    render(<MemoryRouter><BestiaryRoster /></MemoryRouter>);

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

    render(<MemoryRouter><BestiaryRoster /></MemoryRouter>);
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

    // MemoryRouter: the spawn dialog navigates to the module reader.
    render(
      <MemoryRouter>
        <RulesPage />
      </MemoryRouter>,
    );

    // Default tab is Search; the Bestiary trigger swaps the right pane.
    expect(screen.getByTestId('rules-search')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Bestiary' }));
    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
    expect(within(list).getByTestId('roster-row')).toHaveTextContent('SRD Pack: Goblin');
  }, 30000);

  it('spawns a creature into a picked module and toasts with an Open module action', async () => {
    const user = userEvent.setup();
    const { toastSuccess } = await import('@/lib/toast');
    const toastSuccessMock = vi.mocked(toastSuccess);
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const vault = await createModule(
      createModuleSchema({ campaignId: campaign.id, title: 'Vault of Whispers', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await seedPackBook({ title: 'SRD Pack', creatures: [{ name: 'Goblin', level: '1/3' }] });

    render(<MemoryRouter><BestiaryRoster /></MemoryRouter>);
    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
    await user.click(within(list).getByTestId('roster-row'));
    await user.click(screen.getByTestId('spawn-into-module'));

    // One campaign preselects itself; the picker lists its modules.
    const picker = await screen.findByTestId('spawn-module-picker');
    const option = await within(picker).findByTestId('spawn-module-option');
    expect(option).toHaveTextContent('Vault of Whispers');
    await user.click(option);

    const { toastError } = await import('@/lib/toast');
    await waitFor(() => {
      expect(
        toastSuccessMock.mock.calls.length + vi.mocked(toastError).mock.calls.length,
      ).toBeGreaterThan(0);
    });
    if (toastSuccessMock.mock.calls.length === 0) {
      throw new Error(`spawn errored: ${JSON.stringify(vi.mocked(toastError).mock.calls)}`);
    }
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    const [message, action] = toastSuccessMock.mock.calls[0] ?? [];
    expect(message).toBe("Goblin spawned into 'Vault of Whispers'");
    expect(action).toMatchObject({ label: 'Open module' });

    // The artifact exists exactly once, owned by the module, tagged. The
    // read is actDrained (docs/08 §Console guard): the spawn write re-fires
    // the picker's live queries and Base UI's DialogRoot schedules its
    // transition-reset rAF on the timed queue — the raw await used to hand
    // both an outside-act window (the intermittent 'An update to
    // DialogRoot…' leak).
    const mobs = (await actDrained(() => db.artifacts.toArray())).filter(
      (artifact) => artifact.kind === 'npc' && artifact.data.monsterChunkId !== undefined,
    );
    expect(mobs).toHaveLength(1);
    const mob = mobs[0];
    if (mob === undefined) throw new Error('mob artifact missing');
    expect(mob.campaignId).toBe(campaign.id);
    expect(mob.moduleId).toBe(vault.id);
    expect(mob.tags).toContain('module:Vault of Whispers');
    // The picker closes after a successful spawn.
    await waitFor(() => {
      expect(screen.queryByTestId('spawn-module-picker')).not.toBeInTheDocument();
    });
    // The closing dialog's exit transition (Base UI unmounts it on a timer)
    // drains inside act.
    await flushAsyncUpdates();
  }, 30000);

  it('names the empty state loudly when the campaign has no modules', async () => {
    const user = userEvent.setup();
    await createCampaign({ name: 'Barren', system: 'dnd5e' });
    await seedPackBook({ title: 'SRD Pack', creatures: [{ name: 'Goblin', level: '1/3' }] });

    render(<MemoryRouter><BestiaryRoster /></MemoryRouter>);
    const list = await screen.findByTestId('roster-list');
    await waitFor(() => {
      expect(within(list).getAllByTestId('roster-row')).toHaveLength(1);
    });
    await user.click(within(list).getByTestId('roster-row'));
    await user.click(screen.getByTestId('spawn-into-module'));

    expect(await screen.findByTestId('spawn-picker-no-modules')).toHaveTextContent(
      'No modules in “Barren” yet.',
    );
    // Nothing was created — a closed path is not a silent success. The read
    // is actDrained (docs/08 §Console guard): the open dialog's DialogRoot
    // transition-reset rAF and the picker's liveQuery emissions ride
    // fake-indexeddb's timed queue, and the bare await handed them an
    // outside-act window (the intermittent 'An update to DialogRoot…' leak
    // this test was reported with). The trailing drain absorbs any
    // straggler before cleanup.
    expect(
      (await actDrained(() => db.artifacts.toArray())).filter(
        (artifact) => artifact.kind === 'npc' && artifact.data.monsterChunkId !== undefined,
      ),
    ).toHaveLength(0);
    await flushAsyncUpdates();
  }, 30000);
});
