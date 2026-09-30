import 'fake-indexeddb/auto';

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import type { Campaign } from '@/domain';
import { WritersRoom } from '@/features/campaign/components/writers-room';
import type { ChainState } from '@/llm/chainRunner';
import { clearDatabase } from '../db/helpers';
import { expectBlockedReason, expectSelfEvidentBlock } from '../helpers/blocked-reason';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The Writers'-room step form STATES why it is dead while a chain runs
 * (docs/18 §2.3, docs/05 §Why a control cannot act; docs/17 row 99).
 *
 * The whole form — the persona picker, both move buttons, Remove, the brief
 * input, Add step, the Autonomy picker and Run chain — is gated on ONE flag
 * (`busy = chain.status === 'running' || chain.status === 'paused'`) and, before
 * row 99, not one of those controls said a word: they went grey with the chain's
 * progress column beside them and no reason anywhere.
 *
 * Every pin asserts the device's contract (the control is STILL disabled exactly
 * as the spec'd gate says, and the reason is present, associated and
 * perceivable), and the three SELF-EVIDENT halves — at the top, at the bottom,
 * an empty plan — are pinned as carrying NO wrapper, because a decision is only
 * a decision when a test says so.
 *
 * The runner is mocked: this file pins the SURFACE's reasons, not the runner's
 * own state machine.
 */

const h = vi.hoisted(() => ({
  state: { status: 'idle', steps: [] },
  listeners: [] as ((state: unknown) => void)[],
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/llm/chainRunner', () => ({
  chainRunner: {
    getState: () => h.state,
    on: (listener: (state: unknown) => void) => {
      h.listeners.push(listener);
      return () => {
        h.listeners = h.listeners.filter((candidate) => candidate !== listener);
      };
    },
    run: vi.fn(() => Promise.resolve(undefined)),
    cancel: vi.fn(),
    resume: vi.fn(() => Promise.resolve(undefined)),
    retry: vi.fn(() => Promise.resolve(undefined)),
  },
}));

const RUNNING_REASON = 'The chain is running right now — wait for it, or press Stop chain.';
const PAUSED_REASON =
  'The chain is paused on a run that needs you — resolve it in the Assistant tab, or press Stop chain.';

/** Every control the ONE `busy` flag holds, by its own test id. */
const BUSY_GATED_CONTROLS = [
  'writers-room-step-1-persona',
  'writers-room-step-1-move-up',
  'writers-room-step-1-move-down',
  'writers-room-step-1-remove',
  'writers-room-step-1-brief',
  'writers-room-add-step',
  'writers-room-autonomy',
  'run-chain',
];

let campaign: Campaign;

/** The runner's own notification path: the component re-renders on it. */
async function emitChainStatus(status: ChainState['status']): Promise<void> {
  h.state = { status, steps: [] };
  await act(() => {
    for (const listener of [...h.listeners]) listener(h.state);
    return Promise.resolve();
  });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  h.state = { status: 'idle', steps: [] };
  h.listeners = [];
  campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  await createPersona({
    slug: 'worldbuilder',
    name: 'Worldbuilder',
    description: '',
    systemPrompt: '',
    producesKind: 'note',
    builtIn: false,
  });
});

afterEach(cleanup);

async function renderRoom(): Promise<void> {
  render(<WritersRoom campaign={campaign} />);
  await screen.findByTestId('writers-room');
  await flushAsyncUpdates();
}

/** Adds the first step — the form all the row controls live in. */
async function addFirstStep(): Promise<void> {
  await userEvent.setup().click(screen.getByTestId('writers-room-add-step'));
  await screen.findByTestId('writers-room-step-1-brief');
  await flushAsyncUpdates();
}

describe("the Writers' room states why its step form cannot act while a chain runs", () => {
  it('a RUNNING chain: all eight gated controls carry the running reason, perceivably, and Stop chain is there', async () => {
    const user = userEvent.setup();
    await renderRoom();
    await addFirstStep();
    await emitChainStatus('running');

    for (const testId of BUSY_GATED_CONTROLS) {
      await expectBlockedReason(user, testId, RUNNING_REASON);
    }
    // The way out the reason names exists on this very screen.
    expect(screen.getByRole('button', { name: 'Stop chain' })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);

  it('a PAUSED chain says what it is actually waiting on, not a model', async () => {
    const user = userEvent.setup();
    await renderRoom();
    await addFirstStep();
    await emitChainStatus('paused');

    for (const testId of BUSY_GATED_CONTROLS) {
      await expectBlockedReason(user, testId, PAUSED_REASON);
    }
    expect(screen.getByRole('button', { name: 'Stop chain' })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 30_000);

  it('the chain finishing lifts every reason with the gate — nothing is left stating a state that ended', async () => {
    await renderRoom();
    await addFirstStep();
    await emitChainStatus('running');
    expect(screen.getByTestId('run-chain-reason')).toHaveTextContent(RUNNING_REASON);

    await emitChainStatus('completed');
    for (const testId of BUSY_GATED_CONTROLS) {
      expect(screen.queryByTestId(`${testId}-reason`)).toBeNull();
      expect(screen.queryByTestId(`${testId}-blocked`)).toBeNull();
    }
    // Nothing is held by the CHAIN any more — the only controls still disabled
    // are the single step's two move buttons, and only because that one step is
    // both the first and the last (their own self-evident rung, asserted here so
    // the two causes are never confused).
    expectSelfEvidentBlock('writers-room-step-1-move-up');
    expectSelfEvidentBlock('writers-room-step-1-move-down');
    for (const testId of [
      'writers-room-step-1-persona',
      'writers-room-step-1-remove',
      'writers-room-step-1-brief',
      'writers-room-add-step',
      'writers-room-autonomy',
      'run-chain',
    ]) {
      expect(screen.getByTestId(testId)).toBeEnabled();
    }
    expect(screen.queryByRole('button', { name: 'Stop chain' })).toBeNull();
    await flushAsyncUpdates();
  }, 30_000);

  it('SELF-EVIDENT: the first step cannot move up and the last cannot move down — no reason is attached', async () => {
    await renderRoom();
    await addFirstStep();
    await userEvent.setup().click(screen.getByTestId('writers-room-add-step'));
    await screen.findByTestId('writers-room-step-2-brief');

    // At an end (the documented self-evident rule): disabled, no wrapper.
    expectSelfEvidentBlock('writers-room-step-1-move-up');
    expectSelfEvidentBlock('writers-room-step-2-move-down');
    // And the same two controls are LIVE in the direction that exists.
    expect(screen.getByTestId('writers-room-step-1-move-down')).toBeEnabled();
    expect(screen.getByTestId('writers-room-step-2-move-up')).toBeEnabled();
    expect(screen.queryByTestId('writers-room-step-1-move-down-blocked')).toBeNull();
    await flushAsyncUpdates();
  }, 30_000);

  it('SELF-EVIDENT: Run chain with an empty plan — there is nothing to run, so no reason', async () => {
    await renderRoom();
    expectSelfEvidentBlock('run-chain');
    await flushAsyncUpdates();
  }, 30_000);
});
