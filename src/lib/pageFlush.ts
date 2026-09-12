import { toastError } from '@/lib/toast';

/**
 * The page-hide flush seam (docs/17 row 111).
 *
 * Three writers in this app debounce a row write: the canvas chat thread
 * (`features/modules/canvas/chatPersist`, 600 ms), the New Module draft
 * (`features/modules/new-module-dialog`, 500 ms) and the module board's layout
 * (`features/modules/board/BoardPage`, 600 ms). Each of them flushed on
 * UNMOUNT — which covers a route change and nothing else. A tab that is
 * BACKGROUNDED and then frozen or discarded (mobile Safari, Chrome's tab
 * freezing, a bfcache navigation) never unmounts, so a settled chat turn or a
 * typed draft sitting inside its debounce window was simply gone: the row kept
 * its old value and no surface said so.
 *
 * TWO of the three are on this seam today (the chat thread and the draft). The
 * board's layout write has exactly the same exposure and is NOT wired here yet:
 * `features/modules/board/BoardPage` still flushes on unmount only, and that
 * file was out of this slice's reach. The seam was built to take it — a
 * pending-gated flush plus one `registerPageFlush` call, nothing else.
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
 *
 * What this seam deliberately does NOT do: it never AWAITS the writers (a
 * lifecycle handler cannot hold the page open) and it has no opinion about
 * what a flush writes. Whether an IndexedDB transaction started here commits
 * before the tab is actually torn down is the browser's business — see
 * docs/18 §4 for what that means and what stays unproven.
 */

/**
 * A writer's "land what you have now" function. Must be pending-gated,
 * idempotent and non-throwing — see the contract above.
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
