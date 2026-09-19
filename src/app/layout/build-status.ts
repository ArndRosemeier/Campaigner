import { useCallback, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';

/**
 * THE build-status badge seam (docs/17 row 250, docs/18 §2): the ONE place the
 * app asks "is this deployed build suite-verified?", reads the answer off its
 * own origin and validates it at the boundary.
 *
 * THE FILE COMES FROM THE DEPLOY JOB, NOT FROM THE BUNDLE. A push to `main`
 * deploys, and this repo's gate has two tiers: a ~27s COMPILE tier that blocks
 * the push and a FULL suite that follows it in the background (AGENTS
 * §Workflow). The app the owner is testing can therefore be compile-clean and
 * not yet suite-verified, and he asked to SEE that state beside the title. The
 * deploy job writes `dist/build-status.json` AFTER the build — computed by
 * `scripts/buildStatus.mjs` from the board and the pushed commit — and the app
 * fetches it at runtime from its own origin. It is deliberately not a `define`d
 * constant: a stamp baked into the bundle cannot know whether the FULL gate has
 * finished, and `dist/` is gitignored, so the file never recurses into the repo.
 *
 * THREE HONEST STATES, NO FOURTH, AND NEVER A SILENT `verified`. The payload's
 * `state` is one of `verified` / `wip` / `cannot-tell`, and EVERY way this read
 * can fail — no fetch in the runtime, HTTP error, malformed JSON, a payload
 * that is not this shape, a timeout, an offline browser, a dev server that
 * answers with `index.html` — resolves to `cannot-tell` and is shown as such in
 * the top bar. The badge IS the user-visible surface for that failure (AGENTS
 * rule 2): it does not toast, because a build with no status file is a
 * legitimate state and a toast on every reload would be noise about it.
 *
 * A BUILD THE DEPLOY JOB DID NOT PRODUCE HAS NO STATUS FILE, and says so
 * without a network round-trip (`readOwnBuildStatus` below): `import.meta.env.PROD`
 * is exactly "this bundle came out of a build", so `vite dev` and a test run
 * answer `cannot-tell` synchronously and honestly. That is also what keeps the
 * badge from firing an un-awaited async state update inside every test that
 * merely renders the app shell (`useBuildStatus` below explains the mechanism).
 */
export const BUILD_STATUS_STATES = ['verified', 'wip', 'cannot-tell'] as const;

export type BuildStatusState = (typeof BUILD_STATUS_STATES)[number];

export interface BuildStatus {
  readonly state: BuildStatusState;
  readonly detail: string;
}

/** The same-origin file the deploy job writes into `dist/`. */
export const BUILD_STATUS_FILE_NAME = 'build-status.json';

export const BUILD_STATUS_TIMEOUT_MS = 5000;

/** One sentence for the "no deploy job ran for this bundle" state. */
const NOT_A_DEPLOY_BUILD =
  'this bundle was not produced by the deploy job, so there is no build-status.json to read';

/** The payload the deploy script writes — strict, so an unexpected shape is loud. */
export const buildStatusPayloadSchema = z.strictObject({
  state: z.enum(BUILD_STATUS_STATES),
  detail: z.string().min(1),
});

/** The honest answer whenever the state could not be established. */
export function cannotTell(detail: string): BuildStatus {
  return { state: 'cannot-tell', detail };
}

/** The status file's URL under the app's own base path (`/Campaigner/` in prod). */
export function buildStatusUrl(baseUrl: string): string {
  return `${baseUrl}${BUILD_STATUS_FILE_NAME}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read and validate the status file. TOTAL by construction: every failure is
 * answered with `cannot-tell` (never thrown, never `verified`), including the
 * case where the runtime has no `fetch` at all.
 */
export async function readBuildStatus(
  baseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<BuildStatus> {
  try {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      return cannotTell(`${BUILD_STATUS_FILE_NAME} could not be read (no fetch in this runtime)`);
    }
    const response = await doFetch(buildStatusUrl(baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(BUILD_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return cannotTell(`${BUILD_STATUS_FILE_NAME} answered HTTP ${response.status}`);
    }
    const parsed = buildStatusPayloadSchema.safeParse(await response.json());
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return cannotTell(`${BUILD_STATUS_FILE_NAME} is not a build-status payload (${issues})`);
    }
    return parsed.data;
  } catch (error) {
    return cannotTell(`${BUILD_STATUS_FILE_NAME} could not be read (${describeError(error)})`);
  }
}

/**
 * The production read: the deploy job's file, from the app's own origin. A
 * bundle no deploy job produced (a dev server, a test run) has no such file and
 * answers `cannot-tell` without a request.
 */
export function readOwnBuildStatus(): Promise<BuildStatus> {
  if (!import.meta.env.PROD) return Promise.resolve(cannotTell(NOT_A_DEPLOY_BUILD));
  return readBuildStatus(import.meta.env.BASE_URL);
}

/** The badge's read, injectable so a test can drive the real chain. */
export type BuildStatusRead = () => Promise<BuildStatus>;

interface BuildStatusStore {
  status: BuildStatus | null;
  readonly read: BuildStatusRead;
  readonly listeners: Set<() => void>;
  started: boolean;
}

/**
 * Publish a new state to the subscribed badge. A state identical to the one
 * already held is NOT republished: that is what makes the non-deploy bundle's
 * synchronous `cannot-tell` (the store's initial value) a no-op rather than a
 * re-render when its read resolves with the same sentence.
 */
function publishTo(store: BuildStatusStore, next: BuildStatus): void {
  const previous = store.status;
  if (previous !== null && previous.state === next.state && previous.detail === next.detail) return;
  store.status = next;
  for (const listener of store.listeners) listener();
}

/**
 * The badge's state, or `null` while the read is still in flight — a transient
 * absence, deliberately distinct from `cannot-tell`, so a bundle that HAS a
 * status file does not flash a false alarm for the milliseconds the read takes.
 *
 * DELIVERED THROUGH `useSyncExternalStore`, not `useState` in an effect, and the
 * reason is measured rather than aesthetic: a fetch continuation that calls
 * `setState` lands OUTSIDE React's `act()` scope, so every test that merely
 * renders the app shell for something else fails with React's "An update to
 * BuildStatusBadge inside a test was not wrapped in act(...)" warning — and this
 * repo's console guard (tests/setup.ts) rightly treats that noise as a failure
 * instead of allowlisting it. Two things together keep the shell quiet: a
 * non-deploy bundle STARTS at `cannot-tell` (so its read publishes an identical
 * state, which `publishTo` drops), and a real read only happens in a built app.
 * The store is PER BADGE (a lazy initializer, not a module singleton) so no state is
 * shared behind a test's back.
 */
export function useBuildStatus(read: BuildStatusRead = readOwnBuildStatus): BuildStatus | null {
  // One store per badge, built once by the lazy initializer (never re-created,
  // so `subscribe`/`getSnapshot` stay stable for `useSyncExternalStore`).
  const [store] = useState<BuildStatusStore>(() => ({
    status: import.meta.env.PROD ? null : cannotTell(NOT_A_DEPLOY_BUILD),
    read,
    listeners: new Set<() => void>(),
    started: false,
  }));
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      store.listeners.add(listener);
      if (!store.started) {
        store.started = true;
        void store.read().then(
          (next) => {
            publishTo(store, next);
          },
          (error: unknown) => {
            publishTo(
              store,
              cannotTell(`${BUILD_STATUS_FILE_NAME} read failed (${describeError(error)})`),
            );
          },
        );
      }
      return () => {
        store.listeners.delete(listener);
      };
    },
    [store],
  );
  const getSnapshot = useCallback((): BuildStatus | null => store.status, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
