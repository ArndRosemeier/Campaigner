import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  mobCasterLevel,
  mobSpellChipDetail,
  mobSpellChips,
  mobSpellIndex,
  mobSpellIssues,
  mobSpellVocabulary,
  MOB_SPELL_VOCABULARY_LIMIT,
  maxCastableRank,
} from '@/domain/mobSpells';
import { spellDataSchema, type SpellData } from '@/domain/spellData';
import { pf2eCantripRankFor, PROSE_ONLY_MARKER, spellAtRank } from '@/domain/spellHeightening';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';

/**
 * The mob-spell resolver (docs/17 row 184): the ONE place an assigned spell
 * name becomes a chip, and the ONE place the cast-rank request reaches the
 * heightening rule.
 *
 * The Fireball/Ignition payloads are the REAL v14-dev documents mapped by the
 * ingest lane's own field mapping, so the formulas asserted here are the
 * source's numbers — the same fixtures `pf2e-rules-heightening.test.ts` pins.
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

const fireball = (): Promise<SpellData> =>
  realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
const ignition = (): Promise<SpellData> =>
  realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
const athleticRush = (): Promise<SpellData> =>
  realSpell('athletic-rush.json', 'spells/focus/athletic-rush.json');

function synthetic(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: 'pathfinder2e',
    rank: 1,
    cantrip: false,
    traditions: ['arcane'],
    traits: [],
    rarity: 'common',
    cast: { time: '', range: '', target: '', duration: '' },
    heightening: null,
    heighteningEntries: [],
    heighteningUnparsed: [],
    publication: null,
    ...over,
  });
}

describe('mob spell assignments resolve through the ONE rule', () => {
  it('resolves a real library spell and carries it verbatim', async () => {
    const spell = await fireball();
    const index = mobSpellIndex([{ name: 'Fireball', spellData: spell }]);

    const chips = mobSpellChips([{ name: 'fireball' }], 5, index);

    expect(chips).toHaveLength(1);
    const chip = chips[0];
    if (chip === undefined) throw new Error('no chip');
    // The comparable-name form resolved a different casing (docs/18 §2.1)…
    expect(chip.resolved).toBe(true);
    expect(chip.libraryName).toBe('Fireball');
    // The spelling the author assigned is what the chip shows.
    expect(chip.name).toBe('fireball');
    expect(chip.issues).toEqual([]);
    // No castRank supplied ⇒ the spell's own rank.
    expect(chip.result?.appliedRank).toBe(3);
    expect(chip.result?.values.damage.map((entry) => entry.formula)).toEqual(['6d6']);
  });

  it('a spell cast ABOVE its own rank reaches the chip as the heightened values', async () => {
    const spell = await fireball();
    const index = mobSpellIndex([{ name: 'Fireball', spellData: spell }]);

    const chips = mobSpellChips([{ name: 'Fireball', castRank: 5 }], 9, index);

    const chip = chips[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.result?.appliedRank).toBe(5);
    expect(chip.result?.appliedSteps).toBe(2);
    expect(chip.result?.values.damage.map((entry) => entry.formula)).toEqual(['10d6']);
    // The same bytes the chip's title and the PDF's line render.
    expect(mobSpellChipDetail(chip)).toContain('cast at rank 5: 10d6 fire');
    expect(mobSpellChipDetail(chip)).toContain('heightening: interval (values from interval)');
  });

  it('a CANTRIP is auto-heightened by the rule from the CASTER LEVEL — the caller picks no rank', async () => {
    const spell = await ignition();
    const index = mobSpellIndex([{ name: 'Ignition', spellData: spell }]);

    // The assignment carries NOTHING but the name: if this module computed a
    // cantrip rank itself, this pin could not see the level at all.
    const level5 = mobSpellChips([{ name: 'Ignition' }], 5, index)[0];
    if (level5 === undefined) throw new Error('no chip');
    expect(level5.castRank).toBeNull();
    expect(level5.result?.cantripAuto).toBe(true);
    expect(level5.result?.appliedRank).toBe(3);
    expect(level5.result?.values.damage.map((entry) => entry.formula)).toEqual(['4d4']);
    expect(mobSpellChipDetail(level5)).toContain('cast at rank 3');
    expect(mobSpellChipDetail(level5)).toContain('cantrip, auto-heightened from the caster');

    // The DIFFERENTIAL: the same assignment at another level moves the rank,
    // which no caller-side constant could do.
    const level9 = mobSpellChips([{ name: 'Ignition' }], 9, index)[0];
    if (level9 === undefined) throw new Error('no chip');
    expect(level9.result?.appliedRank).toBe(5);
    expect(level9.result?.values.damage.map((entry) => entry.formula)).toEqual(['6d4']);
  });

  it('a cantrip on a level-less mob is LOUD — never an arbitrary default rank', async () => {
    const spell = await ignition();
    const index = mobSpellIndex([{ name: 'Ignition', spellData: spell }]);

    const chip = mobSpellChips([{ name: 'Ignition' }], null, index)[0];
    if (chip === undefined) throw new Error('no chip');
    // The NAME resolved, so the chip is not the unresolved state…
    expect(chip.resolved).toBe(true);
    // …but no number was invented: the rule refused and the chip says why.
    expect(chip.result).toBeNull();
    expect(chip.issues.join(' ')).toContain('casterLevel');
    expect(mobSpellChipDetail(chip)).toContain('casterLevel');
  });

  it('a FOCUS spell auto-heightens from the CASTER LEVEL — the caller picks no rank (docs/17 row 191)', async () => {
    // The REAL upstream `Athletic Rush` (foundryvtt/pf2e @ v14-dev,
    // packs/pf2e/spells/focus/athletic-rush.json): level 1, the `focus` trait.
    // Upstream's `SpellPF2e.rank` on an actor is clamp(ceil(level / 2), 1, 10),
    // so the same assignment must move with the mob's level.
    const spell = await athleticRush();
    const index = mobSpellIndex([{ name: 'Athletic Rush', spellData: spell }]);

    const level5 = mobSpellChips([{ name: 'Athletic Rush' }], 5, index)[0];
    if (level5 === undefined) throw new Error('no chip');
    // The assignment carries NOTHING but the name: if this module computed a
    // focus rank itself, this pin could not see the level at all.
    expect(level5.castRank).toBeNull();
    expect(level5.result?.focusAuto).toBe(true);
    expect(level5.result?.cantripAuto).toBe(false);
    expect(level5.result?.source).toBe('focus-auto');
    expect(level5.result?.appliedRank).toBe(3);
    const detail = mobSpellChipDetail(level5);
    expect(detail).toContain('cast at rank 3 (focus spell, auto-heightened)');
    // The provenance line names the FOCUS rule, never the cantrip one.
    expect(detail).toContain('heightening: focus-auto');
    expect(detail).not.toContain('cantrip-auto');

    // The DIFFERENTIAL at another level, which no caller-side constant could do.
    const level9 = mobSpellChips([{ name: 'Athletic Rush' }], 9, index)[0];
    if (level9 === undefined) throw new Error('no chip');
    expect(level9.result?.appliedRank).toBe(5);
    expect(level9.result?.source).toBe('focus-auto');
  });

  it('lets a focus spell\'s source fixed autoHeightenLevel win over the caster level', async () => {
    const spell = await athleticRush();
    const index = mobSpellIndex([{ name: 'Athletic Rush', spellData: spell }]);

    const chip = mobSpellChips([{ name: 'Athletic Rush', autoHeightenLevel: 6 }], 9, index)[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.result?.appliedRank).toBe(6);
    expect(chip.result?.source).toBe('focus-auto');
  });

  it('honours an explicitly assigned cast rank for a focus spell', async () => {
    const spell = await athleticRush();
    const index = mobSpellIndex([{ name: 'Athletic Rush', spellData: spell }]);

    const chip = mobSpellChips([{ name: 'Athletic Rush', castRank: 4 }], 9, index)[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.result?.appliedRank).toBe(4);
    expect(chip.result?.focusAuto).toBe(false);
    expect(chip.result?.source).toBe('base');
  });

  it('a focus spell on a level-less mob is a LOUD named issue — never a default rank', async () => {
    const spell = await athleticRush();
    const index = mobSpellIndex([{ name: 'Athletic Rush', spellData: spell }]);

    const chips = mobSpellChips([{ name: 'Athletic Rush' }], null, index);
    const chip = chips[0];
    if (chip === undefined) throw new Error('no chip');
    // The NAME resolved, so the chip is not the unresolved state…
    expect(chip.resolved).toBe(true);
    // …but no number was invented: the rule refused and the chip says why.
    expect(chip.result).toBeNull();
    expect(chip.issues.join(' ')).toContain('focus spell');
    expect(chip.issues.join(' ')).toContain('casterLevel');
    // The run-boundary sentence still names the MOB (docs/17 row 184).
    const issues = mobSpellIssues(chips, 'Level-less Warpriest');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('«Level-less Warpriest»');
    expect(issues[0]).toContain('casterLevel');
  });

  it('an invented spell name stays an UNRESOLVED entry and is loud, never dropped', () => {
    const index = mobSpellIndex([]);

    const chips = mobSpellChips([{ name: 'Flameball', castRank: 3 }], 5, index);

    expect(chips).toHaveLength(1);
    const chip = chips[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.resolved).toBe(false);
    expect(chip.result).toBeNull();
    expect(chip.name).toBe('Flameball');
    expect(mobSpellChipDetail(chip)).toContain('Flameball');
    expect(mobSpellChipDetail(chip)).toContain('not in this campaign');
    // The loud issue names BOTH halves (the spell and the mob).
    expect(mobSpellIssues(chips, 'Grix the Alchemist')).toEqual([
      'the mob «Grix the Alchemist» assigns a spell it cannot use: the spell «Flameball» is not in this campaign\'s imported spell library',
    ]);
  });

  it('a prose-only heightening shows the verbatim note and the loud marker, and computes NO number', () => {
    const spell = synthetic({
      rank: 3,
      damage: { '0': { formula: '1d6', type: 'fire', category: null, materials: [] } },
      heightening: null,
      heighteningEntries: [
        { kind: 'fixed', rank: 5, text: 'The damage increases to 3d6.' },
      ],
    });
    const index = mobSpellIndex([{ name: 'Prosey', spellData: spell }]);

    const chip = mobSpellChips([{ name: 'Prosey', castRank: 5 }], 9, index)[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.result?.source).toBe('prose-only');
    expect(chip.result?.valuesSource).toBe('base');
    expect(chip.result?.values.damage.map((entry) => entry.formula)).toEqual(['1d6']);
    const detail = mobSpellChipDetail(chip);
    // The note is verbatim and the marker is loud.
    expect(chip.result?.notes).toEqual(['The damage increases to 3d6.']);
    expect(detail).toContain('The damage increases to 3d6.');
    expect(detail).toContain(PROSE_ONLY_MARKER);
    // The VALUES line is the base formula, not the prose's number.
    expect(detail).toContain('cast at rank 5: 1d6 fire');
  });

  it('surfaces the rule warnings and unparsed lines instead of swallowing them', () => {
    const spell = synthetic({
      rank: 3,
      damage: { '0': { formula: '6d6', type: 'fire', category: null, materials: [] } },
      heightening: { type: 'interval', interval: 2, area: 0, damage: { '0': '2d6' } },
      heighteningEntries: [{ kind: 'increment', increment: 2, text: 'The damage increases by 2d6.' }],
      heighteningUnparsed: ['Heightened (special) something the parser could not classify.'],
    });
    const index = mobSpellIndex([{ name: 'Slow Burn', spellData: spell }]);

    // Rank 4 is one rank above the base for a (+2) spell: no whole step applies
    // and the leftover is named, never hidden.
    const chip = mobSpellChips([{ name: 'Slow Burn', castRank: 4 }], 9, index)[0];
    if (chip === undefined) throw new Error('no chip');
    expect(chip.result?.stepRemainder).toBe(1);
    const detail = mobSpellChipDetail(chip);
    expect(detail).toContain('left over');
    expect(detail).toContain('unparsed-heightening: Heightened (special)');
  });

  it('a legacy row with no assignments resolves to no chips at all', () => {
    const index = mobSpellIndex([]);
    expect(mobSpellChips(undefined, 5, index)).toEqual([]);
    expect(mobSpellChips(null, 5, index)).toEqual([]);
    expect(mobSpellChips([], 5, index)).toEqual([]);
  });
});

describe('mob caster level is the stat block level', () => {
  it.each([
    ['5', 5],
    ['  12 ', 12],
    ['-1', -1],
    ['0', 0],
    ['1/2', null],
    ['—', null],
    ['', null],
    ['CR 5', null],
  ])('reads %j as %j', (level, expected) => {
    expect(mobCasterLevel(level)).toBe(expected);
  });

  it('uses the source expression for the maximum castable rank', () => {
    expect(maxCastableRank(1)).toBe(1);
    expect(maxCastableRank(5)).toBe(3);
    expect(maxCastableRank(20)).toBe(10);
  });
});

/**
 * THE AGREEMENT PIN for the ONE Paizo cantrip-rank rule (docs/17 row 194, the
 * fold appended to it): the vocabulary's eligibility cap, the rank a cantrip
 * is cast at and the rank an auto-heightened focus spell is cast at are the
 * SAME rule. The fold's whole value is that these three cannot drift, so this
 * drives all three consumers over the same caster levels and requires one
 * number. Level 7 → 4 and 9 → 5 are the pinned cells: the arithmetic is not
 * the trivial double/halve and both sit inside the 1..10 clamp.
 */
describe('the Paizo cantrip-rank rule is ONE number for all three consumers', () => {
  const cantrip = synthetic({ rank: 0, cantrip: true });
  const focus = synthetic({ rank: 1, traits: ['focus'] });

  it.each([
    [1, 1],
    [7, 4],
    [9, 5],
    [10, 5],
    [20, 10],
  ])('agrees at caster level %i on rank %i', (level, expected) => {
    // The shared number AND the Paizo rule's own value: the three consumers
    // agreeing on a WRONG number (one that drifted together) must red too.
    expect(pf2eCantripRankFor(level)).toBe(expected);
    expect(maxCastableRank(level)).toBe(expected);
    expect(spellAtRank(cantrip, { casterLevel: level }).appliedRank).toBe(expected);
    expect(spellAtRank(focus, { casterLevel: level }).appliedRank).toBe(expected);
  });

  it('is PF2e ONLY — a dnd5e cantrip never reaches the Paizo rank rule', () => {
    // Row 194 dispatches on the payload's OWN system before any PF2e arm, so
    // the same caster level that gives a PF2e cantrip rank 5 gives this 5e
    // cantrip its own slot-level answer instead.
    const result = spellAtRank(dnd5eSpell(), { casterLevel: 9, characterLevel: 9 });
    expect(result.appliedRank).toBe(0);
    expect(result.cantripAuto).toBe(false);
    expect(result.cantripScaling).toBe(true);
    expect(pf2eCantripRankFor(9)).toBe(5);
    expect(result.appliedRank).not.toBe(pf2eCantripRankFor(9));
  });
});

describe('the prompt vocabulary offers the REAL library, bounded and honest', () => {
  const entries = [
    { name: 'Fireball', rank: 3, cantrip: false },
    { name: 'Ignition', rank: 0, cantrip: true },
    { name: 'Wish', rank: 10, cantrip: false },
    { name: 'Magic Missile', rank: 1, cantrip: false },
  ];

  it('keeps cantrips and the ranks a caster of that level can reach', () => {
    const vocabulary = mobSpellVocabulary(entries, 5);
    expect(vocabulary.lines).toEqual([
      'Ignition — Cantrip',
      'Magic Missile — Rank 1',
      'Fireball — Rank 3',
    ]);
    expect(vocabulary.total).toBe(3);
  });

  it('offers everything when the caster level is unknown (no guessed level)', () => {
    expect(mobSpellVocabulary(entries, null).lines).toHaveLength(4);
  });

  it('windows a huge corpus deterministically', () => {
    const many = Array.from({ length: MOB_SPELL_VOCABULARY_LIMIT + 25 }, (_, position) => ({
      name: `Spell ${String(position).padStart(4, '0')}`,
      rank: 1,
      cantrip: false,
    }));
    const vocabulary = mobSpellVocabulary(many, 20);
    expect(vocabulary.lines).toHaveLength(MOB_SPELL_VOCABULARY_LIMIT);
    expect(vocabulary.total).toBe(MOB_SPELL_VOCABULARY_LIMIT + 25);
  });
});

describe('the ONE comparable-name form decides what a name means', () => {
  it('folds NFC and case through the shared alias comparison, never a hand-rolled one', () => {
    const spell = synthetic();
    const index = mobSpellIndex([{ name: 'Müller', spellData: spell }]);
    // A DECOMPOSED spelling (u + U+0308) is the same name — the exact case the
    // shared comparison was built for (docs/17 row 162).
    const chips = mobSpellChips([{ name: 'MU\u0308LLER' }], 3, index);
    expect(chips[0]?.resolved).toBe(true);
  });
});

/**
 * The dnd5e half of the mob-spell resolver (docs/17 row 194). The payload
 * shape mirrors the REAL corpus documents the dnd5e importer maps (Fire Bolt's
 * whole-die cantrip scaling, Fireball's whole-die slot scaling, Magic Missile's
 * prose-only empty scaling mode) and the ASSIGNMENT shape the importer stamps
 * onto a caster creature's stat block (level as the cast rank, cantrips
 * rankless, the creature's own character/caster level).
 */
function dnd5eSpell(over: Partial<SpellData> = {}): SpellData {
  return spellDataSchema.parse({
    system: 'dnd5e',
    rank: 0,
    cantrip: true,
    traditions: [],
    school: 'evo',
    filterAxis: 'school',
    properties: ['vocal', 'somatic'],
    traits: [],
    rarity: 'common',
    cast: { time: '1 action', range: '120 ft.', target: '1 creature', duration: 'Instantaneous' },
    damage: { 0: { formula: '1d10', type: 'fire', category: null, materials: [] } },
    upcast: {
      baseLevel: 0,
      sentence: '',
      parts: [
        {
          index: 0,
          formula: '1d10',
          number: 1,
          denomination: 10,
          bonus: '',
          types: ['fire'],
          scaling: { mode: 'whole', number: 1, formula: '' },
        },
      ],
    },
    ...over,
  });
}

function dnd5eFireball(): SpellData {
  return dnd5eSpell({
    rank: 3,
    cantrip: false,
    upcast: {
      baseLevel: 3,
      sentence:
        'When you cast this spell using a spell slot of 4th level or higher, the damage increases by 1d6 for each slot level above 3rd.',
      parts: [
        {
          index: 0,
          formula: '8d6',
          number: 8,
          denomination: 6,
          bonus: '',
          types: ['fire'],
          scaling: { mode: 'whole', number: 1, formula: '' },
        },
      ],
    },
    damage: { 0: { formula: '8d6', type: 'fire', category: null, materials: [] } },
  });
}

/** The one chip a single-assignment resolver call must produce. */
function onlyChip(chips: ReturnType<typeof mobSpellChips>): NonNullable<ReturnType<typeof mobSpellChips>[number]> {
  const chip = chips[0];
  if (chip === undefined) throw new Error('expected one chip');
  return chip;
}

describe('the dnd5e arm of the ONE resolver (row 194)', () => {
  it('THE CANTRIP TRAP: a 5e cantrip on a level-5 and a level-11 creature NEVER shows the PF2e rank/damage progression', () => {
    const index = mobSpellIndex([{ name: 'Fire Bolt', spellData: dnd5eSpell() }]);

    const atFive = mobSpellChips(
      [{ name: 'Fire Bolt', casterLevel: 5 }],
      null,
      index,
    );
    const atEleven = mobSpellChips(
      [{ name: 'Fire Bolt', casterLevel: 11 }],
      null,
      index,
    );

    // PF2E'S RULE WOULD PRINT rank 3 / rank 6. The 5e cantrip stays at level 0
    // (`appliedRank`) and its dice follow the SYSTEM'S OWN tier expression.
    expect(atFive[0]?.result?.appliedRank).toBe(0);
    expect(atEleven[0]?.result?.appliedRank).toBe(0);
    expect(atFive[0]?.result?.cantripAuto).toBe(false);
    expect(atFive[0]?.result?.cantripScaling).toBe(true);
    expect(atFive[0]?.result?.values.damage.map((entry) => entry.formula)).toEqual(['2d10']);
    expect(atEleven[0]?.result?.values.damage.map((entry) => entry.formula)).toEqual(['3d10']);
    // The chip's OWN noun is dnd5e's: a level, never a PF2e rank.
    const detail = mobSpellChipDetail(onlyChip(atFive));
    expect(detail).toContain('cast at level 0');
    expect(detail).toContain('upcasting: upcast');
    expect(detail).not.toContain('cast at rank');
    expect(detail).not.toContain('cantrip-auto');
  });

  it('a PF2e cantrip beside it keeps the byte-identical PF2e behaviour', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    const index = mobSpellIndex([{ name: 'Ignition', spellData: ignition }]);
    const atFive = mobSpellChips([{ name: 'Ignition' }], 5, index);
    expect(atFive[0]?.result?.appliedRank).toBe(3);
    expect(atFive[0]?.result?.cantripAuto).toBe(true);
    expect(atFive[0]?.result?.cantripScaling).toBe(false);
    expect(mobSpellChipDetail(onlyChip(atFive))).toContain('cast at rank 3');
  });

  it('a caster creature assigns a levelled spell at its SOURCE level and the resolver scales it there', () => {
    const index = mobSpellIndex([{ name: 'Fireball', spellData: dnd5eFireball() }]);
    // The importer's assignment: level 3 = the cast rank.
    const chips = mobSpellChips([{ name: 'Fireball', castRank: 3 }], 6, index);
    expect(chips[0]?.resolved).toBe(true);
    expect(chips[0]?.system).toBe('dnd5e');
    expect(chips[0]?.result?.appliedRank).toBe(3);
    expect(chips[0]?.result?.values.damage.map((entry) => entry.formula)).toEqual(['8d6']);
    const detail = mobSpellChipDetail(onlyChip(chips));
    expect(detail).toContain('cast at level 3');
    expect(detail).toContain('8d6 fire');
    // The source's own sentence rides the chip, whether or not the structured
    // scaling answered.
    expect(detail).toContain('the damage increases by 1d6 for each slot level above 3rd');
  });

  it('a name the corpus lacks stays a LOUD unresolved chip, never dropped and never prose', () => {
    const index = mobSpellIndex([{ name: 'Fire Bolt', spellData: dnd5eSpell() }]);
    const chips = mobSpellChips([{ name: 'Eldritch Blast' }], 5, index);
    expect(chips[0]?.resolved).toBe(false);
    expect(chips[0]?.result).toBeNull();
    expect(chips[0]?.system).toBeNull();
    const detail = mobSpellChipDetail(onlyChip(chips));
    expect(detail).toContain('Eldritch Blast');
    expect(detail).toContain('not in this campaign');
    expect(mobSpellIssues(chips, 'Cult Mage')).toEqual([
      'the mob «Cult Mage» assigns a spell it cannot use: the spell «Eldritch Blast» is not in this campaign\'s imported spell library',
    ]);
  });

  it('a dnd5e assignment level is never applied to a PF2e spell (loud, not ignored)', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    const index = mobSpellIndex([{ name: 'Ignition', spellData: ignition }]);
    const chips = mobSpellChips([{ name: 'Ignition', casterLevel: 9 }], 5, index);
    expect(chips[0]?.resolved).toBe(true);
    expect(chips[0]?.result).toBeNull();
    expect(chips[0]?.issues[0]).toContain('caster/character level cannot apply');
  });
});
