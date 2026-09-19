import type { JSX } from 'react';

import {
  useBuildStatus,
  type BuildStatusRead,
  type BuildStatusState,
} from '@/app/layout/build-status';
import { Badge } from '@/components/ui/badge';

/**
 * The build-status badge beside the app title (docs/17 row 250, docs/18 §2):
 * the owner's "WIP, right after the Campaigner Title" for rapid testing. A push
 * to `main` deploys immediately, and the FULL suite follows the push rather than
 * blocking it (AGENTS §Workflow), so a build the app is serving can be
 * compile-clean and NOT yet suite-verified. This badge names that state where he
 * is looking.
 *
 * It renders exactly the three honest states the payload can carry, and nothing
 * while a status file is still being read: `verified` (the FULL gate is GREEN at
 * this tree), `WIP` (compiles, unverified) and `cannot tell` (the state could
 * not be established — no file, no network, a malformed payload, an unknown
 * commit). A failure NEVER degrades to `verified`; the badge is the visible
 * surface for it (`build-status.ts` owns the read and its validation).
 */
const STATE_LABELS: Record<BuildStatusState, string> = {
  verified: 'verified',
  wip: 'WIP',
  'cannot-tell': 'cannot tell',
};

const STATE_CLASSES: Record<BuildStatusState, string> = {
  verified: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  wip: 'border-amber-500/60 bg-amber-500/15 font-semibold text-amber-800 dark:text-amber-200',
  'cannot-tell': 'border-neutral-500/50 bg-neutral-500/10 text-neutral-700 dark:text-neutral-300',
};

export interface BuildStatusBadgeProps {
  /**
   * The status read to use. The APP never passes one: `TopBar` renders the
   * badge with the default read (the deploy job's file on this origin). It is
   * injectable so a test can drive the REAL read + validation chain — the same
   * `readBuildStatus` the production default calls — without pretending that a
   * dev or test bundle has a status file.
   */
  readonly readStatus?: BuildStatusRead | undefined;
}

export function BuildStatusBadge({ readStatus }: BuildStatusBadgeProps = {}): JSX.Element | null {
  const status = useBuildStatus(readStatus);
  if (status === null) return null;
  return (
    <Badge
      variant="outline"
      data-testid="build-status-badge"
      data-state={status.state}
      title={status.detail}
      className={STATE_CLASSES[status.state]}
    >
      {STATE_LABELS[status.state]}
    </Badge>
  );
}
