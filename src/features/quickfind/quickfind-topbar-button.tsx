import type { JSX } from 'react';
import { useLocation } from 'react-router-dom';
import { SearchIcon } from 'lucide-react';

import { campaignIdFromPath } from '@/app/routes';
import { Button } from '@/components/ui/button';
import { useQuickFindStore } from '@/features/quickfind/quickfindStore';

/** Cosmetic shortcut hint; Apple platforms (iPadOS reports a Mac UA) use ⌘. */
function shortcutHint(): string {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

/**
 * Top-bar entry into quick find (05-UI.md §Top bar): the Ctrl/Cmd+K palette
 * had no touch path — an on-screen keyboard has no Cmd key — so the same
 * dialog is reachable by tap wherever a campaign is open. Renders nothing
 * outside campaign routes, mirroring the hotkey's own gating
 * (quickfind-hotkey.tsx).
 */
export function QuickFindTopBarButton(): JSX.Element | null {
  const { pathname } = useLocation();
  const openQuickFind = useQuickFindStore((state) => state.openQuickFind);
  if (campaignIdFromPath(pathname) === undefined) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Quick find"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={openQuickFind}
      data-testid="quick-find-button"
    >
      <SearchIcon aria-hidden data-icon="inline-start" />
      Find
      <kbd className="ml-1 hidden rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground lg:inline">
        {shortcutHint()}
      </kbd>
    </Button>
  );
}
