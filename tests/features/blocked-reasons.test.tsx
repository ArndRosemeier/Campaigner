import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import {
  canvasChatKey,
  useCanvasChatStore,
  type CanvasChatMessage,
} from '@/features/modules/canvas/chatStore';
import { ChatSidebar } from '@/features/modules/canvas/ChatSidebar';
import { useCanvasPreviewStore } from '@/features/modules/canvas/previewStore';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * A blocked control's REASON, on the canvas and its chat sidebar (docs/18 §2.3,
 * docs/05-UI §"Why a control cannot act").
 *
 * The owner's report was three canvas header controls that "did nothing". They
 * were implemented, pinned and correct — what was missing was a perceivable
 * reason: the two AI buttons were natively disabled, and the only stated reason
 * lived in a `title` (invisible in Chrome, unreachable by keyboard).
 *
 * So every pin here asserts BOTH halves, and neither alone is enough:
 * the control is STILL disabled exactly as the spec'd gate says, AND the reason
 * is present, associated via `aria-describedby`, and reachable by hover (absent
 * before the hover, so a wrapper that never receives it fails the pin instead
 * of passing vacuously). States whose block is self-evident (a blank chat
 * input) are pinned as exactly that: disabled with NO wrapper at all.
 *
 * ONE gate was lifted rather than explained (docs/17 row 102): the canvas opens
 * in the preview and the AI actions used to be disabled there, so the first
 * press of either did nothing AND, before the device existed, said nothing. The
 * owner asked for both to work in the rendered view, so the preview is no
 * longer part of any gate: the pins below assert the inverse — live in BOTH
 * views, no wrapper, no reason — while the REAL blocks (generating, refine in
 * flight, open proposal) still state themselves through the device.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

// A module seeded at `status: 'generating'` means "a live forge owns this
// module", and that is the page-local lease the reconcile guard reads (docs/17
// row 110). The engine is not exercised in this file, so there is no real
// controller to ask — without this, app-start reconciliation would (correctly)
// fail the seeded row as an interrupted generation and the busy-state reasons
// below would be pinning a state the app no longer shows for such a row.
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasLiveModuleGen: vi.fn(() => true),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const PART_PLAN = [
  { title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Flooded Nave', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

const GENERATING_REASON = 'The module is generating right now — wait for it (or press Stop).';
const STREAMING_REASON = 'The proposal is still streaming — wait for it, or press Stop proposal.';

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): ReturnType<typeof render> {
  window.history.replaceState(null, '', path);
  return render(<RouterProvider router={createAppRouter()} />);
}

async function seedModule(status: 'ready' | 'generating' = 'ready'): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Keeper Ilse' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    status,
    spine: moduleSpineSchema.parse({
      premise: 'The premise promises a drowned [[Vault Door]].',
      themes: [],
      partPlan: PART_PLAN,
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party bargains with [[Keeper Ilse]] at the gate.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  useCanvasPreviewStore.setState({ ownerModuleId: null, openByModule: {} });
  useCanvasChatStore.setState({ ownerModuleId: null, byModule: {} });
});

afterEach(cleanup);

async function renderCanvas(): Promise<void> {
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
}

/** The reason the device attached to `testId`, or null when it has none. */
function reasonTextOf(testId: string): string | null {
  return screen.queryByTestId(`${testId}-reason`)?.textContent ?? null;
}

describe('the canvas header states why its controls cannot act', () => {
  beforeEach(async () => {
    await seedModule();
  });

  it('first open (preview by default): both AI actions are LIVE there — the view is not a gate', async () => {
    await renderCanvas();
    // The state the owner hit: the canvas lands in the preview.
    expect(screen.getByTestId('canvas-preview')).toBeInTheDocument();

    for (const testId of ['canvas-refine-selection', 'canvas-rewrite-part']) {
      // docs/17 row 102: both actions work in the rendered view, so there is
      // no gate here and no reason to state — a wrapper would mean a block
      // that is not real.
      expect(screen.getByTestId(testId)).toBeEnabled();
      expect(screen.queryByTestId(`${testId}-blocked`)).not.toBeInTheDocument();
      expect(reasonTextOf(testId)).toBeNull();
      // And the copy that used to explain the preview is not on screen either
      // (the source-scan pin: tests/features/canvas-preview-ai-actions).
      expect(document.body.textContent).not.toContain('switch to Edit (the header toggle)');
    }

    // The view toggle is NOT blocked in this state — no reason attached.
    expect(screen.getByTestId('canvas-preview-toggle')).toBeEnabled();
    expect(screen.queryByTestId('canvas-preview-toggle-blocked')).not.toBeInTheDocument();
    expect(reasonTextOf('canvas-preview-toggle')).toBeNull();
    await flushAsyncUpdates();
  }, 30_000);

  it('Edit and Preview leave both AI actions live — the schedule gates them, not the view', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    expect(screen.getByTestId('canvas-refine-selection')).toBeEnabled();
    expect(reasonTextOf('canvas-refine-selection')).toBeNull();

    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor', {}, { timeout: 10_000 });
    expect(screen.getByTestId('canvas-refine-selection')).toBeEnabled();
    expect(reasonTextOf('canvas-refine-selection')).toBeNull();
    expect(screen.queryByTestId('canvas-refine-selection-blocked')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-preview', {}, { timeout: 10_000 });
    expect(screen.getByTestId('canvas-refine-selection')).toBeEnabled();
    expect(screen.queryByTestId('canvas-refine-selection-blocked')).not.toBeInTheDocument();
    expect(reasonTextOf('canvas-refine-selection')).toBeNull();
    await flushAsyncUpdates();
  }, 30_000);

  it('a generating module names THAT as the reason — on the AI actions, the view toggle and the chat send', async () => {
    await seedModule('generating');
    await renderCanvas();
    for (const testId of [
      'canvas-refine-selection',
      'canvas-rewrite-part',
      'canvas-preview-toggle',
      'canvas-chat-send',
    ]) {
      expect(screen.getByTestId(testId)).toBeDisabled();
      expect(reasonTextOf(testId)).toBe(GENERATING_REASON);
    }
    // The chat's reason comes from the page (one copy of the sentence), so the
    // sidebar never has to guess what `aiBusy` means.
    expect(screen.getByTestId('canvas-chat-send-blocked')).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId('canvas-chat-send-reason').id,
    );
    await flushAsyncUpdates();
  }, 30_000);

  it('a streaming proposal holds Apply and Discard, and names Stop proposal as the way out', async () => {
    const user = userEvent.setup();
    let release: (() => void) | null = null;
    const NEW_PART = 'A brand new stormy part.';
    chatMock.mockImplementation(() => {
      return new Promise((resolve) => {
        release = () => {
          resolve({
            text: JSON.stringify({ replacement: NEW_PART }),
            modelUsed: 'test-model',
            fallback: null,
          });
        };
      });
    });
    await renderCanvas();
    await user.click(screen.getByTestId('canvas-preview-toggle'));
    await screen.findByTestId('canvas-editor', {}, { timeout: 10_000 });

    await user.click(screen.getByTestId('canvas-rewrite-part'));
    const dialog = await screen.findByTestId('canvas-instruction-dialog');
    await user.click(within(dialog).getByTestId('canvas-rewrite-part-select'));
    await user.click(await screen.findByRole('option', { name: 'Part 1: The Gate Bargain' }));
    await user.type(within(dialog).getByTestId('canvas-instruction-input'), 'make it stormy');
    await user.click(within(dialog).getByTestId('canvas-instruction-confirm'));
    await flushAsyncUpdates();

    // Held open: the turn is still streaming.
    await screen.findByTestId('canvas-proposal-bar', {}, { timeout: 5_000 });
    expect(screen.getByTestId('canvas-proposal-apply')).toBeDisabled();
    expect(screen.getByTestId('canvas-proposal-discard')).toBeDisabled();
    expect(reasonTextOf('canvas-proposal-apply')).toBe(STREAMING_REASON);
    expect(reasonTextOf('canvas-proposal-discard')).toBe(STREAMING_REASON);
    // The way out the sentence names is ON SCREEN.
    expect(screen.getByTestId('canvas-stop-proposal')).toBeInTheDocument();
    // The header's AI actions are held by the same run and say so too.
    expect(reasonTextOf('canvas-rewrite-part')).toBe('A refine is running.');

    // Settle it: the reason goes with the gate.
    act(() => {
      release?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-proposal-apply')).toBeEnabled();
    });
    expect(reasonTextOf('canvas-proposal-apply')).toBeNull();
    expect(screen.queryByTestId('canvas-proposal-apply-blocked')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);
  it('the Versions menu clear-all is a SELF-EVIDENT block: the menu states the empty state itself', async () => {
    const user = userEvent.setup();
    await renderCanvas();
    await user.click(screen.getByTestId('canvas-versions'));
    const item = await screen.findByTestId('canvas-versions-clear', {}, { timeout: 5_000 });
    // Blocked (Base UI menu items carry aria-disabled, not the native attribute
    // — the reason this control is not a `title`-carrier either).
    expect(item).toHaveAttribute('aria-disabled', 'true');
    // …and WHAT it is blocked on is on screen in the same menu, one line above:
    // the empty state (or the loading state) of the list it would clear.
    const stated =
      screen.queryByTestId('canvas-saved-versions-empty') ??
      screen.queryByTestId('canvas-saved-versions-loading');
    expect(stated).not.toBeNull();
    expect(stated?.textContent ?? '').toContain('versions');
    expect(item).not.toHaveAttribute('title');
    await flushAsyncUpdates();
  }, 30_000);
});

describe('the canvas chat states why its controls cannot act', () => {
  function seedChat(options: { inFlight: boolean; reported: boolean; text: string }): void {
    const outcome = {
      id: 'outcome-1',
      kind: 'failed' as const,
      command: { search: 'nowhere', replace: 'somewhere', all: false },
      targetParts: [{ planIndex: 0, title: 'The Gate Bargain' }],
      occurrences: null,
      from: null,
      to: null,
      before: null,
      reason: 'no match for that text',
      closest: null,
      failureFrom: null,
      reported: options.reported,
    };
    const messages: CanvasChatMessage[] = [
      {
        id: 'message-1',
        role: 'assistant',
        text: options.text,
        raw: null,
        status: 'failed',
        error: 'the reply was not valid JSON',
        outcomes: [outcome],
        createdAt: 1,
      },
    ];
    useCanvasChatStore.setState({
      ownerModuleId: world.moduleId,
      byModule: {
        [canvasChatKey(world.moduleId)]: {
          messages,
          open: true,
          modelSelection: null,
          inFlight: options.inFlight,
        },
      },
    });
  }

  function renderChat(props: { aiBusy: boolean; aiBusyReason: string | null }): void {
    render(
      <ChatSidebar
        moduleId={world.moduleId}
        hasPlannedParts
        pool={[]}
        aiBusy={props.aiBusy}
        aiBusyReason={props.aiBusyReason}
        previewOpen
        onPreviewSend={undefined}
        onPreviewReportOutcome={undefined}
        onPreviewReportMessage={undefined}
        onEditorTurnApplied={undefined}
        onPreviewStop={undefined}
        onChatCleared={undefined}
      />,
    );
  }

  beforeEach(async () => {
    await clearDatabase();
    await seedModule();
  });

  it('a blank input is a SELF-EVIDENT block: disabled with no reason wrapper at all', async () => {
    const user = userEvent.setup();
    seedChat({ inFlight: false, reported: false, text: '' });
    renderChat({ aiBusy: false, aiBusyReason: null });

    const send = await screen.findByTestId('canvas-chat-send');
    expect(send).toBeDisabled();
    expect(reasonTextOf('canvas-chat-send')).toBeNull();
    expect(screen.queryByTestId('canvas-chat-send-blocked')).not.toBeInTheDocument();

    // Typing is the whole way out — and the wrapper appears with the state.
    await user.type(screen.getByTestId('canvas-chat-input'), 'make it rain');
    await waitFor(() => {
      expect(screen.getByTestId('canvas-chat-send')).toBeEnabled();
    });
    expect(reasonTextOf('canvas-chat-send')).toBeNull();
  }, 30_000);

  it('the module-wide block is stated on Send and on both Report buttons, from the page’s own sentence', async () => {
    seedChat({ inFlight: false, reported: false, text: 'half a reply' });
    renderChat({ aiBusy: true, aiBusyReason: GENERATING_REASON });

    expect(await screen.findByTestId('canvas-chat-send')).toBeDisabled();
    expect(reasonTextOf('canvas-chat-send')).toBe(GENERATING_REASON);
    const reportError = screen.getByTestId('canvas-chat-report-error');
    expect(reportError).toBeDisabled();
    expect(reasonTextOf('canvas-chat-report-error')).toBe(GENERATING_REASON);
    const reportOutcome = screen.getByTestId('canvas-chat-report-outcome');
    expect(reportOutcome).toBeDisabled();
    expect(reasonTextOf('canvas-chat-report-outcome')).toBe(GENERATING_REASON);
  }, 30_000);

  it('a live reply holds the Report buttons with the sidebar’s own reason (Send is replaced by Stop)', async () => {
    seedChat({ inFlight: true, reported: false, text: 'half a reply' });
    renderChat({ aiBusy: false, aiBusyReason: null });

    expect(await screen.findByTestId('canvas-chat-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-chat-send')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-chat-report-error')).toBeDisabled();
    expect(reasonTextOf('canvas-chat-report-error')).toBe(
      'A reply is still streaming — wait for it, or press Stop.',
    );
    expect(reasonTextOf('canvas-chat-report-outcome')).toBe(
      'A reply is still streaming — wait for it, or press Stop.',
    );
  }, 30_000);

  it('an already-reported outcome is SELF-EVIDENT (its label reads "Reported"): no reason wrapper', async () => {
    seedChat({ inFlight: false, reported: true, text: 'done' });
    renderChat({ aiBusy: false, aiBusyReason: null });

    const reported = await screen.findByTestId('canvas-chat-report-outcome');
    expect(reported).toBeDisabled();
    expect(reported).toHaveTextContent('Reported');
    expect(reasonTextOf('canvas-chat-report-outcome')).toBeNull();
    expect(screen.queryByTestId('canvas-chat-report-outcome-blocked')).not.toBeInTheDocument();
  }, 30_000);
});
