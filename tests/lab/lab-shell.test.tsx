import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LabPage } from '@/features/lab/LabPage';
import { runLabeledDungeonBench } from '@/features/lab/labClients';
import { toastError } from '@/lib/toast';
import type { LabeledDungeonMapResult } from '@/features/lab/experiments/labeledDungeon';

/**
 * Lab shell tests with a mocked runner (no live LLM calls): the shell
 * renders the registry entry, the run/results states, and refuses a second
 * click while running loudly instead of queueing.
 */

vi.mock('@/features/lab/labClients', () => ({
  runLabeledDungeonBench: vi.fn(),
  blobToDataUrl: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const benchMock = vi.mocked(runLabeledDungeonBench);
const toastErrorMock = vi.mocked(toastError);

const OK_MAP: LabeledDungeonMapResult = {
  imageUrl: 'data:image/webp;base64,OKMAP',
  status: 'ok',
  errorMessage: '',
  marks: [{ label: 'A', x: 120, y: 340, note: 'on the wreck deck' }],
  missing: ['B', 'C', 'D', 'E', 'F', 'G', 'H'],
  modelUsed: 'test-chat-model',
};

const FAILED_MAP: LabeledDungeonMapResult = {
  imageUrl: 'data:image/webp;base64:BADMAP',
  status: 'failed',
  errorMessage: 'the model has no vision input',
  marks: [],
  missing: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  modelUsed: '',
};

beforeEach(() => {
  benchMock.mockReset().mockResolvedValue([OK_MAP, FAILED_MAP]);
  toastErrorMock.mockReset();
});

describe('lab shell', () => {
  it('lists the bench with the cost note on the run button and no results yet', () => {
    render(<LabPage />);

    expect(screen.getByTestId('lab-page')).toBeInTheDocument();
    expect(screen.getByTestId('lab-experiment-labeled-dungeon-maps')).toBeInTheDocument();
    const runButton = screen.getByTestId('lab-run');
    expect(runButton).toHaveTextContent('Run labeled-dungeon bench');
    expect(runButton).toHaveTextContent('generates 4 images + 4 vision passes');
    expect(screen.queryByTestId('lab-map-0')).not.toBeInTheDocument();
    expect(benchMock).not.toHaveBeenCalled();
  });

  it('runs the bench and renders original vs annotated plus the per-letter table', async () => {
    const user = userEvent.setup();
    render(<LabPage />);

    await user.click(screen.getByTestId('lab-run'));

    // (The busy indicator itself is pinned by the deferred-runner test
    // below — the immediate mock settles before it could be observed here.)

    // The found letter draws a disk; the missing one draws nothing.
    expect(await screen.findByTestId('lab-disk-0-A')).toBeInTheDocument();
    expect(screen.queryByTestId('lab-disk-0-B')).not.toBeInTheDocument();

    // Side-by-side original vs annotated images.
    const originals = screen.getAllByAltText('Generated dungeon map 1');
    expect(originals).toHaveLength(1);
    expect(screen.getByAltText('Annotated dungeon map 1')).toBeInTheDocument();

    // Per-letter rows: found vs loud not-found (never an invented coordinate).
    expect(screen.getByTestId('lab-row-0-A')).toHaveTextContent('found');
    expect(screen.getByTestId('lab-row-0-A')).toHaveTextContent('on the wreck deck');
    expect(screen.getByTestId('lab-row-0-B')).toHaveTextContent('not found');

    // The failed map names its failure loudly and draws no disks.
    const failed = screen.getByTestId('lab-map-1');
    expect(failed).toHaveTextContent('the model has no vision input');
    expect(screen.queryByTestId('lab-disk-1-A')).not.toBeInTheDocument();
    expect(screen.getByTestId('lab-row-1-A')).toHaveTextContent('not found');
  });

  it('refuses a second click while running loudly and never queues', async () => {
    const user = userEvent.setup();
    let release!: (maps: LabeledDungeonMapResult[]) => void;
    benchMock.mockImplementation(
      () =>
        new Promise<LabeledDungeonMapResult[]>((resolve) => {
          release = resolve;
        }),
    );
    render(<LabPage />);

    await user.click(screen.getByTestId('lab-run'));
    expect(await screen.findByTestId('lab-running')).toBeInTheDocument();
    await user.click(screen.getByTestId('lab-run'));

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0]?.[0]).toMatch(/already running/);
    expect(benchMock).toHaveBeenCalledTimes(1);

    release([OK_MAP]);
    await waitFor(() => {
      expect(screen.queryByTestId('lab-running')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('lab-map-0')).toBeInTheDocument();
  });
});
