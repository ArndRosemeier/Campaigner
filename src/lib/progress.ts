import { create } from 'zustand';

/**
 * Shared progress seam (00-OVERVIEW §Global conventions): anything slow —
 * batch generation, module parts, PDF builds — reports through here and the
 * app-wide <ProgressDock /> (AppShell) renders one stacked job per entry:
 * a determinate 0..1 bar when progress is known, an animated sweep when it
 * is not, and a detail line describing what is happening RIGHT NOW. A bare
 * disabled button is not a progress experience.
 */

export interface ProgressJob {
  id: string;
  /** What overall task is running ("Generating 3 npcs"). */
  label: string;
  /** What is happening right now ("Mira — drafting…"). */
  detail: string;
  /** 0..1, or null for an indeterminate (unknown-length) task. */
  progress: number | null;
}

interface ProgressState {
  jobs: ProgressJob[];
  /** Starts (or restarts) a job; an existing job with the same id is replaced. */
  start: (id: string, label: string, detail?: string) => void;
  /** Updates detail/progress of a started job; silently ignored when absent. */
  update: (id: string, patch: { detail?: string; progress?: number | null }) => void;
  /** Removes a finished job; the dock disappears once no jobs remain. */
  finish: (id: string) => void;
  /** Test seam: clears every job (module-level store persists across tests). */
  reset: () => void;
}

function clampProgress(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export const useProgressStore = create<ProgressState>((set) => ({
  jobs: [],

  start: (id, label, detail = '') => {
    set((state) => {
      const job: ProgressJob = { id, label, detail, progress: null };
      return { jobs: [...state.jobs.filter((existing) => existing.id !== id), job] };
    });
  },

  update: (id, patch) => {
    set((state) => {
      const index = state.jobs.findIndex((job) => job.id === id);
      if (index === -1) return state; // already finished — never resurrect
      const job = state.jobs[index];
      if (job === undefined) return state;
      const next: ProgressJob = {
        ...job,
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.progress !== undefined
          ? { progress: patch.progress === null ? null : clampProgress(patch.progress) }
          : {}),
      };
      const jobs = [...state.jobs];
      jobs[index] = next;
      return { jobs };
    });
  },

  finish: (id) => {
    set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) }));
  },

  reset: () => {
    set({ jobs: [] });
  },
}));
