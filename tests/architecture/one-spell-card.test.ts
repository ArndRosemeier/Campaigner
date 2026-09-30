import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { repoFiles } from '../helpers/sourceCode';

/**
 * THE one spell-detail renderer (docs/17 row 216, docs/18 §2.3).
 *
 * The owner's report — *"the spell chips are not clickable, they do not open
 * the spell description"* — is answered by pointing the mob chip at the
 * renderer the Spells page already uses (`features/spells/spell-card.SpellCard`)
 * inside a dialog, NOT by writing a second detail view. The drift this scan
 * catches is invisible: a second spell-detail component renders a plausible
 * card today and diverges the moment one of them is touched, exactly the
 * duplication docs/18 §2 exists to stop.
 *
 * WHAT REDS THIS, named so a reader knows. (1) The `spell-card` testid — the
 * renderer's rendered contract — declared anywhere but `spell-card.tsx`: a
 * second detail view must claim a testid, and this one is taken. (2) `SpellCard`
 * imported anywhere but the TWO declared hosts: the Spells page's pane and the
 * mob chip's dialog. A third host (a new surface wanting a spell card) reds on
 * purpose, so the docs/18 §2.3 host row is updated deliberately; a host that
 * drops the import (the dialog going back to a hand-rolled body) reds too.
 *
 * The walk is the ONE tree walk (`repoFiles`, docs/17 row 427), with the
 * counting INLINE in the `it` callback.
 */

const SPELL_CARD_MODULE = 'src/features/spells/spell-card.tsx';
const SPELLS_PAGE = 'src/features/spells/SpellsPage.tsx';
const MOB_CHIPS = 'src/features/spells/mob-spell-chips.tsx';

describe('one spell-detail renderer, hosted by the spell list and the mob chip dialog', () => {
  it('declares the spell-card testid once, and imports SpellCard from exactly the two hosts', () => {
    const files = repoFiles('src', ['.ts', '.tsx']);

    const testidOwners: string[] = [];
    const importers: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (text.includes('data-testid="spell-card"')) testidOwners.push(path);
      if (/import \{[^}]*\bSpellCard\b[^}]*\} from '@\/features\/spells\/spell-card'/.test(text)) {
        importers.push(path);
      }
    }

    // The testid IS the renderer's contract, so exactly one component owns it.
    expect(testidOwners.sort()).toEqual([SPELL_CARD_MODULE]);
    // The Spells page's pane and the mob chip's dialog — the two declared hosts.
    // `localeCompare` so the expectation reads by name, not by code unit.
    expect(importers.sort((a, b) => a.localeCompare(b))).toEqual([MOB_CHIPS, SPELLS_PAGE]);
  });
});
