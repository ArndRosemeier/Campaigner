import { describe, expect, it } from 'vitest';

import {
  buildNotation,
  countPercentileDice,
  dieDisplayName,
  formatTraySummary,
  parseStoredTray,
  percentileFaceTotal,
  sumRollTotal,
} from '@/features/dice/math';
import type { DiceTray, DieSides, TrayDie } from '@/features/dice/types';

function die(sides: DieSides, id = `die-${String(sides)}-${String(Math.random())}`): TrayDie {
  return { id, sides };
}

function tray(dice: TrayDie[], modifier = 0): DiceTray {
  return { dice, modifier };
}

describe('dieDisplayName', () => {
  it('names standard dice d4…d20 and the percentile die d%', () => {
    expect(dieDisplayName(4)).toBe('d4');
    expect(dieDisplayName(6)).toBe('d6');
    expect(dieDisplayName(8)).toBe('d8');
    expect(dieDisplayName(10)).toBe('d10');
    expect(dieDisplayName(12)).toBe('d12');
    expect(dieDisplayName(20)).toBe('d20');
    expect(dieDisplayName(100)).toBe('d%');
  });
});

describe('buildNotation', () => {
  it('groups multiples and orders by die size', () => {
    expect(buildNotation([die(6, 'a'), die(6, 'b'), die(4, 'c'), die(20, 'd')])).toEqual([
      '1d4',
      '2d6',
      '1d20',
    ]);
  });

  it('appends percentile dice in STANDARD_DICE order', () => {
    expect(buildNotation([die(100, 'p'), die(6, 'a'), die(100, 'q')])).toEqual(['1d6', '2d%']);
  });

  it('returns an empty notation for an empty tray', () => {
    expect(buildNotation([])).toEqual([]);
  });
});

describe('formatTraySummary', () => {
  it('joins dice groups with +', () => {
    expect(formatTraySummary(tray([die(6, 'a'), die(6, 'b'), die(20, 'c')]))).toBe('2d6+1d20');
  });

  it('appends a positive modifier explicitly', () => {
    expect(formatTraySummary(tray([die(6, 'a')], 3))).toBe('1d6+3');
    expect(formatTraySummary(tray([], 3))).toBe('+3');
  });

  it('appends a negative modifier with an explicit sign', () => {
    expect(formatTraySummary(tray([die(6, 'a')], -3))).toBe('1d6-3');
    expect(formatTraySummary(tray([], -2))).toBe('-2');
  });

  it('formats a zero modifier as dice only and an empty tray as empty string', () => {
    expect(formatTraySummary(tray([die(4, 'a')]))).toBe('1d4');
    expect(formatTraySummary(tray([]))).toBe('');
  });
});

describe('percentile handling', () => {
  it('counts percentile dice', () => {
    expect(countPercentileDice([die(100, 'a'), die(6, 'b'), die(100, 'c')])).toBe(2);
    expect(countPercentileDice([die(6, 'a')])).toBe(0);
  });

  it('fixes a percentile face of 0 up to 100', () => {
    expect(percentileFaceTotal(0)).toBe(100);
    expect(percentileFaceTotal(40)).toBe(40);
  });
});

describe('sumRollTotal', () => {
  it('sums dice plus the modifier', () => {
    expect(sumRollTotal([{ value: 4, sides: 6 }, { value: 2, sides: 6 }], 3, 0)).toBe(9);
  });

  it('applies negative modifiers', () => {
    expect(sumRollTotal([{ value: 4, sides: 6 }], -2, 0)).toBe(2);
  });

  it('fixes percentile zeros up to 100 and sums them with other dice', () => {
    expect(
      sumRollTotal(
        [
          { value: 0, sides: 100 },
          { value: 60, sides: 100 },
          { value: 5, sides: 6 },
        ],
        1,
        2,
      ),
    ).toBe(166);
  });

  it('accepts string sides from the engine response', () => {
    expect(sumRollTotal([{ value: 3, sides: 'd6' }], 0, 0)).toBe(3);
  });

  it('throws loudly when the engine returns a different percentile count than the tray had', () => {
    expect(() => sumRollTotal([{ value: 5, sides: 6 }], 0, 1)).toThrow(
      'Expected 1 percentile dice, got 0',
    );
    expect(() =>
      sumRollTotal([{ value: 0, sides: 100 }, { value: 0, sides: 100 }], 0, 1),
    ).toThrow('Expected 1 percentile dice, got 2');
  });

  it('throws loudly on a die sides value that is not a die size', () => {
    expect(() => sumRollTotal([{ value: 5, sides: 'banana' }], 0, 0)).toThrow(
      'Unknown die sides: banana',
    );
  });
});

describe('parseStoredTray', () => {
  it('round-trips a tray the picker would persist', () => {
    const stored = {
      dice: [
        { id: 'a', sides: 6 },
        { id: 'b', sides: 100 },
      ],
      modifier: 5,
    };
    expect(parseStoredTray(stored)).toEqual({
      dice: [
        { id: 'a', sides: 6 },
        { id: 'b', sides: 100 },
      ],
      modifier: 5,
    });
  });

  it('rejects corrupt or hostile storage shapes instead of serving them', () => {
    expect(parseStoredTray(null)).toBeNull();
    expect(parseStoredTray('2d6')).toBeNull();
    expect(parseStoredTray({ dice: 'nope', modifier: 1 })).toBeNull();
    expect(parseStoredTray({ dice: [{ id: 'a', sides: 7 }], modifier: 0 })).toBeNull();
    expect(parseStoredTray({ dice: [{ id: 'a', sides: 'd6' }], modifier: 0 })).toBeNull();
    expect(parseStoredTray({ dice: [{ id: 3, sides: 6 }], modifier: 0 })).toBeNull();
    expect(parseStoredTray({ dice: [], modifier: Number.NaN })).toBeNull();
    expect(parseStoredTray({ dice: [] })).toBeNull();
  });
});
