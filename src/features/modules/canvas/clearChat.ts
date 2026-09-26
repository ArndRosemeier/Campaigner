import type { Id } from '@/domain';
import { canvasChatThreadPersists, type CanvasChatFraming } from '@/llm/canvasChat';
import { clearPersistedChatThread } from '@/features/modules/canvas/chatPersist';
import { useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { useCanvasLedgerStore } from '@/features/modules/canvas/canvasStore';

/**
 * Clear-chat orchestration (08-MODULE-DESIGNER §Module canvas chat; docs/18
 * §2.3): returns ONE module's canvas chat to a pristine state in ONE action —
 * the live conversation (`chatStore`), the persisted thread on the module row
 * (`chatPersist`, the SAME write seam the debounced writer uses) and that
 * module's SESSION version ledger (`canvasStore`) — so the Versions dropdown
 * goes back to its truthful empty state instead of outliving the thread that
 * produced its entries.
 *
 * Order is load-bearing: THE ROW GOES FIRST, awaited. The persisted thread is
 * the half that survives a reload, so a failure there ABORTS the whole action
 * (the throw propagates: the caller toasts and nothing is cleared) — clearing
 * the store first would leave the row holding the old thread with an empty
 * store, and the next canvas open (or live-query emission) would restore the
 * whole conversation from it.
 *
 * What this does NOT touch (the dialog copy states it): the module's DOCUMENT
 * text. Chat edits that already applied are saved content — the document is
 * written only through the part-text save path, and reverting text is the
 * Versions ledger's job (session-only by design). Other modules' threads,
 * ledgers and highlights are untouched too: the ledger is keyed
 * `moduleId#planIndex` and the chat key is per module.
 *
 * The last-replacement highlight is PAGE state (`CanvasPage.lastReplacement`,
 * which drives both the editor's CM6 mark and the preview's wash), so the
 * caller clears it — see `ChatSidebar`'s `onChatCleared`.
 *
 * TWO SURFACES, ONE CLEAR (docs/17 row 362). The `framing` says WHICH chat is
 * cleared, and only the surface whose thread PERSISTS owns the row half and the
 * module ledger. GM assist is session-only in this slice, so its clear drops
 * the store key and nothing else: its messages are gone from the sidebar, the
 * module chat's saved thread is untouched, and the shared session ledger (which
 * covers BOTH surfaces' undo and cannot tell them apart) survives.
 */

export interface ClearModuleChatInput {
  /** The module whose chat is cleared (owning the row thread + ledger). */
  moduleId: Id;
  /** The surface's chat key (`canvasChatKeyFor(moduleId, framing)`). */
  key: string;
  /**
   * WHICH canvas chat surface is cleared (docs/17 row 362). Only the surface
   * whose thread PERSISTS (`canvasChatThreadPersists`) owns the row half and
   * the module's session ledger; GM assist is session-only in this slice, so
   * clearing it must touch NEITHER — its key has no persisted thread, and the
   * ledger is keyed per MODULE and cannot tell the two surfaces' undo entries
   * apart, so emptying it would throw away the module chat's own undo.
   */
  framing: CanvasChatFraming;
}

/**
 * Clears one surface's chat. Throws when the persisted thread could not be
 * cleared (then NOTHING was cleared — the caller surfaces the error loudly);
 * resolves once every in-memory slice is pristine.
 */
export async function clearModuleChat(input: ClearModuleChatInput): Promise<void> {
  const ownsRow = canvasChatThreadPersists(input.framing);
  // The row half is AWAITED and FIRST for the surface that has one: see the
  // file header for why a failure here aborts the whole action.
  if (ownsRow) await clearPersistedChatThread(input.moduleId, input.key);
  // The live conversation + its outcome cards, then (for the surface that owns
  // them) THIS module's session ledger.
  useCanvasChatStore.getState().clearModule(input.key);
  if (ownsRow) useCanvasLedgerStore.getState().clearModule(input.moduleId);
}
