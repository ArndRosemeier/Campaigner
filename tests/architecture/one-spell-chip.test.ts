import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one spell-chip renderer (docs/17 row 184, docs/18 §2.3). The campaign
 * spell list and a mob's stat block show the SAME spell token: one component
 * owns the resolved tone, the unresolved dashed state and the testids, and both
 * surfaces import it.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-styled spell pill renders identically today and diverges the moment one
 * of them is touched. The needle is the tone literal itself — re-spelling it
 * anywhere else reds by file and count — plus the import edges that make the
 * sharing real rather than intended.
 */

const SPELL_CHIP_MODULE = 'src/components/spell-chip.tsx';
const SPELLS_PAGE = 'src/features/spells/SpellsPage.tsx';
const MOB_CHIPS = 'src/features/spells/mob-spell-chips.tsx';
const STAT_BLOCK = 'src/features/campaign/components/stat-block.tsx';

/** The resolved spell tone, as one literal — nobody may re-spell it. */
const SPELL_TONE_NEEDLE = 'border-indigo-500/50 bg-indigo-500/10 text-indigo-800';

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('one spell-chip renderer shared by the spell list and a mob stat block', () => {
  it('declares the spell tone once, in components/spell-chip.tsx', () => {
    const files = [SPELL_CHIP_MODULE, SPELLS_PAGE, MOB_CHIPS, STAT_BLOCK];
    const owners = files.filter((file) => read(file).includes(SPELL_TONE_NEEDLE));
    expect(owners).toEqual([SPELL_CHIP_MODULE]);
  });

  it('builds the spell chip on the ONE chip element', () => {
    const source = read(SPELL_CHIP_MODULE);
    expect(source).toMatch(/import \{[^}]*\bChip\b[^}]*\} from '@\/components\/chip'/);
    // The unresolved state is the SHARED dashed tone, not a local restatement.
    expect(source).toMatch(/import \{[^}]*\bCHIP_UNRESOLVED\b[^}]*\} from '@\/components\/chip'/);
  });

  it('routes both surfaces through SpellChip, and the stat block through the chips section', () => {
    for (const consumer of [SPELLS_PAGE, MOB_CHIPS]) {
      expect(read(consumer)).toMatch(/import \{[^}]*\bSpellChip\b[^}]*\} from '@\/components\/spell-chip'/);
    }
    expect(read(STAT_BLOCK)).toMatch(/import \{[^}]*\bMobSpellChips\b[^}]*\}/);
  });
});
