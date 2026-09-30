import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createRun, getRun } from '@/db/runRepo';
import {
  cancelCanvasGeneration,
  claimModuleGeneration,
  registerCanvasAbort,
  releaseModuleGeneration,
} from '@/llm/canvasBusy';
import { readErrorBody } from '@/llm/openrouter';
import { waitForRunStatus } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';
import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * A Stop must reach the work it stops (docs/17 row 413). The owner approved an
 * advisor card and the chat hung for 20+ minutes; the audit behind this row
 * found three places where a stop, or a time limit, could not reach the work:
 * a `<change>`'s run (the chat's Stop never cancelled it), a turn started in the
 * other canvas mode (Stop aborted only its own mode's controller), and an error
 * response whose body never arrived (no limit applied to it at all).
 */

beforeEach(async () => {
  await clearDatabase();
});

async function runningRun(): Promise<string> {
  const run = await createRun({
    campaignId: crypto.randomUUID(),
    personaId: crypto.randomUUID(),
    autonomy: 'auto',
    userBrief: 'a brief',
  });
  return run.id;
}

describe('waitForRunStatus cancelOnAbort', () => {
  it('cancels the run when the caller stops, and returns its cancelled row', async () => {
    const runId = await runningRun();
    const stop = new AbortController();
    const waiting = waitForRunStatus(runId, { cancelOnAbort: stop.signal });

    stop.abort();
    const settled = await waiting;

    expect(settled.status).toBe('cancelled');
    expect((await getRun(runId))?.status).toBe('cancelled');
  });

  it('cancels at once when the stop landed before the wait began', async () => {
    const runId = await runningRun();
    const stop = new AbortController();
    stop.abort();

    expect((await waitForRunStatus(runId, { cancelOnAbort: stop.signal })).status).toBe('cancelled');
  });

  it('refuses a wait that carries both stop meanings', async () => {
    const runId = await runningRun();
    await expect(
      waitForRunStatus(runId, { signal: new AbortController().signal, cancelOnAbort: new AbortController().signal }),
    ).rejects.toThrow('signal OR cancelOnAbort');
  });
});

describe('cancelCanvasGeneration', () => {
  it("stops a module's turn by module id, whichever controller started it", () => {
    const turn = new AbortController();
    claimModuleGeneration('module-1');
    const { signal, releaseHandle } = registerCanvasAbort('module-1', turn);
    try {
      expect(cancelCanvasGeneration('module-1')).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(turn.signal.aborted).toBe(true);
    } finally {
      releaseHandle();
      releaseModuleGeneration('module-1');
    }
    expect(cancelCanvasGeneration('module-1')).toBe(false);
  });
});

describe('readErrorBody', () => {
  /** An error response whose body never arrives. */
  function stalledResponse(): Response {
    return new Response(new ReadableStream({ start: () => undefined }), { status: 502 });
  }

  it('returns the body when it arrives', async () => {
    expect(await readErrorBody(new Response('upstream down', { status: 502 }), undefined)).toBe('upstream down');
  });

  it('names a body that never arrived instead of waiting forever', async () => {
    const text = await readErrorBody(stalledResponse(), undefined, 20);
    expect(text).toBe('(HTTP 502: the error body did not arrive within 0s)');
  });

  it("ends at once on the caller's Stop", async () => {
    const stop = new AbortController();
    const reading = readErrorBody(stalledResponse(), stop.signal, 60_000);
    stop.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is the ONLY place src/llm reads a response body as text', () => {
    // filesWith over the comment-stripped tree: the one `response.text()` left
    // is inside readErrorBody (the shared source-scan helper, docs/17 row 284).
    expect(filesWith('response.text()').filter((path) => path.startsWith('src/llm/'))).toEqual([
      'src/llm/openrouter.ts',
    ]);
    expect(CODE['src/llm/openrouter.ts']?.split('response.text()').length).toBe(2);
  });
});
