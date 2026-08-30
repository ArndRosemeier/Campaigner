import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { clearDatabase } from '../db/helpers';

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

beforeEach(clearDatabase);
afterEach(cleanup);

describe('WorkspacePage', () => {
  it('renders the tree and opens the editor when an artifact row is clicked', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gorim',
      body: 'A dwarf smith.',
    });

    renderWorkspace(workspacePath(campaign.id));

    expect(await screen.findByText('Gorim')).toBeDefined();
    expect(screen.getByText('Persona panel')).toBeDefined();

    await user.click(screen.getByText('Gorim'));

    expect(await screen.findByTestId('artifact-editor')).toBeDefined();
    expect(screen.getByTestId('revision-badge').textContent).toBe('rev 1');
  });

  it('creates an artifact via the tree + button with a non-empty default name', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderWorkspace(workspacePath(campaign.id));

    await user.click(await screen.findByRole('button', { name: 'New NPC' }));

    expect(await screen.findByTestId('artifact-editor')).toBeDefined();
    const nameInput = screen.getByTestId<HTMLInputElement>('artifact-name');
    expect(nameInput.value).toBe('New NPC');
    await waitFor(async () => {
      const stored = await db.artifacts.where('campaignId').equals(campaign.id).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('New NPC');
    });
  });

  it('shows the welcome panel when no artifact is open', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderWorkspace(workspacePath(campaign.id));

    expect(await screen.findByText('Welcome to Ember')).toBeDefined();
    expect(screen.queryByTestId('artifact-editor')).toBeNull();
  });
});
