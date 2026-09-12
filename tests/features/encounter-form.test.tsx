import 'fake-indexeddb/auto';

import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type EncounterArtifactData,
  type GameSystem,
  type Id,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { EncounterForm } from '@/features/campaign/components/kind-forms';
import { createRulebook, createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from '../db/helpers';

/**
 * Encounter editor monster sources (07-MILESTONE-3 M3-B): a per-row source
 * selector (NPC link / rulebook / inline / none) and the resolved
 * "Stat blocks" panel with origin badges — dangling refs show a visible
 * "missing ref" warning instead of crashing.
 */

function statBlock(system: GameSystem = 'dnd5e'): StatBlock {
  return statBlockSchema.parse({
    system,
    level: '3',
    size: 'Large',
    creatureType: 'giant',
    ac: 15,
    acNote: '',
    hp: 84,
    hpFormula: '',
    speed: '',
    abilities: { str: 18, dex: 10, con: 16, int: 6, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

describe('encounter form monster sources', () => {
  beforeEach(clearDatabase);

  it('resolves NPC links and rulebook refs, flagging dangling ones', async () => {
    const campaign = await createCampaign({ name: 'C', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Vexra',
      data: {
        appearance: '',
        personality: '',
        statBlock: statBlock(),
      },
    });
    const data: EncounterArtifactData = {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [
        { name: 'Vexra', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: npc.id } },
        { name: 'Ghost', count: 1, notes: '', treasure: '', source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-0000000000999' } },
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
    };
    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
        onChange={vi_noop}
      />,
    );

    const panel = await screen.findByTestId('stat-blocks-panel');
    expect(panel).toBeInTheDocument();
    // NPC link resolves with origin badge.
    await screen.findByText('NPC: Vexra');
    // Dangling rulebook chunk → warning badge, no crash.
    // The reason is NAMED (`missing ref (Ghost)`, docs/11 D9) and the badge
    // renders it in its compact form — the roster row already shows the
    // creature's name right beside it, so the badge does not repeat it.
    await screen.findByText('missing ref');
    expect(await screen.findByText('Ghost')).toBeInTheDocument();
    // The resolved stat block card renders the NPC's stats.
    await waitFor(() => {
      expect(screen.getAllByText('AC').length).toBeGreaterThan(0);
    });
  });

  it('switches a row to inline stats via the source selector', async () => {
    const user = userEvent.setup();
    const data: EncounterArtifactData = {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Bandit', count: 4, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    let latest: EncounterArtifactData | null = null;

    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={(next) => {
          latest = next;
        }}
      />,
    );

    await user.click(screen.getByLabelText('Stats source for Bandit'));
    // Under full-suite parallel load the popup can lag; wait for it.
    await user.click(
      await screen.findByRole('option', { name: 'Inline stats' }, { timeout: 5_000 }),
    );
    // The dialog opens with an empty inline stat block; add one.
    await user.click(
      await screen.findByRole('button', { name: 'Add stat block' }, { timeout: 5_000 }),
    );
    await waitFor(() => {
      expect(latest?.monsters[0]?.source.type).toBe('inline');
    });
  });

  it('the rulebook-link dialog never lists an unparsed statblock chunk (fix-02 decision 3)', async () => {
    const user = userEvent.setup();
    await createCampaign({ name: 'C', system: 'dnd5e' });
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
      pageCount: 2,
    });
    await db.rulebooks.update(book.id, { status: 'ready' });
    const parsed = await makeChunk(book.id, 'Hill Giant stats.', ['Hill Giant'], statBlock());
    await putChunks([
      parsed,
      // A detected stat block whose best-effort parse gave up: never citable.
      await makeChunk(book.id, 'Stone Giant (parse gave up).', ['Stone Giant'], null),
    ]);
    const data: EncounterArtifactData = {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Giant', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={vi_noop}
      />,
    );

    await user.click(screen.getByLabelText('Stats source for Giant'));
    await user.click(
      await screen.findByRole('option', { name: 'From rulebook…' }, { timeout: 5_000 }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Link a rulebook stat block/i });
    await user.type(within(dialog).getByPlaceholderText('Search stat blocks…'), 'giant');

    // Only the parsed chunk is offered; the null-statBlock chunk is absent.
    expect(await within(dialog).findByText('Hill Giant')).toBeInTheDocument();
    expect(within(dialog).queryByText('Stone Giant')).not.toBeInTheDocument();
  });

  it('the rulebook-link dialog never offers another system’s creatures (campaign-scoped pool)', async () => {
    const user = userEvent.setup();
    await createCampaign({ name: 'C', system: 'dnd5e' });
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
      pageCount: 2,
    });
    await db.rulebooks.update(book.id, { status: 'ready' });
    const pf2ePack = await createPackBook({
      title: 'PF2e Monster Core',
      system: 'pathfinder2e',
      filename: 'pf2e.zip',
    });
    await finalizePackBook(pf2ePack.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    await putChunks([
      await makeChunk(book.id, 'Hill Giant stats.', ['Hill Giant'], statBlock()),
      await makeChunk(
        pf2ePack.id,
        'Kobold Warrior stats.',
        ['Kobold Warrior'],
        statBlock('pathfinder2e'),
      ),
    ]);
    const data: EncounterArtifactData = {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Giant', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={vi_noop}
      />,
    );

    await user.click(screen.getByLabelText('Stats source for Giant'));
    await user.click(
      await screen.findByRole('option', { name: 'From rulebook…' }, { timeout: 5_000 }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Link a rulebook stat block/i });
    await user.type(within(dialog).getByPlaceholderText('Search stat blocks…'), 'stats');

    // The same-system PDF chunk is offered; the pf2e pack creature is not —
    // cross-system links are impossible by construction.
    expect(await within(dialog).findByText('Hill Giant')).toBeInTheDocument();
    expect(within(dialog).queryByText('Kobold Warrior')).not.toBeInTheDocument();
  });

  it('stamps content identity when the rulebook-link dialog cites a chunk', async () => {
    const user = userEvent.setup();
    await createCampaign({ name: 'C', system: 'dnd5e' });
    const book = await createRulebook({
      title: 'Bestiary',
      system: 'dnd5e',
      filename: 'bestiary.pdf',
      pageCount: 2,
    });
    await db.rulebooks.update(book.id, { status: 'ready' });
    const text = 'Hill Giant stats, stamped.';
    const contentHash = await sha256Hex(text);
    const parsed = ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'statblock',
      headingPath: ['Hill Giant'],
      text,
      statBlock: statBlock(),
      contentHash,
    });
    await putChunks([parsed]);
    const data: EncounterArtifactData = {
      difficulty: '',
      levelHint: '',
      monsters: [{ name: 'Giant', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    let latest: EncounterArtifactData | null = null;
    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={(next) => {
          latest = next;
        }}
      />,
    );

    await user.click(screen.getByLabelText('Stats source for Giant'));
    await user.click(
      await screen.findByRole('option', { name: 'From rulebook…' }, { timeout: 5_000 }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Link a rulebook stat block/i });
    await user.type(within(dialog).getByPlaceholderText('Search stat blocks…'), 'giant');
    await user.click(await within(dialog).findByText('Hill Giant'));

    // Citation birth carries content identity, not just the uuid.
    await waitFor(() => {
      expect(latest?.monsters[0]?.source).toEqual({
        type: 'rulebook',
        chunkId: parsed.id,
        contentHash,
        creatureName: 'Hill Giant',
      });
    });
  });
});

async function makeChunk(
  bookId: Id,
  text: string,
  headingPath: string[],
  statBlock: StatBlock | null,
): Promise<RuleChunk> {
  return ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath,
    text,
    statBlock,
    contentHash: await sha256Hex(text),
  });
}

function vi_noop(): (data: EncounterArtifactData) => void {
  return () => undefined;
}

describe('encounter form site shape, path reorder and target levels (docs/11 D11/D12)', () => {
  beforeEach(clearDatabase);

  function StatefulEncounterForm({ initial }: { initial: EncounterArtifactData }) {
    const [data, setData] = useState(initial);
    return <EncounterForm data={data} campaignArtifacts={[]} campaignSystem="dnd5e" onChange={setData} />;
  }

  function singleData(overrides: Partial<EncounterArtifactData> = {}): EncounterArtifactData {
    return {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
      ...overrides,
    };
  }

  it('labels the selector Encounter/Dungeon and writes the owner choice', async () => {
    const user = userEvent.setup();
    render(<StatefulEncounterForm initial={singleData()} />);
    const trigger = screen.getByRole('combobox', { name: 'Site shape' });
    expect(trigger).toHaveTextContent('Encounter');
    await user.click(trigger);
    // findBy, not get: the select popup mounts through a positioned portal
    // on a timed update, so a sync query can outrun it under load (the
    // transient full-suite flake in this test).
    await user.click(await screen.findByRole('option', { name: 'Dungeon (complex)' }));
    expect(screen.getByRole('combobox', { name: 'Site shape' })).toHaveTextContent('Dungeon');
  });

  it('disables the shape the battlemap on file cannot hold', async () => {
    const user = userEvent.setup();
    const twoRooms = {
      ...singleData({ siteShape: 'complex' }),
      layout: {
        gridW: 24,
        gridH: 18,
        theme: 't',
        rooms: [
          {
            id: '00000000-0000-4000-8000-0000000000c1', name: 'A',
            rects: [{ x: 1, y: 1, w: 6, h: 6 }], mobsRect: { x: 2, y: 2, w: 4, h: 4 },
            description: '', monsterIndexes: [], spawn: true, key: '', keyTreasure: '',
          },
          {
            id: '00000000-0000-4000-8000-0000000000c2', name: 'B',
            rects: [{ x: 10, y: 1, w: 6, h: 6 }], mobsRect: { x: 11, y: 2, w: 4, h: 4 },
            description: '', monsterIndexes: [], spawn: false, key: '', keyTreasure: '',
          },
        ],
        corridors: [],
      },
    };
    render(<StatefulEncounterForm initial={twoRooms} />);
    await user.click(screen.getByRole('combobox', { name: 'Site shape' }));
    // findBy, not get — the popup's portal mount is timed (see above).
    const single = await screen.findByRole('option', { name: 'Encounter (single)' });
    expect(single).toHaveAttribute('data-disabled');
    expect(await screen.findByRole('option', { name: 'Dungeon (complex)' })).not.toHaveAttribute(
      'data-disabled',
    );
  });

  it('shows the budget advisory from the generation loop', () => {
    render(<StatefulEncounterForm initial={singleData({ budgetAdvisory: 'Room "Arena" ships over its challenge budget.' })} />);
    expect(screen.getByTestId('budget-advisory')).toHaveTextContent('ships over its challenge budget');
  });

  it('edits a room target level (owner-corrected challenge target)', async () => {
    const user = userEvent.setup();
    render(<StatefulEncounterForm initial={twoRoomData()} />);
    await user.type(screen.getByTestId('room-target-level-0'), '6');
    const label = screen.getByTestId('room-keys-editor');
    expect(label).toBeInTheDocument();
    // The stateful harness re-renders with the typed value; read the input.
    expect(screen.getByTestId('room-target-level-0')).toHaveValue(6);
  });

  it('reorders the dungeon path from the Room Keys section without touching the rooms array', async () => {
    const user = userEvent.setup();
    render(<StatefulEncounterForm initial={twoRoomData()} />);
    // Path order starts as the rooms array order: Entry (path 1), Sanctum (path 2).
    expect(screen.getByTestId('room-key-label-0')).toHaveTextContent('Room A — Entry (path 1)');
    expect(screen.getByTestId('room-key-label-1')).toHaveTextContent('Room B — Sanctum (path 2)');
    await user.click(screen.getByTestId('room-move-down-0'));
    // Sanctum is now path room 1; the ROOMS array (rects/keys) is untouched.
    expect(screen.getByTestId('room-key-label-0')).toHaveTextContent('Room B — Sanctum (path 1)');
    expect(screen.getByTestId('room-key-label-1')).toHaveTextContent('Room A — Entry (path 2)');
  });
});

describe('encounter form fill grade (docs/11 D12 amendment)', () => {
  beforeEach(clearDatabase);

  function FillGradeHarness({ initial }: { initial: EncounterArtifactData }) {
    const [data, setData] = useState(initial);
    return <EncounterForm data={data} campaignArtifacts={[]} campaignSystem="dnd5e" onChange={setData} />;
  }

  it('offers the fill-grade input for complexes only (empty = drawn once)', () => {
    const { unmount } = render(<FillGradeHarness initial={twoRoomData()} />);
    const input = screen.getByRole('spinbutton', { name: 'Fill grade' });
    expect(input).toHaveValue(null);
    expect(screen.getByText(/Left empty, the first map generation draws one/)).toBeInTheDocument();
    // Honesty copy (docs/11 D18 two-button regeneration): the fill grade
    // restocks nothing by itself — Repopulate / Regenerate everything do.
    expect(screen.getByText(/restocks nothing by itself/)).toBeInTheDocument();
    expect(screen.getByText(/press Repopulate for a new roster/)).toBeInTheDocument();
    expect(screen.getByText(/the only automatic generation/)).toBeInTheDocument();
    unmount();
    // A single arena has no rooms to stock — no field, honest copy.
    render(<EncounterForm data={singleComplexFree()} campaignArtifacts={[]} campaignSystem="dnd5e" onChange={vi_noop()} />);
    expect(screen.queryByRole('spinbutton', { name: 'Fill grade' })).not.toBeInTheDocument();
  });

  it('writes an owner-set fill grade and clears back to auto (the field unsets)', async () => {
    const user = userEvent.setup();
    render(<FillGradeHarness initial={twoRoomData()} />);
    const input = screen.getByRole('spinbutton', { name: 'Fill grade' });
    await user.type(input, '65');
    expect(input).toHaveValue(65);
    // The stateful harness re-rendered with the typed value — clear it back
    // to unset (auto) and the field empties again.
    await user.clear(input);
    expect(input).toHaveValue(null);
  });

  /** A single-site fixture without a layout (the field must be absent). */
  function singleComplexFree(): EncounterArtifactData {
    return {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
    };
  }
});

/** A complex two-room fixture (Entry spawn first, Sanctum second). */
function twoRoomData(): EncounterArtifactData {
  return {
    difficulty: 'hard',
    levelHint: '4',
    monsters: [],
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    preset: 'standard',
    locationKind: 'dungeon',
    siteShape: 'complex',
    budgetAdvisory: '',
    layout: {
      gridW: 24,
      gridH: 18,
      theme: 'ash temple',
      rooms: [
        {
          id: '00000000-0000-4000-8000-0000000000b1', name: 'Entry',
          rects: [{ x: 1, y: 1, w: 6, h: 6 }], mobsRect: { x: 2, y: 2, w: 4, h: 4 },
          description: '', monsterIndexes: [], spawn: true, key: '', keyTreasure: '',
        },
        {
          id: '00000000-0000-4000-8000-0000000000b2', name: 'Sanctum',
          rects: [{ x: 10, y: 1, w: 6, h: 6 }], mobsRect: { x: 11, y: 2, w: 4, h: 4 },
          description: '', monsterIndexes: [], spawn: false, key: '', keyTreasure: '',
        },
      ],
      corridors: [],
    },
  };
}

describe('encounter form map style override (docs/11 natural-site mode)', () => {
  beforeEach(clearDatabase);

  function singleData(overrides: Partial<EncounterArtifactData> = {}): EncounterArtifactData {
    return {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
      ...overrides,
    };
  }

  it('defaults to Auto (the field stays unset = derive from the site classification)', async () => {
    const user = userEvent.setup();
    let latest: EncounterArtifactData | null = null;
    render(
      <StatefulEncounterFormSwitch initial={singleData()} onChange={(next) => { latest = next; }} />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Map style' });
    expect(trigger).toHaveTextContent('Auto (from site)');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Natural site' }));
    await waitFor(() => {
      expect(latest?.mapMode).toBe('natural');
    });
    await user.click(screen.getByRole('combobox', { name: 'Map style' }));
    await user.click(await screen.findByRole('option', { name: 'Dungeon (architectural)' }));
    await waitFor(() => {
      expect(latest?.mapMode).toBe('architectural');
    });
    // Back to Auto: the owner clears the override (derive again).
    await user.click(screen.getByRole('combobox', { name: 'Map style' }));
    await user.click(await screen.findByRole('option', { name: 'Auto (from site)' }));
    await waitFor(() => {
      expect(latest?.mapMode).toBeUndefined();
    });
  });

  it('writes the forced modes through the controlled harness', async () => {
    const user = userEvent.setup();
    render(<StatefulEncounterFormSwitch initial={singleData({ mapMode: 'natural' })} onChange={() => undefined} />);
    expect(screen.getByRole('combobox', { name: 'Map style' })).toHaveTextContent('Natural site');
    await user.click(screen.getByRole('combobox', { name: 'Map style' }));
    await user.click(await screen.findByRole('option', { name: 'Dungeon (architectural)' }));
    expect(screen.getByRole('combobox', { name: 'Map style' })).toHaveTextContent('Dungeon');
  });
});

/** Controlled harness variant whose onChange is passed explicitly (the
 * stateful ones above own their state; this one reports every patch). */
function StatefulEncounterFormSwitch({
  initial,
  onChange,
}: {
  initial: EncounterArtifactData;
  onChange: (data: EncounterArtifactData) => void;
}) {
  const [data, setData] = useState(initial);
  return (
    <EncounterForm
      data={data}
      campaignArtifacts={[]}
      campaignSystem="dnd5e"
      onChange={(next) => {
        setData(next);
        onChange(next);
      }}
    />
  );
}

describe('encounter form room keys + mob treasure (owner-ratified arc)', () => {
  beforeEach(clearDatabase);

  /** Controlled harness: EncounterForm is a controlled component — the
   *  parent owns the data, so keystrokes must feed back through state. */
  function StatefulEncounterForm({ initial }: { initial: EncounterArtifactData }) {
    const [data, setData] = useState(initial);
    return <EncounterForm data={data} campaignArtifacts={[]} campaignSystem="dnd5e" onChange={setData} />;
  }

  function layoutData(): EncounterArtifactData {
    return {
      difficulty: 'hard',
      levelHint: '4',
      monsters: [{ name: 'Ash Cultist', count: 2, notes: '', treasure: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'complex',
      budgetAdvisory: '',
      layout: {
        gridW: 24,
        gridH: 18,
        theme: 'ash temple',
        rooms: [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            name: 'Entry',
            rects: [{ x: 1, y: 1, w: 8, h: 6 }],
            mobsRect: { x: 2, y: 2, w: 5, h: 4 },
            description: '',
            monsterIndexes: [],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
          {
            id: '00000000-0000-4000-8000-0000000000a2',
            name: 'Sanctum',
            rects: [{ x: 10, y: 1, w: 10, h: 8 }],
            mobsRect: { x: 12, y: 3, w: 6, h: 4 },
            description: '',
            monsterIndexes: [0],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      },
    };
  }

  it('edits mob treasure per roster row', async () => {
    const user = userEvent.setup();
    render(
      <StatefulEncounterForm
        initial={{
          difficulty: '',
          levelHint: '',
          monsters: [{ name: 'Bandit', count: 4, notes: '', treasure: '', source: { type: 'none' } }],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
        }}
      />,
    );
    await user.type(screen.getByLabelText('Treasure carried by one Bandit'), 'Pouch: 5 gp');
    expect(screen.getByLabelText('Treasure carried by one Bandit')).toHaveValue('Pouch: 5 gp');
  });

  it('edits per-room key and room treasure when a layout exists', async () => {
    const user = userEvent.setup();
    render(<StatefulEncounterForm initial={layoutData()} />);
    expect(screen.getByTestId('room-keys-editor')).toBeInTheDocument();
    expect(screen.getByTestId('room-key-label-0')).toHaveTextContent('Room A — Entry');
    expect(screen.getByTestId('room-key-label-1')).toHaveTextContent('Room B — Sanctum');

    await user.type(screen.getByLabelText('Room A key'), 'Cracked doors hang off one hinge.');
    await user.type(screen.getByLabelText('Room A treasure'), 'Fallen banner: 15 gp');
    expect(screen.getByLabelText('Room A key')).toHaveValue('Cracked doors hang off one hinge.');
    expect(screen.getByLabelText('Room A treasure')).toHaveValue('Fallen banner: 15 gp');
    // The sibling room is untouched by the Room A edits.
    expect(screen.getByLabelText('Room B key')).toHaveValue('');
  });

  it('offers no room-keys editor without a layout', () => {
    render(
      <EncounterForm
        data={{
          difficulty: '',
          levelHint: '',
          monsters: [{ name: 'Bandit', count: 1, notes: '', treasure: '', source: { type: 'none' } }],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          layout: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
        }}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={vi_noop()}
      />,
    );
    expect(screen.queryByTestId('room-keys-editor')).not.toBeInTheDocument();
  });
});
