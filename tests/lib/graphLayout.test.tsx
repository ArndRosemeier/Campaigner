import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, graphPath } from '@/app/routes';
import { artifactSchema, type Artifact } from '@/domain';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { clearDatabase } from '../db/helpers';

import { createAppRouter } from '@/app/router';
import { layoutGraph } from '@/lib/graphLayout';

/**
 * Link graph (06-MILESTONES M2): deterministic kind-row layout, dangling
 * links dropped, page renders nodes/edges and navigates on click.
 */

describe('layoutGraph', () => {
  const campaignId = '11111111-1111-4111-8111-111111111111';
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const MISSING = '00000000-0000-4000-8000-0000000000ff';

  function artifact(
    id: string,
    kind: 'npc' | 'location',
    name: string,
    links: { targetId: string; relation: string }[] = [],
  ): Artifact {
    return artifactSchema.parse({
      id,
      createdAt: 1,
      updatedAt: 1,
      campaignId,
      kind,
      name,
      tags: [],
      summary: '',
      body: '',
      links,
      imageIds: [],
      coverImageId: null,
      currentRevision: 1,
      data:
        kind === 'npc'
          ? {
              role: '',
              appearance: '',
              personality: '',
              motivation: '',
              secrets: '',
              voiceNotes: '',
              statBlock: null,
            }
          : { locationType: '', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
  }

  it('clusters kinds into rows and spaces nodes deterministically', () => {
    const a = artifact(A, 'npc', 'Zeta');
    const b = artifact(B, 'npc', 'Alpha');
    const c = artifact(C, 'location', 'Docks');
    const layout = layoutGraph([a, b, c]);

    const alpha = layout.nodes.find((node) => node.name === 'Alpha');
    const zeta = layout.nodes.find((node) => node.name === 'Zeta');
    const docks = layout.nodes.find((node) => node.name === 'Docks');
    expect(alpha?.x).toBeLessThan(zeta?.x ?? 0);
    expect(alpha?.y).toBe(zeta?.y);
    expect(docks?.y).not.toBe(alpha?.y);
    // Same input → same output (deterministic).
    expect(layoutGraph([a, b, c])).toEqual(layout);
  });

  it('drops dangling links and keeps valid ones with relations', () => {
    const a = artifact(A, 'npc', 'Alpha', [{ targetId: C, relation: 'located-in' }]);
    const b = artifact(B, 'npc', 'Beta', [{ targetId: MISSING, relation: 'ally-of' }]);
    const c = artifact(C, 'location', 'Docks');
    const layout = layoutGraph([a, b, c]);
    expect(layout.edges).toEqual([{ from: A, to: C, relation: 'located-in' }]);
    expect(layoutGraph([a, b, c]).edges).toHaveLength(1);
  });
});

describe('GraphPage', () => {
  beforeEach(clearDatabase);

  it('renders nodes for linked artifacts and opens one on click', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'The Docks',
    });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grimm',
      links: [{ targetId: location.id, relation: 'lives-in' }],
    });

    const router = createMemoryRouter(createAppRouter().routes as never, {
      initialEntries: [graphPath(campaign.id)],
    });
    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByTestId('link-graph')).toBeTruthy();
    });
    expect(screen.getByText('Grimm')).toBeDefined();
    expect(screen.getByText('The Docks')).toBeDefined();
    expect(screen.getByText('lives-in')).toBeDefined();

    await user.click(screen.getByText('Grimm'));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        ROUTES.artifact.replace(':campaignId', campaign.id).replace(':artifactId', npc.id),
      );
    });
  }, 20000);
});
