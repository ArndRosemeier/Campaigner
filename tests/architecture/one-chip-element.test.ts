import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { countsIn, readTree } from '../helpers/sourceCode';

/**
 * THE one chip element (docs/17 row 182, docs/18 §2.3). The wiki-link chip and
 * the spell list's spell chips are the SAME token; `src/components/chip.tsx`
 * owns the element and its base class, and the two consumers pass a tone.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * `<button>` wearing the same rounded/full pill classes renders identically
 * today and diverges the moment one of them is touched. The needle is the
 * CHIP_BASE class string itself — re-spelling it anywhere else (or re-declaring
 * the kind colours) reds by file and count.
 */

const CHIP_MODULE = 'src/components/chip.tsx';
const WIKI_MARKDOWN = 'src/features/campaign/components/wiki-markdown.tsx';
const SPELLS_PAGE = 'src/features/spells/SpellsPage.tsx';

/** The base shape, as one literal — nobody may re-spell it. */
const CHIP_BASE_NEEDLE = 'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full border';
/** One kind colour, as one literal — the resolved-tone vocabulary. */
const KIND_COLOUR_NEEDLE = 'border-rose-500/50 bg-rose-500/10 text-rose-800';

const SRC = readTree('src', ['.ts', '.tsx']);

function countsOf(needle: string): Map<string, number> {
  return new Map(countsIn(SRC, 'src/', needle));
}

describe('one chip element shared by wiki chips and the spell list (SOURCE SCAN)', () => {
  it('declares the chip base class once, in components/chip.tsx', () => {
    const counts = countsOf(CHIP_BASE_NEEDLE);
    expect([...counts.keys()]).toEqual([CHIP_MODULE]);
    expect(counts.get(CHIP_MODULE)).toBe(1);
  });

  it('declares the artifact-kind tone vocabulary once, in components/chip.tsx', () => {
    const counts = countsOf(KIND_COLOUR_NEEDLE);
    expect([...counts.keys()]).toEqual([CHIP_MODULE]);
  });

  it('routes both consumers through the shared Chip', () => {
    const wiki = readFileSync(join(process.cwd(), WIKI_MARKDOWN), 'utf8');
    const spells = readFileSync(join(process.cwd(), SPELLS_PAGE), 'utf8');
    expect(wiki).toMatch(/import \{[^}]*\bChip\b[^}]*\} from '@\/components\/chip'/);
    // The spell list reaches the SAME element through the ONE spell-chip
    // renderer (docs/17 row 184) — `components/spell-chip.tsx` is the chip's
    // only spell-shaped consumer, and `tests/architecture/one-spell-chip.test.ts`
    // pins that it builds on `Chip` rather than re-spelling it.
    expect(spells).toMatch(/import \{[^}]*\bSpellChip\b[^}]*\} from '@\/components\/spell-chip'/);
    expect(spells).not.toContain(CHIP_BASE_NEEDLE);
    // The wiki renderer no longer owns a button of its own for a chip.
    expect(wiki).not.toContain(CHIP_BASE_NEEDLE);
  });
});
