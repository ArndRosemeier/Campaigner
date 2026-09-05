import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  FOUNDRY_DND5E_SRD_ADAPTER_ID,
  foundryDnd5eSrdAdapter,
} from '@/ingest/packs/dnd5e-foundry';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import { collectPackRoster } from '@/llm/encounterRoster';

import type { PackFileParse } from '@/ingest/packs/types';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'dnd5e');

function fixtureYaml(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function fixtureBytes(name: string): Uint8Array {
  return new TextEncoder().encode(fixtureYaml(name));
}

async function parseYaml(name: string, yaml = fixtureYaml(name)): Promise<PackFileParse> {
  return foundryDnd5eSrdAdapter.parseFile(name, new TextEncoder().encode(yaml));
}

describe('foundry-dnd5e-srd adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await parseYaml('ape.yml');
    await parseYaml('kobold.yml');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps ape.yml onto an exact score-based StatBlock (§10 acceptance)', async () => {
    const parsed = await parseYaml('ape.yml');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failures).toHaveLength(0);

    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Ape');
    // fix-02 D4 fold: PackEntry carries only name/statBlock/text — roster
    // ordering derives from the persisted statBlock (level = '1/2' below).
    expect(entry?.statBlock.extras.Traits).toBe('beast');

    const block = entry?.statBlock;
    // 12-BESTIARY-PACKS §10: abilities.str = 16, ac = 12, hp = 19 with
    // hpFormula "3d8 + 6" — dnd5e ability scores map directly, no conversion.
    expect(block?.system).toBe('dnd5e');
    expect(block?.abilities.str).toBe(16);
    expect(block?.abilities).toEqual({ str: 16, dex: 14, con: 14, int: 6, wis: 12, cha: 7 });
    expect(block?.ac).toBe(12);
    expect(block?.hp).toBe(19);
    expect(block?.hpFormula).toBe('3d8 + 6');
    expect(block?.level).toBe('1/2');
    expect(block?.size).toBe('Medium');
    expect(block?.creatureType).toBe('beast');
    expect(block?.speed).toBe('30 feet, climb 30 feet');
    expect(block?.saves).toBe('');
    expect(block?.skills).toBe('Athletics +5, Perception +3');
    expect(block?.senses).toBe('passive Perception 13');
    expect(block?.languages).toBe('');
    expect(block?.extras.Traits).toBe('beast');
    expect(block?.extras['Ability modifiers']).toBe(
      'Str +3, Dex +2, Con +2, Int -2, Wis +1, Cha -2',
    );
    expect(block?.extras.Alignment).toBe('Unaligned');
    expect(block?.extras.Environment).toBe('Forest');
  });

  it('renders ape weapon items as attack lines and feats by activation', async () => {
    const parsed = await parseYaml('ape.yml');
    const block = parsed.entries[0]?.statBlock;

    // Fist: STR 16 (+3) + proficiency bonus +2 (CR 1/2) = +5.
    // Rock: natural ranged weapon → DEX +2 + proficiency +2 = +4, damage +2.
    expect(block?.actions.map((action) => action.name)).toEqual(['Fist +5', 'Rock +4', 'Multiattack']);
    expect(block?.actions[0]?.text).toBe('1d6+3 bludgeoning');
    expect(block?.actions[1]?.text).toBe('1d6+2 bludgeoning (range 25/50 ft.)');
    expect(block?.actions[2]?.text).toBe('The monster makes two fist attacks.');
    expect(block?.traits).toEqual([]);
    expect(block?.reactions).toEqual([]);
  });

  it('renders the plain-text stat block with resolved link notation', async () => {
    const parsed = await parseYaml('ape.yml');
    const text = parsed.entries[0]?.text ?? '';
    expect(text).toContain('Ape — CR 1/2');
    expect(text).toContain('Medium, beast');
    expect(text).toContain('AC 12; HP 19 (3d8 + 6)');
    expect(text).toContain('Speed 30 feet, climb 30 feet');
    expect(text).toContain('Str 16 (+3), Dex 14 (+2), Con 14 (+2), Int 6 (-2), Wis 12 (+1), Cha 7 (-2)');
    expect(text).toContain('Melee Fist +5, 1d6+3 bludgeoning');
    expect(text).toContain('Ranged Rock +4, 1d6+2 bludgeoning (range 25/50 ft.)');
    expect(text).toContain('Multiattack — The monster makes two fist attacks.');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('[[lookup');
    expect(text).not.toContain('&reference');
  });

  it('maps proficiency levels to printed save and skill strings (wolf)', async () => {
    const parsed = await parseYaml('wolf.yml');
    expect(parsed.entries).toHaveLength(1);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Wolf');
    expect(entry?.statBlock.level).toBe('1/4');

    const block = entry?.statBlock;
    expect(block?.level).toBe('1/4');
    expect(block?.hp).toBe(11);
    expect(block?.hpFormula).toBe('2d8 + 2');
    expect(block?.speed).toBe('40 feet');
    // prc/ste value 1 → proficient: ability mod + proficiency bonus (CR 1/4 → +2).
    expect(block?.skills).toBe('Perception +3, Stealth +4');
    expect(block?.senses).toBe('passive Perception 13');
    expect(block?.languages).toBe('');
    // Natural finesse attack uses the better of Str/Dex (15 → +2): Bite +4.
    expect(block?.actions.map((action) => action.name)).toEqual(['Bite +4']);
    expect(block?.actions[0]?.text).toBe('2d4+2 piercing (finesse)');
    // Feats without activities are the printed traits.
    expect(block?.traits.map((trait) => trait.name)).toEqual(['Keen Hearing and Smell', 'Pack Tactics']);
    expect(block?.traits[0]?.text).toBe(
      'The monster has advantage on Wisdom (Perception) checks that rely on hearing or smell.',
    );
    expect(block?.reactions).toEqual([]);
    expect(entry?.text).toContain('Keen Hearing and Smell The monster has advantage');
  });

  it('maps CR 1/8, subtype tags, senses and languages (kobold)', async () => {
    const parsed = await parseYaml('kobold.yml');
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Kobold');
    // Subtype tags stay in extras.Traits ("humanoid, kobold") for the roster.
    expect(entry?.statBlock.extras.Traits).toBe('humanoid, kobold');

    const block = entry?.statBlock;
    expect(block?.level).toBe('1/8');
    expect(block?.size).toBe('Small');
    expect(block?.creatureType).toBe('humanoid');
    expect(block?.hp).toBe(5);
    expect(block?.hpFormula).toBe('2d6 - 2');
    expect(block?.senses).toBe('Darkvision 60 ft., passive Perception 8');
    expect(block?.languages).toBe('Common, Draconic');
    expect(block?.skills).toBe('');
    expect(block?.extras.Traits).toBe('humanoid, kobold');
    expect(block?.extras.Alignment).toBe('Lawful Evil');
    // Finesse dagger (DEX 15 → +2) beats STR 7 (-2): +2 + proficiency +2 = +4.
    expect(block?.actions.map((action) => action.name)).toEqual(['Dagger +4', 'Sling +4']);
    expect(block?.actions[0]?.text).toBe('1d4+2 piercing (finesse, light)');
    expect(block?.actions[1]?.text).toBe('1d4+2 bludgeoning (ammunition, range 30/120 ft.)');
  });

  it('derives the exact armor-wearer AC the old schema rejected (goblin)', async () => {
    // Real document, trimmed: packs/_source/monsters/humanoid/goblin.yml @
    // 6.0.x. It stores `ac: {flat: null, calc: default}` plus equipped
    // Leather Armor (11) and Shield (2) — the OLD schema failed this exact
    // document loudly ("no flat Armor Class stored"). The derivation follows
    // the dnd5e system's published formula (§5): 11 + min(dexMod 2, no cap)
    // + shield 2 = 15, with the gear names as the printed acNote — exactly
    // the printed SRD value "15 (Leather Armor, Shield)".
    const parsed = await parseYaml('goblin.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.ac).toBe(15);
    expect(block?.acNote).toBe('Leather Armor, Shield');
    expect(parsed.entries[0]?.text).toContain('AC 15 (Leather Armor, Shield); HP 7 (2d6)');
    // Real goblin attacks: scimitar stores `ability: dex` (finesse) → +4.
    // Nimble Escape (bonus-action check feat) buckets to actions.
    expect(block?.actions.map((action) => action.name)).toEqual([
      'Scimitar +4',
      'Shortbow +4',
      'Nimble Escape',
    ]);
    expect(block?.actions[0]?.text).toBe('1d6+2 slashing (finesse, light)');
    expect(block?.actions[1]?.text).toBe('1d6+2 piercing (two-handed, ammunition, range 80/320 ft.)');
    // ste value 2 = expertise (the printed SRD goblin has Stealth +6).
    expect(block?.skills).toBe('Stealth +6');
  });

  it('maps the satyr (another calc-default armor wearer) exactly', async () => {
    // Real document, trimmed: packs/_source/monsters/fey/satyr.yml @ 6.0.x.
    // Printed SRD: AC 14 (Leather Armor) = 11 + Dex +3 (no cap on light).
    const parsed = await parseYaml('satyr.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.ac).toBe(14);
    expect(block?.acNote).toBe('Leather Armor');
    expect(block?.level).toBe('1/2');
    expect(block?.actions.map((action) => action.name)).toEqual([
      'Shortbow +5',
      'Shortsword +5',
      'Ram +3',
    ]);
  });

  it('maps custom base-damage formulas exactly (badger, saber-toothed tiger)', async () => {
    // Real documents, trimmed: packs/_source/monsters/beast/badger.yml and
    // beast/saber-toothed-tiger.yml @ 6.0.x. Both store dice-less bases with
    // `custom.enabled` formulas — the OLD "has no base damage" failure class.
    // The badger's flat "1" renders without a sign; the tiger's
    // "1d10 + @mod + 1" resolves @mod to the attack's STR modifier (+4):
    // 1d10+5 and 2d6+5, exactly the system's roll-data semantics.
    const badger = await parseYaml('badger.yml');
    expect(badger.failures).toEqual([]);
    expect(badger.entries[0]?.statBlock.actions.map((action) => [action.name, action.text])).toEqual([
      ['Bite -1', '1 piercing'],
    ]);

    const tiger = await parseYaml('saber-toothed-tiger.yml');
    expect(tiger.failures).toEqual([]);
    expect(tiger.entries[0]?.statBlock.actions.map((action) => action.name)).toEqual([
      'Bite +6',
      'Claw +6',
      'Pounce',
    ]);
    expect(tiger.entries[0]?.statBlock.actions[0]?.text).toBe('1d10+5 piercing');
    expect(tiger.entries[0]?.statBlock.actions[1]?.text).toBe('2d6+5 slashing');
  });

  it('maps ability "none" attacks without an ability modifier (camel)', async () => {
    // Real document, trimmed: packs/_source/monsters/beast/camel.yml @ 6.0.x.
    // `attack.ability: "none"` + stored bonus "3": to-hit = proficiency +2 +
    // stored 3 = +5 (the printed SRD value), and the damage carries NO ability
    // modifier: 1d4. The OLD adapter failed with unknown ability "none".
    const parsed = await parseYaml('camel.yml');
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.actions.map((action) => [action.name, action.text])).toEqual([
      ['Bite +5', '1d4 bludgeoning'],
    ]);
  });

  it('maps flat attacks, stored numeric bonuses and multi-type damage (tiny animated object)', async () => {
    // Real document, trimmed: packs/_source/monsters/summons/
    // tiny-animated-object.yml @ 6.0.x. Pins four corpus classes at once:
    // `attack.flat: true` (stored bonus 8 IS the to-hit), `details.cr: null`
    // (the system's printed "—"), numeric-string movement (`walk: "30"`,
    // `units: null`) — all rejected by the old schema.
    const parsed = await parseYaml('tiny-animated-object.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.level).toBe('—');
    expect(block?.ac).toBe(18);
    expect(block?.speed).toBe('30 feet');
    expect(block?.actions.map((action) => [action.name, action.text])).toEqual([
      ['Slam +8', '1d4 bludgeoning piercing slashing'],
    ]);
  });

  it('maps null movement/sense scalars and hover (arcane eye)', async () => {
    // Real document, trimmed: packs/_source/monsters/summons/arcane-eye.yml
    // @ 6.0.x. Its summons document stores `burrow/climb/swim: null`,
    // `walk: 0`, `units: null` and `senses.units: null` — the old schema's
    // invalid_type failure class. Nulls mean the system defaults (0 / 'ft').
    const parsed = await parseYaml('arcane-eye.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.speed).toBe('fly 30 feet (hover)');
    expect(block?.senses).toBe('passive Perception 5');
    expect(block?.level).toBe('0');
  });

  it('maps the CR-less avatar of death to the printed "—" level', async () => {
    // Real document, trimmed: packs/_source/monsters/undead/avatar-of-death.yml
    // @ 6.0.x. `details.cr: null` is the system's printed "—"; its
    // proficiency is stored-null too. parseLevelSort orders "—" after every
    // leveled creature in the roster.
    const parsed = await parseYaml('avatar-of-death.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.level).toBe('—');
    expect(block?.ac).toBe(20);
    expect(block?.hp).toBe(1);
    expect(parsed.entries[0]?.text).toContain('Avatar of Death — CR —');
    expect(parsed.entries[0]?.text).toContain('Speed 60 feet, fly 60 feet (hover)');
  });

  it('renders damage-less attacks without a damage term (roper tendril)', async () => {
    // Real document, trimmed: packs/_source/monsters/monstrosity/roper.yml
    // @ 6.0.x. The Tendril stores no damage at all (it only grapples): the
    // line renders "Melee Tendril +7" without a damage term or trailing
    // comma — exact, not best-effort.
    const parsed = await parseYaml('roper.yml');
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.text).toContain('Melee Bite +7, 4d8+4 piercing');
    expect(parsed.entries[0]?.text).toContain('Melee Tendril +7');
    expect(parsed.entries[0]?.statBlock.actions.find((action) => action.name === 'Tendril +7')?.text).toBe('');
  });

  it('resolves attack.ability "spellcasting" from the stored caster ability (lich)', async () => {
    // Real document, trimmed: packs/_source/monsters/undead/lich.yml @ 6.0.x
    // (Paralyzing Touch weapon + one trait kept). `attack.ability:
    // "spellcasting"` resolves to `system.attributes.spellcasting` ("int"):
    // Int +5 (20) + proficiency +7 (CR 21) = +12, damage 3d6+5.
    const parsed = await parseYaml('lich.yml');
    expect(parsed.failures).toEqual([]);
    const block = parsed.entries[0]?.statBlock;
    expect(block?.level).toBe('21');
    expect(block?.saves).toBe('Con +10, Int +12, Wis +9');
    expect(block?.actions.find((action) => action.name === 'Paralyzing Touch +12')?.text).toBe(
      '3d6+5 cold',
    );
  });

  it('keeps the loud failure for unresolvable stored damage formulas', async () => {
    // The arcane hand's Clenched Fist stores a summon-level dice-count
    // formula "(4 + 2 * (@flags.dnd5e.summon.level - 5))d8" whose flag is
    // absent from the document — no exact value exists, so the entry stays a
    // loud failure (12-BESTIARY-PACKS §1: exact, never best-effort). This is
    // the single documented corpus exclusion (docs/12 §4).
    const unresolvable = fixtureYaml('saber-toothed-tiger.yml').replace(
      "formula: 1d10 + @mod + 1",
      "formula: (4 + 2 * (@flags.dnd5e.summon.level - 5))d8",
    );
    const parsed = await parseYaml('unresolvable.yml', unresolvable);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.failures[0]?.message).toContain('unsupported damage formula');
  });

  it('keeps the loud failures for unsupported armor shapes', async () => {
    // Two unsupported gear shapes stay loud (exact-or-loud, §1/§4): a second
    // equipped armor piece (the system warns and uses the first) and an
    // equipped armor with no numeric value.
    const twoArmors = fixtureYaml('goblin.yml').replace(
      '        value: shield\n        baseItem: \'\'',
      '        value: medium\n        baseItem: \'\'',
    ).replace(
      '        value: 2\n        dex: null\n        magicalBonus: null',
      '        value: 14\n        dex: 2\n        magicalBonus: null',
    ).replace('name: Shield', 'name: Breastplate');
    const doubleArmor = await parseYaml('two-armors.yml', twoArmors);
    expect(doubleArmor.failures[0]?.message).toContain('multiple equipped armors');

    const valueless = fixtureYaml('goblin.yml').replace(
      '        value: 11\n        dex: null',
      '        value: null\n        dex: null',
    );
    const noValue = await parseYaml('valueless.yml', valueless);
    expect(noValue.failures[0]?.message).toContain('has no armor value');
  });

  it('accepts a string CR and fails unsupported CRs loudly', async () => {
    const stringCr = await parseYaml('wolf-cr.yml', fixtureYaml('wolf.yml').replace('cr: 0.25', "cr: '1/4'"));
    expect(stringCr.entries[0]?.statBlock.level).toBe('1/4');

    const weirdCr = await parseYaml('wolf-cr.yml', fixtureYaml('wolf.yml').replace('cr: 0.25', 'cr: 0.75'));
    expect(weirdCr.entries).toHaveLength(0);
    expect(weirdCr.failures[0]?.message).toContain('unsupported CR "0.75"');
  });

  it('skips non-NPC documents (counted, not failed)', async () => {
    const multi =
      `${fixtureYaml('wolf.yml')}\n---\nname: Encounter Map\ntype: vehicle\n---\n42\n`;
    const parsed = await parseYaml('mixed.yml', multi);
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Wolf']);
    expect(parsed.skipped).toBe(2);
    expect(parsed.failures).toHaveLength(0);
  });

  it('fails the file loudly when it is empty or not valid YAML', async () => {
    await expect(
      foundryDnd5eSrdAdapter.parseFile('empty.yml', new TextEncoder().encode('   ')),
    ).rejects.toThrow('empty.yml: file is empty');
    await expect(
      foundryDnd5eSrdAdapter.parseFile('broken.yml', new TextEncoder().encode('name: [unclosed')),
    ).rejects.toThrow('broken.yml: invalid YAML');
  });

  it('collects creature validation failures without aborting the file', async () => {
    const missingHp = fixtureYaml('wolf.yml').replace('max: 11', 'max: "eleven"');
    const unknownSize = fixtureYaml('wolf.yml').replace('size: med', 'size: colossal');

    const mixed = `${fixtureYaml('ape.yml')}\n---\n${missingHp}\n---\n${unknownSize}`;
    const parsed = await parseYaml('mixed.yml', mixed);
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Ape']);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0]?.name).toBe('Wolf');
    expect(parsed.failures[0]?.message).toContain('max');
    expect(parsed.failures[1]?.name).toBe('Wolf');
    expect(parsed.failures[1]?.message).toContain('unknown size "colossal"');
  });

  it('is registered and resolves through the registry', () => {
    expect(PACK_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'foundry-pf2e',
      FOUNDRY_DND5E_SRD_ADAPTER_ID,
    ]);
    const adapter = getPackAdapter('foundry-dnd5e-srd');
    expect(adapter.system).toBe('dnd5e');
    expect(adapter.extensions).toContain('.yml');
    expect(adapter.label).toContain('D&D 5e');
    // §2: the CC-BY-4.0 attribution is stored on the book verbatim.
    expect(adapter.license).toContain('CC-BY-4.0');
    expect(adapter.license).toContain('SRD');
    expect(adapter.license).toContain('not for redistribution');
    expect(() => getPackAdapter('foundry-4e')).toThrow(
      'unknown pack adapter "foundry-4e" (available: foundry-pf2e, foundry-dnd5e-srd)',
    );
  });
});

describe('dnd5e pack roster integration (12-BESTIARY-PACKS §7/§11)', () => {
  it('imports a dnd5e pack and orders the roster by fractional CR', async () => {
    const persisted: RuleChunk[][] = [];
    const deps: PackImportDeps = {
      createBook: (input) =>
        Promise.resolve({
          id: crypto.randomUUID(),
          createdAt: 1,
          updatedAt: 1,
          title: input.title,
          system: input.system,
          filename: input.filename,
          pageCount: 0,
          status: 'processing',
          errorMessage: '',
          origin: 'pack',
          packMeta: null,
        }),
      persistChunks: (chunks) => {
        persisted.push(chunks);
        return Promise.resolve();
      },
      finalizeBook: (id, packMeta) =>
        Promise.resolve({
          id,
          createdAt: 1,
          updatedAt: 1,
          title: 'SRD Bestiary',
          system: 'dnd5e',
          filename: 'srd-bestiary.zip',
          pageCount: 0,
          status: 'ready',
          errorMessage: '',
          origin: 'pack',
          packMeta,
        }),
      failBook: () => Promise.resolve(),
    };
    const result = await importPack(
      'foundry-dnd5e-srd',
      [
        { name: 'ape.yml', bytes: fixtureBytes('ape.yml') },
        { name: 'kobold.yml', bytes: fixtureBytes('kobold.yml') },
        { name: 'wolf.yml', bytes: fixtureBytes('wolf.yml') },
        { name: 'avatar-of-death.yml', bytes: fixtureBytes('avatar-of-death.yml') },
      ],
      { title: 'SRD Bestiary', deps },
    );
    expect(result.imported).toBe(4);

    // The roster re-derives levelSort from the printed CR via parseLevelSort
    // (1/8 < 1/4 < 1/2) and carries the 5e type + subtype tags from extras.
    // The CR-less "—" avatar sorts after every leveled creature.
    const roster = await collectPackRoster('dnd5e', {
      listBooks: () => Promise.resolve([result.book]),
      listChunks: () => Promise.resolve(persisted.flat()),
    });
    expect(roster.lines).toEqual([
      'Kobold (1/8, humanoid, kobold)',
      'Wolf (1/4, beast)',
      'Ape (1/2, beast)',
      'Avatar of Death (—, undead)',
    ]);
    const chunks = persisted.flat();
    expect(roster.chunkByName.get('ape')).toBe(chunks[0]?.id);
    expect(roster.chunkByName.get('kobold')).toBe(chunks[1]?.id);
  });
});
