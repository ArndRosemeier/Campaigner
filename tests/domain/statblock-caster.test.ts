import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  casterStatLine,
  mobCasterLevel,
  mobSpellChipDetail,
  mobSpellChips,
  mobSpellIndex,
  SPELL_DC_MISSING_MARKER,
  statBlockIsCaster,
  statBlockSchema,
  statBlockStatesNoSpellDc,
  type SpellData,
  type StatBlock,
} from '@/domain';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';

/**
 * The caster fields on a stat block (docs/17 row 201): spell DC, spell attack
 * and tradition are additive/nullable, are never invented (a caster that states
 * no DC yields the LOUD marker, not a number derived from its level), and the
 * cantrip auto-heightening the owner asked about is confirmed at the NPC
 * caster's OWN printed level through the ONE rule.
 */

const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');

async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

/** A complete PF2e block; every caster field is left to the caller. */
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

describe('the caster fields on a stat block (docs/17 row 201)', () => {
  it('are additive and nullable: a pre-arc block parses with NONE of them and renders no caster line', () => {
    const legacy = block();
    expect(legacy.spellDC).toBeUndefined();
    expect(legacy.spellAttack).toBeUndefined();
    expect(legacy.tradition).toBeUndefined();
    // A mundane block is NOT a caster: no line, no marker, no error.
    expect(statBlockIsCaster(legacy)).toBe(false);
    expect(statBlockStatesNoSpellDc(legacy)).toBe(false);
    expect(casterStatLine(legacy)).toBeNull();
  });

  it('survive the parse (numeric strings coerced) and render as ONE line the card and PDF share', () => {
    const caster = block({ spellDC: '25', spellAttack: '+17', tradition: 'arcane' });
    expect(caster.spellDC).toBe(25);
    expect(caster.spellAttack).toBe(17);
    expect(caster.tradition).toBe('arcane');
    expect(statBlockIsCaster(caster)).toBe(true);
    expect(statBlockStatesNoSpellDc(caster)).toBe(false);
    expect(casterStatLine(caster)).toBe('Spell DC 25 · spell attack +17 · tradition arcane');
  });

  it('a caster that states NO spell DC prints the LOUD marker — NEVER a computed number', () => {
    // The owner's must: a GM needs the DC. The block carries spells (so it IS a
    // caster) but states no DC, and the surface must say so rather than derive a
    // level-appropriate number (AGENTS rule 1).
    const caster = block({ spells: [{ name: 'Fireball', castRank: 3 }] });
    expect(statBlockIsCaster(caster)).toBe(true);
    expect(statBlockStatesNoSpellDc(caster)).toBe(true);
    const line = casterStatLine(caster);
    expect(line).toBe(SPELL_DC_MISSING_MARKER);
    // NO digit anywhere: a "plausible" DC (e.g. 25 for a level-7 caster) would
    // be the invented number this pin exists to forbid.
    expect(line).not.toMatch(/\d/);

    // The signal is any caster evidence, not only spells: a tradition alone is
    // enough to be a caster, and its missing DC is still loud.
    const traditionOnly = block({ tradition: 'occult' });
    expect(statBlockStatesNoSpellDc(traditionOnly)).toBe(true);
    expect(casterStatLine(traditionOnly)).toBe(`${SPELL_DC_MISSING_MARKER} · tradition occult`);
  });

  it('refuses a malformed spell DC at the boundary, naming the field', () => {
    const result = statBlockSchema.safeParse({
      ...block(),
      spellDC: 'twenty',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('a non-numeric spell DC must not parse');
    expect(result.error.issues.some((issue) => issue.path[0] === 'spellDC')).toBe(true);
  });

  it("a level-7 NPC caster's CANTRIP auto-heightens to rank 4 through the ONE rule", async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    const index = mobSpellIndex([{ name: 'Ignition', spellData: ignition }]);
    const caster = block({ level: '7', spells: [{ name: 'Ignition' }] });

    const chip = mobSpellChips(caster.spells, mobCasterLevel(caster.level), index)[0];
    if (chip === undefined) throw new Error('the caster stored no chip');
    // The assignment carried NOTHING but the name; the rank came from the
    // creature's OWN printed level (clamp(ceil(7 / 2), 1, 10) = 4).
    expect(chip.castRank).toBeNull();
    expect(chip.result?.cantripAuto).toBe(true);
    expect(chip.result?.appliedRank).toBe(4);
    expect(chip.result?.values.damage.map((entry) => entry.formula)).toEqual(['5d4']);
    const detail = mobSpellChipDetail(chip);
    expect(detail).toContain('cast at rank 4');
    expect(detail).toContain('5d4 fire');
    expect(detail).toContain("cantrip, auto-heightened from the caster's level");
    expect(detail).toContain('heightening: cantrip-auto');
  });

  it('a caster whose LEVEL is unknown keeps the cantrip LOUD — never an invented rank', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    const index = mobSpellIndex([{ name: 'Ignition', spellData: ignition }]);
    // A printed "—" level is a legal stat-block value and resolves to NO caster
    // level (`mobCasterLevel`), so the rule refuses rather than guessing.
    const caster = block({ level: '—', spells: [{ name: 'Ignition' }] });
    expect(mobCasterLevel(caster.level)).toBeNull();

    const chip = mobSpellChips(caster.spells, mobCasterLevel(caster.level), index)[0];
    if (chip === undefined) throw new Error('the caster stored no chip');
    expect(chip.resolved).toBe(true);
    expect(chip.result).toBeNull();
    expect(chip.issues.join(' ')).toContain('casterLevel');
    // No formula and no rank: the detail names what is missing.
    expect(mobSpellChipDetail(chip)).not.toMatch(/\d+d\d+/);
    expect(mobSpellChipDetail(chip)).toContain('casterLevel');
    // And the block's own missing DC is still loud alongside it.
    expect(casterStatLine(caster)).toBe(SPELL_DC_MISSING_MARKER);
  });
});
