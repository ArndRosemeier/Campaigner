import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ArtifactRepo from '@/db/artifactRepo';
import {
  createArtifact,
  publishToLibrary,
  updateArtifact,
  type ArtifactKindRemovalCounts,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import {
  createModule as buildModule,
  type Artifact,
  type ArtifactKind,
  type GlobalArtifact,
  type Id,
} from '@/domain';
import { ROUTES, workspacePath } from '@/app/routes';
import { CampaignTree } from '@/features/campaign/components/campaign-tree';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { clearDatabase } from '../db/helpers';
import { actDrained } from '../helpers/flush';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/db/artifactRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof ArtifactRepo>();
  // Wrapped, not replaced: every test but the failure one exercises the real
  // seam (the clear-workspace.test.tsx pattern).
  return { ...actual, deleteArtifactsOfKind: vi.fn(actual.deleteArtifactsOfKind) };
});

const { deleteArtifactsOfKind } = await import('@/db/artifactRepo');
const removeKindMock = vi.mocked(deleteArtifactsOfKind);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);
const toastErrorMock = vi.mocked(toastError);

let realRemoveKind: (campaignId: Id, kind: ArtifactKind) => Promise<ArtifactKindRemovalCounts>;

beforeEach(async () => {
  const actual = await vi.importActual<typeof ArtifactRepo>('@/db/artifactRepo');
  realRemoveKind = actual.deleteArtifactsOfKind;
  await clearDatabase();
  vi.clearAllMocks();
  removeKindMock.mockImplementation(realRemoveKind);
});
afterEach(cleanup);

/**
 * Per-region "remove all" (owner request: a remove-all button beside each
 * kind region's `+`). Pinned here: the presence rules (a kind region with
 * rows offers it; the Party, the module group and the library group never
 * do), the confirm's LIVE census copy, cancel writing nothing, the confirm
 * deleting exactly that kind, the toast reporting the in-transaction counts,
 * and a failing seam surfacing through `toastError` (AGENTS rule 2).
 */

async function makeModule(campaignId: Id, title: string): Promise<Id> {
  const module = await createModule(
    buildModule({
      campaignId,
      title,
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  return module.id;
}

/** The header row a kind region / group renders (label + its action buttons).
 * Found by its CollapsibleTrigger BUTTON, because the scope control above the
 * tree carries its own "Library"/"Campaign" labels. */
function groupHeader(label: string): HTMLElement {
  const trigger = screen
    .getAllByRole('button')
    .find((button) => button.textContent.startsWith(label));
  const header = trigger?.parentElement;
  if (header === undefined || header === null) {
    throw new Error(`no group header rendered for ${label}`);
  }
  return header;
}

function renderTree(
  campaignId: Id,
  artifacts: readonly Artifact[],
  globals: readonly GlobalArtifact[] = [],
): void {
  render(
    <MemoryRouter>
      <CampaignTree
        campaignId={campaignId}
        artifacts={artifacts}
        globals={globals}
        selectedArtifactId={undefined}
        onSelectArtifact={vi.fn()}
      />
    </MemoryRouter>,
  );
}

function renderWorkspace(campaignId: Id): void {
  render(
    <MemoryRouter initialEntries={[workspacePath(campaignId)]}>
      <Routes>
        <Route path={ROUTES.workspace} element={<WorkspacePage />} />
        <Route path={ROUTES.artifact} element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CampaignTree — per-region remove-all button', () => {
  it('sits beside the region’s own + for kinds with rows — never for the Party, the module group or the library', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const location = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
    });
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    const moduleNote = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'note',
      name: 'Vault note',
    });
    const publishedRow = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Lib Tower',
    });
    const libraryRow = await publishToLibrary(publishedRow.id);
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });

    renderTree(campaign.id, [npc, location, pc, moduleNote], [libraryRow]);

    const npcButton = await screen.findByTestId('remove-all-npc');
    // IN the region header, next to its `+` (not a row action, not elsewhere).
    const npcHeader = groupHeader('NPCs');
    expect(npcHeader).toContainElement(npcButton);
    expect(within(npcHeader).getByLabelText('New NPC')).toBeInTheDocument();
    expect(npcButton).toHaveAttribute('aria-label', 'Remove all NPCs');
    expect(screen.getByTestId('remove-all-location')).toBeInTheDocument();

    // The Party region HAS a row and still offers nothing (excluded kind).
    expect(groupHeader('Party')).toHaveTextContent('1');
    expect(screen.queryByTestId('remove-all-pc')).toBeNull();
    expect(screen.queryByLabelText('Remove all Party')).toBeNull();
    // A kind with no campaign-level rows of its own offers nothing.
    expect(screen.queryByTestId('remove-all-note')).toBeNull();
    // The module-owned note row lives in its module group — no remove-all
    // there (module rows are out of reach of this action).
    await screen.findByText('Ember Vault');
    expect(within(groupHeader('Ember Vault')).queryByRole('button', { name: /^Remove all/ })).toBeNull();
    // And the Library group never carries one: its rows are `campaignId ===
    // null` and structurally unreachable.
    expect(within(groupHeader('Library')).queryByRole('button', { name: /^Remove all/ })).toBeNull();
  });

  it('offers nothing when the campaign holds only module-owned or library rows', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const moduleNpc = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'npc',
      name: 'Vault guard',
    });
    const publishedRow = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Lib Goblin',
    });
    const libraryRow = await publishToLibrary(publishedRow.id);
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });

    renderTree(campaign.id, [moduleNpc], [libraryRow]);

    // The NPCs region renders (empty) and the header offers only the `+`.
    const npcHeader = await waitFor(() => groupHeader('NPCs'));
    expect(within(npcHeader).getByLabelText('New NPC')).toBeInTheDocument();
    expect(within(npcHeader).queryByRole('button', { name: /^Remove all/ })).toBeNull();
    expect(screen.queryByTestId('remove-all-npc')).toBeNull();
  });
});

describe('CampaignTree — remove-all confirm', () => {
  async function seed(): Promise<{ campaignId: Id; npc: Id; keeper: Id; pc: Id; library: Id }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const moduleId = await makeModule(campaign.id, 'Ember Vault');
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    await updateArtifact(npc.id, { body: 'changed' }); // second revision
    const doomed = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Hobgoblin' });
    const keeper = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
      links: [{ targetId: npc.id, relation: 'ally' }],
    });
    const pc = await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    const moduleNpc = await createArtifact({
      campaignId: campaign.id,
      moduleId,
      kind: 'npc',
      name: 'Vault guard',
    });
    const librarySource = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Lib Goblin',
    });
    const library = await publishToLibrary(librarySource.id);
    expect(doomed.id).toBeDefined();
    expect(moduleNpc.id).toBeDefined();
    return { campaignId: campaign.id, npc: npc.id, keeper: keeper.id, pc: pc.id, library: library.id };
  }

  it('cancel writes nothing at all', async () => {
    const user = userEvent.setup();
    const { campaignId, npc } = await seed();
    renderWorkspace(campaignId);
    const before = await actDrained(() => db.artifacts.toArray());
    const revisionsBefore = await actDrained(() => db.revisions.count());

    await user.click(await screen.findByTestId('remove-all-npc'));
    const confirm = await screen.findByTestId('remove-all-npc-confirm');
    // The census is a live query: it lands after the dialog's first paint.
    await waitFor(() => {
      expect(within(confirm).getByTestId('remove-all-npc-counts')).toHaveTextContent(
        /no undo for artifacts/,
      );
    });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('remove-all-npc-confirm')).not.toBeInTheDocument();
    });
    expect(removeKindMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(await actDrained(() => db.artifacts.toArray())).toEqual(before);
    expect(await actDrained(() => db.revisions.count())).toBe(revisionsBefore);
    expect(await actDrained(() => db.artifacts.get(npc))).toBeDefined();
  });

  it('names the campaign, shows the live census, deletes exactly that kind and toasts the real counts', async () => {
    const user = userEvent.setup();
    const { campaignId, npc, keeper, pc, library } = await seed();
    renderWorkspace(campaignId);
    await screen.findByText('Goblin');

    await user.click(await screen.findByTestId('remove-all-npc'));
    const confirm = await screen.findByTestId('remove-all-npc-confirm');
    // Campaign for context + the live census: rows, revision history, and the
    // surprising half (the survivor that loses its back-link).
    await waitFor(() => {
      expect(within(confirm).getByText(/Remove all NPCs from .Ember./)).toBeInTheDocument();
    });
    const counts = within(confirm).getByTestId('remove-all-npc-counts');
    await waitFor(() => {
      expect(counts).toHaveTextContent(/permanently deletes 2 NPCs/);
    });
    expect(counts).toHaveTextContent(/3 revision-history entries/);
    expect(counts).toHaveTextContent(/1 surviving artifact keeps working but loses a link/);
    expect(counts).toHaveTextContent(/no undo for artifacts/);
    // The two guards the owner must be able to trust, in the dialog itself.
    expect(counts).toHaveTextContent(/module-owned rows and the global library are never touched/);
    expect(counts).toHaveTextContent(/Only this campaign’s own NPCs are removed/);

    const action = within(confirm).getByTestId('remove-all-npc-confirm-action');
    expect(action).not.toBeDisabled();
    await user.click(action);

    await waitFor(() => {
      expect(screen.queryByTestId('remove-all-npc-confirm')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Removed 2 NPCs, 3 revisions, 1 back-link cleaned.',
      );
    });
    expect(toastErrorMock).not.toHaveBeenCalled();

    // Exactly that kind went: the survivors — including the module-owned npc
    // and the SAME-KIND library row — are intact, and the back-link is gone.
    expect(await actDrained(() => db.artifacts.get(npc))).toBeUndefined();
    const survivor = await actDrained(() => db.artifacts.get(keeper));
    expect(survivor?.links).toEqual([]);
    expect(await actDrained(() => db.artifacts.get(pc))).toBeDefined();
    expect(await actDrained(() => db.artifacts.get(library))).toBeDefined();
    expect(
      await actDrained(() =>
        db.artifacts.where('campaignId').equals(campaignId).filter((row) => row.kind === 'npc').toArray(),
      ),
    ).toHaveLength(1); // the module-owned guard only
  });

  it('surfaces a failing seam through toastError and deletes nothing', async () => {
    const user = userEvent.setup();
    const { campaignId, npc } = await seed();
    renderWorkspace(campaignId);
    removeKindMock.mockRejectedValueOnce(new Error('simulated seam failure'));

    await user.click(await screen.findByTestId('remove-all-npc'));
    const confirm = await screen.findByTestId('remove-all-npc-confirm');
    await user.click(within(confirm).getByTestId('remove-all-npc-confirm-action'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not remove all NPCs',
        expect.objectContaining({ message: 'simulated seam failure' }),
      );
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(await actDrained(() => db.artifacts.get(npc))).toBeDefined();
  });
});
