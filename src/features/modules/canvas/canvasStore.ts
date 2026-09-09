import { create } from 'zustand';

/**
 * Canvas version ledger (08-MODULE-DESIGNER §Module canvas): one append-only
 * ledger per (module, part) of accepted text — every accepted AI action AND
 * every manual canvas save appends an entry; "Restore" proposes an older
 * entry's markdown through the SAME suggestion machinery (accept → the one
 * part-text save path → a new ledger entry), so restores ride undo and the
 * save path instead of writing the row from the side.
 *
 * STRICTLY SESSION-ONLY zustand state — in-memory, never persisted, dies on
 * reload (Board staging precedent, deliberate — documented in docs/08:
 * the canonical row always holds a complete text, the ledger is a review
 * convenience, and persistence would imply a revision history the module
 * row does not have). Do not "fix" this with persistence.
 *
 * Scope guard: the ledger clears when the page's module changes (resetFor),
 * matching the board store's owner model. Part switching KEEPS the other
 * parts' ledgers within the session.
 */

export interface CanvasVersionEntry {
  /** Per-part monotonically increasing sequence (1-based). */
  seq: number;
  markdown: string;
  origin: 'user' | 'ai';
  /** What produced this text ("Refine: make it rain", "Manual edit", "Restored version #2"). */
  label: string;
  createdAt: number;
}

interface CanvasPartLedger {
  nextSeq: number;
  versions: CanvasVersionEntry[];
}

export function canvasLedgerKey(moduleId: string, planIndex: number): string {
  return `${moduleId}#${String(planIndex)}`;
}

interface CanvasLedgerEntryInput {
  markdown: string;
  origin: 'user' | 'ai';
  label: string;
}

interface CanvasLedgerState {
  ownerModuleId: string | null;
  byPart: Record<string, CanvasPartLedger>;
  /** Clears the ledger when the canvas page's module changes (Board precedent). */
  resetFor: (moduleId: string) => void;
  append: (key: string, entry: CanvasLedgerEntryInput) => void;
}

export const useCanvasLedgerStore = create<CanvasLedgerState>((set, get) => ({
  ownerModuleId: null,
  byPart: {},
  resetFor: (moduleId) => {
    if (get().ownerModuleId === moduleId) return;
    set({ ownerModuleId: moduleId, byPart: {} });
  },
  append: (key, entry) => {
    set((state) => {
      const ledger = state.byPart[key] ?? { nextSeq: 1, versions: [] };
      const version: CanvasVersionEntry = {
        seq: ledger.nextSeq,
        markdown: entry.markdown,
        origin: entry.origin,
        label: entry.label,
        createdAt: Date.now(),
      };
      return {
        byPart: {
          ...state.byPart,
          [key]: {
            nextSeq: ledger.nextSeq + 1,
            // Append-only: restores append too (they land through accept).
            versions: [...ledger.versions, version],
          },
        },
      };
    });
  },
}));

/** The ledger of one part, oldest first (empty when nothing accepted yet). */
export function ledgerFor(
  state: CanvasLedgerState,
  key: string,
): readonly CanvasVersionEntry[] {
  return state.byPart[key]?.versions ?? [];
}
