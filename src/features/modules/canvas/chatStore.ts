import { create } from 'zustand';

import type { CanvasChatFraming, CanvasEditCommand } from '@/llm/canvasChat';

/**
 * Canvas chat state (08-MODULE-DESIGNER §Module canvas chat): the per-MODULE
 * conversation, command outcome cards and the session model selection.
 * Messages + outcomes PERSIST on the module row's `chatThread` field
 * (docs/17 row 57 — written after each settled turn via `chatPersist`,
 * restored on canvas open as history); the MODEL SELECTION stays
 * session-only (Board staging precedent) and dies on reload. The DOC is
 * still the truth for part text: applied commands are editor transactions
 * persisted through the split-save.
 *
 * Keyed per MODULE (`canvasChatKey(moduleId)` — no part component, owner
 * direction in docs/17 row 51): ONE conversation per module; switching the
 * open part in the editor keeps the same conversation, and the model
 * selection is per module too. The chat edits the whole module's parts
 * document — outcome cards name the part each outcome targets.
 */

/** Which part an outcome targets (whole-module chat: cards must name it). */
export interface CanvasChatOutcomePart {
  planIndex: number;
  title: string;
}

/** One applied/failed edit command rendered as an OUTCOME CARD — or, since
 * docs/17 row 360, one adversarial REVIEW of the module's premise or a part. */
export interface CanvasChatOutcome {
  id: string;
  /**
   * `applied` / `failed` are the edit command's two outcomes; `clean` is the
   * adversarial review's QUIET success — the critique found nothing to fix, so
   * no editor ran and nothing was written (never rendered as a failure, and
   * never as a change that did not happen).
   */
  kind: 'applied' | 'failed' | 'clean';
  /** The original command (the report-to-LLM turn quotes it verbatim). An
   * adversarial review synthesises the equivalent whole-target replacement, so
   * the card's before→after IS the review's own edit. */
  command: CanvasEditCommand;
  /** Which part(s) this outcome targets/applies to (part order; failures
   * anchor on the closest/multi-match part; [] = no part applies). */
  targetParts: CanvasChatOutcomePart[];
  /** applied: how many occurrences IN THE TARGET PART (1, or N for a
   * replace-all inside it). */
  occurrences: number | null;
  /** applied: first applied range in the TARGET part's text coordinates
   * (card anchor). */
  from: number | null;
  to: number | null;
  /** applied: the ACTUAL replaced text (ladder-resolved, may differ from
   * search by case/whitespace) — the card's mini before→after. */
  before: string | null;
  /** failed: the loud reason. */
  reason: string | null;
  /** failed (zero matches): the closest candidate snippet from the parts. */
  closest: string | null;
  /** failed: anchor offset in the target part's text for the report-to-LLM
   * excerpt (null when nothing corresponds). */
  failureFrom: number | null;
  /** Report-to-LLM has fired for this outcome (button is one-shot). */
  reported: boolean;
  /**
   * An adversarial review's critique findings, one rendered line each
   * (`llm/canvasChat.adversarialFindingLine`). Absent/`[]` for every edit
   * outcome. The card renders them ABOVE the before→after: the owner asked for
   * the review to see WHAT the critic found, not merely that the text moved.
   */
  findings?: string[] | undefined;
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

export interface CanvasChatModuleState {
  messages: CanvasChatMessage[];
  /** Sidebar visibility (session-only; per module like everything else). */
  open: boolean;
  /** The canvas model selection; null = Settings defaultChatModel. */
  modelSelection: string | null;
  /** One chat generation in flight for this module (drives the Stop button). */
  inFlight: boolean;
}

/** The chat state key: per MODULE — one conversation across part switches. */
export function canvasChatKey(moduleId: string): string {
  return moduleId;
}

/**
 * The GM-assist chat's state key (docs/17 row 362): its OWN conversation on
 * the same module, beside the module chat. The suffix cannot collide with a
 * module id (ids are uuids), so the two threads share the ONE store and the
 * SAME sidebar while never sharing a message.
 */
export function gmAssistKey(moduleId: string): string {
  return `${moduleId}#gm-assist`;
}

/**
 * THE key resolver for a canvas chat surface (docs/17 row 362) — the ONE place
 * a caller turns "which chat" into "which store key", so the sidebar and the
 * page's preview/report paths can never disagree about it.
 */
export function canvasChatKeyFor(moduleId: string, framing: CanvasChatFraming): string {
  return framing === 'module' ? canvasChatKey(moduleId) : gmAssistKey(moduleId);
}

interface CanvasChatStoreState {
  ownerModuleId: string | null;
  byModule: Record<string, CanvasChatModuleState>;
  /** Clears every chat when the canvas page's module changes (Board precedent). */
  resetFor: (moduleId: string) => void;
  module: (key: string) => CanvasChatModuleState;
  toggleOpen: (key: string) => void;
  setOpen: (key: string, open: boolean) => void;
  setModelSelection: (key: string, model: string | null) => void;
  setInFlight: (key: string, inFlight: boolean) => void;
  /**
   * Drops ONE module's conversation + outcome cards (the Clear-chat control,
   * docs/08 §Module canvas chat). Only the MESSAGES go: the sidebar's open
   * state and the model selection are surface preferences, and `inFlight`
   * belongs to the turn lifecycle — the control refuses to clear while a
   * reply is in flight, so this never strands a running turn.
   */
  clearModule: (key: string) => void;
  addMessage: (key: string, message: CanvasChatMessage) => void;
  updateMessage: (key: string, messageId: string, patch: Partial<CanvasChatMessage>) => void;
  markOutcomeReported: (key: string, messageId: string, outcomeId: string) => void;
}

const EMPTY_STATE: CanvasChatModuleState = {
  messages: [],
  // Front door (docs/17 row 57): the canvas opens with the chat sidebar
  // OPEN by default. Still collapsible — the toggle writes this same field,
  // which stays session-only per module.
  open: true,
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
  byModule: {},
  resetFor: (moduleId) => {
    if (get().ownerModuleId === moduleId) return;
    set({ ownerModuleId: moduleId, byModule: {} });
  },
  module: (key) => get().byModule[key] ?? EMPTY_STATE,
  toggleOpen: (key) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: { ...(state.byModule[key] ?? EMPTY_STATE), open: !(state.byModule[key] ?? EMPTY_STATE).open },
      },
    }));
  },
  setOpen: (key, open) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: { ...(state.byModule[key] ?? EMPTY_STATE), open },
      },
    }));
  },
  setModelSelection: (key, model) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: { ...(state.byModule[key] ?? EMPTY_STATE), modelSelection: model },
      },
    }));
  },
  setInFlight: (key, inFlight) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: { ...(state.byModule[key] ?? EMPTY_STATE), inFlight },
      },
    }));
  },
  clearModule: (key) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: { ...(state.byModule[key] ?? EMPTY_STATE), messages: [] },
      },
    }));
  },
  addMessage: (key, message) => {
    set((state) => ({
      byModule: {
        ...state.byModule,
        [key]: {
          ...(state.byModule[key] ?? EMPTY_STATE),
          messages: [...(state.byModule[key] ?? EMPTY_STATE).messages, message],
        },
      },
    }));
  },
  updateMessage: (key, messageId, patch) => {
    set((state) => {
      const moduleState = state.byModule[key] ?? EMPTY_STATE;
      return {
        byModule: {
          ...state.byModule,
          [key]: {
            ...moduleState,
            messages: moduleState.messages.map((message) =>
              message.id === messageId ? { ...message, ...patch } : message,
            ),
          },
        },
      };
    });
  },
  markOutcomeReported: (key, messageId, outcomeId) => {
    set((state) => {
      const moduleState = state.byModule[key] ?? EMPTY_STATE;
      return {
        byModule: {
          ...state.byModule,
          [key]: {
            ...moduleState,
            messages: moduleState.messages.map((message) =>
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
