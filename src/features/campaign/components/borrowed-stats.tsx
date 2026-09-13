import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { FileWarningIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { resolveDerivedNpcStats } from '@/db/creatureRepo';
import type { CreatureRef, StatBlock } from '@/domain';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';
import { StatBlockCard } from '@/features/campaign/components/stat-block';

/**
 * A CITED row's numbers, READ-ONLY (docs/11 D3; ledger row 134).
 *
 * An `npc` carrying a `creatureRef` has no stat block of its own BY DESIGN —
 * `npcDataSchema` refuses the pair by name — its numbers are the library
 * creature's, derived at read time. The encounter roster and the battle board
 * have always drawn them; the row's OWN details surface drew nothing at all
 * and offered an "Add stat block" button that the cited-row refill refuses
 * (docs/11 §A cited row's REFILL), so the owner saw a named zombie with a
 * portrait, a prose field and no numbers anywhere he looked.
 *
 * This is the ONE render of those numbers, mounted by every surface that shows
 * a cited row (the artifact editor's `NpcForm`, the read-only `NpcCard`). It
 * asks `db/creatureRepo.resolveDerivedNpcStats` — the repo-wired read of the
 * ONE rule in `domain/encounterResolve` — so the panel, the encounter listing
 * and the battle token cannot disagree, and it NEVER writes: the block is
 * drawn from the library on every render, never stored on the row.
 *
 * TWO failure paths, both LOUD and both naming the creature (AGENTS rules 1
 * and 2 — no default, no blank):
 *
 * - the library cannot supply the citation at all → the derivation answers the
 *   one shared `missing ref (<creature>)` reason, rendered here as a named
 *   destructive notice (never a silently empty stat area);
 * - the read THROWS (a citation carrying neither key cannot be resolved) →
 *   the sentence is rendered in place AND raised through `lib/toast`.
 */
export interface BorrowedStatBlockProps {
  /** The row's own name — the identity the reader opened. */
  npcName: string;
  /** The citation the row carries; its presence is what makes the numbers borrowed. */
  citation: CreatureRef;
}

type BorrowedStats =
  | { status: 'loading' }
  | { status: 'ready'; statBlock: StatBlock | null; origin: string }
  | { status: 'failed'; message: string };

export function BorrowedStatBlock({ npcName, citation }: BorrowedStatBlockProps): JSX.Element {
  const [derived, setDerived] = useState<BorrowedStats>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setDerived({ status: 'loading' });
    void resolveDerivedNpcStats(npcName, citation)
      .then((result) => {
        if (live) setDerived({ status: 'ready', ...result });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setDerived({ status: 'failed', message: errorMessage(error) });
        toastError(`Could not read «${npcName}»'s borrowed stats`, error);
      });
    return () => {
      live = false;
    };
  }, [npcName, citation]);

  if (derived.status === 'loading') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="borrowed-stat-block-loading">
        Reading {npcName}&apos;s stats from the library…
      </p>
    );
  }

  if (derived.status === 'failed') {
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
        data-testid="borrowed-stat-block-failed"
      >
        <span className="flex items-center gap-1 font-medium text-destructive">
          <FileWarningIcon aria-hidden className="size-3" /> Borrowed stats unavailable
        </span>
        <p className="text-destructive">{derived.message}</p>
      </div>
    );
  }

  if (derived.statBlock === null) {
    // The library lost the creature (a re-ingest under a new id, a removed
    // book). `origin` is the shared, NAMED reason — `missing ref (Zombie)` —
    // so this reads as a statement about a creature, never as an empty stat
    // area a reader could mistake for "this npc has no stats".
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
        data-testid="borrowed-stat-block-missing"
      >
        <span className="flex items-center gap-1 font-medium text-destructive">
          <FileWarningIcon aria-hidden className="size-3" /> Borrowed stats unavailable
        </span>
        <p className="text-destructive" data-testid="borrowed-stat-block-missing-origin">
          {derived.origin}
        </p>
        <p className="text-muted-foreground">
          {npcName} draws its numbers from a library creature this workspace no longer holds.
          Re-import the book it came from — nothing is invented here, and no stat block is written
          onto the row.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid="borrowed-stat-block">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" data-testid="borrowed-stat-block-badge">
          Borrowed from the library
        </Badge>
        <span
          className="text-[11px] text-muted-foreground"
          data-testid="borrowed-stat-block-origin"
        >
          {derived.origin}
        </span>
      </div>
      <StatBlockCard statBlock={derived.statBlock} name={npcName} />
    </div>
  );
}
