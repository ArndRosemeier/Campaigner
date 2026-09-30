import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath } from '@/app/routes';
import { db } from '@/db/db';
import {
  createArtifact,
  listArtifactsByCampaign,
  publishToLibrary,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, moduleSchema, type AnyArtifact, type Module } from '@/domain';
import { saveModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

import { MentionsPanel } from '@/features/campaign/components/mentions-panel';

/**
 * The Mentions panel (14-BACKLINKS-ORPHANS): every wiki-link mention of one
 * entity across all modules — per document with counts, alias-only matches
 * included, deep-linked to the reader location; module-tier shadows of the
 * same name do not count (the reader's resolution).
 */

async function createCampaignFixture(): Promise<string> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  return campaign.id;
}

async function createModuleFixture(input: {
  campaignId: string;
  title: string;
  premise: string;
  parts?: { planIndex: number; markdown: string }[];
}): Promise<Module> {
  const draft = createModule({
    campaignId: input.campaignId,
    title: input.title,
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return saveModule(
    moduleSchema.parse({
      ...draft,
      spine: {
        premise: input.premise,
        themes: [],
        partPlan: [{ title: 'Part', levelBand: '1–3', synopsis: '', levelUpTrigger: '' }],
      },
      parts: (input.parts ?? []).map((part) => ({
        planIndex: part.planIndex,
        markdown: part.markdown,
        status: 'ready' as const,
        errorMessage: '',
        edited: false,
      })),
    }),
  );
}

function renderPanel(
  artifact: AnyArtifact,
  campaignId: string,
  pool: readonly AnyArtifact[],
): ReturnType<typeof createMemoryRouter> {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <MentionsPanel artifact={artifact} campaignId={campaignId} campaignArtifacts={pool} />,
      },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('MentionsPanel', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  it('lists mentions across modules per document and deep-links each to its reader location', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    const moduleA = await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grix]] brews. The party meets [[Grix]] again.',
      parts: [{ planIndex: 0, markdown: '[[Grix]] returns.' }],
    });
    const moduleB = await createModuleFixture({
      campaignId,
      title: 'Bell Harbor',
      premise: '[[Grix]] sails.',
    });
    const grix = await createArtifact({ campaignId, kind: 'npc', name: 'Grix' });

    const router = renderPanel(grix, campaignId, [grix]);

    await waitFor(() => {
      expect(screen.getAllByTestId('mention-row')).toHaveLength(3);
    });
    expect(screen.getByTestId('mentions-count').textContent).toBe('4 mentions');
    // Per document: module title, Premise/Part N, ×count.
    expect(screen.getAllByText('Ashen Vault')).toHaveLength(2);
    expect(screen.getByText('Bell Harbor')).toBeDefined();
    expect(screen.getAllByText('Premise')).toHaveLength(2);
    expect(screen.getByText('Part 1')).toBeDefined();
    expect(screen.getByText('×2')).toBeDefined();
    expect(screen.getAllByText('×1')).toHaveLength(2);

    // A part row deep-links with the #part-N hash; a premise row to the
    // plain reader. Both are plain reader links.
    const rows = screen.getAllByTestId('mention-row');
    const partRow = rows.find((row) => row.getAttribute('data-where') === 'part-0');
    if (partRow === undefined) throw new Error('the part-0 mention row did not render');
    expect(partRow.getAttribute('href')).toBe(modulePath(campaignId, moduleA.id, 0));
    const premiseRow = rows.find((row) => row.textContent.includes('Bell Harbor'));
    if (premiseRow === undefined) throw new Error('the premise mention row did not render');
    expect(premiseRow.getAttribute('href')).toBe(modulePath(campaignId, moduleB.id));

    // Clicking a part row lands on the reader at that part.
    await user.click(partRow);
    await waitFor(() => {
      expect(router.state.location.pathname + router.state.location.hash).toBe(
        modulePath(campaignId, moduleA.id, 0),
      );
    });
  }, 20000);

  it('includes alias-only matches and names the spellings', async () => {
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Guard Halmund]] watches.',
      parts: [{ planIndex: 0, markdown: '[[Halmund]] argues.' }],
    });
    const halmund = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Halmund',
      aliases: ['Guard Halmund'],
    });

    renderPanel(halmund, campaignId, [halmund]);

    await waitFor(() => {
      expect(screen.getAllByTestId('mention-row')).toHaveLength(2);
    });
    expect(screen.getByTestId('mentions-aliases').textContent).toBe(
      'Mentioned as [[Guard Halmund]], [[Halmund]]',
    );
    expect(screen.getByTestId('mentions-count').textContent).toBe('2 mentions');
  }, 20000);

  it('does not count a module-tier shadow of the same name in its owning module', async () => {
    const campaignId = await createCampaignFixture();
    const moduleA = await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Guide]] leads.',
    });
    await createModuleFixture({
      campaignId,
      title: 'Bell Harbor',
      premise: '[[Guide]] follows.',
    });
    const campaignRow = await createArtifact({ campaignId, kind: 'npc', name: 'Guide' });
    const shadow = await createArtifact({
      campaignId,
      moduleId: moduleA.id,
      kind: 'npc',
      name: 'Guide',
    });
    // In Bell Harbor (no tier-0 owner) both rows sit in tier 1 and the NEWER
    // wins — make the campaign row deterministically newer so its panel shows
    // exactly the mention the reader would give it there.
    await db.artifacts.update(campaignRow.id, { updatedAt: shadow.updatedAt + 1000 });
    // Fresh rows — the recency bump must be visible to the pool, not just to
    // the DB.
    const pool = await listArtifactsByCampaign(campaignId);
    expect(pool).toHaveLength(2);
    const freshCampaignRow = pool.find((row) => row.id === campaignRow.id);
    const shadowRow = pool.find((row) => row.id === shadow.id);
    if (freshCampaignRow === undefined || shadowRow === undefined) {
      throw new Error('the Guide rows did not persist');
    }

    // The campaign row only gets the mention the READER would give it.
    renderPanel(freshCampaignRow, campaignId, pool);
    await waitFor(() => {
      expect(screen.getAllByTestId('mention-row')).toHaveLength(1);
    });
    expect(screen.getByText('Bell Harbor')).toBeDefined();
    expect(screen.queryByText('Ashen Vault')).toBeNull();

    // The shadow's own panel shows its module's tier-0 mention. Unmount the
    // first panel first so its rows cannot satisfy this panel's assertions.
    cleanup();
    renderPanel(shadowRow, campaignId, pool);
    await waitFor(() => {
      expect(screen.getAllByTestId('mention-row')).toHaveLength(1);
    });
    expect(screen.getByText('Ashen Vault')).toBeDefined();
    expect(screen.queryByText('Bell Harbor')).toBeNull();
  }, 20000);

  it('shows the empty state with the [[name]] hint for an unmentioned entity', async () => {
    const campaignId = await createCampaignFixture();
    const ghost = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Ghost of the Vault',
      aliases: ['The Ghost'],
    });

    renderPanel(ghost, campaignId, [ghost]);

    await waitFor(() => {
      expect(screen.getByTestId('mentions-empty')).toBeTruthy();
    });
    expect(screen.getByTestId('mentions-empty').textContent).toContain('[[Ghost of the Vault]]');
    expect(screen.getByTestId('mentions-empty').textContent).toContain('or one of its aliases');
  }, 20000);

  it('lists a library row mentions across the open campaign', async () => {
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: 'A [[Goblin Warrior]] patrols.',
    });
    const goblin = await createArtifact({ campaignId, kind: 'npc', name: 'Goblin Warrior' });
    const published = await publishToLibrary(goblin.id);

    renderPanel(published, campaignId, [published]);

    await waitFor(() => {
      expect(screen.getAllByTestId('mention-row')).toHaveLength(1);
    });
    expect(screen.getByTestId('mentions-count').textContent).toBe('1 mention');
  }, 20000);
});
