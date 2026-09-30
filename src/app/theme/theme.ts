import { useLayoutEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * App-wide color theme (05-UI.md): dark mode is the default ("GM-at-the-table
 * friendly"), with a light mode toggle in the top bar.
 */
export type Theme = 'light' | 'dark';

/** Spec default — do not change without updating 05-UI.md. */
export const DEFAULT_THEME: Theme = 'dark';

/** The single localStorage key the theme is persisted under. */
export const THEME_STORAGE_KEY = 'campaigner.theme';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: DEFAULT_THEME,
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
    }),
    { name: THEME_STORAGE_KEY },
  ),
);

/**
 * Applies a theme to the document root. The only function in the app that
 * touches the DOM for theming; Tailwind's `.dark` variant keys off this class
 * (see `@custom-variant dark` in index.css).
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/**
 * Keeps the document root in sync with the theme store. Mounted exactly once,
 * in `AppShell`, so every route respects the stored theme.
 */
export function useThemeSync(): void {
  const theme = useThemeStore((state) => state.theme);
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
}
