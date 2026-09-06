import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  DND5E_ITEM_TYPES,
  FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID,
  foundryDnd5eEquipmentAdapter,
} from '@/ingest/packs/dnd5e-equipment';
import { DND5E_PROPERTY_LABELS } from '@/ingest/packs/dnd5e-foundry';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import type { PackItemEntry } from '@/ingest/packs/types';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'dnd5e-equipment');

/**
 * Fixture source paths (verbatim-trimmed live documents, docs/12 §10 lesson).
 * Trimmed to the consumed subset (name/type/system.description.value/
 * system.price/system.rarity/system.source.rules/system.properties) plus
 * unknown keys that must be ignored (`_id`, `ownership`, `system.quantity`,
 * `system.weight`, `system.type`).
 */
export const SOURCE_PATHS: Readonly<Record<string, string>> = {
  'longsword.yml': 'packs/_source/equipment24/weapons/martial-melee/longsword.yml @ 6.0.x',
  'shield.yml': 'packs/_source/equipment24/armor/shield.yml @ 6.0.x',
  'candle.yml': 'packs/_source/equipment24/adventuring-gear/candle.yml @ 6.0.x',
  'bag-of-beans.yml': 'packs/_source/equipment24/consumables/bag-of-beans.yml @ 6.0.x',
  'chain-mail.yml': 'packs/_source/items/armor/chain-mail.yml @ 6.0.x',
  'chicken.yml': 'packs/_source/tradegoods/chicken.yml @ 6.0.x',
  'copper.yml': 'packs/_source/tradegoods/copper.yml @ 6.0.x',
};

function fixtureBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

async function parseFile(name: string): Promise<ReturnType<typeof foundryDnd5eEquipmentAdapter.parseFile>> {
  return foundryDnd5eEquipmentAdapter.parseFile(name, fixtureBytes(name));
}

async function firstItem(name: string): Promise<PackItemEntry> {
  const parsed = await parseFile(name);
  expect(parsed.failures).toEqual([]);
  const items = parsed.items ?? [];
  expect(items, `${name} must yield exactly one item entry`).toHaveLength(1);
  expect(parsed.skipped).toBe(0);
  const item = items[0];
  if (item === undefined) throw new Error(`unreachable: ${name} asserted to have one item`);
  return item;
}

describe('foundry-dnd5e-equipment adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await parseFile('longsword.yml');
    await parseFile('chicken.yml');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is registered with the item entry noun', () => {
    expect(getPackAdapter(FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID).id).toBe(FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID);
    expect(PACK_ADAPTERS.map((adapter) => adapter.entryNoun).filter((noun) => noun === 'item')).toHaveLength(2);
  });

  it('maps the longsword (weapon, gp price, property label) exactly', async () => {
    const entry = await firstItem('longsword.yml');
    expect(entry.name).toBe('Longsword');
    expect(entry.item).toEqual({
      system: 'dnd5e',
      category: 'weapon',
      level: null,
      priceDisplay: '15 gp',
      priceCp: 1500,
      rarity: '',
      traits: ['versatile'],
      rulesEdition: '2024',
    });
    expect(entry.text).toContain('weapon · 15 gp');
    expect(entry.text).toContain('Traits: versatile');
    expect(entry.text.startsWith('weapon · 15 gp · 2024 rules')).toBe(true);
  });

  it('maps the shield (armor-as-equipment, 10 gp, 2024 rules)', async () => {
    const entry = await firstItem('shield.yml');
    expect(entry.item.category).toBe('equipment');
    expect(entry.item.priceCp).toBe(1000);
    expect(entry.item.priceDisplay).toBe('10 gp');
    expect(entry.item.rulesEdition).toBe('2024');
    expect(entry.item.traits).toEqual([]);
  });

  it('maps the cp-denominated candle (the sub-gold denomination case)', async () => {
    const entry = await firstItem('candle.yml');
    expect(entry.item.category).toBe('consumable');
    expect(entry.item.priceCp).toBe(1);
    expect(entry.item.priceDisplay).toBe('1 cp');
  });

  it('keeps the rare rarity verbatim (Bag of Beans, 2000 gp)', async () => {
    const entry = await firstItem('bag-of-beans.yml');
    expect(entry.item.rarity).toBe('rare');
    expect(entry.item.priceCp).toBe(200000);
    expect(entry.item.priceDisplay).toBe('2000 gp');
    expect(entry.item.rulesEdition).toBe('2024');
  });

  it('maps the 2014-rules chain mail from the items pack', async () => {
    const entry = await firstItem('chain-mail.yml');
    expect(entry.item.category).toBe('equipment');
    expect(entry.item.priceCp).toBe(7500);
    expect(entry.item.rulesEdition).toBe('2014');
  });

  it('maps trade goods (loot, sub-gold coins, 2014 rules)', async () => {
    const chicken = await firstItem('chicken.yml');
    expect(chicken.item).toMatchObject({ category: 'loot', priceCp: 2, priceDisplay: '2 cp', rulesEdition: '2014' });
    const copper = await firstItem('copper.yml');
    expect(copper.item).toMatchObject({ category: 'loot', priceCp: 50, priceDisplay: '5 sp', rulesEdition: '2014' });
  });

  it('covers every accepted item type with a pinned real document', async () => {
    const pins: Readonly<Record<string, string>> = {
      weapon: 'longsword.yml',
      equipment: 'shield.yml',
      consumable: 'candle.yml',
      loot: 'chicken.yml',
    };
    expect([...DND5E_ITEM_TYPES].sort()).toEqual(Object.keys(pins).concat('tool').sort());
    for (const [category, file] of Object.entries(pins)) {
      const entry = await firstItem(file);
      expect(entry.item.category, file).toBe(category);
    }
    // tool is in the corpus (37 + 37 documents) but has no dedicated fixture;
    // the type is accepted by construction (same mapEquipment path).
    expect(DND5E_ITEM_TYPES.has('tool')).toBe(true);
  });

  it('keeps unknown property slugs raw instead of dropping them', () => {
    expect(DND5E_PROPERTY_LABELS.ver).toBe('versatile');
    expect(DND5E_PROPERTY_LABELS.zzz).toBeUndefined();
    const doc = {
      name: 'Odd Blade',
      type: 'weapon',
      system: {
        description: { value: '<p>A blade.</p>' },
        price: { value: 1, denomination: 'gp' },
        rarity: '',
        properties: ['ver', 'zvire'],
        source: { rules: '2024' },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    return foundryDnd5eEquipmentAdapter.parseFile('odd-blade.yml', bytes).then((parsed) => {
      expect(parsed.failures).toEqual([]);
      expect(parsed.items?.[0]?.item.traits).toEqual(['versatile', 'zvire']);
    });
  });

  it('skips non-item documents by design and counts them (folders, NPCs)', async () => {
    const npc = {
      name: 'Bandit',
      type: 'npc',
      system: { description: { value: '' } },
    };
    const folder = 'name: Equipment\nflags: {}\n';
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(npc)}\n---\n${folder}\n`,
    );
    const result = await foundryDnd5eEquipmentAdapter.parseFile('mixed.yml', bytes);
    expect(result.entries).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('fails the file loudly when empty or unparseable', async () => {
    await expect(foundryDnd5eEquipmentAdapter.parseFile('empty.yml', new Uint8Array())).rejects.toThrow(
      'file is empty',
    );
    await expect(
      foundryDnd5eEquipmentAdapter.parseFile('bad.yml', new TextEncoder().encode('name: [unclosed')),
    ).rejects.toThrow('not valid YAML');
  });

  it('collects a loud per-entry failure on an unsupported coin (never a silent zero)', async () => {
    const doc = {
      name: 'Strange Coin',
      type: 'loot',
      system: {
        description: { value: '' },
        price: { value: 5, denomination: 'bit' },
        rarity: '',
        source: { rules: '2024' },
      },
    };
    const result = await foundryDnd5eEquipmentAdapter.parseFile(
      'hostile.yml',
      new TextEncoder().encode(JSON.stringify(doc)),
    );
    expect(result.items).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain('unsupported dnd5e price coin "bit"');
  });

  it('feeds the importPack item lane end-to-end (item book, itemsImported)', async () => {
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
          title: id,
          system: 'dnd5e',
          filename: 'equipment.yml',
          pageCount: 0,
          status: 'ready',
          errorMessage: '',
          origin: 'pack',
          packMeta,
        }),
      failBook: () => Promise.resolve(),
    };
    const result = await importPack(
      FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID,
      [
        { name: 'longsword.yml', bytes: fixtureBytes('longsword.yml') },
        { name: 'chicken.yml', bytes: fixtureBytes('chicken.yml') },
      ],
      { title: 'D&D 5e Equipment', deps },
    );
    expect(result.imported).toBe(2);
    expect(result.itemsImported).toBe(2);
    expect(result.book.packMeta?.itemsImported).toBe(2);
    const chunk = persisted.flat()[0];
    expect(chunk?.chunkType).toBe('item');
    expect(chunk?.statBlock).toBeNull();
    expect(chunk?.itemData?.rulesEdition).toBe('2024');
  });

  it('parses every committed fixture with zero failures (corpus sweep pin)', async () => {
    const names = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.yml'));
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      const parsed = await parseFile(name);
      expect(parsed.failures, name).toEqual([]);
      expect(parsed.items?.length ?? 0, name).toBe(1);
      // The SOURCE_PATHS map pins every fixture to its live upstream path.
      expect(SOURCE_PATHS[name], name).toBeDefined();
    }
  });
});
