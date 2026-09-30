import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { battleSchema, newId } from '@/domain';
import {
  BATTLE_ZOOM_MAX,
  BATTLE_ZOOM_MIN,
  DEFAULT_BATTLE_VIEW,
  SAFE_FALLBACK_BATTLE_VIEW,
  resolveBattleView,
} from '@/domain/battle/view';

/**
 * THE ONE READER of the stored battle view (docs/17 row 262b, docs/18 §2.3).
 *
 * The RESTORE path is the security-relevant half of this slice: an iOS tab
 * discard or a reload must never put the GM's stat blocks back in front of the
 * players. These pin the two named fallbacks and — the load-bearing part — that
 * a CORRUPT stored view does not take the battle row down with it. The row
 * keeps the field lenient (`view: z.unknown()`), so `battleSchema.parse` still
 * succeeds and `resolveBattleView` is the single place that decides to fail
 * safe (player-safe) and loud (the caller's toast).
 */

const VALID = {
  playerSafe: true,
  zoom: 1.5,
  pan: { x: -40, y: 12 },
  selectedTokenId: newId(),
  selectedVeilId: null,
  selectedEffectId: null,
  selectedKeyRoomId: 'room-1',
};

function battleRow(view: unknown): unknown {
  return {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    campaignId: newId(),
    moduleId: newId(),
    encounterArtifactId: null,
    board: {},
    view,
  };
}

describe('resolveBattleView', () => {
  it('restores the NAMED default for an absent view (no error, no toast)', () => {
    for (const absent of [null, undefined]) {
      const resolved = resolveBattleView(absent);
      expect(resolved.view).toEqual(DEFAULT_BATTLE_VIEW);
      expect(resolved.fallback).toBe('absent');
      expect(resolved.problem).toBeNull();
    }
    // A fresh board is GM view — the pre-262b behaviour, now one named value.
    expect(DEFAULT_BATTLE_VIEW.playerSafe).toBe(false);
  });

  it('round-trips every persisted field of a valid view', () => {
    const resolved = resolveBattleView(VALID);
    expect(resolved.fallback).toBeNull();
    expect(resolved.problem).toBeNull();
    expect(resolved.view).toEqual(VALID);
  });

  it('fails SAFE (player-safe) and LOUD (a reason) on a corrupt view', () => {
    const corrupt: unknown[] = [
      { playerSafe: 'yes', zoom: 1 },
      { ...VALID, zoom: BATTLE_ZOOM_MAX + 1 },
      { ...VALID, zoom: BATTLE_ZOOM_MIN - 1 },
      { ...VALID, pan: { x: Number.POSITIVE_INFINITY, y: 0 } },
      { ...VALID, selectedTokenId: 'not-a-uuid' },
      'nonsense',
      42,
    ];
    for (const stored of corrupt) {
      const resolved = resolveBattleView(stored);
      expect(resolved.fallback).toBe('corrupt');
      expect(resolved.view).toEqual(SAFE_FALLBACK_BATTLE_VIEW);
      expect(resolved.view.playerSafe).toBe(true);
      expect(resolved.problem).toBeInstanceOf(ZodError);
    }
    // The two fallbacks are deliberately DIFFERENT: collapsing them would be
    // the silent GM reset this slice exists to prevent.
    expect(SAFE_FALLBACK_BATTLE_VIEW).not.toEqual(DEFAULT_BATTLE_VIEW);
  });

  it('keeps the battle row alive around a corrupt view — the row boundary is lenient BY DESIGN', () => {
    const parsed = battleSchema.safeParse(battleRow({ playerSafe: 'yes', zoom: 'wide' }));
    // The row parses: a corrupt PREFERENCE must never cost the GM the board.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // …and the value arrives at the ONE reader unchanged, for it to judge.
    expect(parsed.data.view).toEqual({ playerSafe: 'yes', zoom: 'wide' });
    expect(resolveBattleView(parsed.data.view).fallback).toBe('corrupt');
    // An absent field materializes as null (the named-default case).
    expect(battleSchema.parse(battleRow(undefined)).view).toBeNull();
  });
});
