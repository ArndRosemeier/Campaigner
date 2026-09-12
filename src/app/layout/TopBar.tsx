import type { JSX } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRightIcon } from 'lucide-react';

import { CampaignSwitcher } from '@/app/layout/CampaignSwitcher';
import { appNavItems } from '@/app/layout/nav';
import { ThemeToggle } from '@/app/layout/ThemeToggle';
import { ROUTES, campaignIdFromPath, modulePath } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { HelpButton } from '@/help/HelpButton';
import { LanguageSelect } from '@/features/settings/language-select';
import { TopBarNewModuleButton } from '@/features/modules/top-bar-new-module';
import { QuickFindTopBarButton } from '@/features/quickfind/quickfind-topbar-button';
import { readSettings } from '@/db/settingsRepo';
import { cn } from '@/lib/utils';

/**
 * Top bar shown on all routes: app name, campaign switcher, the app-level
 * nav (Rules / Settings / last-module shortcut) and the theme toggle
 * (05-UI.md §Top bar). The campaign-level sections (Modules / Workspace /
 * Graph) live in the campaign bar rendered below this bar.
 *
 * The last-module shortcut sits next to Settings: an arrow + the last module
 * opened in a reader, one click back to the table-prep view. Hidden until a
 * reader has been opened (settings.lastModule === null) — a genuine
 * absence, not a failure.
 */
export function TopBar(): JSX.Element {
  const { pathname } = useLocation();
  const items = appNavItems();
  // Pure read (no default-row write) for the liveQuery; lastModule is
  // undefined while the row loads — the entry simply appears a tick later.
  const settings = useLiveQuery(() => readSettings(), []);
  const lastModule = settings?.lastModule ?? null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <NavLink
        to={ROUTES.campaignPicker}
        className="font-heading text-base font-semibold tracking-tight"
      >
        Campaigner
      </NavLink>

      <CampaignSwitcher />

      <nav aria-label="Primary" className="ml-2 flex items-center gap-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
        {lastModule !== null && (
          <NavLink
            to={modulePath(lastModule.campaignId, lastModule.moduleId)}
            data-testid="topbar-last-module"
            title={lastModule.name}
            className={({ isActive }) =>
              cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'max-w-52',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <ArrowRightIcon aria-hidden data-icon="inline-start" className="shrink-0" />
            <span className="min-w-0 truncate">{lastModule.name}</span>
          </NavLink>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-1">
        <QuickFindTopBarButton />
        {/* Generation language (default English) — choosable on the main
            page's top bar and persisted in the settings row. */}
        <LanguageSelect compact />
        {campaignIdFromPath(pathname) !== undefined && (
          <TopBarNewModuleButton campaignId={campaignIdFromPath(pathname) ?? ''} />
        )}
        <HelpButton label="Campaigner" />
        <ThemeToggle />
      </div>
    </header>
  );
}
