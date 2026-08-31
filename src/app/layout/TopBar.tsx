import type { JSX } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { CampaignSwitcher } from '@/app/layout/CampaignSwitcher';
import { navItems } from '@/app/layout/nav';
import { ThemeToggle } from '@/app/layout/ThemeToggle';
import { ROUTES, campaignIdFromPath, playPath } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { HelpButton } from '@/help/HelpButton';
import { cn } from '@/lib/utils';

/**
 * Top bar shown on all routes: app name, campaign switcher, primary nav links
 * and the theme toggle, in spec order (05-UI.md §Top bar). The Workspace nav
 * link targets the open campaign's workspace (resolved from the URL — the top
 * bar renders outside the routed page, so useParams cannot see child params).
 */
export function TopBar(): JSX.Element {
  const { pathname } = useLocation();
  const items = navItems(campaignIdFromPath(pathname));

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
      </nav>

      <div className="ml-auto flex items-center gap-1">
        {campaignIdFromPath(pathname) !== undefined && (
          <NavLink
            to={playPath(campaignIdFromPath(pathname) ?? '')}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            aria-label="Play"
          >
            ▶ Play
          </NavLink>
        )}
        <HelpButton label="Campaigner" />
        <ThemeToggle />
      </div>
    </header>
  );
}
