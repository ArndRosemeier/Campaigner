import type { JSX } from 'react';
import { Moon, Sun } from 'lucide-react';

import { useThemeStore } from '@/app/theme/theme';
import { Button } from '@/components/ui/button';

/**
 * Light/dark theme toggle for the top bar (05-UI.md). The theme itself lives
 * in `app/theme/theme.ts` — this component only reads and toggles the store;
 * applying it to the document is centralized in `useThemeSync`.
 */
export function ThemeToggle(): JSX.Element {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);

  const isDark = theme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
    >
      {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}
