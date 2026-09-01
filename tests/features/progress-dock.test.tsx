import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProgressDock } from '@/features/progress/progress-dock';
import { useProgressStore } from '@/lib/progress';

/**
 * The app-wide progress dock (00-OVERVIEW): renders one stacked job per
 * running task — label, determinate fill + percent, or an indeterminate
 * sweep — and the detail line describing the current step. No jobs → the
 * dock disappears entirely.
 */

describe('ProgressDock', () => {
  beforeEach(() => {
    useProgressStore.getState().reset();
  });
  afterEach(cleanup);

  it('renders nothing when no jobs are running', () => {
    render(<ProgressDock />);
    expect(screen.queryByTestId('progress-dock')).not.toBeInTheDocument();
  });

  it('shows a determinate bar with percent and the current detail', () => {
    useProgressStore.getState().start('job-1', 'Generating 2 npcs');
    useProgressStore.getState().update('job-1', { detail: 'Mira — drafting…', progress: 0.5 });

    render(<ProgressDock />);

    expect(screen.getByTestId('progress-label')).toHaveTextContent('Generating 2 npcs');
    expect(screen.getByTestId('progress-detail')).toHaveTextContent('Mira — drafting…');
    expect(screen.getByTestId('progress-percent')).toHaveTextContent('50%');
    expect(screen.getByTestId('progress-bar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByTestId('progress-fill').getAttribute('width')).toBeNull();
    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('shows an animated indeterminate sweep when progress is unknown', () => {
    useProgressStore.getState().start('job-1', 'Designing the module outline');

    render(<ProgressDock />);

    expect(screen.queryByTestId('progress-percent')).not.toBeInTheDocument();
    expect(screen.getByTestId('progress-fill')).toHaveClass('progress-indeterminate');
    expect(screen.getByTestId('progress-detail')).toHaveTextContent('Working…');
  });

  it('stacks concurrent jobs and drops each on finish', () => {
    const store = useProgressStore.getState();
    store.start('job-1', 'Generating 2 npcs');
    store.start('job-2', 'Building PDF: The Drowned Vault');

    render(<ProgressDock />);

    expect(screen.getAllByTestId('progress-job')).toHaveLength(2);
    expect(screen.getByText('Building PDF: The Drowned Vault')).toBeInTheDocument();

    act(() => {
      store.finish('job-2');
    });
    expect(screen.getAllByTestId('progress-job')).toHaveLength(1);
    act(() => {
      store.finish('job-1');
    });
    expect(screen.queryByTestId('progress-dock')).not.toBeInTheDocument();
  });
});
