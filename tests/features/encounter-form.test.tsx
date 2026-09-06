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
    await screen.findByText('missing ref');
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
        }}
        campaignArtifacts={[]}
        campaignSystem="dnd5e"
        onChange={vi_noop()}
      />,
    );
    expect(screen.queryByTestId('room-keys-editor')).not.toBeInTheDocument();
  });
});
