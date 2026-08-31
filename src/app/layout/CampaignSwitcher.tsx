import type { JSX } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, CheckIcon } from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';

import { ROUTES, workspacePath } from '@/app/routes';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { campaignRepo } from '@/db';
import { cn } from '@/lib/utils';

/**
 * Top-bar campaign switcher (05-UI.md §Top bar): lists every campaign live
 * (Dexie observable — new campaigns appear without a reload), shows the
 * current campaign in the trigger, and opens a campaign's workspace on
 * selection.
 */
export function CampaignSwitcher(): JSX.Element {
  const campaigns = useLiveQuery(() => campaignRepo.listCampaigns(), []);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // The top bar renders outside the routed page, so useParams() cannot see
  // :campaignId — match the URL against the workspace/artifact patterns.
  const match = matchPath(ROUTES.artifact, pathname) ?? matchPath(ROUTES.workspace, pathname);
  const currentId = match?.params.campaignId;
  const current = campaigns?.find((campaign) => campaign.id === currentId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'w-44 justify-between gap-2 font-normal',
        )}
        aria-label="Switch campaign"
      >
        <span className="truncate" data-testid="current-campaign">
          {current === undefined ? 'No campaign' : current.name}
        </span>
        <ChevronDown aria-hidden className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {campaigns === undefined ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : campaigns.length === 0 ? (
          <DropdownMenuItem disabled>No campaigns yet</DropdownMenuItem>
        ) : (
          campaigns.map((campaign) => (
            <DropdownMenuItem
              key={campaign.id}
              onClick={() => {
                navigate(workspacePath(campaign.id));
              }}
            >
              <CheckIcon
                aria-hidden
                className={cn(
                  'size-3.5 shrink-0',
                  campaign.id === currentId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="truncate">{campaign.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
