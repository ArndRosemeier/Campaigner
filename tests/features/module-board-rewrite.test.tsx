import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { boardPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { useBoardStore } from '@/features/modules/board/boardStore';
import { useStagedRewritesStore } from '@/features/modules/board/stagedRewrites';

/**
 * Board rewrite + staged rewrites through the UI (08-MODULE-DESIGNER
 * §Module board): the rewrite dialog (instruction + per-run prior-modules
 * override), the engine seam (runParts subset — rewritePart semantics
 * WITHOUT the swallow-all catch, so ModuleBusyError surfaces loudly), the
 * ghost preview (rAF-throttled tokens — partial text never touches the row),
 * "Show previous", Apply through the ONE part-text save path (edited:true +
 * promote scan), Discard restoring the old text, and the board Stop button.
 * The LLM engine itself is mocked at `runParts` (its internals — floor
 * gates, normalization — are pinned by tests/llm/moduleGen-*); the streaming
 * emitter stays real.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteSecondModuleUses: vi.fn(),
}));

vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    runParts: vi.fn(),
    cancelModuleGen: vi.fn(),
  };
});

const { runParts, cancelModuleGen } = await import('@/llm/moduleGen');
const runPartsMock = vi.mocked(runParts);
const cancelModuleGenMock = vi.mocked(cancelModuleGen);
const { promoteSecondModuleUses } = await import('@/db/artifactAutoPromote');
const promoteSpy = vi.mocked(promoteSecondModuleUses);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const OLD_TEXT = 'The old gate bargain text. '.repeat(10);
const NEW_TEXT = 'The brand-new rewritten text. '.repeat(10);

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(options: { includePriorModules?: boolean } = {}): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: options.includePriorModules ?? false,
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'The premise.',
      themes: [],
      partPlan: [
        { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
        { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
      ],
    }),
    parts: [
      modulePartSchema.parse({ planIndex: 0, markdown: OLD_TEXT, status: 'ready', errorMessage: '', edited: false }),
      modulePartSchema.parse({ planIndex: 1, markdown: 'Part two. '.repeat(10), status: 'ready', errorMessage: '', edited: false }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

/** The mocked engine: streams tokens, then writes the ready row itself —
 * exactly the observable surface a real runParts subset has. */
function mockEngineRun(): void {
  runPartsMock.mockImplementation(async (moduleId, _campaign, options) => {
    const planIndex = options?.planIndexes?.[0];
    if (planIndex === undefined) throw new Error('mock expects a subset run');
    const { moduleGenEvents } = await import('@/llm/moduleGen');
    moduleGenEvents.emit({ kind: 'part-token', moduleId, planIndex, delta: 'The brand-new ' });
    moduleGenEvents.emit({ kind: 'part-token', moduleId, planIndex, delta: 'rewritten text. ' });
    await patchModule(moduleId, {
      parts: [
        modulePartSchema.parse({ planIndex, markdown: NEW_TEXT, status: 'ready', errorMessage: '', edited: false }),
        modulePartSchema.parse({ planIndex: 1, markdown: 'Part two. '.repeat(10), status: 'ready', errorMessage: '', edited: false }),
      ],
    });
    moduleGenEvents.emit({ kind: 'done', moduleId });
    const row = await getModule(moduleId);
    if (row === undefined) throw new Error('module row vanished during mock run');
    return row;
  });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  // Module-level session stores: reset so one test's staging/zoom never
  // leaks into the next (the page's own reset is keyed by module id).
  useStagedRewritesStore.setState({ byNodeKey: {} });
  useBoardStore.getState().resetFor('reset');
  await seedModule();
});

describe('board rewrite + staging', () => {
  it('rewrites: ghost preview → proposed framing → apply lands edited:true through the save path', async () => {
    const user = userEvent.setup();
    mockEngineRun();
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    const partCard = await screen.findByTestId('board-part-0', {}, { timeout: 10_000 });

    await user.click(within(partCard).getByTestId('board-part-rewrite-0'));
    const dialog = await screen.findByTestId('board-rewrite-dialog');
    await user.type(within(dialog).getByLabelText('Optional instruction'), 'make it rain');
    // The prior-modules toggle defaults to the ROW's flag (false here).
    expect(within(dialog).getByTestId('board-rewrite-prior-modules')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.click(within(dialog).getByTestId('board-rewrite-confirm'));
    // Drain the click's async continuation (engine mock + row write +
    // staging) inside act — otherwise liveQuery updates leak.
    await flushAsyncUpdates();

    // The engine ran as a SUBSET (one plan index) with the dialog's values.
    await waitFor(() => {
      expect(runPartsMock).toHaveBeenCalledTimes(1);
    });
    expect(runPartsMock.mock.calls[0]?.[2]).toMatchObject({
      planIndexes: [0],
      extraInstruction: 'make it rain',
      includePriorModules: false,
    });

    // Streaming ghost preview (rAF-throttled): partial text on the card while
    // the proposal is still being written.
    await waitFor(() => {
      expect(within(screen.getByTestId('board-part-0')).getByTestId('board-part-staged')).toBeInTheDocument();
    });
    await waitFor(
      () => {
        expect(screen.getByTestId('board-part-staged-text')).toHaveTextContent(/rewritten text/);
      },
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('board-part-staged')).toHaveAttribute('data-staged-status', 'proposed');

    // The engine landed: the complete new text renders AS-IS (no diff view),
    // with Show previous for the old text.
    await waitFor(() => {
      expect(screen.getByTestId('board-part-show-previous')).toBeInTheDocument();
    });
    expect(screen.getByTestId('board-part-staged-text')).toHaveTextContent('brand-new rewritten text');
    await user.click(screen.getByTestId('board-part-show-previous'));
    expect(screen.getByTestId('board-part-staged-text')).toHaveTextContent('old gate bargain');
    await user.click(screen.getByTestId('board-part-show-previous'));

    // Apply: THE one part-text save path (edited:true) + promote scan fired.
    await user.click(screen.getByTestId('board-part-apply'));
    await waitFor(() => {
      expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [NEW_TEXT]);
    });
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      const part = row?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.markdown).toBe(NEW_TEXT);
      expect(part?.edited).toBe(true);
      expect(part?.status).toBe('ready');
    });
    expect(toastSuccessMock).toHaveBeenCalledWith('Rewrite applied');
    // Staging dropped: the card renders canonical content again.
    await waitFor(() => {
      expect(within(screen.getByTestId('board-part-0')).queryByTestId('board-part-staged')).not.toBeInTheDocument();
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('discard restores the previous text through the save path and drops the staging', async () => {
    const user = userEvent.setup();
    mockEngineRun();
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    const partCard = await screen.findByTestId('board-part-0', {}, { timeout: 10_000 });

    await user.click(within(partCard).getByTestId('board-part-rewrite-0'));
    await user.click(await screen.findByTestId('board-rewrite-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('board-part-discard')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('board-part-discard'));
    await waitFor(async () => {
      const row = await getModule(world.moduleId);
      const part = row?.parts.find((entry) => entry.planIndex === 0);
      expect(part?.markdown).toBe(OLD_TEXT);
      expect(part?.edited).toBe(true);
    });
    // Discard restores through the save path — promote scan fired for the
    // restored text too (it is a part-text write like any other).
    expect(promoteSpy).toHaveBeenCalledWith(world.moduleId, [OLD_TEXT]);
    await waitFor(() => {
      expect(within(screen.getByTestId('board-part-0')).queryByTestId('board-part-staged')).not.toBeInTheDocument();
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('surfaces a busy module LOUDLY (ModuleBusyError) and never queues silently', async () => {
    const user = userEvent.setup();
    // The REAL class (kept via the mock spread) — the page's instanceof check
    // must recognise it for the loud busy surface.
    const { ModuleBusyError } = await import('@/llm/moduleGen');
    const busyError = new ModuleBusyError(world.moduleId);
    runPartsMock.mockRejectedValue(busyError);
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    const partCard = await screen.findByTestId('board-part-0', {}, { timeout: 10_000 });

    await user.click(within(partCard).getByTestId('board-part-rewrite-0'));
    await user.click(await screen.findByTestId('board-rewrite-confirm'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'A generation is already running for this module — wait for it or stop it first',
        busyError,
      );
    });
    // No staging left behind on failure.
    await waitFor(() => {
      expect(within(screen.getByTestId('board-part-0')).queryByTestId('board-part-staged')).not.toBeInTheDocument();
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('honours the per-run prior-modules override from the dialog', async () => {
    const user = userEvent.setup();
    await clearDatabase();
    await seedModule({ includePriorModules: true });
    mockEngineRun();
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    const partCard = await screen.findByTestId('board-part-0', {}, { timeout: 10_000 });

    await user.click(within(partCard).getByTestId('board-part-rewrite-0'));
    const dialog = await screen.findByTestId('board-rewrite-dialog');
    expect(within(dialog).getByTestId('board-rewrite-prior-modules')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Turn it OFF for this run only — the row keeps its flag.
    await user.click(within(dialog).getByTestId('board-rewrite-prior-modules'));
    await user.click(within(dialog).getByTestId('board-rewrite-confirm'));
    await flushAsyncUpdates();

    await waitFor(() => {
      expect(runPartsMock).toHaveBeenCalledTimes(1);
    });
    expect(runPartsMock.mock.calls[0]?.[2]).toMatchObject({ includePriorModules: false });
    expect((await getModule(world.moduleId))?.includePriorModules).toBe(true);
    await flushAsyncUpdates();
  }, 30_000);

  it('shows the Stop button while generating (cancelModuleGen is the one stop path)', async () => {
    const user = userEvent.setup();
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    runPartsMock.mockImplementation(() => new Promise(() => undefined));
    renderAppAt(boardPath(world.campaignId, world.moduleId));
    await screen.findByTestId('board-part-0', {}, { timeout: 10_000 });

    const stop = await screen.findByTestId('board-stop');
    await user.click(stop);
    expect(cancelModuleGenMock).toHaveBeenCalledWith(world.moduleId);
    // While busy, rewrite affordances are disabled.
    expect(screen.getByTestId('board-part-rewrite-0')).toBeDisabled();
    await flushAsyncUpdates();
  }, 30_000);
});
