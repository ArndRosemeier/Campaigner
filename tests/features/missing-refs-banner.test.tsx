import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { MissingRefsBanner } from '@/features/campaign/components/missing-refs-banner';
import { clearDatabase } from '../db/helpers';

function renderBannerAt(campaignId: string): void {
  render(
    <MemoryRouter initialEntries={[workspacePath(campaignId)]}>
      <MissingRefsBanner />
    </MemoryRouter>,
  );
}

function encounterData(monsters: unknown[]): Record<string, unknown> {
  return {
    difficulty: 'medium',
    levelHint: '1',
    monsters,
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
}

beforeEach(clearDatabase);
afterEach(cleanup);

/**
 * Missing-refs campaign banner (07-MILESTONE-3 M3-E slice B): null on clean
 * campaigns, loud with the Rules resolve path when encounters dangle.
 */
describe('MissingRefsBanner', () => {
  it('stays hidden when every encounter resolves', async () => {
    const campaign = await createCampaign({ name: 'Clean', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Dock talk',
      data: encounterData([
        { name: 'Custom thug', count: 1, notes: '', treasure: '', source: { type: 'none' } },
      ]) as never,
    });
    renderBannerAt(campaign.id);

    await waitFor(() => {
      expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
    });
  });

  it('shows with the Rules link when a rulebook citation dangles', async () => {
    const campaign = await createCampaign({ name: 'Gappy', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Goblin ambush',
      data: encounterData([
        {
          name: 'Goblin Warrior',
          count: 2,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: '00000000-0000-4000-8000-000000000000' },
        },
      ]) as never,
    });
    renderBannerAt(campaign.id);

    const banner = await screen.findByTestId('missing-refs-banner');
    expect(banner.textContent).toContain('missing ref');
    const link = await screen.findByTestId('missing-refs-rules-link');
    expect(link.getAttribute('href')).toBe('/rules');
  });

  it('shows for a dangling NPC ref too', async () => {
    const campaign = await createCampaign({ name: 'Nappy', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Vexra shows up',
      data: encounterData([
        {
          name: 'Vexra',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: '00000000-0000-4000-8000-000000000001' },
        },
      ]) as never,
    });
    renderBannerAt(campaign.id);

    await screen.findByTestId('missing-refs-banner');
  });

  it('stays hidden off campaign routes', async () => {
    render(
      <MemoryRouter initialEntries={['/rules']}>
        <MissingRefsBanner />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
    });
  });
});
