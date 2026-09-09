import { create } from 'zustand';

import type { CanvasEditCommand } from '@/llm/canvasChat';

/**
 * Canvas chat state (08-MODULE-DESIGNER §Module canvas chat): the per-part
 * conversation, command outcome cards and the session model selection —
 * STRICTLY SESSION-ONLY zustand (Board staging precedent, docs/08). Dies on
 * reload AND resets when the canvas's module changes (resetFor). The DOC is
 * the truth: chat messages are a review surface, never a persistence
 * layer — do not "fix" this with persistence.
 *
 * Keyed per open part (`moduleId#planIndex`): each part carries its own
 * conversation and selection; switching parts keeps the other parts' chats
 * within the session.
 */

/** One applied/failed edit command rendered as an OUTCOME CARD. */
export interface CanvasChatOutcome {
  id: string;
  kind: 'applied' | 'failed';
  /** The original command (the report-to-LLM turn quotes it verbatim). */
  command: CanvasEditCommand;
  /** applied: how many occurrences (1, or N for replace-all). */
  occurrences: number | null;
  /** applied: first applied range in doc coordinates (card anchor). */
  from: number | null;
  to: number | null;
  /** applied: the ACTUAL replaced doc text (ladder-resolved, may differ
   * from search by case/whitespace) — the card's mini before→after. */
  before: string | null;
  /** failed: the loud reason. */
  reason: string | null;
  /** failed (zero matches): the closest candidate snippet from the doc. */
  closest: string | null;
  /** failed: anchor offset for the report-to-LLM excerpt (null when
   * nothing in the doc corresponds). */
  failureFrom: number | null;
  /** Report-to-LLM has fired for this outcome (button is one-shot). */
  reported: boolean;
}

export type CanvasChatMessageStatus = 'streaming' | 'ok' | 'failed' | 'aborted';

export interface CanvasChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** user: the instruction. assistant: the RAW reply (prose + XML blocks)
   * while streaming, the PARSED prose once settled, the raw reply on
   * failure (the report turn quotes it). */
  text: string;
  /** assistant only: the canonical raw reply (prose + XML blocks) once
   * settled — history payloads quote it so the model sees its own
   * commands. */
  raw: string | null;
  status: CanvasChatMessageStatus;
  /** failed: the loud error (parse failure / transport error). */
  error: string | null;
  /** assistant only: command outcomes in reply order. */
  outcomes: CanvasChatOutcome[];
  createdAt: number;
}

export interface CanvasChatPartState {
  messages: CanvasChatMessage[];
  /** Sidebar visibility (session-only; per part like everything else). */
  open: boolean;
  /** The canvas model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  /** One chat generation in flight for this part (drives the Stop button). */
  inFlight: boolean;
}

export function canvasChatKey(moduleId: string, planIndex: number): string {
  return `${moduleId}#${String(planIndex)}`;
}

interface CanvasChatStoreState {
  ownerModuleId: string | null;
  byPart: Record<string, CanvasChatPartState>;
  /** Clears every chat when the canvas page's module changes (Board precedent). */
  resetFor: (moduleId: string) => void;
  part: (key: string) => CanvasChatPartState;
  toggleOpen: (key: string) => void;
  setOpen: (key: string, open: boolean) => void;
  setModelSelection: (key: string, model: string | null) => void;
  setInFlight: (key: string, inFlight: boolean) => void;
  addMessage: (key: string, message: CanvasChatMessage) => void;
  updateMessage: (key: string, messageId: string, patch: Partial<CanvasChatMessage>) => void;
  markOutcomeReported: (key: string, messageId: string, outcomeId: string) => void;
}

const EMPTY_PART: CanvasChatPartState = {
  messages: [],
  open: false,
  modelSelection: null,
  inFlight: false,
};

/** Collision-free message/outcome ids (no crypto dependency — jsdom-safe). */
let chatSeq = 0;
export function newChatId(prefix: string): string {
  chatSeq += 1;
  return `${prefix}-${String(chatSeq)}`;
}

export const useCanvasChatStore = create<CanvasChatStoreState>((set, get) => ({
  ownerModuleId: null,
  byPart: {},
  resetFor: (moduleId) => {
    if (get().ownerModuleId === moduleId) return;
    set({ ownerModuleId: moduleId, byPart: {} });
  },
  part: (key) => get().byPart[key] ?? EMPTY_PART,
  toggleOpen: (key) => {
    set((state) => ({
      byPart: {
        ...state.byPart,
        [key]: { ...(state.byPart[key] ?? EMPTY_PART), open: !(state.byPart[key] ?? EMPTY_PART).open },
      },
    }));
  },
  setOpen: (key, open) => {
    set((state) => ({
      byPart: {
        ...state.byPart,
        [key]: { ...(state.byPart[key] ?? EMPTY_PART), open },
      },
    }));
  },
  setModelSelection: (key, model) => {
    set((state) => ({
      byPart: {
        ...state.byPart,
        [key]: { ...(state.byPart[key] ?? EMPTY_PART), modelSelection: model },
      },
    }));
  },
  setInFlight: (key, inFlight) => {
    set((state) => ({
      byPart: {
        ...state.byPart,
        [key]: { ...(state.byPart[key] ?? EMPTY_PART), inFlight },
      },
    }));
  },
  addMessage: (key, message) => {
    set((state) => ({
      byPart: {
        ...state.byPart,
        [key]: {
          ...(state.byPart[key] ?? EMPTY_PART),
          messages: [...(state.byPart[key] ?? EMPTY_PART).messages, message],
        },
      },
    }));
  },
  updateMessage: (key, messageId, patch) => {
    set((state) => {
      const part = state.byPart[key] ?? EMPTY_PART;
      return {
        byPart: {
          ...state.byPart,
          [key]: {
            ...part,
            messages: part.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          },
        },
      };
    });
  },
  markOutcomeReported: (key, messageId, outcomeId) => {
    set((state) => {
      const part = state.byPart[key] ?? EMPTY_PART;
      return {
        byPart: {
          ...state.byPart,
          [key]: {
            ...part,
            messages: part.messages.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    outcomes: message.outcomes.map((outcome) =>
                      outcome.id === outcomeId ? { ...outcome, reported: true } : outcome,
                    ),
                  }
                : message,
            ),
          },
        },
      };
    });
  },
}));
