import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_UI_SCALE,
  UI_SCALES,
  UI_SCALE_STORAGE_KEY,
  useUiScaleStore,
} from '@/app/theme/uiScale';
import { deleteAllData } from '@/db/maintenance';

/**
 * UI-scale store (05-UI.md §Settings Appearance card): localStorage
 * persistence via `zodPersistStorage` (valid/invalid/missing → default),
 * and the key surviving Delete-all-data like the theme (maintenance.ts
 * PRESERVED_KEYS — device display preference, never in the data DB).
 */

/** A well-formed zustand-persist envelope around a (possibly bogus) scale. */
function envelope(uiScale: unknown): string {
  return JSON.stringify({ state: { uiScale }, version: 0 });
}

beforeEach(() => {
  localStorage.clear();
  useUiScaleStore.setState({ uiScale: DEFAULT_UI_SCALE });
});

describe('uiScale store', () => {
  it('defaults to 100% with no stored value', () => {
    expect(useUiScaleStore.getState().uiScale).toBe(1);
  });

  it('falls back to 100% when the stored key is missing at rehydrate', async () => {
    localStorage.removeItem(UI_SCALE_STORAGE_KEY);
    await useUiScaleStore.persist.rehydrate();
    expect(useUiScaleStore.getState().uiScale).toBe(1);
  });

  it('rehydrates a stored valid factor', async () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, envelope(1.25));
    await useUiScaleStore.persist.rehydrate();
    expect(useUiScaleStore.getState().uiScale).toBe(1.25);
  });

  it('falls back to 100% on an invalid factor and drops the stored row', async () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, envelope(1.3));
    await useUiScaleStore.persist.rehydrate();
    expect(useUiScaleStore.getState().uiScale).toBe(1);
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull();
  });

  it('falls back to 100% on unparseable JSON', async () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '{not json');
    await useUiScaleStore.persist.rehydrate();
    expect(useUiScaleStore.getState().uiScale).toBe(1);
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull();
  });

  it('persists a change under the app key with the chosen factor', () => {
    useUiScaleStore.getState().setUiScale(0.9);
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null) throw new Error('setUiScale did not persist');
    expect(JSON.parse(raw)).toMatchObject({ state: { uiScale: 0.9 }, version: 0 });
  });

  it('declares exactly the four spec steps', () => {
    expect([...UI_SCALES]).toEqual([0.9, 1, 1.1, 1.25]);
  });

  it('survives Delete-all-data next to the theme (PRESERVED_KEYS)', async () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, envelope(1.1));
    localStorage.setItem('campaigner.transient', 'gone');
    await deleteAllData();
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem('campaigner.transient')).toBeNull();
  });
});
