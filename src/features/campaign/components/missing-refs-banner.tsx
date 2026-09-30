import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';

import { ROUTES, campaignIdFromPath } from '@/app/routes';
import { db } from '@/db/db';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { isMissingRefOrigin } from '@/domain/encounterResolve';
import {
  missingRefsSummary,
  type MissingRefStrand,
} from '@/features/campaign/components/missing-refs-summary';

/**
 * Missing-refs campaign banner (07-MILESTONE-3 M3-E slice B; WHAT it names is
 * docs/17 row 155): a campaign whose encounters cite rulebook chunks or NPC
 * artifacts that are NOT in this library (an import-anyway landing, a deleted
 * book, a pruned NPC) says so on every campaign route — above the routed page,
 * below the campaign bar — with the resolve path named. It derives from the
 * SAME `resolveMonsterEntry` contract the encounter rows render (`missing ref`),
 * so the banner and the badges can never disagree; it clears itself the moment
 * the content is installed (no persisted flag to go stale).
 *
 * It names WHAT is missing, not only how much: the creatures (the name the
 * `missing ref (<creature>)` badge already carries) and, when the citation
 * recorded one, the BOOK it came from — stamped at citation birth (docs/17 row
 * 155, docs/12 §8) — so "which of the many packs do I install?" has an answer.
 * A citation written before that stamp records no book, and the banner SAYS so
 * rather than inventing a pack from a creature's name (AGENTS rule 1). Nothing
 * is persisted and nothing is read from a stored gap list: both facts are
 * re-derived from the resolver on every render, so the banner still clears
 * itself the moment the pack is installed.
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
    const strands: MissingRefStrand[] = [];
    for (const artifact of encounters) {
      for (const entry of artifact.data.monsters) {
        // The banner contract IS the row contract: a `missing ref` origin
        // here is a `missing ref` badge on the encounter row.
        const resolved = await resolveMonsterEntryWithRepos(entry);
        if (!isMissingRefOrigin(resolved.origin)) continue;
        // Every strand is REPORTED, named or not: the structured reason is
        // what names it, and a resolution that produced none yields the honest
        // "names no creature" clause rather than a silently dropped count.
        strands.push({
          encounter: artifact.name,
          creature: resolved.missingRef?.creature ?? '',
          bookTitle: resolved.missingRef?.bookTitle,
        });
      }
    }
    return strands.length === 0 ? null : strands;
  }, [campaignId]);

  if (state === null || state === undefined) return null;
  return (
    <div
      className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs"
      data-testid="missing-refs-banner"
      role="note"
    >
      {missingRefsSummary(state)}{' '}
      <Link to={ROUTES.rules} className="font-medium underline" data-testid="missing-refs-rules-link">
        Open Rules to install the pack or re-import the rulebook
      </Link>
      .
    </div>
  );
}
