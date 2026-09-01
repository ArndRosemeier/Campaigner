import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { playPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createArtifact as buildArtifact,
  createModule,
  moduleSchema,
  newId,
  type Artifact,
  type Id,
  type Module,
} from '@/domain';
import { matchModules, QuickFindDialog } from '@/features/quickfind/quickfind-dialog';
import { clearDatabase } from '../db/helpers';

/**
 * Module-designer integration points of quick-find (08-M4-D): the "Modules"
 * group over module titles and part plan titles/synopses (matchModules +
 * onPickModule with partIndex), the artifact-only result set, and the
 * app-mounted Ctrl+K hotkey navigating to the reader's `#part-<i>` hash.
 */

const FIXTURE_CAMPAIGN_ID = newId();

function moduleFixture(campaignId: Id = FIXTURE_CAMPAIGN_ID): Module {
  const base = createModule({
    campaignId,
    title: 'The Drowned Vault',
    concept: 'A vault lost beneath the harbor.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({
    ...base,
    spine: {
      premise: 'A drowned vault waits beneath the harbor.',
      themes: [],
      partPlan: [
        {
          title: 'The Sunken Gate',
          levelBand: '1–2',
          synopsis: 'The party forces the gate.',
          levelUpTrigger: 'The gate falls.',
        },
        {
          title: 'Drowned Halls',
          levelBand: '3–4',
          synopsis: 'The halls below flood.',
          levelUpTrigger: 'The tide turns.',
        },
      ],
    },
    parts: [
      { planIndex: 0, markdown: 'The gate looms.', status: 'ready', errorMessage: '', edited: false },
      { planIndex: 1, markdown: 'Halls descend.', status: 'ready', errorMessage: '', edited: false },
    ],
  });
}

function renderQuickFindDialog(
  artifacts: readonly Artifact[],
  modules: readonly Module[],
  onPickModule: (moduleId: Id, partIndex: number | undefined) => void,
): void {
  render(
    <QuickFindDialog
      open
      onOpenChange={vi.fn()}
      artifacts={artifacts}
      modules={modules}
      mode="play"
      onPickModule={onPickModule}
    />,
  );
}

describe('matchModules', () => {
  it('matches part titles and synopses case-insensitively with their part index', () => {
    const module = moduleFixture();

    const titleHit = matchModules('SUNKEN gate', [module]);
    expect(titleHit).toHaveLength(1);
    expect(titleHit[0]?.module.id).toBe(module.id);
    expect(titleHit[0]?.partIndex).toBe(0);

    const synopsisHit = matchModules('forces the gate', [module]);
    expect(synopsisHit).toHaveLength(1);
    expect(synopsisHit[0]?.partIndex).toBe(0);
  });

  it('matches the module title with an undefined partIndex and ignores empty queries', () => {
    const module = moduleFixture();

    expect(matchModules('drowned vault', [module])).toEqual([
      { module, partIndex: undefined },
    ]);
    expect(matchModules('', [module])).toEqual([]);
  });
});

describe('QuickFindDialog modules group', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  it('shows a part match in the Modules group and picks it with its part index', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const onPickModule = vi.fn();
    renderQuickFindDialog([], [module], onPickModule);

    await user.type(screen.getByTestId('quickfind-input'), 'sunken gate');
    const items = await screen.findAllByTestId('quickfind-module');
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) throw new Error('expected exactly one module item');
    expect(item).toHaveTextContent('The Drowned Vault');
    expect(item).toHaveTextContent('Part 1:');
    expect(item).toHaveTextContent('The Sunken Gate');

    await user.click(item);
    expect(onPickModule).toHaveBeenCalledTimes(1);
    expect(onPickModule).toHaveBeenCalledWith(module.id, 0);
  });

  it('picks the module itself (partIndex undefined) for a module title match', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const onPickModule = vi.fn();
    renderQuickFindDialog([], [module], onPickModule);

    await user.type(screen.getByTestId('quickfind-input'), 'drowned vault');
    const item = await screen.findByTestId('quickfind-module');
    expect(item).toHaveTextContent('The Drowned Vault');
    expect(item).toHaveTextContent('module');

    await user.click(item);
    expect(onPickModule).toHaveBeenCalledTimes(1);
    expect(onPickModule).toHaveBeenCalledWith(module.id, undefined);
  });

  it('shows only the Artifacts group for a query matching only an artifact', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const artifact = buildArtifact({
      campaignId: FIXTURE_CAMPAIGN_ID,
      kind: 'location',
      name: 'The Docks',
      summary: 'Where the ferries moor.',
    });
    renderQuickFindDialog([artifact], [module], vi.fn());

    await user.type(screen.getByTestId('quickfind-input'), 'Docks');
    const artifactItem = await screen.findByTestId('quickfind-artifact');
    expect(artifactItem).toHaveTextContent('The Docks');
    expect(screen.queryByTestId('quickfind-module')).not.toBeInTheDocument();
    expect(screen.queryByText('Modules')).not.toBeInTheDocument();
    expect(screen.getByText('Artifacts')).toBeInTheDocument();
  });
});

describe('QuickFindHotkey', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  it('opens with Ctrl+K on a play route and navigates to the reader part hash on pick', {
    timeout: 20_000,
  }, async () => {
    const user = userEvent.setup();
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Old Tower' });
    const module = await saveModule(moduleFixture(campaign.id));

    window.history.replaceState(null, '', playPath(campaign.id));
    render(<RouterProvider router={createAppRouter()} />);
    expect(
      await screen.findByRole('heading', { name: 'Old Tower' }, { timeout: 5_000 }),
    ).toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByTestId('quickfind-dialog', {}, { timeout: 5_000 });
    await user.type(screen.getByTestId('quickfind-input'), 'sunken gate');
    const item = await within(dialog).findByTestId('quickfind-module', {}, { timeout: 5_000 });
    await user.click(item);

    await waitFor(() => {
      expect(window.location.hash).toBe('#part-0');
    });
    expect(window.location.pathname).toBe(`/c/${campaign.id}/m/${module.id}`);
    expect(await screen.findByTestId('module-reader', {}, { timeout: 5_000 })).toBeInTheDocument();
  });
});
