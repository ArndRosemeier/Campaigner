import type { JSX } from 'react';
import { FileWarningIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { StatBlock } from '@/domain';
import { authoredStatOrigin, derivedStatOrigin } from '@/domain/encounterResolve';
import { StatBlockCard } from '@/features/campaign/components/stat-block';

/**
 * A CAST creature's numbers, READ-ONLY (docs/11 D3; ledger row 134; docs/17 row
 * 255b).
 *
 * An `npc` born out of a library creature has numbers that are the LIBRARY's,
 * never prose a run authored — the owner's Aunt Agatha. The encounter roster and
 * the battle board have always drawn them; the row's OWN details surface drew
 * nothing at all and offered an "Add stat block" button that the cast-row refill
 * refuses (docs/11 §A), so the owner saw a named zombie with a portrait, a prose
 * field and no numbers anywhere he looked.
 *
 * THE COPY IS THE ROW'S (docs/17 row 255b), and since the clean cut (docs/17 row
 * 278) it is the ONLY spelling: the cast STORES the library's bytes on the row
 * (`statBlock` + the stamped `sourceLine`), so this component renders that copy
 * directly — no library read, nothing to fail, and uninstalling the pack cannot
 * blank a mob the campaign already owns. The stamped line is disclosed with the
 * NPC's own name (`derivedStatOrigin`), exactly as the old derived label was.
 *
 * It NEVER writes: nothing here stores a block on the row.
 *
 * TWO ARMS, ONE PROVENANCE (docs/17 row 284). A direct instruction now lets a run
 * AUTHOR a cast row's numbers, and the row keeps its origin stamps as identity —
 * so the pair above is no longer the whole story and the surface must not keep
 * claiming "the numbers are the library's" after they were authored.
 * `BorrowedStatBlock` stays the pure COPY; `AuthoredStatBlock` below is the row
 * whose numbers are the campaign's own and whose origin is disclosed as
 * provenance. Both read the SAME `sourceLine` and the SAME one composer per arm.
 */
export interface BorrowedStatBlockProps {
  /** The row's own name — the identity the reader opened. */
  npcName: string;
  /**
   * The row's own COPY of the library's block. `statBlock` is null only on a
   * malformed cast row (a cast is born with its copy), which then renders the
   * named missing notice rather than an empty stat area.
   */
  copy: { statBlock: StatBlock | null; sourceLine: string | undefined };
}

export function BorrowedStatBlock({ npcName, copy }: BorrowedStatBlockProps): JSX.Element {
  if (copy.statBlock !== null) {
    return (
      <div className="flex flex-col gap-1" data-testid="borrowed-stat-block">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" data-testid="borrowed-stat-block-badge">
            Copied from the library
          </Badge>
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="borrowed-stat-block-origin"
          >
            {derivedStatOrigin(npcName, copy.sourceLine ?? '')}
          </span>
        </div>
        <StatBlockCard statBlock={copy.statBlock} name={npcName} />
      </div>
    );
  }

  // A cast creature with no copy on its row. It should not exist — and it is
  // NAMED rather than drawn as an empty stat area (AGENTS rule 1).
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
      data-testid="borrowed-stat-block-missing"
    >
      <span className="flex items-center gap-1 font-medium text-destructive">
        <FileWarningIcon aria-hidden className="size-3" /> Copied stats unavailable
      </span>
      <p className="text-destructive" data-testid="borrowed-stat-block-missing-origin">
        {npcName} is a cast creature, but its row carries no copied stat block — re-cast it from the
        library to restore its numbers. Nothing is invented here.
      </p>
    </div>
  );
}

/**
 * The SAME row, once a direct instruction AUTHORED its numbers (docs/17 row 284,
 * the owner: *"yes of course, direct instructions need to be honored not
 * ignored."*).
 *
 * It is deliberately a SECOND, clearly-named arm rather than a flag on the
 * borrowed one: the two rows hold genuinely different facts and one badge string
 * cannot say both. `BorrowedStatBlock` says "these numbers are the library's
 * copy"; this says "these numbers are this campaign's own, and the row still
 * knows which creature it began as" — the origin stamps survive as PROVENANCE
 * (the portrait and reuse identity ride `originToken`), which is exactly why the
 * disclosure stays on screen instead of being dropped with the copy.
 */
export function AuthoredStatBlock({ npcName, copy }: BorrowedStatBlockProps): JSX.Element {
  if (copy.statBlock !== null) {
    return (
      <div className="flex flex-col gap-1" data-testid="authored-stat-block">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" data-testid="authored-stat-block-badge">
            Authored for this campaign
          </Badge>
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="authored-stat-block-origin"
          >
            {authoredStatOrigin(npcName, copy.sourceLine ?? '')}
          </span>
        </div>
        <StatBlockCard statBlock={copy.statBlock} name={npcName} />
      </div>
    );
  }

  // An authored row the owner emptied (the form's Remove): the numbers are gone
  // but the identity stamps stay, so this NAMES the state rather than rendering
  // an empty stat area (AGENTS rule 1).
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-dashed p-2 text-xs text-muted-foreground"
      data-testid="authored-stat-block-empty"
    >
      <span className="font-medium">{npcName} has no stat block.</span>
      <p data-testid="authored-stat-block-empty-origin">
        Its numbers were authored for this campaign and have since been removed; the creature it
        originated from is still recorded. Add or generate a stat block in the editor to restore
        them.
      </p>
    </div>
  );
}
