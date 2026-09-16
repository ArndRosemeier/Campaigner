import type { JSX } from 'react';

import { CHIP_UNRESOLVED, Chip, type ChipProps } from '@/components/chip';

/**
 * THE one spell-chip renderer (docs/17 row 184, docs/18 §2.3).
 *
 * A spell chip is the SAME token the wiki renderer uses (`components/chip`),
 * and there are exactly TWO surfaces that render one: the campaign spell list
 * (docs/17 row 182) and a mob's stat block (the mob half of the spells arc).
 * Both go through THIS component so the resolved tone, the UNRESOLVED dashed
 * state and the chip's own testids are declared once — two hand-styled spell
 * pills is exactly the drift `tests/architecture/one-spell-chip.test.ts`
 * forbids.
 *
 * `resolved` is the ONE thing a caller decides: a name that does not resolve in
 * the library renders the UNRESOLVED state with the name still VISIBLE (the
 * wiki-link precedent), never hidden and never blank. `detail` is the chip's
 * tooltip — for a mob spell it is `domain/mobSpells.mobSpellChipDetail`, the
 * values at the cast rank plus the rule's provenance, so the same bytes reach
 * the chip's title and the PDF's printed line.
 */
export const SPELL_CHIP_TONE =
  'border-indigo-500/50 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200';

export interface SpellChipProps extends Omit<ChipProps, 'tone' | 'children'> {
  /** The spell's displayed name (the library's own spelling when resolved). */
  name: string;
  /** False ⇒ the UNRESOLVED state (dashed, muted), name still shown. */
  resolved?: boolean | undefined;
  /** The chip's detail/tooltip; the name alone when omitted. */
  detail?: string | undefined;
  /** Visible text after the name (the list's own rank label is a sibling
   *  element instead — the page's rendered text is pinned byte-for-byte). */
  suffix?: string | undefined;
}

export function SpellChip({
  name,
  resolved = true,
  detail,
  suffix,
  className,
  ...rest
}: SpellChipProps): JSX.Element {
  return (
    <Chip
      {...rest}
      data-testid={resolved ? 'spell-chip' : 'spell-chip-unresolved'}
      {...(resolved ? {} : { 'data-spell-unresolved': name })}
      tone={resolved ? SPELL_CHIP_TONE : CHIP_UNRESOLVED}
      className={className}
      title={detail ?? name}
    >
      {suffix === undefined ? name : `${name} ${suffix}`}
    </Chip>
  );
}
