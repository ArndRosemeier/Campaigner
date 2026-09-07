import { useLayoutEffect } from 'react';
import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { zodPersistStorage } from '@/lib/persisted';

/**
 * App-wide UI scale (05-UI.md §Settings Appearance card): multiplies the root
 * font-size through the `--ui-scale` CSS var (index.css), so every rem-based
 * surface — Tailwind v4's default scale, shadcn on rem — scales together.
 * Deliberately NOT CSS zoom: zoom breaks the px-measured battle board, dice
 * stage and PDF viewer (docs/18 §2.3). Device display preference — persisted
 * in localStorage next to the theme (theme precedent), never in the data DB.
 */
export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;

export type UiScale = (typeof UI_SCALES)[number];

/** Spec default — do not change without updating 05-UI.md. */
export const DEFAULT_UI_SCALE: UiScale = 1;

/** The single localStorage key the UI scale is persisted under. */
export const UI_SCALE_STORAGE_KEY = 'campaigner.uiScale';

const persistedSchema = z.object({ uiScale: z.literal([...UI_SCALES]) });

type UiScalePersisted = z.infer<typeof persistedSchema>;

interface UiScaleState {
  uiScale: UiScale;
  setUiScale: (scale: UiScale) => void;
}

export const useUiScaleStore = create<UiScaleState>()(
  persist(
    (set) => ({
      uiScale: DEFAULT_UI_SCALE,
      setUiScale: (uiScale) => set({ uiScale }),
    }),
    {
      name: UI_SCALE_STORAGE_KEY,
      storage: zodPersistStorage(persistedSchema),
      partialize: (state): UiScalePersisted => ({ uiScale: state.uiScale }),
    },
  ),
);

/**
 * Applies a UI scale to the document root. The only function in the app that
 * touches the DOM for scaling; index.css multiplies the root font-size by it.
 */
export function applyUiScale(scale: UiScale): void {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

/**
 * Keeps the document root in sync with the UI-scale store. Mounted exactly
 * once, in `AppShell` right after `useThemeSync`, so every route respects the
 * stored scale.
 */
export function useUiScaleSync(): void {
  const uiScale = useUiScaleStore((state) => state.uiScale);
  useLayoutEffect(() => {
    applyUiScale(uiScale);
  }, [uiScale]);
}
