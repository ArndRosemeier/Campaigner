import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { newId } from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { seedBuiltInPersonas } from '@/db/seed';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

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
    expect(screen.getByTestId('persona-panel')).toBeDefined();

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

  it('deletes an artifact from the visible row button, clearing dangling links', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Gorim' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Forge',
      links: [{ targetId: npc.id, relation: 'workplace-of' }],
    });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Gorim')).toBeDefined();

    // Hover-revealed trash button on the row (always in the a11y tree).
    await user.click(screen.getByRole('button', { name: 'Delete Gorim' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Gorim')).not.toBeInTheDocument();
    });
    // Drain the delete-triggered live-query updates before the plain DB reads.
    await flushAsyncUpdates();
    const { getArtifact } = await import('@/db/artifactRepo');
    const rows = await import('@/db/artifactRepo').then((m) =>
      m.listArtifactsByCampaign(campaign.id),
    );
    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(rows.find((row) => row.name === 'Forge')?.links).toEqual([]);
    await flushAsyncUpdates();
  }, 20000);

  it('shows persona names, not ids, in selects after choosing', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();

    renderWorkspace(workspacePath(campaign.id));

    // Wait for the personas live query to resolve (the Assistant tab's
    // persona select shows the placeholder until then).
    const personaTrigger = await screen.findByRole('combobox', { name: 'Persona' });
    await waitFor(() => {
      expect(personaTrigger.textContent).not.toBe('Loading…');
    });

    // The chain builder pre-selects the first persona: the closed trigger
    // must show its human-readable NAME, never the raw id (regression for
    // selects displaying uuids after a choice).
    await user.click(screen.getByRole('tab', { name: "Writers' room" }));
    await screen.findByTestId('writers-room');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const stepTrigger = await screen.findByRole('combobox', { name: 'Step 1 persona' });
    const { listPersonas } = await import('@/db/personaRepo');
    const personas = await listPersonas();
    const firstPersona = personas[0];
    expect(firstPersona).toBeDefined();
    await waitFor(() => {
      expect(stepTrigger.textContent).toBe(`${firstPersona?.name}▼`);
    });
    expect(stepTrigger.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }, 20000);

  it('deletes a run from the Runs tab', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const { createRun } = await import('@/db/runRepo');
    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'a unique brief for deletion',
      pinnedChunkIds: [],
    });

    renderWorkspace(workspacePath(campaign.id));
    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('a unique brief for deletion')).toBeDefined();

    await user.click(
      screen.getByRole('button', {
        name: `Delete run ${new Date(run.updatedAt).toLocaleString()}`,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText('a unique brief for deletion')).not.toBeInTheDocument();
    });
    const { getRun } = await import('@/db/runRepo');
    expect(await getRun(run.id)).toBeUndefined();
  }, 20000);
});
