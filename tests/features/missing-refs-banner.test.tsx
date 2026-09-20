import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId, globalArtifactSchema, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import type { MonsterEntry } from '@/domain';
import { workspacePath } from '@/app/routes';
import { citationBookTitle, creatureOriginLabel } from '@/domain/encounterResolve';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { db } from '@/db/db';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { MissingRefsBanner } from '@/features/campaign/components/missing-refs-banner';
import {
  MISSING_REF_NAME_CAP,
  missingRefsSummary,
  type MissingRefStrand,
} from '@/features/campaign/components/missing-refs-summary';
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

    // The GLOBAL row answered, so no strand is missing.
    await waitFor(() => {
      expect(screen.queryByTestId('missing-refs-banner')).toBeNull();
    });
    const resolved = await resolveMonsterEntryWithRepos(entry);
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

/** A roster entry citing a chunk nothing in this library answers — the strand
 * shape every pin below is about. */
function missingEntry(name: string, source: Record<string, unknown> = {}): unknown {
  return {
    name,
    count: 1,
    notes: '',
    treasure: '',
    source: {
      type: 'rulebook',
      chunkId: '00000000-0000-4000-8000-0000000000ff',
      ...source,
    },
  };
}

async function bannerFor(entries: unknown[], encounterName = 'Goblin ambush'): Promise<string> {
  const campaign = await createCampaign({ name: 'Gappy', system: 'dnd5e' });
  await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: encounterName,
    data: encounterData(entries) as never,
  });
  renderBannerAt(campaign.id);
  const banner = await screen.findByTestId('missing-refs-banner');
  return banner.textContent;
}

/**
 * WHAT the banner names (docs/17 row 155): the creatures a campaign is missing
 * — the question the count alone left unanswered — and the pack to install
 * when the citation recorded one, or the plain statement that it did not.
 */
describe('the missing-refs banner names what is missing', () => {
  it('names the creature AND the pack a citation recorded', async () => {
    const text = await bannerFor([
      missingEntry('Zombie', { creatureName: 'Zombie', bookTitle: 'Monster Manual' }),
    ]);

    expect(text).toContain("1 encounter entry cites a stat block missing from this library");
    expect(text).toContain('Missing: Zombie.');
    expect(text).toContain('The missing pack is «Monster Manual».');
  });

  it('names the creatures and INVENTS NO PACK when the citation recorded none', async () => {
    // A citation written before the pack stamp existed — the real shape of
    // every row older than this landing. Naming a pack here would be a guess.
    const text = await bannerFor([missingEntry('Zombie', { creatureName: 'Zombie' })]);

    expect(text).toContain('Missing: Zombie.');
    expect(text).toContain('The pack was not recorded when this citation was written.');
    expect(text).not.toContain('«');
  });

  it('names the packs it does know and how many strands record none', async () => {
    const text = await bannerFor([
      missingEntry('Zombie', { creatureName: 'Zombie', bookTitle: 'Monster Manual' }),
      missingEntry('Ghoul', { creatureName: 'Ghoul', bookTitle: 'Monster Manual' }),
      missingEntry('Skeleton', { creatureName: 'Skeleton' }),
    ]);

    expect(text).toContain('3 encounter entries across 1 encounter cites stat blocks');
    expect(text).toContain('Missing: Ghoul, Skeleton, Zombie.');
    expect(text).toContain('The missing pack is «Monster Manual».');
    expect(text).toContain('1 of 3 citations does not record which pack it was written from.');
  });

  it('bounds the name list and states the remainder exactly (never a silent truncation)', async () => {
    const text = await bannerFor(
      ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((creature) =>
        missingEntry(creature, { creatureName: creature }),
      ),
    );

    // Six strands, four names listed, and the count of what is NOT listed is
    // the truth about how much is missing — an off-by-one here is a lie.
    expect(text).toContain('6 encounter entries across 1 encounter cites stat blocks');
    expect(text).toContain('Missing: Alpha, Bravo, Charlie, Delta (+2 more).');
    expect(text).not.toContain('Echo');
  });

  it('deduplicates and orders the names deterministically', async () => {
    const text = await bannerFor([
      missingEntry('One', { creatureName: 'Zombie' }),
      missingEntry('Two', { creatureName: 'zombie' }),
      missingEntry('Three', { creatureName: 'ghoul' }),
      missingEntry('Four', { creatureName: 'Bog Zombie' }),
    ]);

    // One creature, one name: the comparison trims and casefolds, and the
    // printed order is the locale order of that key.
    expect(text).toContain('4 encounter entries across 1 encounter cites stat blocks');
    expect(text).toContain('Missing: Bog Zombie, ghoul, Zombie.');
  });

  it('never drops a strand it cannot name — the count includes it and says so', async () => {
    const text = await bannerFor([
      missingEntry('Zombie', { creatureName: 'Zombie' }),
      // A roster entry that names nothing at all: the resolver's label is the
      // bare `missing ref`, and the banner still counts it.
      missingEntry(''),
    ]);

    expect(text).toContain('2 encounter entries across 1 encounter cites stat blocks');
    expect(text).toContain('Missing: Zombie.');
    expect(text).toContain('1 of them names no creature.');
  });

  it('names the SAME pack identity the origin label prints for that book', async () => {
    // The differential this landing exists to keep: the title the banner shows
    // and the title `creatureOriginLabel` puts in a row's badge come from the
    // same book row, so the two can never name different packs.
    const book = await createPackBook({
      title: 'Monster Manual',
      system: 'dnd5e',
      filename: 'mm.zip',
    });
    const chunk = ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 44,
      pageEnd: 44,
      chunkType: 'statblock',
      headingPath: ['Zombie'],
      text: 'Zombie stat block',
      statBlock: null,
      contentHash: await sha256Hex('Zombie stat block'),
    });
    const originLabel = await creatureOriginLabel(chunk, 'Zombie', {
      getRulebook: (bookId) => db.rulebooks.get(bookId),
    });
    const stampedTitle = citationBookTitle(book);
    if (stampedTitle === undefined) throw new Error('the pack book row has no title');

    expect(originLabel.startsWith(`${stampedTitle}:`)).toBe(true);
    const text = await bannerFor([
      missingEntry('Zombie', { creatureName: 'Zombie', bookTitle: stampedTitle }),
    ]);
    expect(text).toContain(`The missing pack is «${originLabel.split(':')[0] ?? ''}».`);
  });
});

/** The sentence itself, pinned where it is composed: the cap arithmetic (an
 * off-by-one is a lie about how much is missing) and the two pack shapes. */
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
