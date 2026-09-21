import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { globalArtifactSchema, stampNewEntity, statBlockSchema } from '@/domain';
import type { MonsterEntry } from '@/domain';
import { workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { MissingRefsBanner } from '@/features/campaign/components/missing-refs-banner';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import {
  MISSING_REF_NAME_CAP,
  missingRefsSummary,
  type MissingRefStrand,
} from '@/features/campaign/components/missing-refs-summary';
import { clearDatabase, encounterDataFixture as encounterData } from '../db/helpers';

function renderBannerAt(campaignId: string): void {
  render(
    <MemoryRouter initialEntries={[workspacePath(campaignId)]}>
      <MissingRefsBanner />
    </MemoryRouter>,
  );
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
        { name: 'Custom thug', count: 1, notes: '', treasure: '', source: { type: 'none' as const } },
      ]) as never,
    });
    renderBannerAt(campaign.id);

    // The banner is absent BEFORE the live query settles too, so a bare
    // `waitFor(null)` returns on its first tick, proves nothing, and then lets
    // the query's late setState land outside act — which the console guard
    // fails. The drain is what waits for the READ (docs/17 row 272).
    await flushAsyncUpdates();
    expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
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

  it('RESOLVES a roster npc-ref to a GLOBAL library NPC — no `missing ref` (docs/17 row 263)', async () => {
    // The defect: `db/monsterResolve` injected the CAMPAIGN-ONLY `getArtifact`
    // while the battle seeder, the portrait queue and the cast path all pass the
    // any-scope one, so a roster link to a GLOBAL NPC rendered the loud
    // `missing ref` badge in its own workspace. The banner is the SAME resolve
    // contract the encounter rows render, so "the banner stays hidden" is the
    // honest render pin; the direct resolve below is its non-vacuity arm (the
    // GLOBAL row's own origin, not a missing-ref reason).
    const campaign = await createCampaign({ name: 'Global', system: 'dnd5e' });
    const global = globalArtifactSchema.parse({
      ...stampNewEntity(),
      campaignId: null,
      moduleId: null,
      kind: 'npc',
      name: 'Sage of the Vale',
      tags: [],
      aliases: [],
      summary: '',
      body: '',
      links: [],
      currentRevision: 1,
      imageIds: [],
      coverImageId: null,
      writerModel: '',
      data: {
        appearance: '',
        personality: '',
        statBlock: statBlockSchema.parse({
          system: 'dnd5e',
          level: '5',
          size: 'Medium',
          creatureType: 'humanoid',
          ac: 15,
          acNote: '',
          hp: 44,
          hpFormula: '8d8+8',
          speed: '30 ft.',
          abilities: { str: 12, dex: 14, con: 12, int: 16, wis: 13, cha: 11 },
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
      },
    });
    await db.artifacts.put(global);
    const entry: MonsterEntry = {
      name: 'Sage of the Vale',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: global.id },
    };
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'The sage arrives',
      data: encounterData([entry]) as never,
    });
    renderBannerAt(campaign.id);

    // The GLOBAL row answered, so no strand is missing — and the raw resolve
    // await is WRAPPED, not merely followed by a drain: a bare await of a Dexie
    // read hands the component's liveQuery the window to dispatch its setState
    // outside act (tests/helpers/flush.ts), which is the leak the full gate
    // failed here (docs/17 row 272). Draining inside the same act also makes the
    // negative assertion NON-VACUOUS: the `waitFor(null)` this replaced returned
    // before the query had run at all, so it proved nothing either way.
    const resolved = await actDrained(() => resolveMonsterEntryWithRepos(entry));
    expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
    expect(resolved.missingRef).toBeUndefined();
    expect(resolved.origin).toBe('NPC: Sage of the Vale');
    expect(resolved.statBlock?.ac).toBe(15);
  });

  it('still reports a genuinely ABSENT npc-ref loudly', async () => {
    const campaign = await createCampaign({ name: 'Gone', system: 'dnd5e' });
    const entry: MonsterEntry = {
      name: 'Nobody',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: '00000000-0000-4000-8000-0000000000aa' },
    };
    await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Nobody comes',
      data: encounterData([entry]) as never,
    });
    renderBannerAt(campaign.id);

    const banner = await screen.findByTestId('missing-refs-banner');
    expect(banner.textContent).toContain("'missing ref'");
    const resolved = await resolveMonsterEntryWithRepos(entry);
    expect(resolved.statBlock).toBeNull();
    expect(resolved.missingRef?.creature).toBe('Nobody');
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
          name: 'Vexra',
          count: 2,
          notes: '',
          treasure: '',
          // A dangling npc-ref: the SURVIVING missing-ref lane (docs/17 row 278).
          source: { type: 'npc-ref', artifactId: '00000000-0000-4000-8000-0000000000aa' },
        },
      ]) as never,
    });
    renderBannerAt(campaign.id);

    const banner = await screen.findByTestId('missing-refs-banner');
    expect(banner.textContent).toContain("'missing ref'");
    expect(banner.textContent).not.toContain('\u2018');
    expect(banner.textContent).not.toContain('\u2019');
  });

});

describe('missingRefsSummary', () => {
  const strand = (creature: string, bookTitle?: string): MissingRefStrand => ({
    encounter: 'Crypt',
    creature,
    ...(bookTitle === undefined ? {} : { bookTitle }),
  });

  it('prints no sentence for no strands', () => {
    expect(missingRefsSummary([])).toBe('');
  });

  it('lists exactly MISSING_REF_NAME_CAP names with no remainder, and one more WITH it', () => {
    const names = Array.from({ length: MISSING_REF_NAME_CAP + 1 }, (_, index) => `Mob ${String(index)}`);
    const atCap = missingRefsSummary(names.slice(0, MISSING_REF_NAME_CAP).map((name) => strand(name)));
    expect(atCap).toContain(`Missing: ${names.slice(0, MISSING_REF_NAME_CAP).join(', ')}.`);
    expect(atCap).not.toContain('more');

    const overCap = missingRefsSummary(names.map((name) => strand(name)));
    expect(overCap).toContain(`Missing: ${names.slice(0, MISSING_REF_NAME_CAP).join(', ')} (+1 more).`);
  });

  it('names every pack it was given, and states the unrecorded remainder', () => {
    const text = missingRefsSummary([
      strand('Zombie', 'Monster Manual'),
      strand('Ghoul', 'Monster Core'),
      strand('Skeleton'),
    ]);
    expect(text).toContain('The missing packs are «Monster Core», «Monster Manual».');
    expect(text).toContain('1 of 3 citations does not record which pack it was written from.');
  });

  it('says the pack was not recorded when NO strand knows one', () => {
    expect(missingRefsSummary([strand('Zombie')])).toContain(
      'The pack was not recorded when this citation was written.',
    );
    expect(missingRefsSummary([strand('Zombie'), strand('Ghoul')])).toContain(
      'The packs were not recorded when these citations were written.',
    );
  });
});
