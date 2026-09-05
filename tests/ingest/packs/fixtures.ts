/**
 * Fixture builders for the pack import tests: a pf2e creature document in the
 * exact shape of the Foundry VTT PF2e system packs (fields verified against
 * foundryvtt/pf2e `v14-dev` — see docs/12-BESTIARY-PACKS.md §3). Note the
 * v14-dev perception placement: top-level `system.perception`, NOT
 * `system.attributes.perception` (moved in the v14 schema; verified against
 * the live Monster Core corpus).
 */

interface MeleeItem {
  name: string;
  type: 'melee';
  system: {
    bonus: { value: number };
    damageRolls: Record<string, { damage: string; damageType: string }>;
    attackEffects?: { value: string[] };
    traits?: { value: string[] };
    description?: { value: string };
  };
}

interface ActionItem {
  name: string;
  type: 'action';
  system: {
    actionType?: { value: string };
    description?: { value: string };
    traits?: { value: string[] };
  };
}

export type Pf2eItem = MeleeItem | ActionItem;

export function meleeItem(overrides: Partial<MeleeItem> = {}): MeleeItem {
  const base: MeleeItem = {
    name: 'Sickle',
    type: 'melee',
    system: {
      bonus: { value: 8 },
      damageRolls: { d1: { damage: '1d4+3', damageType: 'slashing' } },
      attackEffects: { value: ['Grab'] },
      traits: { value: ['agile', 'finesse'] },
      description: { value: '' },
    },
  };
  return {
    ...base,
    ...overrides,
    system: { ...base.system, ...overrides.system },
  };
}

export function actionItem(
  name: string,
  actionType: string,
  description: string,
  traits: string[] = [],
): ActionItem {
  return {
    name,
    type: 'action',
    system: {
      actionType: { value: actionType },
      description: { value: description },
      traits: { value: traits },
    },
  };
}

export function baseNpc(name = 'Charau-ka'): Record<string, unknown> {
  return {
    _id: 'test-npc-id',
    name,
    type: 'npc',
    img: null,
    items: [
      meleeItem(),
      actionItem(
        'Shrieking Frenzy',
        'free',
        '<p><strong>Trigger</strong> The charau-ka\'s turn begins.</p><p><strong>Effect</strong> The charau-ka is @UUID[Compendium.pf2e.conditionitems.Item.Quickened] until the end of its turn.</p>',
        ['primal'],
      ),
      actionItem(
        'Thrown Weapon Mastery',
        'passive',
        '<p>When the charau-ka throws a weapon, the weapon gains the deadly d6 weapon trait.</p>',
      ),
      { name: 'Hide Armor', type: 'armor', system: {} },
    ],
    system: {
      abilities: {
        cha: { mod: 0 },
        con: { mod: 2 },
        dex: { mod: 3 },
        int: { mod: -1 },
        str: { mod: 3 },
        wis: { mod: 1 },
      },
      attributes: {
        ac: { details: '', value: 18 },
        hp: { details: '', max: 18, temp: 0, value: 18 },
        speed: { otherSpeeds: [{ type: 'climb', value: 25 }], value: 25 },
      },
      // v14-dev: perception lives at the system top level, not under
      // `attributes` (verified against the live Monster Core corpus).
      perception: {
        details: '',
        mod: 6,
        senses: [{ type: 'darkvision' }, { acuity: 'imprecise', range: 30, type: 'scent' }],
      },
      details: {
        blurb: '',
        languages: { details: '', value: ['draconic', 'mwangi'] },
        level: { value: 1 },
        publicNotes: '',
      },
      saves: {
        fortitude: { saveDetail: '', value: 7 },
        reflex: { saveDetail: '', value: 8 },
        will: { saveDetail: '', value: 4 },
      },
      skills: { athletics: { base: 6 }, religion: { base: 4 }, stealth: { base: 6 } },
      traits: {
        rarity: 'common',
        size: { value: 'sm' },
        value: ['chaotic', 'charau-ka', 'evil', 'humanoid'],
      },
    },
  };
}

export function folderDoc(name = 'Book 1: Hellknight Hill'): Record<string, unknown> {
  return { _id: 'folder-id', name, type: 'Folder' };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
