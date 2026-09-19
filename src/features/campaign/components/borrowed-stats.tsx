import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { FileWarningIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { resolveDerivedNpcStats } from '@/db/creatureRepo';
import type { CreatureRef, StatBlock } from '@/domain';
import { derivedStatOrigin, missingCreatureOrigin } from '@/domain/encounterResolve';
import { errorMessage } from '@/lib/errors';
import { toastError } from '@/lib/toast';
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
 * THE COPY IS NOW THE ROW'S (docs/17 row 255b). Under the one-representation
 * model the cast STORES the library's bytes on the row (`statBlock` + the
 * stamped `sourceLine` + the opaque `originToken`), so this component renders
 * `copy` directly — no library read, nothing to fail, and uninstalling the pack
 * cannot blank a mob the campaign already owns. The stamped line is disclosed
 * exactly as the derived one used to be, with the NPC's own name added
 * (`derivedStatOrigin`), so the label a GM reads is byte-identical.
 *
 * THE LEGACY POINTER STILL RENDERS (`citation`): a row the v24 migration could
 * not convert (its pack was uninstalled at upgrade time) keeps its `creatureRef`
 * and is resolved live through `db/creatureRepo.resolveDerivedNpcStats` — the
 * repo-wired read of the ONE rule in `domain/encounterResolve` — so the panel,
 * the encounter listing and the battle token cannot disagree. Its failure paths
 * stay LOUD and both name the creature (AGENTS rules 1 and 2 — no default, no
 * blank): the library cannot supply it → the shared `missing ref (<creature>)`
 * reason rendered as a named notice; the read THROWS (a citation carrying
 * neither key) → the sentence in place AND through `lib/toast`.
 *
 * It NEVER writes: nothing here stores a block on the row.
 */
export interface BorrowedStatBlockProps {
  /** The row's own name — the identity the reader opened. */
  npcName: string;
  /**
   * The row's own COPY of the library's block (docs/17 row 255b). Present on a
   * converted row; `statBlock` is null only on a malformed one, which then falls
   * through to the citation path or renders the named missing notice.
   */
  copy?: { statBlock: StatBlock | null; sourceLine: string | undefined } | undefined;
  /** The LEGACY pointer of an unconverted row, resolved live. */
  citation?: CreatureRef | undefined;
}

type BorrowedStats =
  | { status: 'loading' }
  | { status: 'ready'; statBlock: StatBlock | null; origin: string }
  | { status: 'failed'; message: string };

export function BorrowedStatBlock({ npcName, copy, citation }: BorrowedStatBlockProps): JSX.Element {
  const [derived, setDerived] = useState<BorrowedStats>({ status: 'loading' });
  const copiedBlock = copy?.statBlock ?? null;
  // The library is read ONLY for a row that owns no copy — a converted row
  // renders from its own bytes and must not touch the library at all.
  const needsRead = copiedBlock === null && citation !== undefined;

  useEffect(() => {
    // `needsRead` is the narrowing: it is only true when a pointer exists.
    if (!needsRead) return;
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
  }, [npcName, citation, needsRead]);

  if (copiedBlock !== null) {
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
            {derivedStatOrigin(npcName, copy?.sourceLine ?? '')}
          </span>
        </div>
        <StatBlockCard statBlock={copiedBlock} name={npcName} />
      </div>
    );
  }

  if (citation === undefined) {
    // A cast creature with neither a copy nor a pointer. It should not exist —
    // and it is NAMED rather than drawn as an empty stat area (AGENTS rule 1).
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
        data-testid="borrowed-stat-block-missing"
      >
        <span className="flex items-center gap-1 font-medium text-destructive">
          <FileWarningIcon aria-hidden className="size-3" /> Borrowed stats unavailable
        </span>
        <p className="text-destructive" data-testid="borrowed-stat-block-missing-origin">
          {missingCreatureOrigin(npcName)}
        </p>
      </div>
    );
  }

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
