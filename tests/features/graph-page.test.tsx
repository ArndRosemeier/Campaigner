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
import { LINK_HEALTH_ROW_CAP } from '@/features/campaign/components/link-health-report';

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

describe('GraphPage — link-health report (14-BACKLINKS-ORPHANS)', () => {
  beforeEach(clearDatabase);

  async function expandReport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByTestId('link-health-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('link-health-unresolved')).toBeTruthy();
    });
  }

  it('is not rendered for a campaign without any prose mention', async () => {
    const campaignId = await createCampaignFixture();
    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('graph-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('link-health')).toBeNull();
  }, 20000);

  it('lists unresolved phantom names with per-document counts and deep-links the first mention', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    const moduleA = await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Seggel]] and [[Seggel]].',
      parts: [{ planIndex: 0, markdown: '[[Seggel]] waits.' }],
    });
    await createModuleFixture({
      campaignId,
      title: 'Bell Harbor',
      premise: '[[Moro]] looms.',
    });
    await createArtifact({ campaignId, kind: 'location', name: 'The Docks' });

    const router = renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-health-toggle')).toBeTruthy();
    });
    await expandReport(user);

    expect(screen.getByTestId('link-health-counts').textContent).toBe('2 unresolved · 1 never mentioned');

    const seggel = screen
      .getAllByTestId('link-health-unresolved-row')
      .find((row) => row.getAttribute('data-name') === 'Seggel');
    if (seggel === undefined) throw new Error('the Seggel unresolved row did not render');
    expect(seggel.textContent).toContain('×3');
    expect(seggel.textContent).toContain('Ashen Vault — Premise ×2, Part 1 ×1');
    const moro = screen
      .getAllByTestId('link-health-unresolved-row')
      .find((row) => row.getAttribute('data-name') === 'Moro');
    expect(moro?.textContent).toContain('Bell Harbor — Premise ×1');

    // Never-mentioned artifacts link to the entity detail route.
    expect(screen.getByTestId('link-health-never-row').textContent).toContain('The Docks');

    // The first reader location hosts the stub/adopt flow.
    await user.click(seggel);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(modulePath(campaignId, moduleA.id));
    });
  }, 20000);

  it('honors the module filter in both sub-lists', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] and [[Seggel]] and [[Seggel]].',
    });
    await createModuleFixture({
      campaignId,
      title: 'Bell Harbor',
      premise: '[[Moro]] looms.',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });

    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-health-toggle')).toBeTruthy();
    });
    await expandReport(user);
    // In the all-modules scope Grimm IS mentioned (Ashen Vault) — the
    // never-mentioned list is empty until the filter narrows the prose.
    expect(screen.getByTestId('link-health-counts').textContent).toBe('2 unresolved · 0 never mentioned');

    await user.click(screen.getByTestId('graph-module-filter'));
    await user.click(await screen.findByRole('option', { name: 'Bell Harbor' }));

    // Bell Harbor's prose: only Moro is unresolved; Grimm's only mention is
    // out of scope, so the campaign row counts as never mentioned HERE.
    await waitFor(() => {
      expect(screen.getByTestId('link-health-counts').textContent).toBe('1 unresolved · 1 never mentioned');
    });
    const unresolvedNames = screen
      .getAllByTestId('link-health-unresolved-row')
      .map((row) => row.getAttribute('data-name'));
    expect(unresolvedNames).toEqual(['Moro']);
    expect(screen.getByTestId('link-health-never-row').textContent).toContain('Grimm');
  }, 20000);

  it('honors the kind filter: a resolved kind hides phantoms, Unresolved hides entities', async () => {
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
    await waitFor(() => {
      expect(screen.getByTestId('link-health-toggle')).toBeTruthy();
    });
    await expandReport(user);

    // Kind = Locations: phantoms have no kind (muted note); the one location
    // is mentioned, so the never-mentioned list is empty for the kind.
    await user.click(screen.getByTestId('graph-kind-filter'));
    await user.click(await screen.findByRole('option', { name: 'Locations' }));
    await waitFor(() => {
      expect(screen.getByTestId('link-health-unresolved-note')).toBeTruthy();
    });
    expect(screen.getByTestId('link-health-counts').textContent).toBe('0 never mentioned');
    expect(screen.getByTestId('link-health-never-empty').textContent).toContain(
      'Every entity in scope is mentioned',
    );

    // Kind = Unresolved: exactly the phantoms; the artifact list is hidden.
    await user.click(screen.getByTestId('graph-kind-filter'));
    await user.click(await screen.findByRole('option', { name: 'Unresolved (phantoms)' }));
    await waitFor(() => {
      expect(screen.getByTestId('link-health-counts').textContent).toBe('1 unresolved');
    });
    expect(screen.getByTestId('link-health-unresolved-row').getAttribute('data-name')).toBe('Seggel');
    expect(screen.getByTestId('link-health-never-note')).toBeTruthy();
  }, 20000);

  it('caps both sub-lists with visible truncation notes', async () => {
    const campaignId = await createCampaignFixture();
    const parts = Array.from({ length: LINK_HEALTH_ROW_CAP + 6 }, (_, index) => ({
      planIndex: index,
      markdown: `[[Name ${String(index)}]]`,
    }));
    await createModuleFixture({ campaignId, title: 'Ashen Vault', premise: '', parts });
    for (let index = 0; index < LINK_HEALTH_ROW_CAP + 6; index += 1) {
      await createArtifact({ campaignId, kind: 'npc', name: `Filler ${String(index)}` });
    }

    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-health-toggle')).toBeTruthy();
    });
    const user = userEvent.setup();
    await expandReport(user);

    const total = String(LINK_HEALTH_ROW_CAP + 6);
    expect(screen.getByTestId('link-health-counts').textContent).toBe(
      `${total} unresolved · ${total} never mentioned`,
    );
    expect(screen.getAllByTestId('link-health-unresolved-row')).toHaveLength(LINK_HEALTH_ROW_CAP);
    expect(screen.getAllByTestId('link-health-never-row')).toHaveLength(LINK_HEALTH_ROW_CAP);
    expect(screen.getByTestId('link-health-unresolved-truncated').textContent).toBe(
      `Showing ${String(LINK_HEALTH_ROW_CAP)} of ${total} unresolved names (truncated; 6 more)`,
    );
    expect(screen.getByTestId('link-health-never-truncated').textContent).toBe(
      `Showing ${String(LINK_HEALTH_ROW_CAP)} of ${total} never-mentioned entities (truncated; 6 more)`,
    );
  }, 30000);

  it('shows both empty states when every name resolves and every entity is mentioned', async () => {
    const user = userEvent.setup();
    const campaignId = await createCampaignFixture();
    await createModuleFixture({
      campaignId,
      title: 'Ashen Vault',
      premise: '[[Grimm]] waits.',
    });
    await createArtifact({ campaignId, kind: 'npc', name: 'Grimm' });

    renderGraph(campaignId);
    await waitFor(() => {
      expect(screen.getByTestId('link-health-toggle')).toBeTruthy();
    });
    await expandReport(user);

    expect(screen.getByTestId('link-health-unresolved-empty').textContent).toContain(
      'every wiki-link in scope resolves',
    );
    expect(screen.getByTestId('link-health-never-empty').textContent).toContain(
      'Every entity in scope is mentioned',
    );
    expect(screen.queryByTestId('link-health-unresolved-row')).toBeNull();
    expect(screen.queryByTestId('link-health-never-row')).toBeNull();
  }, 20000);
});
