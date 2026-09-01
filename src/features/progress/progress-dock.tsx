import type { JSX } from 'react';

import { useProgressStore } from '@/lib/progress';

/**
 * App-wide progress dock (AppShell, above <main>): one stacked job per
 * running task, each with a determinate left-to-right bar (percent when the
 * task knows its progress) or an animated sweep when it does not, a label
 * naming the overall task, and a detail line describing the current step —
 * so a multi-minute generation never looks like a hang.
 */
export function ProgressDock(): JSX.Element | null {
  const jobs = useProgressStore((state) => state.jobs);
  if (jobs.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      data-testid="progress-dock"
    >
      <div className="pointer-events-auto flex w-full max-w-xl flex-col gap-4 rounded-lg border bg-popover p-4 shadow-lg">
        {jobs.map((job) => (
          <div key={job.id} className="flex flex-col gap-1.5" data-testid="progress-job">
            <div className="flex items-baseline justify-between gap-2 text-sm font-medium">
              <span data-testid="progress-label">{job.label}</span>
              {job.progress !== null && (
                <span className="text-xs tabular-nums text-muted-foreground" data-testid="progress-percent">
                  {String(Math.round(job.progress * 100))}%
                </span>
              )}
            </div>
            <div
              className="h-2.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={job.label}
              data-testid="progress-bar"
              {...(job.progress !== null
                ? {
                    'aria-valuenow': Math.round(job.progress * 100),
                    'aria-valuemin': 0,
                    'aria-valuemax': 100,
                  }
                : {})}
            >
              {job.progress !== null ? (
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${String(Math.round(job.progress * 100))}%` }}
                  data-testid="progress-fill"
                />
              ) : (
                <div
                  className="progress-indeterminate h-full w-1/3 rounded-full bg-primary"
                  data-testid="progress-fill"
                />
              )}
            </div>
            <p
              className="text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
              data-testid="progress-detail"
            >
              {job.detail === '' ? 'Working…' : job.detail}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
