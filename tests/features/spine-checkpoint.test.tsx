import 'fake-indexeddb/auto';

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SpineCheckpoint } from '@/features/modules/spine-checkpoint';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';
import type { Campaign, ModuleEntityKind, ModuleSpine } from '@/domain';

/**
 * Spine approval checkpoint (08-MODULE-DESIGNER M4-B) with the fix-01
 * entities line: the normalized glossary is displayed read-only, with
 * absorbed variants shown next to their canonical entity.
 */

const SPINE: ModuleSpine = {
  premise: 'A harbor town raised its bell to warn of the drownings.',
  themes: ['duty', 'decay'],
  partPlan: [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives with the low tide.',
      levelUpTrigger: 'The bell is found.',
    },
  ],
};

let campaign: Campaign;

beforeEach(async () => {
  await clearDatabase();
  campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
});

afterEach(() => {
  // No chat is called here — the checkpoint is display + delegation only.
});

describe('SpineCheckpoint entities line (fix-01)', () => {
  it('lists canonical entities with their kinds and absorbed variants', () => {
    const entityKinds: ModuleEntityKind[] = [
      { name: 'Halmund', kind: 'npc', absorbed: ['Guard Halmund', 'Halmunds'] },
      { name: 'The Undercroft', kind: 'location', absorbed: [] },
    ];
    render(
      <SpineCheckpoint
        moduleId={campaign.id}
        campaign={campaign}
        spine={SPINE}
        busy={false}
        entityKinds={entityKinds}
      />,
    );
    const line = screen.getByTestId('spine-entities');
    expect(line).toHaveTextContent('Halmund (npc; also: Guard Halmund, Halmunds)');
    expect(line).toHaveTextContent('The Undercroft (location)');
  });

  it('shows no entities line for a glossary-less spine', () => {
    render(
      <SpineCheckpoint
        moduleId={campaign.id}
        campaign={campaign}
        spine={SPINE}
        busy={false}
        entityKinds={[]}
      />,
    );
    expect(screen.queryByTestId('spine-entities')).not.toBeInTheDocument();
  });
});
