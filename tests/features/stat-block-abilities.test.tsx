import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { statBlockSchema, type StatBlock } from '@/domain';
import { foundryPf2eAdapter } from '@/ingest/packs/pf2e-foundry';
import { StatBlockCard, StatBlockForm } from '@/features/campaign/components/stat-block';

/**
 * The ability convention on screen (docs/12 §5, docs/05 §Artifact editor,
 * docs/17 row 95). The app STORES d20-scale scores in every system, including
 * Pathfinder 2e — whose own stat blocks print signed MODIFIERS instead — so a
 * PF2e block shows the BONUS only ("STR +2") while every other system keeps
 * "14 (+2)", and the EDITOR mirrors that per-system meaning: a PF2e field is
 * the printed bonus and is converted with the shared inverse (10 + 2·mod),
 * visibly stated rather than done silently (AGENTS 1).
 *
 * The owner's report that started this: a generated PF2e mob printed
 * "2 (−4)", because the model wrote its printed "+2" and the app read the
 * coerced `2` as a score.
 */

function block(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '3',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 14,
    acNote: '',
    hp: 20,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 14, dex: 16, con: 12, int: 10, wis: 12, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

/** Every card is rendered inside this wrapper: the editor form shares labels. */
const CARD = 'card-under-test';

function renderCard(statBlock: StatBlock, name: string): ReturnType<typeof render> {
  return render(
    <div data-testid={CARD}>
      <StatBlockCard statBlock={statBlock} name={name} />
    </div>,
  );
}

/** The ability cell of the classic stat-block card: label + its printed value. */
function abilityCell(label: string): string {
  return within(screen.getByTestId(CARD)).getByText(label).parentElement?.textContent ?? '';
}

/** The editor + the card over ONE piece of state: a real round trip. */
function EditorHarness({ initial }: { initial: StatBlock }) {
  const [statBlock, setStatBlock] = useState(initial);
  return (
    <div>
      <StatBlockForm statBlock={statBlock} onChange={setStatBlock} />
      <output data-testid="stored-str">{String(statBlock.abilities.str)}</output>
      <div data-testid={CARD}>
        <StatBlockCard statBlock={statBlock} name="Round trip" />
      </div>
    </div>
  );
}

describe('stat block ability display', () => {
  /**
   * Revert-proof: print `{score} ({modifier})` for every system (the pre-row-95
   * card) and the first assertion reads "STR14 (+2)" instead of "STR+2".
   */
  it('prints the BONUS ONLY for Pathfinder 2e, and score (bonus) for every other system', () => {
    const { unmount } = renderCard(block({ system: 'pathfinder2e' }), 'Wolf');
    expect(abilityCell('STR')).toBe('STR+2');
    expect(abilityCell('DEX')).toBe('DEX+3');
    // The stored d20 score never reaches a PF2e reader.
    expect(within(screen.getByTestId(CARD)).queryByText(/16 \(\+3\)/)).toBeNull();
    unmount();

    renderCard(block({ system: 'dnd5e' }), 'Cultist');
    expect(abilityCell('STR')).toBe('STR14 (+2)');
    expect(abilityCell('DEX')).toBe('DEX16 (+3)');
  });

  /**
   * docs/12 §5's promise: an IMPORTED PF2e bestiary row is stored as
   * `10 + 2·mod` and must print identically to a generated one. The block here
   * is produced by the REAL adapter from the real Monster Core fixture, so the
   * whole chain — printed `+2` → stored 14 → on screen "+2" — is pinned.
   *
   * Revert-proof: this fails on the pre-row-95 card (it printed "14 (+2)"), and
   * it would fail again if the importer stopped applying the conversion.
   */
  it('prints an imported Pathfinder 2e creature exactly like a generated one', async () => {
    const fixture = join(import.meta.dirname, '..', 'fixtures', 'packs', 'pf2e', 'wolf.json');
    const parsed = await foundryPf2eAdapter.parseFile(
      'wolf.json',
      new Uint8Array(readFileSync(fixture)),
    );
    const imported = parsed.entries[0]?.statBlock;
    if (imported === undefined) throw new Error('the pf2e fixture produced no stat block');
    // The importer's own convention (docs/12 §5), re-asserted here so the
    // display parity below cannot pass over a changed stored value.
    expect(imported.abilities.str).toBe(14);

    const { unmount } = renderCard(imported, 'Wolf');
    const importedCells = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(abilityCell);
    unmount();

    renderCard(block({ system: 'pathfinder2e', abilities: imported.abilities }), 'Wolf');
    const generatedCells = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'].map(abilityCell);
    expect(importedCells).toEqual(generatedCells);
    expect(importedCells[0]).toBe('STR+2');
  });
});

describe('stat block ability editor', () => {
  /**
   * The editor's PF2e semantics: the field IS the printed bonus (a stored score
   * of 14 shows as the bonus 2), a signed value typed is the same modifier the
   * book prints, and the conversion is stated on screen.
   *
   * Revert-proof: drop the `printsAbilityModifiers` branch from `patchAbility`
   * and `+2`/`-1` land on the row as the scores 2/-1 (the stored-str output
   * reads "2"/"-1" and the card then prints "-4"/"-6").
   */
  it('shows and edits the BONUS for a Pathfinder 2e block, converting through the shared inverse', () => {
    render(<EditorHarness initial={block({ system: 'pathfinder2e' })} />);

    // str 14 (a +2 modifier) is edited as the bonus.
    const strField = screen.getByLabelText('STR bonus');
    expect(strField).toHaveValue(2);
    expect(screen.getByTestId('stat-block-ability-conversion').textContent).toContain(
      '10 + 2 × the bonus',
    );

    fireEvent.change(strField, { target: { value: '4' } });
    expect(screen.getByTestId('stored-str').textContent).toBe('18');
    expect(abilityCell('STR')).toBe('STR+4');

    // A SIGNED value the owner types means the printed modifier, not a score.
    fireEvent.change(screen.getByLabelText('DEX bonus'), { target: { value: '-1' } });
    expect(screen.getByLabelText('DEX bonus')).toHaveValue(-1);
    expect(abilityCell('DEX')).toBe('DEX-1');
  });

  /**
   * The other systems are untouched: the field is the SCORE, a typed 16 lands on
   * the row as 16, and no conversion note appears (nothing is reinterpreted
   * silently or otherwise for a d20 block).
   */
  it('keeps score semantics and shows no conversion note for a non-Pathfinder block', () => {
    render(<EditorHarness initial={block({ system: 'dnd5e' })} />);
    expect(screen.queryByTestId('stat-block-ability-conversion')).toBeNull();
    const strField = screen.getByLabelText('STR');
    expect(strField).toHaveValue(14);

    fireEvent.change(strField, { target: { value: '16' } });
    expect(screen.getByTestId('stored-str').textContent).toBe('16');
    expect(abilityCell('STR')).toBe('STR16 (+3)');
  });
});
