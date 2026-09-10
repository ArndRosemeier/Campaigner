import { describe, expect, it } from 'vitest';

import {
  findDraftMatches,
  replaceAllDraftMatches,
  replaceDraftMatch,
} from '@/features/modules/textMatches';

/**
 * Part text editor pure helpers (08-MODULE-DESIGNER M4-A): string-offset
 * find with ReaderSearch loop parity (non-overlapping, case-folded unless
 * case-sensitive) plus single/all replacement.
 */

describe('findDraftMatches', () => {
  it('returns no matches for an empty needle (never a whole-draft wipe)', () => {
    expect(findDraftMatches('some draft', '', false)).toEqual([]);
  });

  it('finds case-insensitive matches with string offsets', () => {
    const matches = findDraftMatches('The lantern burns. LANTERN light.', 'lantern', false);
    expect(matches).toEqual([
      { start: 4, end: 11 },
      { start: 19, end: 26 },
    ]);
  });

  it('narrows to exact case when case-sensitive', () => {
    const matches = findDraftMatches('The lantern burns. LANTERN light.', 'lantern', true);
    expect(matches).toEqual([{ start: 4, end: 11 }]);
  });

  it('does not overlap matches (ReaderSearch indexOf-loop parity)', () => {
    expect(findDraftMatches('aaa', 'aa', false)).toEqual([{ start: 0, end: 2 }]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(findDraftMatches('quiet draft', 'lantern', false)).toEqual([]);
  });
});

describe('replaceDraftMatch', () => {
  it('splices the replacement over exactly one match', () => {
    expect(replaceDraftMatch('The lantern burns.', { start: 4, end: 11 }, 'lamp')).toBe(
      'The lamp burns.',
    );
  });
});

describe('replaceAllDraftMatches', () => {
  it('replaces every match back-to-front and reports the count', () => {
    const { text, count } = replaceAllDraftMatches(
      'lantern oil and LANTERN light',
      'lantern',
      'torch',
      false,
    );
    expect(text).toBe('torch oil and torch light');
    expect(count).toBe(2);
  });

  it('keeps later offsets valid when the replacement changes the length', () => {
    const { text, count } = replaceAllDraftMatches('aa aa', 'aa', 'aaa', false);
    expect(text).toBe('aaa aaa');
    expect(count).toBe(2);
  });

  it('is a no-op (count 0, same text) for an empty needle or no matches', () => {
    expect(replaceAllDraftMatches('some draft', '', 'x', false)).toEqual({
      text: 'some draft',
      count: 0,
    });
    expect(replaceAllDraftMatches('quiet draft', 'lantern', 'x', false)).toEqual({
      text: 'quiet draft',
      count: 0,
    });
  });
});
