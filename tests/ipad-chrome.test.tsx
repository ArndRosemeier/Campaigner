import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/layout/AppShell';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ProgressDock } from '@/features/progress/progress-dock';
import { useProgressStore } from '@/lib/progress';

/**
 * iPad batch F — PWA chrome + bottom safe-area (05-UI.md §Tablet):
 * - the AppShell frame pads all four safe-area insets (bottom included, so
 *   content clears the home indicator when the progress dock is empty);
 * - the ProgressDock and the Toaster keep their own bottom offsets exactly
 *   once (fixed layers ignore the frame pad — no double-padding);
 * - dialog content clamps to the dynamic viewport height so short-landscape
 *   dialogs scroll instead of clipping under the URL bar / keyboard.
 */

const mocks = vi.hoisted(() => ({
  chainGetState: vi.fn(() => ({ steps: [], currentIndex: 0, status: 'idle' })),
}));

vi.mock('@/llm/chainRunner', () => ({
  chainRunner: { getState: mocks.chainGetState, on: vi.fn(() => () => undefined), cancel: vi.fn() },
}));

function renderShell(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div data-testid="shell-child">child</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useProgressStore.getState().reset();
  mocks.chainGetState.mockReset().mockReturnValue({ steps: [], currentIndex: 0, status: 'idle' });
});

afterEach(cleanup);

describe('app shell safe-area frame', () => {
  it('pads all four safe-area insets, bottom exactly once', () => {
    renderShell();

    const shell = screen.getByTestId('app-shell');
    expect(shell.className).toContain('pt-[env(safe-area-inset-top)]');
    expect(shell.className).toContain('pl-[env(safe-area-inset-left)]');
    expect(shell.className).toContain('pr-[env(safe-area-inset-right)]');
    expect(shell.className).toContain('pb-[env(safe-area-inset-bottom)]');
    // No double-padding: the bottom inset appears exactly once on the frame.
    expect(shell.className.match(/safe-area-inset-bottom/g)).toHaveLength(1);
    expect(screen.getByTestId('shell-child')).toBeInTheDocument();
  });
});

describe('progress dock offset', () => {
  it('keeps its own single safe-area bottom offset', () => {
    useProgressStore.getState().start('job-1', 'Generating 2 npcs');

    render(<ProgressDock />);

    const dock = screen.getByTestId('progress-dock');
    expect(dock.className).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
    expect(dock.className.match(/safe-area-inset-bottom/g)).toHaveLength(1);
  });
});

describe('dialog viewport clamp', () => {
  it('constrains dialog content to the dynamic viewport height with scroll', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Clamped dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(content.className).toContain('overflow-y-auto');
  });
});
