import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { debugLog } from '@/lib/debug';
import { useProgressStore } from '@/lib/progress';
import { toastError } from '@/lib/toast';

/**
 * THE async job-queue factory (F6): one implementation of the background
 * "pump jobs with N workers, report on the shared dock, fail loud per
 * artifact" machinery that the mob-portrait, entity-image and encounter-map
 * queues previously hand-rolled with DIVERGENT invariant subsets (the
 * entity-image queue had no enqueue dedupe — concurrent same-name jobs
 * generated a double image and silently overwrote the cover; the
 * encounter-map queue had no cancellation at all; only the map queue kept a
 * retryable failed list). Every queue built on this factory INHERITS the
 * union of the invariants:
 *
 * - **Dedupe vs queued + active** (and within one enqueue batch) on a
 *   stable `key` — a job can never run concurrently against itself.
 * - **Cancellation**: `dequeue` drops a pending job and aborts the
 *   in-flight one through its AbortController; an aborted job settles
 *   silently (no toast, no failed-list entry).
 * - **Failed list + retry**: failures toast loud per artifact (AGENTS rule
 *   2) and land on `failed`; `retryFailed(filter?)` re-enqueues them, and
 *   re-enqueueing a failed job directly clears its failed entry.
 * - **Dock counters** per `dockGroup(job)`: monotonic done/total progress on
 *   the shared progress dock, started with the group's first job and
 *   finished when the group drains.
 *
 * RELOAD SURVIVAL: NOT PROVIDED — BY DESIGN (deferred). Queues are
 * module-scope zustand state, so a reload discards queued/active/failed
 * jobs and dock counters. Persisting queue rows (Dexie) is an OWNER DESIGN
 * DECISION (ledger note: queue persistence was explicitly deferred in the
 * convergence batch — do not invent it here); run-level work reconciles
 * through `failRunningRuns`, and the dock only ever showed ephemeral
 * progress. On store init the in-memory state is therefore simply fresh:
 * no phantom jobs, no half-cancelled rows owned by the queue. Callers that
 * need the limitation visible (e.g. "your queued portraits are gone after a
 * reload") should surface it in their own UI, not in this factory.
 */

/** How one job settled. `cancelled` is silent everywhere (user withdrew it). */
export type JobOutcome = 'done' | 'skipped' | 'failed' | 'cancelled';

/** The in-flight context handed to `process`: the job's abort signal. */
export interface JobContext {
  signal: AbortSignal;
}

export interface JobQueueConfig<T> {
  /** debugLog channel (lib/debug is dev-only). */
  name: string;
  /** Stable job identity: dedupe key and cancellation target. */
  key: (job: T) => string;
  /**
   * The progress-dock group a job reports under (id + label). The dock job
   * starts with the group's first enqueued job and finishes when the group's
   * counter drains.
   */
  dockGroup: (job: T) => { id: string; label: string };
  /** Dock detail while the job is in flight. */
  activeDetail: (job: T) => string;
  /** Dock detail once the job settles (`failed` included; `cancelled` never
   * reaches the dock — the job was withdrawn and its counter already
   * decremented through `dequeue`). */
  settledDetail: (job: T, outcome: 'done' | 'skipped' | 'failed') => string;
  /** The loud per-artifact failure toast title (AGENTS rule 2). */
  failureTitle: (job: T) => string;
  /**
   * The job body: resolves `'done'` or `'skipped'`, THROWS to fail loud
   * (toast + failed list). The `signal` is aborted by `dequeue` — observe it
   * to stop work early; an abort settles the job as `'cancelled'` (silent),
   * whatever the throwing error is.
   */
  process: (job: T, ctx: JobContext) => Promise<'done' | 'skipped'>;
  /**
   * Worker count for one pump cycle. Default 1 (the serial encounter-map
   * shape); parallel queues pass e.g. the Settings' maxParallelRequests.
   */
  workerCount?: () => Promise<number>;
}

export interface JobQueueState<T> {
  queued: T[];
  /** Jobs whose processing is in flight right now (≤ worker count). */
  active: T[];
  /** Failed jobs awaiting `retryFailed` (or a direct re-enqueue). */
  failed: T[];
  /** Dedupes against queued+active, clears matching failed entries, pumps. */
  enqueue: (jobs: T[]) => void;
  /** Removes a pending (or aborts the in-flight) job for this key. */
  dequeue: (job: T) => void;
  /** Re-enqueues failed jobs (all, or those matching the filter). */
  retryFailed: (filter?: (job: T) => boolean) => void;
  /** Test/recovery seam: clears all state, aborts in-flight jobs, drops
   * dock counters and stops the pump. */
  reset: () => void;
}

export type JobQueueStore<T> = UseBoundStore<StoreApi<JobQueueState<T>>>;

export function createJobQueue<T>(config: JobQueueConfig<T>): JobQueueStore<T> {
  const controllers = new Map<string, AbortController>();
  /** Per-dock-group counters: done/total keep the bar monotonic. */
  const counters = new Map<string, { total: number; done: number }>();
  let pumping = false;

  function bumpTotal(job: T): void {
    const group = config.dockGroup(job);
    let counter = counters.get(group.id);
    if (counter === undefined) {
      counter = { total: 0, done: 0 };
      counters.set(group.id, counter);
      useProgressStore.getState().start(group.id, group.label);
    }
    counter.total += 1;
    useProgressStore.getState().update(group.id, {
      progress: counter.done / counter.total,
    });
  }

  function bumpDone(job: T, detail: string): void {
    const group = config.dockGroup(job);
    const counter = counters.get(group.id);
    if (counter === undefined) return;
    counter.done += 1;
    useProgressStore.getState().update(group.id, {
      progress: counter.done / counter.total,
      detail,
    });
    if (counter.done >= counter.total) {
      useProgressStore.getState().finish(group.id);
      counters.delete(group.id);
    }
  }

  function bumpRemoved(job: T): void {
    const group = config.dockGroup(job);
    const counter = counters.get(group.id);
    if (counter === undefined) return;
    counter.total -= 1;
    if (counter.done >= counter.total) {
      useProgressStore.getState().finish(group.id);
      counters.delete(group.id);
    } else {
      useProgressStore.getState().update(group.id, {
        progress: counter.done / counter.total,
      });
    }
  }

  /** Atomically moves the queue head into the active set. Returns null when
   * the queue is empty. (zustand's setState is synchronous, so no two
   * workers can take the same job.) */
  function takeNext(): T | null {
    let taken: T | null = null;
    store.setState((state) => {
      const job = state.queued[0];
      if (job === undefined) return state;
      taken = job;
      return {
        queued: state.queued.slice(1),
        active: [...state.active, job],
      };
    });
    return taken;
  }

  /** Removes a finished (or dequeued mid-flight) job from the active set. */
  function releaseJob(job: T): void {
    store.setState((state) => ({
      active: state.active.filter((candidate) => config.key(candidate) !== config.key(job)),
    }));
  }

  async function processJob(job: T): Promise<JobOutcome> {
    const controller = new AbortController();
    controllers.set(config.key(job), controller);
    try {
      return await config.process(job, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return 'cancelled';
      // Loud per-artifact failure (AGENTS rule 2); the queue continues.
      toastError(config.failureTitle(job), error);
      return 'failed';
    } finally {
      controllers.delete(config.key(job));
    }
  }

  async function pumpWorker(): Promise<void> {
    for (;;) {
      const job = takeNext();
      if (job === null) return;
      useProgressStore.getState().update(config.dockGroup(job).id, {
        detail: config.activeDetail(job),
      });
      const outcome = await processJob(job);
      debugLog(config.name, `job ${config.key(job)} finished`, { outcome });
      if (outcome !== 'cancelled') {
        // A withdrawn job's counter was already decremented by dequeue —
        // counting it as done would push the group's progress past its total.
        if (outcome === 'failed') {
          store.setState((state) => ({
            failed: state.failed.some((failed) => config.key(failed) === config.key(job))
              ? state.failed
              : [...state.failed, job],
          }));
        }
        bumpDone(job, config.settledDetail(job, outcome));
      }
      releaseJob(job);
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      do {
        // Jobs are independent per queue contract: run up to workerCount at
        // once (the workers share the queue).
        const limit = Math.max(1, config.workerCount === undefined ? 1 : await config.workerCount());
        const workers: Promise<void>[] = [];
        for (let worker = 0; worker < limit; worker += 1) {
          workers.push(pumpWorker());
        }
        await Promise.all(workers);
        // A job may have been enqueued while the last workers were exiting —
        // drain again instead of stranding it until the next enqueue.
      } while (store.getState().queued.length > 0);
    } finally {
      pumping = false;
    }
  }

  const store = create<JobQueueState<T>>((set, get) => ({
    queued: [],
    active: [],
    failed: [],
    enqueue: (jobs) => {
      // One job per key: duplicates within the batch and against known
      // (queued + active) jobs are dropped — a job must never run
      // concurrently against itself.
      let kept: T[] = [];
      set((state) => {
        const known = new Set(
          [...state.queued, ...state.active].map((job) => config.key(job)),
        );
        kept = jobs.filter((job) => {
          const jobKey = config.key(job);
          if (known.has(jobKey)) return false;
          known.add(jobKey);
          return true;
        });
        if (kept.length === 0) return state;
        return {
          queued: [...state.queued, ...kept],
          // Re-enqueueing a failed job (directly or via retryFailed) is the
          // explicit retry — its failed entry is superseded.
          failed: state.failed.filter(
            (failed) => !kept.some((job) => config.key(job) === config.key(failed)),
          ),
        };
      });
      for (const job of kept) bumpTotal(job);
      void pump();
    },
    dequeue: (job) => {
      set((state) => ({
        queued: state.queued.filter((candidate) => config.key(candidate) !== config.key(job)),
        active: state.active.filter((candidate) => config.key(candidate) !== config.key(job)),
      }));
      controllers.get(config.key(job))?.abort();
      bumpRemoved(job);
    },
    retryFailed: (filter) => {
      const jobs = get().failed.filter(filter ?? (() => true));
      if (jobs.length === 0) return;
      get().enqueue(jobs);
    },
    reset: () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      counters.clear();
      pumping = false;
      set({ queued: [], active: [], failed: [] });
    },
  }));

  return store;
}
