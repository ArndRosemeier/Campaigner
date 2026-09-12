import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import { workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
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
    // The banner is AGGREGATE ("1 encounter entry cites…"), so it quotes the
    // reason's STEM, not one creature's name — the named `missing ref (Name)`
    // belongs on the row badge, where a row names exactly one creature. The
    // copy is still exactly true: every reason starts with this stem, and the
    // library (the rules link) is the only remedy there is.
    expect(banner.textContent).toContain("'missing ref'");
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

  it('uses ASCII quotes around the named missing ref (no curly-quote mojibake)', async () => {
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
    expect(banner.textContent).toContain("'missing ref'");
    expect(banner.textContent).not.toContain('‘');
    expect(banner.textContent).not.toContain('’');
  });

  it('clears when byte-identical content is installed under a new uuid (the owner case)', async () => {
    // An import-anyway landing: the cited uuid exists nowhere, but the
    // citation carries the content hash stamped at birth (or healed at
    // import) — the L0-exact Monster Core install below mints new row ids.
    const text = 'Goblin Warrior stat block';
    const contentHash = await sha256Hex(text);
    const campaign = await createCampaign({ name: 'Healed', system: 'pathfinder2e' });
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
          source: { type: 'rulebook', chunkId: newId(), contentHash, creatureName: 'Goblin Warrior' },
        },
      ]) as never,
    });
    renderBannerAt(campaign.id);
    await screen.findByTestId('missing-refs-banner');

    cleanup();
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: statBlockSchema.parse({
          system: 'pathfinder2e',
          level: '1',
          size: 'Small',
          creatureType: 'humanoid',
          ac: 15,
          acNote: '',
          hp: 7,
          hpFormula: '2d6',
          speed: '25 ft.',
          abilities: { str: 10, dex: 12, con: 10, int: 8, wis: 10, cha: 8 },
          saves: '',
          skills: '',
          senses: '',
          languages: '',
          traits: [],
          actions: [],
          reactions: [],
          legendary: [],
          extras: {},
        }),
        contentHash,
      }),
    ]);

    // The banner derives from the same resolve contract as the rows: the
    // byte-identical install clears it with no re-import, no flag.
    renderBannerAt(campaign.id);
    await waitFor(() => {
      expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
    });
  });
});
