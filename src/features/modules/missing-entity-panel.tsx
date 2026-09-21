import type { JSX } from 'react';
import { Link } from 'react-router-dom';

import { modulesPath } from '@/app/routes';
import { Button } from '@/components/ui/button';

/**
 * THE one panel a module-scoped page renders when the row it was opened for is
 * GONE (the campaign or the module no longer exists, docs/17 row 316). ONE
 * seam, every module page: the message is the only thing a caller supplies, and
 * "Back to modules" is the same destination everywhere.
 *
 * The three local copies this replaces (`MissingBoard`, `MissingCanvas`,
 * `MissingModule`) were byte-identical, differing in nothing but the function
 * name, and the duplicate-body tripwire carried them as group
 * `1996f7df8ca0ab87`. The body below is a MOVE, not a rewrite: pasting any one
 * of the deleted copies back beside this file reds the tripwire by naming that
 * hash again.
 */
export function MissingEntityPanel({ message, campaignId }: { message: string; campaignId: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" render={<Link to={modulesPath(campaignId)} />} nativeButton={false}>
        Back to modules
      </Button>
    </div>
  );
}
