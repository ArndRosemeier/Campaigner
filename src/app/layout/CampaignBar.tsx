import type { JSX } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { ROUTES, campaignIdFromPath, documentPath } from '@/app/routes';
import { campaignTabs } from '@/app/layout/nav';
import { buttonVariants } from '@/components/ui/button';
import { getModule } from '@/db/moduleRepo';
import { LegacyModulesNotice } from '@/features/modules/legacy-modules-notice';
import { cn } from '@/lib/utils';

/**
 * Campaign bar (05-UI.md §Top bar): the campaign-level tabs — Document /
 * Workspace / Graph / Spells, Document first (the central view — the
 * campaign's ONE document, docs/17 row 389) —
 * rendered on every route directly below the top bar so the app's structure
 * stays visible. Tabs are disabled (with a hint) while no campaign is open
 * instead of hidden.
 *
 * The right side carries the breadcrumb for nested screens (a module in the
 * reader, the battle table), so deep screens always show where you are and
 * the way back is one visible click.
 *
 * Below the tabs sits the legacy multi-module notice (ONE mount for every
 * campaign route): a database that still carries more than one module row is
 * surfaced LOUDLY and its extra rows stay reachable, never silently hidden.
 */
export function CampaignBar(): JSX.Element {
  const { pathname } = useLocation();
  const campaignId = campaignIdFromPath(pathname);
  const tabs = campaignTabs(campaignId);

  return (
    <>
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b bg-background px-4"
        data-testid="campaign-bar"
      >
      <nav aria-label="Campaign" className="flex items-center gap-1">
        {tabs.map((tab) =>
          tab.disabled ? (
            <button
              key={tab.label}
              type="button"
              disabled
              title="Open a campaign first"
              aria-label={`${tab.label} — open a campaign first`}
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'opacity-50')}
            >
              {tab.label}
            </button>
          ) : (
            <NavLink
              key={tab.label}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  isActive && 'bg-accent text-accent-foreground',
                )
              }
            >
              {tab.label}
            </NavLink>
          ),
        )}
      </nav>
      <Breadcrumb pathname={pathname} />
      </div>
      {/* THE ONE legacy multi-module mount (docs/17 row 389) — every
          campaign route, so extra rows are never silently hidden. */}
      <LegacyModulesNotice />
    </>
  );
}

/** The "you are here" trail for screens nested under a tab. */
function Breadcrumb({ pathname }: { pathname: string }): JSX.Element | null {
  const campaignId = campaignIdFromPath(pathname);
  const moduleMatch = matchPath(ROUTES.module, pathname) ?? matchPath(ROUTES.battle, pathname);
  const moduleId = moduleMatch?.params.moduleId;
  const onBattle = matchPath(ROUTES.battle, pathname) !== null;
  const module = useLiveQuery(
    async () => (moduleId === undefined ? undefined : getModule(moduleId)),
    [moduleId],
  );

  if (campaignId === undefined || moduleId === undefined) return null;

  return (
    <div
      className="ml-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      data-testid="campaign-crumb"
    >
      <Link
        to={ROUTES.campaignPicker}
        className="shrink-0 hover:text-foreground hover:underline"
      >
        Campaigns
      </Link>
      <span aria-hidden>/</span>
      <Link
        to={documentPath(campaignId)}
        className="shrink-0 hover:text-foreground hover:underline"
      >
        Document
      </Link>
      <span aria-hidden>/</span>
      <span className="min-w-0 truncate" data-testid="crumb-module">
        {module === undefined ? '…' : module.title}
      </span>
      {onBattle && (
        <>
          <span aria-hidden>/</span>
          <span className="shrink-0">Battle table</span>
        </>
      )}
    </div>
  );
}
