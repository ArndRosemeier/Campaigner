import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { createArtifact, getAnyArtifact, getArtifact, listGlobalArtifacts } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule } from '@/db/moduleRepo';
import { createModule as createModuleRow } from '@/domain';
import { ScopeControl } from '@/features/campaign/components/scope-control';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Scope control in the workspace tree (10-MILESTONE-6 C, D3/D4): module-owned
 * rows group under their module, the global library renders in its own
 * "Library" group (hidden by default in the workspace), publishing a
 * library-kind artifact is a loud two-step act, and the adopt flow returns a
 * library row to a campaign.
 */

function renderWorkspace(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={ROUTES.workspace} element={<WorkspacePage />} />
        <Route path={ROUTES.artifact} element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openRowMenu(user: UserEvent, artifactName: string): Promise<void> {
  await user.pointer([
    { keys: '[MouseRight>]', target: screen.getByText(artifactName) },
    { keys: '[/MouseRight]' },
  ]);
  await screen.findByRole('menu');
}

afterEach(cleanup);

describe('workspace tree scope control', () => {
  let campaignId = '';
  let moduleId = '';

  beforeEach(async () => {
    await clearDatabase();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    campaignId = campaign.id;
    const module = await createModule(
      createModuleRow({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    moduleId = module.id;
    await createArtifact({ campaignId, moduleId, kind: 'npc', name: 'Kael' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Mira' });
  });

  it('groups module-owned rows under their module; plain rows stay in kind groups', async () => {
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Kael');
    await flushAsyncUpdates();

    expect(screen.getByText('Ember Crypt')).toBeInTheDocument();
    // The module group carries its own row; the kind group does not list it.
    const miraList = screen.getByText('Mira').closest('ul') as HTMLElement;
    expect(within(miraList).queryByText('Kael')).toBeNull();
    await flushAsyncUpdates();
  });

  it('publishes a library-kind artifact via the loud confirm; notes are not publishable', async () => {
    const user = userEvent.setup();
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Kael');

    await flushAsyncUpdates();
    await openRowMenu(user, 'Kael');
    await user.click(await screen.findByRole('menuitem', { name: 'Publish to library…' }));
    const dialog = await screen.findByTestId('publish-dialog');
    expect(dialog).toHaveTextContent(/visible and editable from every campaign/);
    await user.click(within(dialog).getByTestId('publish-confirm'));

    let publishedId = '';
    await waitFor(async () => {
      const globals = await listGlobalArtifacts();
      expect(globals).toHaveLength(1);
      publishedId = globals[0]?.id ?? '';
      expect(globals[0]?.campaignId).toBeNull();
      expect(await getArtifact(publishedId)).toBeUndefined();
    });

    // Library group hidden by default in the workspace (D3)…
    await waitFor(async () => {
      const scopes = (await readSettings()).artifactScopes.workspace;
      expect(scopes.global).toBe(false);
    });
    expect(screen.queryByText('Library')).not.toBeInTheDocument();

    // …and shown once the user turns the toggle on.
    await user.click(screen.getByTestId('scope-toggle-global'));
    await screen.findByText('Library');
    await flushAsyncUpdates();
  }, 20000);

  it('does not offer publishing for non-library kinds', async () => {
    const user = userEvent.setup();
    await createArtifact({ campaignId, kind: 'note', name: 'Journal' });
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Journal');

    await flushAsyncUpdates();
    await openRowMenu(user, 'Journal');
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Publish to library…' })).toBeNull();
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();
  });

  it('adopts a library row back into the campaign', async () => {
    const user = userEvent.setup();
    const globalId = '00000000-0000-4000-8000-0000000000a99';
    const row = await createArtifact({ campaignId, kind: 'faction', name: 'The Salt Guild' });
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });
    // Publish, then re-open the workspace so the tree lists it as a library row.
    const { publishToLibrary } = await import('@/db/artifactRepo');
    await publishToLibrary(row.id);
    expect((await getAnyArtifact(globalId)) === undefined).toBe(true);
    expect((await listGlobalArtifacts()).map((entry) => entry.name)).toContain('The Salt Guild');

    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Library');
    await flushAsyncUpdates();

    await openRowMenu(user, 'The Salt Guild');
    await user.click(await screen.findByRole('menuitem', { name: 'Adopt into campaign…' }));
    const dialog = await screen.findByTestId('adopt-dialog');
    await user.click(within(dialog).getByTestId(`adopt-into-${campaignId}`));
    await flushAsyncUpdates();

    await waitFor(async () => {
      const adopted = await getArtifact(row.id);
      expect(adopted?.campaignId).toBe(campaignId);
    });
    expect((await listGlobalArtifacts()).length).toBe(0);
    await flushAsyncUpdates();
    await flushAsyncUpdates();
  });

  it('persists scope toggles per surface in settings', async () => {
    // Rendered standalone: the full workspace page mounts several live-query
    // panes whose settle chain would drown this small assertion in act()
    // noise — the toggle's persistence is what matters here.
    render(<ScopeControl surface="workspace" />);
    const user = userEvent.setup();
    await flushAsyncUpdates();

    expect((await readSettings()).artifactScopes.workspace.global).toBe(false);
    await user.click(screen.getByTestId('scope-toggle-global'));
    await flushAsyncUpdates(40);
    const after = await readSettings();
    expect(after.artifactScopes.workspace.global).toBe(true);
    // The module view keeps its own preference (D4 — independent surfaces).
    expect(after.artifactScopes.moduleView.global).toBe(true);
    await flushAsyncUpdates();
  });
});
