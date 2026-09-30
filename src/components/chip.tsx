import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

import type { ArtifactKind } from '@/domain';
import { cn } from '@/lib/utils';

/**
 * THE chip element (docs/17 row 182, docs/18 §2.3): the small rounded,
 * kind-coloured token that a wiki-link renders as, and that the spell list
 * renders each spell as. There is exactly ONE of it.
 *
 * It was extracted from `features/campaign/components/wiki-markdown.tsx` —
 * where `CHIP_BASE`, `KIND_CHIP_CLASSES` and the resolved-chip `<button>` were
 * module-private — because the spell list needs the SAME token (the owner asked
 * for "chips like our wikilinks") and a second, hand-styled pill beside it is
 * exactly the drift docs/18 §2 warns about (a shape change at one site and not
 * the other). The shared element owns the SHAPE; a caller owns its TONE (the
 * resolved artifact kind, the unresolved dashed style, a spell's own colour)
 * and its behaviour (`onClick`, tooltip, data attributes).
 *
 * `tone` is deliberately a plain className string rather than a closed variant
 * enum: the wiki side already has two declared tones (`KIND_CHIP_CLASSES`,
 * `CHIP_UNRESOLVED`) and the spell list a third, and an enum here would force
 * every new chip kind through this file for no gain. What must NOT be
 * re-spelled is the base class and the button element — both are asserted
 * single-site by `tests/architecture/one-chip-element.test.ts`.
 */
export type ChipTone = string;

/** Extra `data-*` attributes React forwards to the DOM (wiki chips carry the
 *  byte-exact source token this way). */
type ChipDataAttributes = Record<`data-${string}`, string | number | boolean | undefined>;

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> &
  ChipDataAttributes & {
    /** Tone classes appended after the base shape (kind colour, unresolved, spell). */
    tone?: ChipTone | undefined;
    className?: string | undefined;
    children?: ReactNode;
  };

/**
 * The shared chip element.
 *
 * `title` and `onClick` are destructured OUT of the spread deliberately: the
 * rendered attribute ORDER matters, because `tests/features/wiki-source-map.test.tsx`
 * pins the wiki reader's rendered HTML byte-for-byte. The wiki chip emits its
 * `data-*` attributes first, then `class`, then `title`/`onClick`; spreading
 * the data attributes, then `className`, then the two handlers reproduces that
 * order exactly, so extracting this element moves not one rendered byte.
 */
export function Chip({
  tone,
  className,
  children,
  title,
  onClick,
  ...rest
}: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={cn(CHIP_BASE, tone, className)}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* eslint-disable react-refresh/only-export-components -- the constants below
   ARE this module's render contract, not a second component: `Chip` is the one
   component, and the base class plus the tone vocabulary are the values every
   caller (wiki chips, the spell list) must be able to name without re-spelling
   them. The repo's own precedent is `features/campaign/components/wiki-markdown.tsx`. */

/**
 * The chip's base shape — the ONE class string every chip wears. Callers append
 * a tone; nobody rewrites this list.
 */
export const CHIP_BASE =
  'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline text-[0.9em] font-medium whitespace-nowrap';

/**
 * The kind colours a RESOLVED wiki-link chip wears (artifact kinds only — a
 * spell is not an artifact and carries its own tone at its call site). Moved
 * here from `wiki-markdown.tsx` so the chip element and its resolved-tone
 * vocabulary live together.
 */
export const KIND_CHIP_CLASSES: Readonly<Record<ArtifactKind, string>> = {
  pc: 'border-rose-500/50 bg-rose-500/10 text-rose-800 dark:text-rose-200',
  npc: 'border-sky-500/50 bg-sky-500/10 text-sky-800 dark:text-sky-200',
  location: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  event: 'border-teal-500/50 bg-teal-500/10 text-teal-800 dark:text-teal-200',
  faction: 'border-amber-500/60 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  note: 'border-neutral-500/50 bg-neutral-500/10 text-neutral-800 dark:text-neutral-200',
  encounter: 'border-red-500/50 bg-red-500/10 text-red-800 dark:text-red-200',
  plotarc: 'border-violet-500/50 bg-violet-500/10 text-violet-800 dark:text-violet-200',
};

/** The dashed, muted tone an UNRESOLVED wiki-link chip wears. */
export const CHIP_UNRESOLVED =
  'border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground hover:text-foreground';
