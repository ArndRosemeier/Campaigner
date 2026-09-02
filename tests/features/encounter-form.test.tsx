import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { statBlockSchema, type EncounterArtifactData, type StatBlock } from '@/domain';
import { EncounterForm } from '@/features/campaign/components/kind-forms';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
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
        role: '',
        appearance: '',
        personality: '',
        motivation: '',
        secrets: '',
        voiceNotes: '',
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
});

function vi_noop(): (data: EncounterArtifactData) => void {
  return () => undefined;
}
