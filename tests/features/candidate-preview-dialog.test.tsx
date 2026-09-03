import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CandidatePreviewDialog } from '@/features/images/candidate-preview-dialog';
import type { EncounterLayout, Id } from '@/domain';

vi.mock('@/features/images/use-image-url', () => ({
  useImageUrl: vi.fn((id: string) => `blob:mock-image-${id}`),
}));

const SAMPLE_LAYOUT: EncounterLayout = {
  gridW: 24,
  gridH: 18,
  theme: 'dungeon',
  rooms: [
    {
      id: 'd9b2d6b3-6c82-4115-8495-23c28a8d1111',
      name: 'Grand Hall',
      description: 'A vaulted chamber.',
      rects: [{ x: 2, y: 2, w: 10, h: 8 }],
      mobsRect: { x: 4, y: 4, w: 6, h: 4 },
      monsterIndexes: [0],
      spawn: true,
      stagingPoint: { x: 0.25, y: 0.3 },
      markerHue: 120,
      letter: 'A',
    },
  ],
  corridors: [],
};

describe('CandidatePreviewDialog', () => {
  it('renders large preview for the active candidate and navigates between candidates', async () => {
    const user = userEvent.setup();
    const candidates: Id[] = ['img-1', 'img-2', 'img-3'];
    const onClose = vi.fn();
    const onSelectCandidate = vi.fn();

    render(
      <CandidatePreviewDialog
        candidates={candidates}
        currentId="img-1"
        onClose={onClose}
        onSelectCandidate={onSelectCandidate}
        isSelected={(id) => id === 'img-2'}
        title="Candidate inspection"
      />
    );

    const dialog = screen.getByTestId('candidate-preview-dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Candidate inspection')).toBeInTheDocument();
    expect(screen.getAllByText(/Candidate 1 of 3/).length).toBeGreaterThanOrEqual(1);

    // Previous is disabled on first candidate, next is enabled
    const prevBtn = screen.getByTestId('preview-prev-btn');
    const nextBtn = screen.getByTestId('preview-next-btn');
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeEnabled();

    // Click next
    await user.click(nextBtn);
    expect(screen.getAllByText(/Candidate 2 of 3/).length).toBeGreaterThanOrEqual(1);
    expect(prevBtn).toBeEnabled();

    // img-2 is selected
    const selectBtn = screen.getByTestId('preview-select-btn');
    expect(selectBtn).toHaveTextContent('Selected');

    // Click select to toggle
    await user.click(selectBtn);
    expect(onSelectCandidate).toHaveBeenCalledWith('img-2');

    // Click prev to navigate back
    await user.click(prevBtn);
    expect(screen.getAllByText(/Candidate 1 of 3/).length).toBeGreaterThanOrEqual(1);

    // Close button
    const closeBtn = screen.getByTestId('preview-close-btn');
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('renders room overlay toggle when layout is provided', async () => {
    const user = userEvent.setup();
    const candidates: Id[] = ['map-1'];
    const onClose = vi.fn();

    render(
      <CandidatePreviewDialog
        candidates={candidates}
        currentId="map-1"
        onClose={onClose}
        layout={SAMPLE_LAYOUT}
        title="Battlemap preview"
      />
    );

    expect(screen.getByTestId('encounter-layout-preview')).toBeInTheDocument();
    expect(screen.getByText('Grand Hall')).toBeInTheDocument();

    // Toggle overlay off
    const toggleBtn = screen.getByTestId('toggle-room-overlay');
    expect(toggleBtn).toHaveTextContent('Hide overlay');

    await user.click(toggleBtn);
    expect(toggleBtn).toHaveTextContent('Show overlay');
    expect(screen.queryByTestId('encounter-layout-preview')).not.toBeInTheDocument();
  });
});
