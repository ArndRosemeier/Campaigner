import type { JSX } from 'react';
import { FileWarningIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { StatBlock } from '@/domain';
import { derivedStatOrigin } from '@/domain/encounterResolve';
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
