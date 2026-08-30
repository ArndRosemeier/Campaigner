import type { JSX } from 'react';
import { ChevronDown } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Top-bar campaign switcher (05-UI.md §Top bar).
 *
 * Placeholder: there is no campaign store yet (that arrives with the domain +
 * DB layer in T2 and the picker in T3). The dropdown shell is already in place
 * so the top bar matches the spec from day one.
 */
export function CampaignSwitcher(): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'w-44 justify-between gap-2 font-normal',
        )}
      >
        <span className="truncate">No campaign</span>
        <ChevronDown aria-hidden className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem disabled>No campaigns yet</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
