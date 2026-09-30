import { recordRecentChatModel } from '@/db/settingsRepo';
import { toastError } from '@/lib/toast';

/**
 * Records the GLOBAL first-try chat model as recently used (docs/17 row 198).
 *
 * THE ONE in-use recording seam. `db/settingsRepo.recordRecentChatModel` is the
 * ONE WRITE (read + merge through `domain/settings.withRecentChatModel` + write
 * in one transaction); this is the ONE place a caller says "the global model was
 * genuinely in play for this call", so the next path that starts using it cannot
 * invent a second recording mechanism. The callers are the run funnel
 * (`llm/runEngine`, which resolves the global default), module generation and
 * its normalization passes (`llm/moduleGen`), the document planner
 * (`llm/modulePlan`), canvas refine (`llm/canvasRefine`), canvas chat
 * (`llm/canvasChat`, only when the session model is unset so the global is what
 * answers) and the Idea Board (`llm/ideaBoard`, same condition for `board.model`).
 *
 * FIRE-AND-FORGET BY CONTRACT, and that is load-bearing rather than stylistic:
 * the recents list is optional enrichment, and awaiting a settings transaction on
 * a run's critical path was a MEASURED regression (docs/17 row 193 — holding the
 * run row at its previous status let a legitimately racing `approve` observe a
 * stale `awaiting_user` and re-enter the SAME step). A bookkeeping failure never
 * fails a generation, but it is SURFACED loudly so it cannot vanish (AGENTS rule
 * 2). The empty string is not a model and records nothing.
 */
export function recordGlobalChatModelInUse(model: string): void {
  const trimmed = model.trim();
  if (trimmed === '') return;
  void recordRecentChatModel(trimmed).catch((error: unknown) => {
    toastError('Could not update the recently used models', error);
  });
}
