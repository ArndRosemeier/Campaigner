import type { Id, ModuleChatMessage } from '@/domain';
import { patchModule } from '@/db/moduleRepo';
import {
  newChatId,
  useCanvasChatStore,
  type CanvasChatMessage,
} from '@/features/modules/canvas/chatStore';
import { toastError } from '@/lib/toast';
import { registerPageFlush } from '@/lib/pageFlush';

/**
 * Canvas chat thread persistence (08-MODULE-DESIGNER §Module canvas chat,
 * docs/17 row 57 — owner-overturned: the conversation PERSISTS on the
 * module row as the additive inert `chatThread` field; exported modules
 * carry their chat history).
 *
 * - Written after each SETTLED turn (streaming turns never persist),
 *   DEBOUNCED — a write failure toasts LOUDLY but NEVER blocks chatting
 *   (AGENTS 2: the throw stays inside the writer; the controller already
 *   settled).
 * - Restored on canvas open as HISTORY (messages + outcomes render; nothing
 *   auto-applies — restore only touches the store, never the editor).
 * - No Dexie version: the field rides `patchModule` (read-modify-write
 *   inside the tx, so a concurrent part save cannot be lost) and travels
 *   with backup / campaign export-import automatically.
 * - Cleared on demand by the chat's Clear-chat control through the SAME
 *   write seam (`clearPersistedChatThread` — see its contract for the
 *   row-first / loud-failure rules).
 */

export const CHAT_PERSIST_DEBOUNCE_MS = 600;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingModules = new Map<string, string>();

/** Store messages → row entries (settled only; streaming never persists). */
export function serializeChatThread(
  messages: readonly CanvasChatMessage[],
): ModuleChatMessage[] {
  return messages
    .filter((message) => message.status !== 'streaming')
    .map((message) => ({
      role: message.role,
      text: message.text,
      raw: message.raw,
      status: message.status as 'ok' | 'failed' | 'aborted',
      error: message.error,
      outcomes: message.outcomes.map((outcome) => ({
        kind: outcome.kind,
        command: { ...outcome.command },
        targetParts: outcome.targetParts.map((part) => ({ ...part })),
        occurrences: outcome.occurrences,
        from: outcome.from,
        to: outcome.to,
        before: outcome.before,
        reason: outcome.reason,
        closest: outcome.closest,
        failureFrom: outcome.failureFrom,
        reported: outcome.reported,
      })),
      createdAt: message.createdAt,
    }));
}

/** Row entries → store messages (fresh ids; rendered as history only). */
export function deserializeChatThread(
  thread: readonly ModuleChatMessage[],
): CanvasChatMessage[] {
  return thread.map((entry) => ({
    id: newChatId('msg'),
    role: entry.role,
    text: entry.text,
    raw: entry.raw,
    status: entry.status,
    error: entry.error,
    outcomes: entry.outcomes.map((outcome) => ({
      ...outcome,
      command: { ...outcome.command },
      targetParts: outcome.targetParts.map((part) => ({ ...part })),
      id: newChatId('outcome'),
    })),
    createdAt: entry.createdAt === 0 ? Date.now() : entry.createdAt,
  }));
}

/**
 * Restores the persisted thread into the store — once per module, and never
 * over live state: a non-empty store (the user already chatted this
 * session) always wins. Restored entries are history: they render as
 * messages + outcome cards and never touch the editor.
 */
export function hydrateChatFromThread(
  key: string,
  thread: readonly ModuleChatMessage[],
): void {
  if (thread.length === 0) return;
  const store = useCanvasChatStore.getState();
  if (store.module(key).messages.length > 0) return;
  for (const message of deserializeChatThread(thread)) {
    store.addMessage(key, message);
  }
}

async function fireChatPersist(key: string): Promise<void> {
  pendingTimers.delete(key);
  const moduleId = pendingModules.get(key);
  if (moduleId === undefined) return;
  pendingModules.delete(key);
  const messages = useCanvasChatStore.getState().module(key).messages;
  if (messages.length === 0) return;
  try {
    await patchModule(moduleId, { chatThread: serializeChatThread(messages) });
  } catch (error) {
    // Loud, never blocking: the turn already settled — chatting continues,
    // only reload survival is lost for this write (the next settled turn
    // re-schedules).
    toastError(
      'Could not save the chat history — chatting still works, but the thread will not survive a reload',
      error,
    );
  }
}

/**
 * Schedules the write-after-settled-turn (debounced; trailing — the writer
 * reads the store at fire time, so rapid turns collapse into one write).
 */
export function scheduleChatPersist(moduleId: string, key: string): void {
  pendingModules.set(key, moduleId);
  if (pendingTimers.has(key)) return;
  pendingTimers.set(
    key,
    setTimeout(() => {
      void fireChatPersist(key);
    }, CHAT_PERSIST_DEBOUNCE_MS),
  );
}

/**
 * Clears the PERSISTED thread for ONE module — the Clear-chat control
 * (docs/08 §Module canvas chat): the row's `chatThread` goes back to `[]`
 * through the SAME `patchModule` write the debounced writer uses (no second
 * persistence path, no Dexie version bump).
 *
 * Two deliberate differences from the debounced `fireChatPersist`:
 * - the write is AWAITED and its failure PROPAGATES (the caller toasts and
 *   the clear is cancelled). A swallowed failure would leave the in-memory
 *   conversation wiped while the row still carried it — the whole thread
 *   would come straight back on the next canvas open;
 * - a pending debounced write for this key is CANCELLED first: its trailing
 *   fire would re-serialize the store as it was before the clear.
 */
export async function clearPersistedChatThread(moduleId: Id, key: string): Promise<void> {
  const pendingTimer = pendingTimers.get(key);
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimers.delete(key);
  pendingModules.delete(key);
  await patchModule(moduleId, { chatThread: [] });
}

/** Writes any pending thread now (unmount flush, tests). Never throws. */
export async function flushChatPersist(key?: string): Promise<void> {
  const keys =
    key === undefined
      ? [...pendingTimers.keys()]
      : pendingTimers.has(key)
        ? [key]
        : [];
  for (const pending of keys) {
    const timer = pendingTimers.get(pending);
    if (timer !== undefined) clearTimeout(timer);
    await fireChatPersist(pending);
  }
}

/**
 * The page-hide flush (docs/17 row 111, `lib/pageFlush`). Registered HERE, at
 * module scope, because the queue being flushed is this module's: a settled
 * chat turn can be sitting in the 600 ms debounce when the tab is
 * BACKGROUNDED and then frozen or discarded — and a frozen tab never unmounts,
 * so the canvas's own unmount flush never runs.
 *
 * The flush is the file's existing `flushChatPersist` with no key: it visits
 * every module with a QUEUED timer (a key whose debounce already fired is not
 * in `pendingTimers`), takes the timer out before writing, and reports its own
 * failures loudly — so a tab switch writes nothing, a hidden-then-closed page
 * writes once, and a failed write still reaches the owner (AGENTS 2). No new
 * write path, no second serialization, no Dexie version.
 */
registerPageFlush(() => {
  void flushChatPersist();
});
