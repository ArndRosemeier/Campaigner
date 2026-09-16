import 'fake-indexeddb/auto';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createModule, type Campaign, type EncounterArtifactData, type Module } from '@/domain';
import type * as ToastModule from '@/lib/toast';
import { isModuleGenerationClaimed } from '@/llm/canvasBusy';
import { useProgressStore } from '@/lib/progress';
import { bumpStopEpoch } from '@/lib/stopEpoch';
import {
  MODULE_RESTOCK_CONSOLE_TAG,
  restockModuleEncounters,
} from '@/features/modules/module-restock';
import { ModuleRestockButton } from '@/features/modules/module-restock-button';
import { clearDatabase } from '../db/helpers';

/**
 * The module-level restock sweep (docs/17 row 195): ONE loop over a module's
 * encounter artifacts that drives the EXISTING repopulate seam once per
 * encounter. `encounterRegen` is mocked HERE on purpose — the assertion target
 * is the SWEEP's own contract (which encounters, in what order, one at a time,
 * the module slot held, the stop epoch respected, and how a failure is
 * reported), while the run-level behaviour of repopulate itself is pinned where
 * the engine really runs (`tests/llm/encounterRepopulate.test.ts`) and the
 * row-196 portrait interaction is pinned in `tests/features/portrait-queues.test.ts`.
 */

const { repopulateMock, toastErrorPersistentMock, toastInfoMock, toastSuccessMock, toastErrorMock } =
  vi.hoisted(() => ({
    repopulateMock: vi.fn(),
    toastErrorPersistentMock: vi.fn(),
    toastInfoMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));

vi.mock('@/features/campaign/encounterRegen', () => ({
  repopulateEncounter: repopulateMock,
}));

vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return {
    ...actual,
    toastErrorPersistent: toastErrorPersistentMock,
    toastInfo: toastInfoMock,
    toastSuccess: toastSuccessMock,
    toastError: toastErrorMock,
  };
});

function encounterData(): EncounterArtifactData {
  return {
    difficulty: '',
    levelHint: '3',
    monsters: [],
    terrain: '',
    tactics: '',
    treasure: '',
    mapImageId: null,
    preset: 'standard',
    locationKind: 'other',
    siteShape: 'single',
    budgetAdvisory: '',
    layout: null,
  };
}

interface World {
  campaign: Campaign;
  module: Module;
}

async function seedWorld(): Promise<World> {
  const campaign = await createCampaign({ name: 'Restock Campaign', system: 'dnd5e' });
  const module = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Restock Depths',
      concept: 'a module with several fights',
      levelMin: 1,
      levelMax: 5,
      sizeDial: 'standard',
    }),
  );
  return { campaign, module };
}

async function seedEncounter(
  campaignId: string,
  moduleId: string | null,
  name: string,
): Promise<string> {
  const artifact = await createArtifact({
    campaignId,
    ...(moduleId === null ? {} : { moduleId }),
    kind: 'encounter',
    name,
    summary: '',
    body: '',
    data: encounterData(),
  });
  return artifact.id;
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  repopulateMock.mockReset();
  toastErrorPersistentMock.mockReset();
  toastInfoMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  repopulateMock.mockResolvedValue(undefined);
});

describe('the module restock sweep (docs/17 row 195)', () => {
  it('visits EVERY encounter the module owns, never another module’s or a campaign-level one', async () => {
    const world = await seedWorld();
    const second = await saveModule(
      createModule({
        campaignId: world.campaign.id,
        title: 'Other Module',
        concept: '',
        levelMin: 1,
        levelMax: 2,
        sizeDial: 'sketch',
      }),
    );
    // Alphabetical visit order is the repo's own list order.
    const bravo = await seedEncounter(world.campaign.id, world.module.id, 'Bravo Vault');
    const alpha = await seedEncounter(world.campaign.id, world.module.id, 'Alpha Gate');
    const charlie = await seedEncounter(world.campaign.id, world.module.id, 'Charlie Crypt');
    const foreign = await seedEncounter(world.campaign.id, second.id, 'Foreign Hall');
    const campaignLevel = await seedEncounter(world.campaign.id, null, 'Roadside Ambush');

    const report = await restockModuleEncounters(world.module.id);

    expect(report.total).toBe(3);
    expect(report.restocked).toEqual([alpha, bravo, charlie]);
    expect(report.failed).toEqual([]);
    expect(report.stopped).toBe(false);
    expect(repopulateMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      alpha,
      bravo,
      charlie,
    ]);
    // Roster-only: the sweep never ticks the prose lever.
    expect(repopulateMock).toHaveBeenCalledWith(alpha, { redesignProse: false });
    expect(repopulateMock.mock.calls.map((call: unknown[]) => call[0])).not.toContain(foreign);
    expect(repopulateMock.mock.calls.map((call: unknown[]) => call[0])).not.toContain(campaignLevel);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Restocked all 3 encounters in "The Restock Depths"',
    );
  });

  it('runs SEQUENTIALLY, holds the module slot throughout, and reports through the dock', async () => {
    const world = await seedWorld();
    const first = await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    const second = await seedEncounter(world.campaign.id, world.module.id, 'Bravo');

    let active = 0;
    let maxActive = 0;
    let dockLabel: string | undefined;
    let slotHeldDuringRun = false;
    repopulateMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      dockLabel ??= useProgressStore
        .getState()
        .jobs.find((job) => job.id === `module-restock:${world.module.id}`)?.label;
      slotHeldDuringRun = isModuleGenerationClaimed(world.module.id);
      await Promise.resolve();
      active -= 1;
    });

    const report = await restockModuleEncounters(world.module.id);

    expect(repopulateMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([first, second]);
    // A pool would have overlapped here; the loop awaits each run.
    expect(maxActive).toBe(1);
    expect(slotHeldDuringRun).toBe(true);
    expect(dockLabel).toBe('Restocking The Restock Depths');
    // The dock job and the module slot are both released when the sweep ends.
    expect(useProgressStore.getState().jobs).toEqual([]);
    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
    expect(report.restocked).toHaveLength(2);
  });

  it('is LOUD and names every failure with its reason (continue-on-failure policy)', async () => {
    const world = await seedWorld();
    const first = await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    const bad = await seedEncounter(world.campaign.id, world.module.id, 'Bravo');
    const third = await seedEncounter(world.campaign.id, world.module.id, 'Charlie');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    repopulateMock.mockImplementation((id: string) => {
      if (id === bad) return Promise.reject(new Error('the model refused the roster'));
      return Promise.resolve();
    });

    const report = await restockModuleEncounters(world.module.id);

    // Continue-on-failure: the other two still restocked.
    expect(report.restocked).toEqual([first, third]);
    expect(report.failed).toEqual([
      { artifactId: bad, name: 'Bravo', reason: 'the model refused the roster' },
    ]);
    // The user-visible surface is persistent and names the failure and its reason.
    expect(toastErrorPersistentMock).toHaveBeenCalledTimes(1);
    const [title, error] = toastErrorPersistentMock.mock.calls[0] as [string, Error];
    expect(title).toBe('Restocked 2 of 3 encounters in "The Restock Depths" — 1 failed.');
    expect(error.message).toBe('«Bravo»: the model refused the roster');
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // The pasteable record carries the same list past the toast.
    const record = consoleSpy.mock.calls
      .map((call: unknown[]) => call[0])
      .find((line): line is string => typeof line === 'string' && line.startsWith(MODULE_RESTOCK_CONSOLE_TAG));
    expect(record).toContain('"name":"Bravo"');
    expect(record).toContain('the model refused the roster');
    consoleSpy.mockRestore();
  });

  it('a Stop all ends the sweep at the next boundary and says so', async () => {
    const world = await seedWorld();
    await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    await seedEncounter(world.campaign.id, world.module.id, 'Bravo');
    await seedEncounter(world.campaign.id, world.module.id, 'Charlie');
    // The first encounter completes, and the stop lands during it (the epoch
    // bump is exactly what `stopAllGenerations` does before it cancels runs).
    repopulateMock.mockImplementationOnce(() => {
      bumpStopEpoch();
      return Promise.resolve();
    });

    const report = await restockModuleEncounters(world.module.id);

    expect(repopulateMock).toHaveBeenCalledTimes(1);
    expect(report.restocked).toHaveLength(1);
    expect(report.stopped).toBe(true);
    expect(report.failed).toEqual([]);
    expect(toastInfoMock).toHaveBeenCalledWith(
      'Stopped — restocked 1 of 3 encounters in "The Restock Depths"; the rest were not touched',
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(isModuleGenerationClaimed(world.module.id)).toBe(false);
  });

  it('a run cancelled by the existing Stop is a stop, never a named failure', async () => {
    const world = await seedWorld();
    await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    await seedEncounter(world.campaign.id, world.module.id, 'Bravo');
    repopulateMock.mockImplementationOnce(() => {
      bumpStopEpoch();
      return Promise.reject(new Error('Repopulate ended cancelled'));
    });

    const report = await restockModuleEncounters(world.module.id);

    expect(report.stopped).toBe(true);
    expect(report.failed).toEqual([]);
    expect(toastErrorPersistentMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledTimes(1);
  });

  it('says so honestly when the module has no encounters', async () => {
    const world = await seedWorld();
    const report = await restockModuleEncounters(world.module.id);
    expect(report.total).toBe(0);
    expect(repopulateMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledWith(
      '"The Restock Depths" has no encounters to restock',
    );
  });
});

describe('the module restock control shows the difficulty it will run at (docs/17 row 195)', () => {
  it('renders the resolved difficulty read-only beside the button (legacy null reads Normal)', async () => {
    const world = await seedWorld();
    await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    const { unmount } = render(<ModuleRestockButton module={world.module} />);
    // The field is absent on a module created without an explicit choice — the
    // compatibility reading, exactly as the engine resolves it.
    expect(screen.getByTestId('module-restock-difficulty')).toHaveTextContent('Normal');
    unmount();

    render(<ModuleRestockButton module={{ ...world.module, difficulty: 'harder' }} />);
    expect(screen.getByTestId('module-restock-difficulty')).toHaveTextContent('Harder');
  });

  it('pressing it runs the real sweep', async () => {
    const world = await seedWorld();
    const encounter = await seedEncounter(world.campaign.id, world.module.id, 'Alpha');
    render(<ModuleRestockButton module={{ ...world.module, difficulty: 'much-harder' }} />);

    await userEvent.click(screen.getByTestId('module-restock'));

    expect(repopulateMock).toHaveBeenCalledTimes(1);
    expect(repopulateMock).toHaveBeenCalledWith(encounter, { redesignProse: false });
  });
});
