import { liveQuery } from 'dexie';

import {
  createPersonaRun as buildRun,
  personaRunSchema,
  type EntityPatch,
  type Id,
  type NewPersonaRun,
  type PersonaRun,
} from '@/domain';
import { db } from '@/db/db';
import { NotFoundError } from '@/lib/errors';

export type RunPatch = EntityPatch<PersonaRun>;

export async function createRun(input: NewPersonaRun): Promise<PersonaRun> {
  const run = buildRun(input);
  await db.runs.put(run);
  return run;
}

/**
 * Legacy-row guard at the Dexie boundary (the ratified `parseBattleRow`
 * template): zod materializes the additive run options on rows written
 * before they existed — `encounterMapAspect`, `encounterPreset`,
 * `placementModuleId`, `runExtras`, `unattended`, `contextArtifactIds` —
 * so resume/retry sees the schema defaults instead of `undefined`, and a
 * corrupt row fails loudly (AGENTS rules 1+3). Writes already parse
 * (updateRun/failRunningRuns).
 */
function parseRunRow(row: PersonaRun): PersonaRun {
  return personaRunSchema.parse(row);
}

export async function getRun(id: Id): Promise<PersonaRun | undefined> {
  const row = await db.runs.get(id);
  return row === undefined ? undefined : parseRunRow(row);
}

/** Past runs of a campaign, most recent first (Runs tab). */
export async function listRunsByCampaign(campaignId: Id): Promise<PersonaRun[]> {
  const rows = await db.runs.where('campaignId').equals(campaignId).toArray();
  return rows.map(parseRunRow).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The run engine persists after every state change through this function. */
export async function updateRun(id: Id, patch: RunPatch): Promise<PersonaRun> {
  return db.transaction('rw', db.runs, async () => {
    const current = await db.runs.get(id);
    if (!current) throw new NotFoundError('PersonaRun', id);
    const updated = personaRunSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
    await db.runs.put(updated);
    return updated;
  });
}

export async function deleteRun(id: Id): Promise<void> {
  await db.runs.delete(id);
}

/**
 * A cheap identity for "is this the row I already looked at?" — the row's own
 * `updatedAt` (every write through `updateRun`/`failRunningRuns` bumps it) plus
 * its status, so a write that somehow missed the stamp is still seen.
 */
function runRowSignature(run: PersonaRun | undefined): string {
  return run === undefined ? 'gone' : `${String(run.updatedAt)}|${run.status}`;
}

/**
 * Resolves as soon as the run ROW changes (any column) or disappears — the
 * event-backed wait that replaced the 250 ms poll in
 * `runEngine.waitForRunStatus` (docs/17 row 110, docs/18 §4).
 *
 * WHY an observable and not a timer: every run status is written through Dexie,
 * so a Dexie live query is a complete and immediate change signal for this row
 * — including rows written by a run this page did not start — while a poll on a
 * timer is a PACING bug: under Chromium's intensive throttling a hidden tab's
 * timers run at most once a minute, so a 250 ms wait boundary could idle for
 * ~60 s, which is exactly a chain/batch step boundary (chainRunner,
 * entity-batch, encounter-map-queue) sitting still for a minute while the run
 * it waits for is already done.
 *
 * `known` is the row the caller has already inspected: the subscription's FIRST
 * emission (which is the current value, delivered synchronously) only counts as
 * a change when it differs, so a terminal status written between the caller's
 * read and this call is never missed. The abort signal rejects the wait with
 * the same `AbortError` the poll produced (the wait is what is aborted, never
 * the run).
 */
export async function waitForRunRowChange(
  runId: Id,
  known: PersonaRun | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const before = runRowSignature(known);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe: () => void } | null = null;
    /** See the note at the post-subscribe check below (TS cannot see the
     * observer callbacks' assignments). */
    const hasSettled = (): boolean => settled;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('The wait was aborted', 'AbortError'));
    };
    function cleanup(): void {
      subscription?.unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
    const observable = liveQuery(() => db.runs.get(runId));
    subscription = observable.subscribe({
      next: (row) => {
        if (settled) return;
        if (runRowSignature(row) === before) return; // same row: keep waiting
        settled = true;
        cleanup();
        resolve();
      },
      error: (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
    // The first emission is delivered synchronously by `subscribe`, so a wait
    // that already saw a change resolved before `subscription` was assigned.
    // Read through a function on purpose: both `settled` and `subscription` are
    // assigned inside the observer callbacks, which TS's control-flow analysis
    // cannot see (a direct read looks statically falsy to it).
    if (hasSettled()) cleanup();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Marks runs stuck in 'running' as failed (called on app start: the engine
 * does not survive a reload — 04-LLM-PERSONAS acceptance criteria). The
 * interruption classifies as 'cancelled' (docs/05 run views): the run died
 * with the page, not because the provider or a contract failed.
 */
export async function failRunningRuns(errorMessage = 'Interrupted by reload'): Promise<number> {
  const running = await db.runs.where('status').equals('running').toArray();
  if (running.length === 0) return 0;

  const failed = running.map((run) =>
    personaRunSchema.parse({
      ...run,
      status: 'failed',
      errorMessage,
      failureKind: 'cancelled',
      updatedAt: Date.now(),
    }),
  );
  await db.transaction('rw', db.runs, async () => {
    await db.runs.bulkPut(failed);
  });
  return failed.length;
}
