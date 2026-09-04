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

  it('fails a creature without a stored flat AC loudly (armor-derived Goblin)', async () => {
    const parsed = await parseYaml('goblin.yml');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.file).toBe('goblin.yml');
    expect(parsed.failures[0]?.name).toBe('Goblin');
    expect(parsed.failures[0]?.message).toContain('no flat Armor Class');
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
      ],
      { title: 'SRD Bestiary', deps },
    );
    expect(result.imported).toBe(3);

    // The roster re-derives levelSort from the printed CR via parseLevelSort
    // (1/8 < 1/4 < 1/2) and carries the 5e type + subtype tags from extras.
    const roster = await collectPackRoster('dnd5e', {
      listBooks: () => Promise.resolve([result.book]),
      listChunks: () => Promise.resolve(persisted.flat()),
    });
    expect(roster.lines).toEqual([
      'Kobold (1/8, humanoid, kobold)',
      'Wolf (1/4, beast)',
      'Ape (1/2, beast)',
    ]);
    const chunks = persisted.flat();
    expect(roster.chunkByName.get('ape')).toBe(chunks[0]?.id);
    expect(roster.chunkByName.get('kobold')).toBe(chunks[1]?.id);
  });
});
