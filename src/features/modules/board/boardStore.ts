import { create } from 'zustand';

import {
  canvasPriorModuleNodeKey,
  type Id,
  type Module,
  type ModulePartStatus,
  type TextOrigin,
} from '@/domain';

/**
 * Whole-module board session store (08-MODULE-DESIGNER §Module board):
 * the card CONTENT slices the board node components subscribe to, plus the
 * zoom mirror the LOD switch reads. Strictly SESSION state — the module row
 * is the source of truth (parts/premise/status via the module repo, node
 * positions via the row's `canvas` field); nothing here is persisted
 * anywhere, not even localStorage.
 *
 * The store exists so a change to ONE part re-renders ONE card: node
 * components read per-node slices, and `syncContent` replaces a slice's
 * object only when its VALUE changed — React Flow would otherwise re-render
 * every node whenever the module row re-parses (which happens on every
 * layout persist, because `patchModule` bumps `updatedAt`).
 */

/** Zoom threshold between the full markdown card and the skeleton card. */
export const BOARD_LOD_FULL_ABOVE = 0.6;

/** The premise card of the CURRENT module. */
export interface PremiseCardSlice {
  moduleTitle: string;
  premise: string;
}

/**
 * JOIN of `spine.partPlan[planIndex]` (title/band) × `parts[planIndex]`
 * (body/status/edited) — the card renders the same JOIN the reader does.
 */
export interface PartCardSlice {
  moduleId: Id;
  planIndex: number;
  /** From the PLAN — H1 is never stored in markdown; the card renders it. */
  title: string;
  levelBand: string;
  status: ModulePartStatus | 'missing';
  errorMessage: string;
  markdown: string;
  edited: boolean;
  /**
   * WHO WROTE this part's text (docs/17 row 113): `'human'`, `'model'`, or
   * `null` for NOT RECORDED (a row written before the field). The card's badge
   * reads THIS, not `edited` — `edited` only says the text came from outside
   * the generator, which is equally true of a model rewrite the owner accepted
   * through the canvas. `textOriginIsMachineWritten` is the ONE predicate a
   * consumer may apply; nothing re-derives authorship from `writerModel`.
   */
  origin: TextOrigin | null;
}

/** One prior module's read-only text group (premise + parts, TEXT ONLY). */
export interface PriorCardSlice {
  /** The prior module's OWN tier-0 context for its wiki chips. */
  moduleId: Id;
  title: string;
  levelMin: number;
  levelMax: number;
  premise: string;
  parts: { planIndex: number; title: string; markdown: string }[];
}

export interface BoardContent {
  /** null = the module has no spine yet (the board has nothing to render). */
  premise: PremiseCardSlice | null;
  /** Keyed by the stable board node key (`part-<planIndex>`). */
  parts: Record<string, PartCardSlice>;
  /** Keyed by `prior-<moduleId>`. */
  priors: Record<string, PriorCardSlice>;
  /** The module row's status (generation busy state for card actions). */
  moduleStatus: Module['status'];
}

export interface BoardContentInput {
  moduleId: Id;
  moduleTitle: string;
  moduleStatus: Module['status'];
  premise: string | null;
  /** Complete next slice per part node key (the caller derives the JOIN). */
  parts: Record<string, PartCardSlice>;
  priors: PriorCardSlice[];
}

interface ModuleBoardState {
  /** The module whose content this store holds (reset guard on navigation). */
  ownerId: Id | null;
  content: BoardContent;
  /**
   * Viewport zoom mirror (React Flow stays the viewport gesture owner) —
   * the LOD switch reads this. Node components subscribe to the derived
   * BOOLEAN (`zoom >= BOARD_LOD_FULL_ABOVE`), so panning re-renders
   * nothing and zooming re-renders a card only at the threshold flip.
   */
  zoom: number;
  resetFor: (moduleId: Id) => void;
  syncContent: (input: BoardContentInput) => void;
  setZoom: (zoom: number) => void;
}

const EMPTY_CONTENT: BoardContent = { premise: null, parts: {}, priors: {}, moduleStatus: 'draft' };

export const useBoardStore = create<ModuleBoardState>((set) => ({
  ownerId: null,
  content: EMPTY_CONTENT,
  zoom: 1,
  resetFor: (moduleId) => {
    set({ ownerId: moduleId, content: EMPTY_CONTENT, zoom: 1 });
  },
  syncContent: (input) => {
    set((state) => {
      if (state.ownerId !== input.moduleId) {
        // Navigation guard: never merge slices across modules.
        return { ownerId: input.moduleId, content: buildContent(input) };
      }
      const premise =
        premiseEquals(state.content.premise, input.premise, input.moduleTitle)
          ? state.content.premise
          : input.premise === null
            ? null
            : { moduleTitle: input.moduleTitle, premise: input.premise };
      const parts: Record<string, PartCardSlice> = {};
      let changed =
        premise !== state.content.premise ||
        state.content.moduleStatus !== input.moduleStatus ||
        Object.keys(state.content.parts).length !== Object.keys(input.parts).length ||
        Object.keys(state.content.priors).length !== input.priors.length;
      for (const [key, next] of Object.entries(input.parts)) {
        const previous = state.content.parts[key];
        if (previous !== undefined && partEquals(previous, next)) {
          parts[key] = previous;
        } else {
          parts[key] = next;
          changed = true;
        }
      }
      const priors: Record<string, PriorCardSlice> = {};
      for (const prior of input.priors) {
        const key = canvasPriorModuleNodeKey(prior.moduleId);
        const previous = state.content.priors[key];
        if (previous !== undefined && priorEquals(previous, prior)) {
          priors[key] = previous;
        } else {
          priors[key] = prior;
          changed = true;
        }
      }
      return changed ? { content: { premise, parts, priors, moduleStatus: input.moduleStatus } } : state;
    });
  },
  setZoom: (zoom) => {
    set((state) => (state.zoom === zoom ? state : { zoom }));
  },
}));

function buildContent(input: BoardContentInput): BoardContent {
  const priors: Record<string, PriorCardSlice> = {};
  for (const prior of input.priors) {
    priors[canvasPriorModuleNodeKey(prior.moduleId)] = prior;
  }
  return {
    premise:
      input.premise === null
        ? null
        : { moduleTitle: input.moduleTitle, premise: input.premise },
    parts: { ...input.parts },
    priors,
    moduleStatus: input.moduleStatus,
  };
}

function premiseEquals(
  previous: PremiseCardSlice | null,
  premise: string | null,
  moduleTitle: string,
): boolean {
  if (previous === null || premise === null) return previous === premise;
  return previous.moduleTitle === moduleTitle && previous.premise === premise;
}

function partEquals(a: PartCardSlice, b: PartCardSlice): boolean {
  return (
    a.moduleId === b.moduleId &&
    a.planIndex === b.planIndex &&
    a.title === b.title &&
    a.levelBand === b.levelBand &&
    a.status === b.status &&
    a.errorMessage === b.errorMessage &&
    a.markdown === b.markdown &&
    a.edited === b.edited &&
    a.origin === b.origin
  );
}

function priorEquals(a: PriorCardSlice, b: PriorCardSlice): boolean {
  if (
    a.moduleId !== b.moduleId ||
    a.title !== b.title ||
    a.levelMin !== b.levelMin ||
    a.levelMax !== b.levelMax ||
    a.premise !== b.premise ||
    a.parts.length !== b.parts.length
  ) {
    return false;
  }
  return a.parts.every((partA, index) => {
    const partB = b.parts[index];
    if (partB === undefined) return false;
    return (
      partA.planIndex === partB.planIndex &&
      partA.title === partB.title &&
      partA.markdown === partB.markdown
    );
  });
}
