import { create } from 'zustand';

/**
 * Staged board rewrites (08-MODULE-DESIGNER §Module board, owner decision):
 * the decision layer for per-part rewrites on the board. NO DIFFS and no
 * side-by-side view — the rewritten text renders on the card AS-IS with a
 * clear "proposed" framing, the previous text stays readable on demand via
 * the card's "Show previous" toggle, and the owner decides with Apply or
 * Discard. Expected diffs are huge; a diff view would be unreadable.
 *
 * STRICTLY SESSION-ONLY zustand state — in-memory, never persisted, dies on
 * reload (deliberate: the canonical row always holds a complete text, either
 * the engine-written rewrite or, after a Discard, the restored previous one;
 * a reload mid-proposal keeps the engine's text with edited:false and the
 * staging simply disappears with the old text unrecoverable). Documented on
 * purpose — do not "fix" this with persistence.
 *
 * Flow: `stageProposal` when the rewrite starts (captures the OLD text and
 * the module row stays the engine's business) → `appendGhost` streams tokens
 * into the ghost preview (rAF-throttled by the board page — partial text
 * never touches the module row) → `finishProposal` when the engine's ready
 * write landed (newMarkdown = the complete text) → the owner either Applys
 * (markApplied → the save path lands the text with edited:true → drop) or
 * Discards (drop + the page restores the old text through the same save
 * path). A failed apply reverts to proposed.
 */

export type StagedRewriteStatus = 'proposed' | 'applied';

export interface StagedRewrite {
  /** The board node key (`part-<planIndex>`). */
  nodeKey: string;
  planIndex: number;
  /** The text the part had before the rewrite — "Show previous" reads this. */
  oldMarkdown: string;
  /** The complete rewritten text (set once the engine's ready write landed). */
  newMarkdown: string;
  /** Streaming ghost preview (accumulated tokens; never canonical). */
  ghost: string;
  status: StagedRewriteStatus;
}

interface StagedRewritesState {
  byNodeKey: Record<string, StagedRewrite>;
  stageProposal: (input: { nodeKey: string; planIndex: number; oldMarkdown: string }) => void;
  appendGhost: (nodeKey: string, delta: string) => void;
  finishProposal: (nodeKey: string, newMarkdown: string) => void;
  markApplied: (nodeKey: string) => void;
  revertToProposed: (nodeKey: string) => void;
  drop: (nodeKey: string) => void;
}

export const useStagedRewritesStore = create<StagedRewritesState>((set) => ({
  byNodeKey: {},
  stageProposal: ({ nodeKey, planIndex, oldMarkdown }) => {
    set((state) => ({
      byNodeKey: {
        ...state.byNodeKey,
        [nodeKey]: { nodeKey, planIndex, oldMarkdown, newMarkdown: '', ghost: '', status: 'proposed' },
      },
    }));
  },
  appendGhost: (nodeKey, delta) => {
    set((state) => {
      const entry = state.byNodeKey[nodeKey];
      if (entry === undefined) return state;
      return {
        byNodeKey: {
          ...state.byNodeKey,
          [nodeKey]: { ...entry, ghost: entry.ghost + delta },
        },
      };
    });
  },
  finishProposal: (nodeKey, newMarkdown) => {
    set((state) => {
      const entry = state.byNodeKey[nodeKey];
      if (entry === undefined) return state;
      return {
        byNodeKey: {
          ...state.byNodeKey,
          [nodeKey]: { ...entry, newMarkdown, ghost: '' },
        },
      };
    });
  },
  markApplied: (nodeKey) => {
    set((state) => {
      const entry = state.byNodeKey[nodeKey];
      if (entry === undefined || entry.status === 'applied') return state;
      return {
        byNodeKey: {
          ...state.byNodeKey,
          [nodeKey]: { ...entry, status: 'applied' },
        },
      };
    });
  },
  revertToProposed: (nodeKey) => {
    set((state) => {
      const entry = state.byNodeKey[nodeKey];
      if (entry?.status !== 'applied') return state;
      return {
        byNodeKey: {
          ...state.byNodeKey,
          [nodeKey]: { ...entry, status: 'proposed' },
        },
      };
    });
  },
  drop: (nodeKey) => {
    set((state) => {
      if (state.byNodeKey[nodeKey] === undefined) return state;
      const byNodeKey: Record<string, StagedRewrite> = {};
      for (const [key, entry] of Object.entries(state.byNodeKey)) {
        if (key !== nodeKey) byNodeKey[key] = entry;
      }
      return { byNodeKey };
    });
  },
}));

/** True while the module's staged-rewrite decision is pending (the card
 * frames the text as proposed instead of canonical). */
export function stagedRewriteFor(
  byNodeKey: Record<string, StagedRewrite>,
  nodeKey: string,
): StagedRewrite | undefined {
  return byNodeKey[nodeKey];
}
