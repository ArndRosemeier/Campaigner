import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLiveQuery } from 'dexie-react-hooks';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';

import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { createCampaign, getCampaign } from '@/db/campaignRepo';
import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createModule, listModulesByCampaign } from '@/db/moduleRepo';
import { createModule as buildModule, type Campaign, type Id } from '@/domain';
import type * as Maintenance from '@/db/maintenance';
import { modulePath, workspacePath } from '@/app/routes';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The clear aborts in-flight module passes first — that dynamic import must
// never start real LLM machinery in this test.
vi.mock('@/llm/moduleGen', () => ({ cancelModuleGen: vi.fn() }));

vi.mock('@/db/maintenance', async (importOriginal) => {
  const actual = await importOriginal<typeof Maintenance>();
  // Wrapped (not replaced) so most tests exercise the real clear; the
  // in-flight test overrides the implementation per-test.
  return { ...actual, deleteCampaignWorkspace: vi.fn(actual.deleteCampaignWorkspace) };
});

const { toastError, toastSuccess } = await import('@/lib/toast');
const { deleteCampaignWorkspace } = await import('@/db/maintenance');
const deleteWorkspaceMock = vi.mocked(deleteCampaignWorkspace);
const toastSuccessMock = vi.mocked(toastSuccess);
const toastErrorMock = vi.mocked(toastError);

function LocationProbe(): JSX.Element {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

/** Live-query mirrors of the campaign lists — proves no deleted row lingers
 * in any store after the clear (no silent stale UI). */
function StoreProbes({ campaignId }: { campaignId: Id }): JSX.Element {
  const modules = useLiveQuery(() => listModulesByCampaign(campaignId), [campaignId]);
  const artifacts = useLiveQuery(() => listArtifactsByCampaign(campaignId), [campaignId]);
  const moduleText = modules === undefined ? '?' : String(modules.length);
  const artifactText = artifacts === undefined ? '?' : String(artifacts.length);
  return <div data-testid="store-probes">{`${moduleText} modules, ${artifactText} artifacts`}</div>;
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});
afterEach(cleanup);

/**
 * Per-campaign "Clear workspace" UI (campaign settings surface): the Edit
 * campaign dialog carries the action beside the fresh-generation wipe; the
 * confirm types the CAMPAIGN'S NAME (exact, case-sensitive); confirming
 * clears through maintenance (Party included), toasts loud naming the
 * campaign, navigates out of deleted child routes, and leaves no ghosts in
 * the live stores. A second click while clearing refuses loudly.
 */
describe('EditCampaignDialog — clear workspace', () => {
  async function seed(name = 'Emberfall'): Promise<{ campaign: Campaign; moduleId: Id }> {
    const campaign = await createCampaign({
      name,
      description: 'A valley of ash.',
      system: 'dnd5e',
    });
    await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
    const module = await createModule(
      buildModule({
        campaignId: campaign.id,
        title: 'Ember Vault',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'note',
      name: 'Module note',
    });
    return { campaign, moduleId: module.id };
  }

  function renderDialog(campaign: Campaign, path: string): void {
    render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <StoreProbes campaignId={campaign.id} />
        <EditCampaignDialog campaign={campaign} open={true} onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );
  }

  async function openClearConfirm(): Promise<HTMLElement> {
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('clear-workspace'));
    const confirm = await screen.findByTestId('clear-workspace-confirm-dialog');
    return confirm;
  }

  it('requires the exact campaign name — wrong or empty refuses and deletes nothing', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    renderDialog(campaign, workspacePath(campaign.id));

    const confirm = await openClearConfirm();
    const nameInput = within(confirm).getByTestId('clear-workspace-name');
    const confirmButton = within(confirm).getByTestId('clear-workspace-confirm');

    // Empty refuses (button armed only on exact match).
    expect(confirmButton).toBeDisabled();
    // Wrong case refuses loudly: visible mismatch, still disarmed.
    await user.type(nameInput, 'emberfall');
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/doesn’t match/);
    expect(confirmButton).toBeDisabled();
    // A wrong full name refuses too.
    await user.clear(nameInput);
    await user.type(nameInput, 'Emberfall!');
    expect(confirmButton).toBeDisabled();

    expect(deleteWorkspaceMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // Nothing deleted: the workspace is intact.
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(3);
    expect(await db.modules.where('campaignId').equals(campaign.id).count()).toBe(1);
  });

  it('clears on the exact name, toasts the campaign, navigates out of deleted content, leaves no ghosts', async () => {
    const user = userEvent.setup();
    const { campaign, moduleId } = await seed();
    // Sitting on a module reader — deleted content — when the clear lands.
    renderDialog(campaign, modulePath(campaign.id, moduleId));

    const confirm = await openClearConfirm();
    await user.type(within(confirm).getByTestId('clear-workspace-name'), 'Emberfall');
    const confirmButton = within(confirm).getByTestId('clear-workspace-confirm');
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    // Loud success toast naming the campaign.
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Emberfall'));
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    // Navigated out of the deleted module route to the (now empty) campaign page.
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(workspacePath(campaign.id));
    });
    // Live stores show no ghosts: every list re-fired on the commit.
    await waitFor(() => {
      expect(screen.getByTestId('store-probes')).toHaveTextContent('0 modules, 0 artifacts');
    });
    expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(0);
    expect(await db.modules.where('campaignId').equals(campaign.id).count()).toBe(0);
    // The campaign row itself survives with its premise byte-identical.
    const survivor = await getCampaign(campaign.id);
    expect(survivor?.name).toBe('Emberfall');
    expect(survivor?.description).toBe('A valley of ash.');
    expect(survivor?.system).toBe('dnd5e');
  });

  it('stays put when clearing from the campaign page itself', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    renderDialog(campaign, workspacePath(campaign.id));

    const confirm = await openClearConfirm();
    await user.type(within(confirm).getByTestId('clear-workspace-name'), 'Emberfall');
    await user.click(within(confirm).getByTestId('clear-workspace-confirm'));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Emberfall'));
    });
    expect(screen.getByTestId('location')).toHaveTextContent(workspacePath(campaign.id));
  });

  it('refuses a second click while a clear is in flight — one wipe at a time', async () => {
    const user = userEvent.setup();
    const { campaign } = await seed();
    // The first clear never settles, so the second click lands mid-flight.
    deleteWorkspaceMock.mockImplementation(() => new Promise<never>(() => undefined));
    renderDialog(campaign, workspacePath(campaign.id));

    const confirm = await openClearConfirm();
    await user.type(within(confirm).getByTestId('clear-workspace-name'), 'Emberfall');
    const confirmButton = within(confirm).getByTestId('clear-workspace-confirm');
    await user.click(confirmButton);
    // The in-flight label proves the guard is armed before the second click.
    expect(await within(confirm).findByText('Clearing…')).toBeDefined();

    await user.click(confirmButton);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining('already being cleared'));
    });
    expect(deleteWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
