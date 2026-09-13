import { toastError } from '@/lib/toast';

/**
 * The page-hide flush seam (docs/17 row 111).
 *
 * Four writers in this app debounce a row write: the canvas chat thread
 * (`features/modules/canvas/chatPersist`, 600 ms), the New Module draft
 * (`features/modules/new-module-dialog`, 500 ms), the module board's layout
 * (`features/modules/board/BoardPage`, 600 ms) and the artifact editor's draft
 * (`features/campaign/components/artifact-editor`, 800 ms). Each of them
 * flushed on UNMOUNT — which covers a route change and nothing else. A tab that
 * is BACKGROUNDED and then frozen or discarded (mobile Safari, Chrome's tab
 * freezing, a bfcache navigation) never unmounts, so a settled chat turn or a
 * typed draft sitting inside its debounce window was simply gone: the row kept
 * its old value and no surface said so.
 *
 * ALL FOUR are on this seam now (the board and the artifact editor joined in
 * ledger row 118, via the same pending-gated flush plus one
 * `registerPageFlush` call — nothing else). A fifth debounced writer belongs
 * here too: register it, do not add a second listener.
 *
 * The browser's own signals for "this page is going away or being put to
 * sleep" are `pagehide` and `visibilitychange` → `hidden`, and they are what
 * this seam listens for. ONE registration list, ONE pagehide listener, ONE
 * visibilitychange listener — not one copy per writer.
 *
 * The contract every registered flush must keep (this is what makes the seam
 * safe rather than a second write path):
 *
 * 1. **Pending-gated.** A flush whose writer has nothing queued writes
 *    NOTHING and returns. `visibilitychange` fires on every tab switch,
 *    minimise and app-background, so a flush that wrote unconditionally would
 *    turn a display event into a write loop over the whole page's data —
 *    the debounce contract, broken from the other side.
 * 2. **Idempotent.** Flushing twice (pagehide after a hidden, or a hidden
 *    after an unmount flush) performs ONE write. Taking the pending work out
 *    of the writer's own queue BEFORE the write is how the writers do it.
 * 3. **Never throwing.** The writers' flushes already report their own
 *    failures loudly (each one toasts by name); a throw that escaped a
 *    lifecycle listener would be invisible, so anything that does escape is
 *    toasted here (AGENTS rule 2 — no error ends in a console line).
 * 4. **VOID-RETURNING.** A flush returns NOTHING — it is `() => void`, not
 *    `() => void | Promise<void>` — and that is what makes "a page-hide flush
 *    cannot reject unhandled" structural rather than a promise nobody can keep.
 *    The `try`/`catch` above contains a SYNCHRONOUS throw only, so a flush that
 *    RETURNED a promise would put its rejection outside this seam's reach, with
 *    nothing awaiting it: the caller is a lifecycle listener that cannot hold
 *    the page open. Async work therefore stays fire-and-forget INSIDE the
 *    writer (`void saveDraft()`, `void persistLayout()`,
 *    `void flushChatPersist()`), which is the writer's own business and already
 *    has its own loud failure path. A caller that needs a rejection handled must
 *    handle it where the promise is created.
 *
 *    NOTE, MEASURED rather than assumed: `PageFlush = () => void` does NOT make
 *    a promise-returning flush a compile error — TypeScript accepts an `async`
 *    function wherever `() => void` is expected (verified: an `async () => {}`
 *    argument typechecks clean against this declaration). So this item is a
 *    CONVENTION the four writers keep by returning `undefined` (measured, ledger
 *    122), not something the compiler enforces. If a flush ever needs to return
 *    a promise, the seam has to change first — with its own settle-or-surface
 *    story for a rejection the `try`/`catch` cannot reach.
 *
 *    Do NOT add a `.catch(() => {})` here or at a caller to quiet a rejection:
 *    it would SILENCE the one signal that shows an unhandled rejection exists,
 *    and it would double-report failures the writers already toast by name
 *    (AGENTS rules 1–2). A test that triggers this chain OWNS it and must settle
 *    it inside the test — docs/18 §4 (ledger 122) tells that story: a
 *    fire-and-forget flush that settled after jsdom was torn down turned a
 *    288-file / 3324-test green run red.
 *
 * What this seam deliberately does NOT do: it never AWAITS the writers (a
 * lifecycle handler cannot hold the page open) and it has no opinion about
 * what a flush writes. Whether an IndexedDB transaction started here commits
 * before the tab is actually torn down is the browser's business — see
 * docs/18 §4 for what that means and what stays unproven.
 */

/**
 * A writer's "land what you have now" function. Must be pending-gated,
 * idempotent, non-throwing and VOID-returning — see the contract above.
 */
export type PageFlush = () => void;

const flushers = new Set<PageFlush>();
let listening = false;

function runFlushes(): void {
  // Snapshot: a flush that (indirectly) registers or unregisters during the
  // loop must not change what this pass visits.
  for (const flush of [...flushers]) {
    try {
      flush();
    } catch (error) {
      toastError('Pending changes could not be saved before the page closed', error);
    }
  }
}

function onPageHide(): void {
  runFlushes();
}

function onVisibilityChange(): void {
  // `hidden` only: `visible` is not a write signal, and the hook also fires
  // for states that say nothing about the page going away.
  if (document.visibilityState !== 'hidden') return;
  runFlushes();
}

function startListening(): void {
  if (listening) return;
  // Capability boundary, not a swallowed failure: a host with no `window`
  // (a DOM-free test environment) has no page lifecycle to listen to, and
  // there is no flush to trigger there either.
  if (typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('pagehide', onPageHide);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

/**
 * Registers a writer's flush. Returns the unregister function, which is the
 * `useEffect` cleanup for a component-scoped writer and is unused for a
 * module-level one. The listeners exist only while at least one flush is
 * registered, so a page with no debounced writer carries no handler.
 */
export function registerPageFlush(flush: PageFlush): () => void {
  flushers.add(flush);
  startListening();
  return () => {
    flushers.delete(flush);
    if (flushers.size === 0) stopListening();
  };
}
