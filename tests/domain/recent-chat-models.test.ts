import { describe, expect, it } from 'vitest';

import {
  RECENT_CHAT_MODELS_CAP,
  defaultSettings,
  settingsSchema,
  withRecentChatModel,
} from '@/domain';

/**
 * THE recents ordering rule (docs/17 row 193): dedup + move-to-front + cap, in
 * ONE pure domain function shared by the top-bar picker and the run engine's
 * recording. A second ordering anywhere is the drift this pins.
 */
describe('withRecentChatModel — the ONE recents ordering rule (docs/17 row 193)', () => {
  it('builds most-recent-first as A then B then C are used', () => {
    const afterA = withRecentChatModel([], 'a');
    const afterB = withRecentChatModel(afterA, 'b');
    const afterC = withRecentChatModel(afterB, 'c');
    expect(afterC).toEqual(['c', 'b', 'a']);
  });

  it('re-using A moves it to the front exactly once (no duplicate anywhere)', () => {
    const next = withRecentChatModel(['c', 'b', 'a'], 'a');
    expect(next).toEqual(['a', 'c', 'b']);
    expect(next.filter((model) => model === 'a')).toHaveLength(1);
  });

  it('caps at RECENT_CHAT_MODELS_CAP by dropping the OLDEST entry', () => {
    const full = Array.from({ length: RECENT_CHAT_MODELS_CAP }, (_, i) => `m${String(i)}`);
    const next = withRecentChatModel(full, 'fresh');
    expect(next).toEqual(['fresh', ...full.slice(0, RECENT_CHAT_MODELS_CAP - 1)]);
    expect(next).toHaveLength(RECENT_CHAT_MODELS_CAP);
    expect(next).not.toContain(`m${String(RECENT_CHAT_MODELS_CAP - 1)}`);
  });

  it('is pure — the caller’s array is never mutated', () => {
    const original = ['b', 'a'];
    expect(withRecentChatModel(original, 'c')).toEqual(['c', 'b', 'a']);
    expect(original).toEqual(['b', 'a']);
  });

  it('ignores an empty or whitespace-only model', () => {
    expect(withRecentChatModel(['a'], '')).toEqual(['a']);
    expect(withRecentChatModel(['a'], '   ')).toEqual(['a']);
  });
});

describe('the settings row field (docs/17 row 193)', () => {
  it('a fresh row carries an empty recents list', () => {
    expect(defaultSettings().recentChatModels).toEqual([]);
  });

  it('a stored row written before the field parses as [] (no migration)', () => {
    const { recentChatModels: _drop, ...legacy } = defaultSettings();
    expect(settingsSchema.parse(legacy).recentChatModels).toEqual([]);
  });
});
