import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SPELL_DC_MISSING_MARKER, statBlockSchema, type StatBlock } from '@/domain';
import { StatBlockCard } from '@/features/campaign/components/stat-block';

/**
 * The caster line on the ONE stat-block card (docs/17 row 201). A caster's
 * stated spell DC / spell attack / tradition render where a GM reads the block;
 * a caster that states no DC prints the LOUD marker instead of a
 * plausible-looking number; and a mundane or legacy block is byte-for-byte
 * unchanged (no line at all).
 */

function block(over: Record<string, unknown> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '7',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 22,
    acNote: '',
    hp: 90,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 10, dex: 12, con: 14, int: 18, wis: 16, cha: 12 },
    saves: '',
    skills: '',
    senses: '',
    languages: 'Common',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

afterEach(cleanup);

describe('the caster line on the stat-block card (docs/17 row 201)', () => {
  it('renders the stated spell DC, spell attack and tradition', () => {
    render(
      <StatBlockCard
        statBlock={block({ spellDC: 25, spellAttack: 17, tradition: 'arcane' })}
        name="Necromancer Smith"
      />,
    );
    const line = screen.getByTestId('stat-block-caster');
    expect(line).toHaveTextContent('Spell DC 25');
    expect(line).toHaveTextContent('spell attack +17');
    expect(line).toHaveTextContent('tradition arcane');
    expect(line).toHaveAttribute('data-state', 'stated');
  });

  it('prints the LOUD marker — never a computed DC — for a caster that states none', () => {
    render(
      <StatBlockCard
        statBlock={block({ spells: [{ name: 'Fireball', castRank: 3 }] })}
        name="Necromancer Smith"
      />,
    );
    const line = screen.getByTestId('stat-block-caster');
    expect(line).toHaveTextContent(SPELL_DC_MISSING_MARKER);
    expect(line).toHaveAttribute('data-state', 'missing-spell-dc');
    // No number stands in for the DC the model never stated.
    expect(line.textContent).not.toMatch(/\d/);
  });

  it('leaves a MUNDANE block unchanged — no caster line at all', () => {
    render(<StatBlockCard statBlock={block()} name="Innkeeper" />);
    expect(screen.queryByTestId('stat-block-caster')).toBeNull();
  });

  it('leaves a LEGACY block (no caster keys, no spells key) unchanged', () => {
    // A row written before this arc: the parse omits every new key, and the
    // card renders exactly as it did — no line, no marker, no error.
    const legacy = block();
    expect(legacy.spellDC).toBeUndefined();
    expect(legacy.spells).toBeUndefined();
    render(<StatBlockCard statBlock={legacy} name="Old Guard" />);
    expect(screen.queryByTestId('stat-block-caster')).toBeNull();
    expect(screen.queryByTestId('mob-spells')).toBeNull();
  });
});
