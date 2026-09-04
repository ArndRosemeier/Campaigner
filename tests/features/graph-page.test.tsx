import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, graphPath, modulePath } from '@/app/routes';
import { createModule, moduleSchema, type Module } from '@/domain';
import { WIKI_GRAPH_NODE_CAP } from '@/domain/wikiGraph';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

import { createAppRouter } from '@/app/router';

/**
 * The wiki-link Graph page (13-WIKI-GRAPH): derived nodes/phantoms render,
 * filters re-scope the graph, click-through targets the entity route / the
 * phantom's reader location, and the truncation note is visible.
 */

const campaignName = 'Emberfall';

async function createCampaignFixture(): Promise<string> {
  const campaign = await createCampaign({ name: campaignName, system: 'dnd5e' });
  return campaign.id;
}

/** Persists one module with a spine premise and ready parts. */
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

function renderGraph(campaignId: string): ReturnType<typeof createMemoryRouter> {
  const router = createMemoryRouter(createAppRouter().routes as never, {
    initialEntries: [graphPath(campaignId)],
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('GraphPage — the derived wiki-link graph', () => {
  beforeEach(clearDatabase);

  it('renders module hub, resolved nodes and phantoms, and navigates to the artifact on click', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] and [[The Docks]] and [[Seggel]].',
      parts: [{ planIndex: 0, markdown: '[[Seggel]] returns.' }],
    });
    const docks = await createArtifact({ campaignId, kind: 'location', name: 'The Docks' });
    const grimm = await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });

    const router = renderGraph(campaignId);

    await waitFor(() => {
      expect(screen.getByTestId('link-graph')).toBeTruthy();
    });
    expect(screen.getByText('Ashen Vault')).toBeDefined();
    expect(screen.getByText('Grimm')).toBeDefined();
    expect(screen.getByText('The Docks')).toBeDefined();
    expect(screen.getByText('Seggel')).toBeDefined();
    expect(screen.getByTestId('graph-counts').textContent).toBe(
      '3 entities · 1 phantoms · 4 mentions',
    );

    await user.click(screen.getByText('Grimm'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        ROUTES.artifact.replace(':campaignId', campaignId).replace(':artifactId', grimm.id),
      );
    });
    expect(docks.id).toBeDefined();
  }, 20000);

  it('navigates a phantom node to its first mention in the module reader', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    const module = await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] waits.',
      parts: [{ planIndex: 0, markdown: '[[Seggel]] returns.' }],
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });

    const router = renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-graph')).toBeTruthy();
    });

    await user.click(screen.getByText('Seggel'));
    await waitFor(() => {
      expect(router.state.location.pathname + router.state.location.hash).toBe(
        modulePath(campaignId, module.id, 0),
      );
    });
  }, 20000);

  it('navigates the module hub to the reader', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    const module = await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] waits.',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });

    const router = renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-graph')).toBeTruthy();
    });

    await user.click(screen.getByText('Ashen Vault'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(modulePath(campaignId, module.id));
    });
  }, 20000);

  it('filters by module: only that hub and its mentions remain', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] and [[The Docks]].',
    });
    await createModuleFixture({
      campaignId,
      title: 'Bell Harbor',
      premise: '[[The Docks]] again.',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });
    await createArtifact({ campaignId, kind: 'location', name: 'The Docks' });

    renderGraph(campaignId);
    const graph = await screen.findByTestId('link-graph');
    await waitFor(() => {
      expect(within(graph).getByText('Ashen Vault')).toBeTruthy();
    });

    // Node assertions are scoped to the graph: the select popup keeps its
    // options mounted in jsdom after a pick, and they carry module titles too.
    await user.click(screen.getByTestId('graph-module-filter'));
    await user.click(await screen.findByRole('option', { name: 'Bell Harbor' }));

    await waitFor(() => {
      expect(within(graph).queryByText('Ashen Vault')).toBeNull();
      expect(within(graph).queryByText('Grimm')).toBeNull();
    });
    expect(within(graph).getByText('Bell Harbor')).toBeDefined();
    expect(within(graph).getByText('The Docks')).toBeDefined();
    expect(screen.getByTestId('graph-counts').textContent).toBe(
      '1 entities · 0 phantoms · 1 mentions',
    );
  }, 20000);

  it('filters by kind and by unresolved (phantoms)', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] and [[The Docks]] and [[Seggel]].',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });
    await createArtifact({ campaignId, kind: 'location', name: 'The Docks' });

    renderGraph(campaignId);
    const graph = await screen.findByTestId('link-graph');
    await waitFor(() => {
      expect(within(graph).getByText('Seggel')).toBeTruthy();
    });

    await user.click(screen.getByTestId('graph-kind-filter'));
    await user.click(await screen.findByRole('option', { name: 'Locations' }));
    await waitFor(() => {
      expect(within(graph).queryByText('Grimm')).toBeNull();
      expect(within(graph).queryByText('Seggel')).toBeNull();
    });
    expect(within(graph).getByText('The Docks')).toBeDefined();

    await user.click(screen.getByTestId('graph-kind-filter'));
    await user.click(await screen.findByRole('option', { name: 'Unresolved (phantoms)' }));
    await waitFor(() => {
      expect(within(graph).queryByText('The Docks')).toBeNull();
    });
    expect(within(graph).getByText('Seggel')).toBeDefined();
  }, 20000);

  it('caps entity nodes with a visible truncation note', async () => {
    const campaignId = await createCampaignFixture();
    const parts = Array.from({ length: WIKI_GRAPH_NODE_CAP + 5 }, (_, index) => ({
      planIndex: index,
      markdown: `[[Name ${String(index)}]] appears.`,
    }));
    await createModuleFixture({ campaignId, title: 'Ashen Vault', premise: '', parts });

    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('graph-truncation-note')).toBeTruthy();
    });
    expect(screen.getByTestId('graph-truncation-note').textContent).toBe(
      `Showing ${String(WIKI_GRAPH_NODE_CAP)} of ${String(WIKI_GRAPH_NODE_CAP + 5)} entities (graph truncated; 5 more)`,
    );
  }, 20000);

  it('shows the write-wiki-links empty state for a campaign without module prose', async () => {
    const campaignId = await createCampaignFixture();
    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('graph-empty')).toBeTruthy();
    });
    expect(screen.getByTestId('graph-empty').textContent).toContain('[[wiki-links]]');
  }, 20000);
});
