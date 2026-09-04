import { afterEach, describe, expect, it, vi } from 'vitest';

import { foundryPf2eAdapter } from '@/ingest/packs/pf2e-foundry';

import { actionItem, baseNpc, encodeJson, folderDoc, meleeItem } from './fixtures';

describe('foundry-pf2e adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await foundryPf2eAdapter.parseFile('goblin.json', encodeJson(baseNpc('Goblin Warrior')));
    await foundryPf2eAdapter.parseFile('pack.db', encodeJson([baseNpc(), folderDoc()]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a creature document onto an exact StatBlock (modifiers → scores)', async () => {
    const parsed = await foundryPf2eAdapter.parseFile('charau-ka.json', encodeJson(baseNpc()));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failures).toHaveLength(0);

    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Charau-ka');
    // fix-02 D4 fold: PackEntry carries only name/statBlock/text — roster
    // ordering derives from the persisted statBlock (level asserted below)
    // and traits stay in extras.Traits (asserted below).

    const block = entry?.statBlock;
    expect(block?.system).toBe('pathfinder2e');
    expect(block?.level).toBe('1');
    expect(block?.size).toBe('Small');
    expect(block?.creatureType).toBe('humanoid');
    // score = 10 + 2·mod (exact inverse of abilityModifier)
    expect(block?.abilities).toEqual({ str: 16, dex: 16, con: 14, int: 8, wis: 12, cha: 10 });
    expect(block?.ac).toBe(18);
    expect(block?.acNote).toBe('');
    expect(block?.hp).toBe(18);
    expect(block?.hpFormula).toBe('');
    expect(block?.speed).toBe('25 feet, climb 25 feet');
    expect(block?.saves).toBe('Fort +7, Ref +8, Will +4');
    expect(block?.skills).toBe('Athletics +6, Religion +4, Stealth +6');
    expect(block?.senses).toBe('Perception +6; darkvision, imprecise scent 30 feet');
    expect(block?.languages).toBe('Draconic, Mwangi');
    expect(block?.extras['Ability modifiers']).toBe('Str +3, Dex +3, Con +2, Int -1, Wis +1, Cha +0');
    expect(block?.extras.Traits).toBe('chaotic, charau-ka, evil, humanoid');
    expect(block?.extras.Rarity).toBeUndefined();
  });

  it('splits items into attacks, actions, reactions and passive traits', async () => {
    const parsed = await foundryPf2eAdapter.parseFile('charau-ka.json', encodeJson(baseNpc()));
    const block = parsed.entries[0]?.statBlock;

    const sickle = block?.actions.find((action) => action.name === 'Sickle +8');
    expect(sickle?.text).toBe('1d4+3 slashing; (agile, finesse); Grab');
    // free action → actions, passive → traits, carried armor ignored
    expect(block?.actions.some((action) => action.name === 'Shrieking Frenzy')).toBe(true);
    expect(block?.traits).toEqual([
      {
        name: 'Thrown Weapon Mastery',
        text: 'When the charau-ka throws a weapon, the weapon gains the deadly d6 weapon trait.',
      },
    ]);
    expect(block?.reactions).toEqual([]);
  });

  it('renders a plain-text stat block with stripped HTML and resolved notation', async () => {
    const parsed = await foundryPf2eAdapter.parseFile('charau-ka.json', encodeJson(baseNpc()));
    const text = parsed.entries[0]?.text ?? '';
    expect(text).toContain('Charau-ka — Creature 1');
    expect(text).toContain('Small, chaotic, charau-ka, evil, humanoid');
    expect(text).toContain('AC 18; HP 18');
    expect(text).toContain('Melee Sickle +8, 1d4+3 slashing');
    expect(text).toContain('Thrown Weapon Mastery When the charau-ka throws a weapon');
    expect(text).toContain('Quickened'); // @UUID[…Item.Quickened] resolved
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('@UUID');
  });

  it('handles rare traits, HP details and non-common rarity via extras', async () => {
    const doc = baseNpc('Uncommon Beast');
    const system = doc.system as Record<string, unknown>;
    system.traits = {
      rarity: 'uncommon',
      size: { value: 'lg' },
      value: ['animal'],
    };
    const attributes = system.attributes as Record<string, unknown>;
    attributes.hp = { details: 'regeneration 5 (iron)', max: 42, temp: 0, value: 42 };
    const parsed = await foundryPf2eAdapter.parseFile('beast.json', encodeJson(doc));
    const block = parsed.entries[0]?.statBlock;
    expect(block?.size).toBe('Large');
    expect(block?.creatureType).toBe('animal');
    expect(block?.hp).toBe(42);
    expect(block?.extras['HP details']).toBe('regeneration 5 (iron)');
    expect(block?.extras.Rarity).toBe('uncommon');
  });

  it('counts non-creature documents as skipped and parses NDJSON files', async () => {
    const ndjson = [folderDoc(), baseNpc(), baseNpc('Second Creature')]
      .map((doc) => JSON.stringify(doc))
      .join('\n');
    const parsed = await foundryPf2eAdapter.parseFile(
      'bestiary.db',
      new TextEncoder().encode(ndjson),
    );
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failures).toHaveLength(0);
  });

  it('fails the file loudly when it is empty or not parseable', async () => {
    await expect(
      foundryPf2eAdapter.parseFile('empty.json', new TextEncoder().encode('   ')),
    ).rejects.toThrow('empty.json: file is empty');
    await expect(
      foundryPf2eAdapter.parseFile('broken.json', new TextEncoder().encode('{"a": 1}\nnot json')),
    ).rejects.toThrow('broken.json: line 2 is not valid JSON');
  });

  it('collects per-creature mapping failures without aborting the file', async () => {
    const missingLevel = baseNpc('Broken Creature');
    const system = missingLevel.system as Record<string, unknown>;
    const details = system.details as Record<string, unknown>;
    delete details.level;
    const unknownSize = baseNpc('Weird Creature');
    const weirdSystem = unknownSize.system as Record<string, unknown>;
    weirdSystem.traits = { rarity: 'common', size: { value: 'colossal' }, value: [] };

    const ndjson = [missingLevel, baseNpc('Good Creature'), unknownSize]
      .map((doc) => JSON.stringify(doc))
      .join('\n');
    const parsed = await foundryPf2eAdapter.parseFile('mixed.db', new TextEncoder().encode(ndjson));
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Good Creature']);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0]?.name).toBe('Broken Creature');
    expect(parsed.failures[0]?.message).toContain('level');
    expect(parsed.failures[1]?.name).toBe('Weird Creature');
    expect(parsed.failures[1]?.message).toContain('unknown size "colossal"');
  });

  it('maps an attack with multiple damage rolls and a reaction', async () => {
    const doc = baseNpc('Multiattack Creature');
    const items = doc.items as unknown[];
    items.unshift(
      meleeItem({
        name: 'Claw',
        system: {
          bonus: { value: 11 },
          damageRolls: {
            a: { damage: '2d8+4', damageType: 'piercing' },
            b: { damage: '2d6', damageType: 'fire' },
          },
        },
      }),
      actionItem('Retreat', 'reaction', '<p><strong>Trigger</strong> Hit by an attack.</p>'),
    );
    const parsed = await foundryPf2eAdapter.parseFile('multi.json', encodeJson(doc));
    const block = parsed.entries[0]?.statBlock;
    const claw = block?.actions.find((action) => action.name === 'Claw +11');
    expect(claw?.text).toContain('2d8+4 piercing plus 2d6 fire');
    expect(block?.reactions.map((reaction) => reaction.name)).toEqual(['Retreat']);
  });
});
