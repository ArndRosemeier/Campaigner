import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EncounterLayoutPreview } from '@/features/campaign/components/encounter-layout-preview';
import type { EncounterLayout } from '@/domain';

const ENTRY_ROOM: EncounterLayout['rooms'][number] = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Entry',
  rects: [{ x: 1, y: 1, w: 6, h: 6 }],
  mobsRect: { x: 2, y: 2, w: 4, h: 4 },
  description: '',
  monsterIndexes: [],
  spawn: true,
  key: '',
  keyTreasure: '',
  entrance: {
    x: 1,
    y: 1,
    side: 'north',
  },
};

const LAYOUT: EncounterLayout = {
  gridW: 12,
  gridH: 12,
  theme: 'test',
  rooms: [ENTRY_ROOM],
  corridors: [],
};

describe('encounter layout preview (entrance overlay)', () => {
  it('renders the entrance marker on its cell (no detection ghost exists — marker path deleted)', () => {
    const { getByTestId, queryByTestId } = render(<EncounterLayoutPreview layout={LAYOUT} />);
    const marker = getByTestId('encounter-entrance-marker');
    // Centered on the entrance cell (1,1) of a 12×12 grid.
    expect(marker.style.left).toBe('12.5%');
    expect(marker.style.top).toBe('12.5%');
    // North side opens outward, so the glyph points south — rotation 0.
    expect(marker.style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    expect(queryByTestId('encounter-entrance-observed')).toBeNull();
  });

  it('rotates the glyph per side', () => {
    const rotated: EncounterLayout = {
      ...LAYOUT,
      rooms: [
        {
          ...ENTRY_ROOM,
          entrance: { x: 1, y: 1, side: 'west' },
        },
      ],
    };
    const { getByTestId } = render(<EncounterLayoutPreview layout={rotated} />);
    // West opens outward, inward is east — a down-pointing glyph rotated 270°.
    expect(getByTestId('encounter-entrance-marker').style.transform).toBe(
      'translate(-50%, -50%) rotate(270deg)',
    );
  });
});
