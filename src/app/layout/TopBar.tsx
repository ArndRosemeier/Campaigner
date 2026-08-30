import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';

import { CampaignSwitcher } from '@/app/layout/CampaignSwitcher';
import { NAV_ITEMS } from '@/app/layout/nav';
import { ThemeToggle } from '@/app/layout/ThemeToggle';
import { ROUTES } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Top bar shown on all routes: app name, campaign switcher, primary nav links
 * and the theme toggle, in spec order (05-UI.md §Top bar).
 */
export function TopBar(): JSX.Element {
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
        {NAV_ITEMS.map((item) => (
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

      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
