import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createRun, deleteRun, getRun, updateRun } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { listPersonas } from '@/db/personaRepo';
import type { Id } from '@/domain';
import { waitForRunStatus } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Waiting for a run to leave 'running' (docs/17 row 110, docs/18 §4).
 *
 * Measured at HEAD 360a056: `waitForRunStatus` slept in chained 250 ms
 * `setTimeout` calls and re-read the row on each tick. That is a PACING bug on
 * a backgrounded tab, not a cosmetic one: Chromium throttles a hidden page's
 * timers to about one wake-up per MINUTE, so the wait boundary could idle for
 * ~60 s — and a chain or batch step boundary is exactly where this is awaited,
 * which is the shape of the owner's "it gets stalled when I switch to another
 * app" report. Every run status is written through Dexie, so the row itself is
 * a complete, immediate change signal (including rows written by another tab's
 * run); the wait now rides it.
 *
 * What is pinned here: the wait resolves on the ROW CHANGE (with no timer
 * pacing it at all), it still aborts with the same `AbortError`, the
 * "row disappeared" contract is unchanged, and a status that was already
 * terminal is never missed.
 */

let campaignId: Id;
let personaId: Id;

async function startRunningRun(): Promise<Id> {
  const run = await createRun({
    campaignId,
    personaId,
    autonomy: 'auto',
    userBrief: 'Detail the gate warden',
  });
  return run.id;
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Wait', system: 'dnd5e' });
  campaignId = campaign.id;
  const personas = await listPersonas();
  const persona = personas[0];
  if (persona === undefined) throw new Error('no built-in persona seeded');
  personaId = persona.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitForRunStatus', () => {
  it('resolves on the row change, with no timer pacing the wait', async () => {
    const runId = await startRunningRun();
    // Structural pin of the fix: the old implementation could not resolve
    // without a 250 ms tick, so ANY 250 ms timer scheduled while the wait is
    // pending fails this test.
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const pending = waitForRunStatus(runId);
    await Promise.resolve();
    await updateRun(runId, { status: 'completed' });

    const settled = await pending;
    expect(settled.status).toBe('completed');
    const polled = timeoutSpy.mock.calls.filter((call) => call[1] === 250);
    expect(polled).toEqual([]);
  });

  it('sees a terminal status that was already written (never a missed settle)', async () => {
    const runId = await startRunningRun();
    await updateRun(runId, { status: 'completed' });

    await expect(waitForRunStatus(runId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps waiting for a non-terminal write and returns on the terminal one', async () => {
    const runId = await startRunningRun();
    const pending = waitForRunStatus(runId);
    await updateRun(runId, { status: 'awaiting_user' });
    // Not terminal, and `includePaused` is off: the wait must not return here.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(settled).toBe(false);

    await updateRun(runId, { status: 'failed', errorMessage: 'Interrupted by reload' });
    await expect(pending).resolves.toMatchObject({ status: 'failed' });
  });

  it('returns a paused run when the caller asks for paused ones', async () => {
    const runId = await startRunningRun();
    const pending = waitForRunStatus(runId, { includePaused: true });
    await updateRun(runId, { status: 'needs_review' });

    await expect(pending).resolves.toMatchObject({ status: 'needs_review' });
  }, 10_000);

  it('rejects with AbortError when the caller withdraws, even over a terminal row', async () => {
    const runId = await startRunningRun();
    const controller = new AbortController();
    const pending = waitForRunStatus(runId, { signal: controller.signal });
    const captured = pending.catch((error: unknown) => error);
    controller.abort();

    // `DOMException` is not an `instanceof Error` under jsdom, so the pin is
    // on the shape the callers actually read (name/message).
    const error = await captured;
    expect(error).toMatchObject({ name: 'AbortError' });

    // An already-aborted signal wins over a row that is already done: the
    // caller withdrew the job and must never observe it as finished.
    await updateRun(runId, { status: 'completed' });
    await expect(waitForRunStatus(runId, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects when the row disappears while waiting (the contract is unchanged)', async () => {
    const runId = await startRunningRun();
    const pending = waitForRunStatus(runId);
    const captured = pending.catch((error: unknown) => error);
    await deleteRun(runId);

    const error = await captured;
    expect(error).toMatchObject({
      message: `Run ${runId} disappeared while waiting for it to finish`,
    });
  });

  it('still reports a run that was already gone', async () => {
    const runId = await startRunningRun();
    await deleteRun(runId);

    await expect(waitForRunStatus(runId)).rejects.toThrow('disappeared while waiting');
  });

  it('is not left waiting on a row that is rewritten with the same status', async () => {
    const runId = await startRunningRun();
    const pending = waitForRunStatus(runId);
    // A step write with no status change: `updatedAt` moves, the wait keeps
    // going (the row is still not terminal) — and the wait must survive it
    // rather than resolving on a non-terminal write.
    await updateRun(runId, { errorMessage: '' });
    expect((await getRun(runId))?.status).toBe('running');
    await updateRun(runId, { status: 'cancelled' });

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });
});
