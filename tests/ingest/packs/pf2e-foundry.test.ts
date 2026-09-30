import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { foundryPf2eAdapter } from '@/ingest/packs/pf2e-foundry';

import { actionItem, baseNpc, encodeJson, folderDoc, meleeItem, spellcastingEntryItem, spellItem } from './fixtures';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e');

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
}

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
    // docs/17 row 171 — this array-shaped file used to parse as ONE document
    // (the array itself), which the adapter skipped: `entries: [], skipped: 1`.
    // It is unwrapped at the seam now, so the creature IMPORTS and the folder
    // is the ONE honest skip. The outcome is asserted, not just "no network".
    const arrayPack = await foundryPf2eAdapter.parseFile(
      'pack.db',
      encodeJson([baseNpc(), folderDoc()]),
    );
    expect(arrayPack.entries.map((entry) => entry.name)).toEqual(['Charau-ka']);
    expect(arrayPack.skipped).toBe(1);
    expect(arrayPack.failures).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps the real v14-dev Wolf document (perception moved to system.perception)', async () => {
    // Real document, trimmed: foundryvtt/pf2e @ v14-dev,
    // packs/pf2e/pathfinder-monster-core/wolf.json (all consumed fields
    // verbatim; presentation subtrees removed). The v14 schema moved
    // perception from `system.attributes.perception` to top-level
    // `system.perception` — the old schema path no longer exists on ANY
    // v14-dev NPC, so this exact document failed before the fix (492/492
    // corpus failures). Senses values below are the live document's.
    const parsed = await foundryPf2eAdapter.parseFile('wolf.json', fixtureBytes('wolf.json'));
    expect(parsed.failures).toEqual([]);
    expect(parsed.skipped).toBe(0);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Wolf');
    const block = entry?.statBlock;
    expect(block?.level).toBe('1');
    expect(block?.creatureType).toBe('animal');
    expect(block?.ac).toBe(15);
    expect(block?.hp).toBe(24);
    expect(block?.speed).toBe('35 feet');
    expect(block?.abilities).toEqual({ str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 });
    expect(block?.saves).toBe('Fort +6, Ref +9, Will +5');
    expect(block?.skills).toBe('Acrobatics +7, Athletics +6, Stealth +7, Survival +7');
    // The pin: perception comes from the moved top-level `system.perception`.
    expect(block?.senses).toBe('Perception +7; low-light-vision, imprecise scent 30 feet');
    expect(block?.actions.find((action) => action.name === 'Jaws +9')?.text).toBe(
      '1d6+2 piercing; (unarmed); knockdown',
    );
    expect(entry?.text).toContain('Perception +7; low-light-vision, imprecise scent 30 feet');
    // A creature whose OWN document carries no `spell` item OMITS the key
    // (docs/17 rows 184/189): the real Wolf has no spell item, so its block is
    // byte-for-byte what it was before this arc.
    expect(block !== undefined && Object.prototype.hasOwnProperty.call(block, 'spells')).toBe(false);
  });

  it('maps a creature document onto an exact StatBlock (modifiers → scores)', async () => {    const parsed = await foundryPf2eAdapter.parseFile('charau-ka.json', encodeJson(baseNpc()));
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
    // The shared baseNpc fixture carries no publication — no invented Source.
    expect(block?.extras.Source).toBeUndefined();
  });

  it('carries the per-entry publication into extras.Source (hygiene rider, docs/12 §15)', async () => {
    // Live shape verified at v14-dev (goblin-commando.json, Monster Core):
    // system.details.publication = {license, remaster, title}.
    const withSource = baseNpc('Goblin Commando');
    const details = (withSource.system as Record<string, unknown>).details as Record<string, unknown>;
    (withSource.system as Record<string, unknown>).details = {
      ...details,
      publication: { license: 'ORC', remaster: true, title: 'Pathfinder Monster Core' },
    };
    const parsed = await foundryPf2eAdapter.parseFile('goblin-commando.json', encodeJson(withSource));
    const block = parsed.entries[0]?.statBlock;
    expect(block?.extras.Source).toBe('Pathfinder Monster Core (ORC)');
    // Title-only shape still surfaces (license omitted from the render).
    const titleOnly = baseNpc('Half-Title');
    const titleDetails = (titleOnly.system as Record<string, unknown>).details as Record<string, unknown>;
    (titleOnly.system as Record<string, unknown>).details = {
      ...titleDetails,
      publication: { license: '', remaster: true, title: 'NPC Gallery' },
    };
    const parsedTitle = await foundryPf2eAdapter.parseFile('x.json', encodeJson(titleOnly));
    expect(parsedTitle.entries[0]?.statBlock.extras.Source).toBe('NPC Gallery');
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

  it('maps a null land speed (fly-only creature) without a base-speed entry', async () => {
    // Real shape: foundryvtt/pf2e @ v14-dev, packs/pf2e/pathfinder-monster-core/
    // banshee.json — `attributes.speed.value: null` with a 60-foot fly other
    // speed. The old schema required a number, so this document failed too.
    const doc = baseNpc('Banshee');
    const system = doc.system as Record<string, unknown>;
    const attributes = system.attributes as Record<string, unknown>;
    attributes.speed = { otherSpeeds: [{ type: 'fly', value: 60 }], value: null };
    const parsed = await foundryPf2eAdapter.parseFile('banshee.json', encodeJson(doc));
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.speed).toBe('fly 60 feet');
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

  it('stamps a real caster\'s OWN spell items as `spells` (name + rank), in source order (docs/17 row 189)', async () => {
    // Real document, BYTE-FOR-BYTE: foundryvtt/pf2e @ v14-dev,
    // packs/pf2e/pathfinder-monster-core/ghost-mage.json
    // (sha256 b1202c2fa6e9e8f1e70073f25b94778f7b01a463ef860876441e106298cc3401).
    // A level-10 caster with ONE `spellcastingEntry` container, 14 embedded
    // `spell` items (5 cantrips) and carried gear — no invented structure.
    const parsed = await foundryPf2eAdapter.parseFile(
      'ghost-mage.json',
      fixtureBytes('ghost-mage.json'),
    );
    expect(parsed.failures).toEqual([]);
    expect(parsed.skipped).toBe(0);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Ghost Mage');
    expect(entry?.statBlock.level).toBe('10');
    expect(entry?.statBlock.spells).toEqual([
      // The source's OWN item order; one entry per `spell` item. The
      // `spellcastingEntry` container ("Arcane Innate Spells") contributes
      // NOTHING, and a cantrip carries NO cast rank even though the source
      // stores its level as 1 (the cantrip rule derives the rank). A ranked
      // entry's cast rank is the source's OWN `location.heightenedLevel` where
      // it states one: "Dispel Magic" is `level.value: 2` but is heightened to
      // 3 (the printed Ghost Mage stat block lists it at 3rd).
      { name: 'Hallucination', castRank: 5 },
      { name: 'Howling Blizzard', castRank: 5 },
      { name: 'Suggestion', castRank: 4 },
      { name: 'Vision of Death', castRank: 4 },
      { name: 'Blindness', castRank: 3 },
      { name: 'Veil of Privacy', castRank: 3 },
      { name: 'Dispel Magic', castRank: 3 },
      { name: 'Telekinetic Maneuver', castRank: 2 },
      { name: 'Detect Magic' },
      { name: 'Enfeeble', castRank: 1 },
      { name: 'Figment' },
      { name: 'Prestidigitation' },
      { name: 'Read Aura' },
      { name: 'Telekinetic Hand' },
    ]);
  });

  it('omits the `spells` key entirely when a creature carries no spell items (docs/17 rows 184/189)', async () => {
    const parsed = await foundryPf2eAdapter.parseFile('charau-ka.json', encodeJson(baseNpc()));
    const block = parsed.entries[0]?.statBlock;
    // "No field" (legacy / no spells) stays distinguishable from "authored,
    // empty": an absent key, never `spells: []`.
    expect(block !== undefined && Object.prototype.hasOwnProperty.call(block, 'spells')).toBe(false);
    // …and the rest of the block is unchanged by this arc.
    expect(block?.ac).toBe(18);
    expect(block?.actions.map((action) => action.name)).toContain('Sickle +8');
    expect(block?.traits.map((trait) => trait.name)).toEqual(['Thrown Weapon Mastery']);
  });

  it('stamps the source name and rank VERBATIM — never normalized, defaulted or invented (docs/17 row 189)', async () => {
    const doc = baseNpc('Test Caster');
    (doc.items as unknown[]).unshift(
      spellItem('arcane-eye', 4, ['concentrate']),
      spellItem('Detect Magic', 1, ['cantrip', 'detection']),
    );
    const parsed = await foundryPf2eAdapter.parseFile('caster.json', encodeJson(doc));
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.spells).toEqual([
      // The source's lower-case spelling survives (normalization would red
      // here) and its own rank 4 survives (a default of 1 would red here).
      { name: 'arcane-eye', castRank: 4 },
      // A cantrip carries NO cast rank, even though the source stores level 1.
      { name: 'Detect Magic' },
    ]);
  });

  it('reads a ranked spell\'s CAST rank from the source\'s own heightened entry (docs/17 row 189)', async () => {
    // The Foundry PF2e system's OWN `SpellPF2e.rank` getter is
    // `system.location.heightenedLevel || baseRank` (measured in upstream
    // `src/module/item/spell/document.ts` @ v14-dev), so the cast rank is the
    // heightened field where the source states one and the item's level
    // otherwise. A cantrip IGNORES a stored heightenedLevel: its rank is the
    // rule's to derive from the caster's level (docs/17 row 183).
    const doc = baseNpc('Test Caster');
    (doc.items as unknown[]).unshift(
      spellItem('Heightened Bolt', 2, ['concentrate'], 4),
      spellItem('Plain Bolt', 3, ['concentrate']),
      spellItem('Auto Cantrip', 1, ['cantrip'], 5),
    );
    const parsed = await foundryPf2eAdapter.parseFile('ranks.json', encodeJson(doc));
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.spells).toEqual([
      { name: 'Heightened Bolt', castRank: 4 },
      { name: 'Plain Bolt', castRank: 3 },
      { name: 'Auto Cantrip' },
    ]);
  });

  it('stamps the REAL Lawbringer Warpriest focus item with NO rank (docs/17 row 191)', async () => {
    // Real document, BYTE-FOR-BYTE: foundryvtt/pf2e @ v14-dev,
    // packs/pf2e/pathfinder-monster-core/lawbringer-warpriest.json
    // (sha256 d6daa2f0d5856e2eae767a64626d65dfc6d1fa477c89b4301a6659becca16cd4,
    // 66,187 bytes) — the creature the brief's measured evidence names. A
    // level-5 caster with TWO `spellcastingEntry` containers (both
    // `autoHeightenLevel.value: null`), 12 embedded `spell` items and carried
    // gear. "Athletic Rush" is the `focus`-trait item: `level.value: 1`, no
    // `heightenedLevel` anywhere; upstream's `SpellPF2e.rank` for it on this
    // actor is clamp(ceil(5 / 2)) = 3, so the importer claims NO rank.
    const parsed = await foundryPf2eAdapter.parseFile(
      'lawbringer-warpriest.json',
      fixtureBytes('lawbringer-warpriest.json'),
    );
    expect(parsed.failures).toEqual([]);
    expect(parsed.skipped).toBe(0);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Lawbringer Warpriest');
    expect(entry?.statBlock.level).toBe('5');
    expect(entry?.statBlock.spells).toEqual([
      { name: 'Blindness', castRank: 3 },
      { name: 'Haste', castRank: 3 },
      { name: 'Enlarge', castRank: 2 },
      // The focus item: no cast rank and (both entries state null) no fixed
      // auto rank — the rank is the mob rule's to derive from the mob's level.
      { name: 'Athletic Rush' },
      { name: 'Daze' },
      { name: 'Divine Lance' },
      { name: 'Forbidding Ward' },
      { name: 'Guidance' },
      { name: 'Harm', castRank: 1 },
      { name: 'Heal', castRank: 1 },
      { name: 'Light' },
      { name: 'Sure Strike', castRank: 1 },
    ]);
  });

  it('carries a FOCUS item\'s source fixed auto rank — item first, else the casting entry (docs/17 row 191)', async () => {
    const doc = baseNpc('Focus Caster');
    (doc.items as unknown[]).unshift(
      spellcastingEntryItem('entry-1', 6),
      // The item states its own fixed rank: it WINS over the entry's.
      spellItem('Item Fixed', 1, ['focus'], undefined, {
        autoHeightenLevel: 4,
        value: 'entry-1',
      }),
      // This one states none: the ENTRY's 6 is carried.
      spellItem('Entry Fixed', 1, ['focus'], undefined, { value: 'entry-1' }),
      // A focus item pointing at an entry that states none carries nothing.
      spellItem('No Fixed', 1, ['focus'], undefined, { value: 'entry-missing' }),
      // A focus item that DOES state `heightenedLevel` still claims no cast
      // rank: upstream ignores it for an auto-heightened spell.
      spellItem('Ignored Heighten', 1, ['focus'], 9, { value: 'entry-missing' }),
      // A ranked NON-focus item keeps row 189's ratified expression.
      spellItem('Plain Bolt', 3, ['concentrate'], 5),
    );
    const parsed = await foundryPf2eAdapter.parseFile('focus.json', encodeJson(doc));
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.spells).toEqual([
      { name: 'Item Fixed', autoHeightenLevel: 4 },
      { name: 'Entry Fixed', autoHeightenLevel: 6 },
      { name: 'No Fixed' },
      { name: 'Ignored Heighten' },
      { name: 'Plain Bolt', castRank: 5 },
    ]);
  });

  it('fails a creature LOUDLY on a malformed spellcastingEntry autoHeightenLevel (docs/17 row 191)', async () => {
    const doc = baseNpc('Broken Entry Caster');
    (doc.items as unknown[]).unshift({
      _id: 'entry-x',
      name: 'Prepared Spells',
      type: 'spellcastingEntry',
      system: { autoHeightenLevel: { value: 'high' } },
    });
    const parsed = await foundryPf2eAdapter.parseFile('broken-entry.json', encodeJson(doc));
    expect(parsed.entries).toEqual([]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.name).toBe('Broken Entry Caster');
  });

  it('ignores a spellcastingEntry container and a carried item that embeds a spell (docs/17 row 189)', async () => {
    const doc = baseNpc('Test Caster');
    (doc.items as unknown[]).unshift(
      // The container the spell items hang from — not a spell.
      {
        name: 'Arcane Prepared Spells',
        type: 'spellcastingEntry',
        system: { slots: {}, tradition: { value: 'arcane' } },
      },
      spellItem('Sure Strike', 1, ['concentrate']),
      // The upstream shape (real: the Lich's "Scroll of Teleport (Rank 6)"): a
      // `consumable` carries a nested `system.spell` OBJECT. It is carried
      // equipment, not the creature's own casting, so it is NOT stamped.
      {
        name: 'Scroll of Teleport (Rank 6)',
        type: 'consumable',
        system: {
          spell: { name: 'Teleport', type: 'spell', system: { level: { value: 6 } } },
        },
      },
    );
    const parsed = await foundryPf2eAdapter.parseFile('scroll.json', encodeJson(doc));
    expect(parsed.failures).toEqual([]);
    expect(parsed.entries[0]?.statBlock.spells).toEqual([{ name: 'Sure Strike', castRank: 1 }]);
  });

  it('fails a malformed `spell` item LOUDLY instead of dropping it as equipment', async () => {
    const doc = baseNpc('Broken Caster');
    // The source typed this item as a spell but carries no rank: never silently
    // fall through the melee/action arms and disappear.
    (doc.items as unknown[]).unshift({
      name: 'Nameless Rank',
      type: 'spell',
      system: { traits: { value: ['concentrate'] } },
    });
    const parsed = await foundryPf2eAdapter.parseFile('broken-caster.json', encodeJson(doc));
    expect(parsed.entries).toEqual([]);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.name).toBe('Broken Caster');
    expect(parsed.failures[0]?.message).toContain('level');
  });
});
