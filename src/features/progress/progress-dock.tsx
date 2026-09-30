import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { SquareStop } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { chainRunner, type ChainState } from '@/llm/chainRunner';
import { useProgressStore } from '@/lib/progress';
import { stopAllGenerations } from '@/features/progress/stop-all-generations';
import { toastError } from '@/lib/toast';

/**
 * App-wide progress dock (AppShell, above <main>): one stacked job per
 * running task, each with a determinate left-to-right bar (percent when the
 * task knows its progress) or an animated sweep when it does not, a label
 * naming the overall task, and a detail line describing the current step —
 * so a multi-minute generation never looks like a hang. Jobs that carry a
 * destination (a run's workspace view, the module mid-forge) render their
 * label as a button that navigates there — generation stays observable from
 * every screen, not only from the pane that started it.
 *
 * The header hosts **Stop all** (owner request): one press sweeps every
 * generation surface via `stopAllGenerations` — queue jobs, in-flight runs,
 * the module forge, an active Writers' Room chain. Non-destructive (stopped
 * runs stay resumable), no confirmation, disabled while the sweep runs. The
 * dock (and with it the button) also appears while ONLY a chain is running —
 * chain steps are real runs but report no dock job of their own.
 */
export function ProgressDock(): JSX.Element | null {
  const jobs = useProgressStore((state) => state.jobs);
  const chain = useChainState();
  const [stopping, setStopping] = useState(false);
  if (jobs.length === 0 && chain.status !== 'running') return null;

  const stopAll = (): void => {
    if (stopping) return;
    setStopping(true);
    stopAllGenerations()
      .catch((error: unknown) => {
        toastError('Could not stop the running generations', error);
      })
      .finally(() => {
        setStopping(false);
      });
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      data-testid="progress-dock"
    >
      <div className="pointer-events-auto flex w-full max-w-xl flex-col gap-4 rounded-lg border bg-popover p-4 shadow-lg">
        <div className="flex justify-end">
          <Button
            type="button"
            variant="destructive"
            size="xs"
            disabled={stopping}
            onClick={stopAll}
            data-testid="stop-all-generations"
          >
            <SquareStop />
            {stopping ? 'Stopping…' : 'Stop all'}
          </Button>
        </div>
        {jobs.map((job) => (
          <div key={job.id} className="flex flex-col gap-1.5" data-testid="progress-job">
            <div className="flex items-baseline justify-between gap-2 text-sm font-medium">
              {job.href !== undefined ? (
                <DockLink href={job.href} label={job.label} />
              ) : (
                <span data-testid="progress-label">{job.label}</span>
              )}
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

/**
 * The "Open" affordance for a job with a destination. Rendered only when the
 * job carries an href, so bare-store test harnesses without a Router never
 * mount it (it is the only hook-consuming part of the dock).
 */
function DockLink({ href, label }: { href: string; label: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="text-left font-medium underline-offset-2 hover:underline"
      data-testid="progress-open"
      title="Show this job where it lives"
      onClick={() => {
        navigate(href);
      }}
    >
      {label}
    </button>
  );
}

/**
 * The Writers'-Room chain is the one running thing that reports no dock job
 * (its steps are real runs, but only encounter runs start dock entries), so
 * the dock subscribes to the chain state directly: a running chain keeps the
 * dock — and its Stop all button — on screen even with an empty job list.
 */
function useChainState(): ChainState {
  const [chain, setChain] = useState<ChainState>(() => chainRunner.getState());
  useEffect(() => chainRunner.on(setChain), []);
  return chain;
}
