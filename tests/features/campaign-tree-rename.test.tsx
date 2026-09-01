import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { clearDatabase } from '../db/helpers';

/**
 * Campaign-tree rename dialog (M4-A): the "Add old name as alias" checkbox
 * (default on) so module wiki-links keep resolving, alias dedupe when the
 * old name is already among the aliases (case-insensitive), and no duplicate
 * alias when renaming onto an existing alias.
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

/** Opens the row's context menu and starts the rename. */
async function openRenameDialog(user: UserEvent, artifactName: string): Promise<void> {
  await user.pointer([
    { keys: '[MouseRight>]', target: screen.getByText(artifactName) },
    { keys: '[/MouseRight]' },
  ]);
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  await screen.findByRole('dialog');
}

/** Submits the rename dialog with the given alias-checkbox state. */
async function submitRename(user: UserEvent, newName: string, keepAlias: boolean): Promise<void> {
  const dialog = screen.getByRole('dialog');
  const nameInput = within(dialog).getByLabelText('Artifact name');
  await user.clear(nameInput);
  await user.type(nameInput, newName);
  const checkboxControl = within(within(dialog).getByTestId('rename-alias')).getByRole(
    'checkbox',
  );
  expect(checkboxControl).toBeChecked(); // default ON
  if (!keepAlias) {
    await user.click(checkboxControl);
    expect(checkboxControl).not.toBeChecked();
  }
  await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
}

describe('CampaignTree rename dialog', () => {
  beforeEach(clearDatabase);
  afterEach(cleanup);

  it("renames with the alias checkbox on: the row updates and the old name becomes an alias", async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const tower = await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Old Tower' });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Old Tower')).toBeInTheDocument();

    await openRenameDialog(user, 'Old Tower');
    await submitRename(user, 'Tower Ruins', true);

    // The tree row live-updates to the new name.
    expect(await screen.findByText('Tower Ruins')).toBeInTheDocument();
    await waitFor(async () => {
      const stored = await getArtifact(tower.id);
      expect(stored?.name).toBe('Tower Ruins');
      expect(stored?.aliases).toContain('Old Tower');
    });
  }, 20000);

  it("renames with the alias checkbox off: aliases are left unchanged", async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const keep = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Watchfire Keep',
      aliases: ['The Old Fort'],
    });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Watchfire Keep')).toBeInTheDocument();

    await openRenameDialog(user, 'Watchfire Keep');
    await submitRename(user, 'Tower Ruins', false);

    await waitFor(async () => {
      const stored = await getArtifact(keep.id);
      expect(stored?.name).toBe('Tower Ruins');
      expect(stored?.aliases).toEqual(['The Old Fort']);
    });
  }, 20000);

  it('does not re-add the old name as an alias when it is already one (case-insensitive)', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    // The old name is already among the aliases under a different case — the
    // dedupe guard must catch it case-insensitively.
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
      aliases: ['OLD TOWER'],
    });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Old Tower')).toBeInTheDocument();

    await openRenameDialog(user, 'Old Tower');
    await submitRename(user, 'Tower Ruins', true);

    await waitFor(async () => {
      const stored = await getArtifact(artifact.id);
      expect(stored?.name).toBe('Tower Ruins');
      expect(stored?.aliases).toEqual(['OLD TOWER']);
    });
  }, 20000);

  it('does not duplicate an alias when renaming onto it', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
      aliases: ['tower ruins'],
    });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Old Tower')).toBeInTheDocument();

    await openRenameDialog(user, 'Old Tower');
    await submitRename(user, 'Tower Ruins', true);

    await waitFor(async () => {
      const stored = await getArtifact(artifact.id);
      expect(stored?.name).toBe('Tower Ruins');
      expect(stored?.aliases).toContain('Old Tower');
      // The new name absorbs the pre-existing alias spelled the same way
      // (case-insensitively) instead of leaving a redundant alias behind.
      const matches = stored?.aliases.filter(
        (alias) => alias.toLowerCase() === 'tower ruins',
      );
      expect(matches).toHaveLength(0);
    });
  }, 20000);
});
