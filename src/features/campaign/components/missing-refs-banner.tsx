import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { ROUTES, campaignIdFromPath } from '@/app/routes';
import { db } from '@/db/db';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';

/**
 * Missing-refs campaign banner (07-MILESTONE-3 M3-E slice B): a campaign
 * whose encounters cite rulebook chunks or NPC artifacts that are NOT in
 * this library (an import-anyway landing, a deleted book, a pruned NPC)
 * says so on every campaign route — above the routed page, below the
 * campaign bar — with the resolve path named. It derives from the SAME
 * `resolveMonsterEntry` contract the encounter rows render (`missing ref`),
 * so the banner and the badges can never disagree; it clears itself the
 * moment the content is installed (no persisted flag to go stale).
 */
export function MissingRefsBanner(): JSX.Element | null {
  const { pathname } = useLocation();
  const campaignId = campaignIdFromPath(pathname);
  const state = useLiveQuery(async () => {
    if (campaignId === undefined) return null;
    const encounters = await db.artifacts
      .where('campaignId')
      .equals(campaignId)
      .filter((artifact) => artifact.kind === 'encounter')
      .toArray();
    let dangling = 0;
    const names = new Set<string>();
    for (const artifact of encounters) {
      for (const entry of artifact.data.monsters) {
        // The banner contract IS the row contract: a `missing ref` origin
        // here is a `missing ref` badge on the encounter row.
        const resolved = await resolveMonsterEntryWithRepos(entry);
        if (resolved.origin === 'missing ref') {
          dangling += 1;
          names.add(artifact.name);
        }
      }
    }
    return dangling === 0 ? null : { dangling, encounters: names.size };
  }, [campaignId]);

  if (state === null || state === undefined) return null;
  return (
    <div
      className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      data-testid="missing-refs-banner"
      role="note"
    >
      {state.dangling === 1
        ? '1 encounter entry cites a stat block missing from this library — it shows \'missing ref\'.'
        : `${String(state.dangling)} encounter entries across ${String(state.encounters)} ${state.encounters === 1 ? 'encounter cite' : 'encounters cite'} stat blocks missing from this library — they show 'missing ref'.`}{' '}
      <Link to={ROUTES.rules} className="font-medium underline" data-testid="missing-refs-rules-link">
        Open Rules to install the pack or re-import the rulebook
      </Link>
      .
    </div>
  );
}
