import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type EncounterArtifactData,
  type Id,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { EncounterForm } from '@/features/campaign/components/kind-forms';
import { createRulebook } from '@/db/rulebookRepo';
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

function statBlock(): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
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
        { name: 'Vexra', count: 1, notes: '', source: { type: 'npc-ref', artifactId: npc.id } },
        { name: 'Ghost', count: 1, notes: '', source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-0000000000999' } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
    };
    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[npc]}
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
      monsters: [{ name: 'Bandit', count: 4, notes: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
    };
    let latest: EncounterArtifactData | null = null;

    render(
      <EncounterForm
        data={data}
        campaignArtifacts={[]}
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
      monsters: [{ name: 'Giant', count: 1, notes: '', source: { type: 'none' } }],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
    };
    render(<EncounterForm data={data} campaignArtifacts={[]} onChange={vi_noop} />);

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
