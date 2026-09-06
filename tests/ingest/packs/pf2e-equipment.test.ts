import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID,
  foundryPf2eEquipmentAdapter,
  PF2E_ITEM_TYPES,
} from '@/ingest/packs/pf2e-equipment';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import type { PackFileParse, PackItemEntry } from '@/ingest/packs/types';

import { baseNpc, encodeJson, folderDoc } from './fixtures';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e-equipment');

/**
 * Fixture source paths (verbatim-trimmed live documents, docs/12 §10 lesson).
 * Trimmed to the consumed subset (name/type/system.level/system.price/
 * system.traits/system.description) plus a few unknown keys that must be
 * ignored (`_id`, `img`, `publication`, `items`, `bulk`, `rules`).
 */
export const SOURCE_PATHS: Readonly<Record<string, string>> = {
  'longsword.json': 'packs/pf2e/equipment/longsword.json @ v14-dev',
  'chain-mail.json': 'packs/pf2e/equipment/chain-mail.json @ v14-dev',
  'arrows.json': 'packs/pf2e/equipment/arrows.json @ v14-dev',
  'dawnfire-beacon.json': 'packs/pf2e/equipment/dawnfire-beacon.json @ v14-dev',
  'backpack.json': 'packs/pf2e/equipment/backpack.json @ v14-dev',
  'torch.json': 'packs/pf2e/equipment/torch.json @ v14-dev',
  'rations.json': 'packs/pf2e/equipment/rations.json @ v14-dev',
  'alabaster-idol.json': 'packs/pf2e/equipment/alabaster-idol.json @ v14-dev',
  'anointing-oil.json': 'packs/pf2e/equipment/anointing-oil.json @ v14-dev',
  'steel-shield.json': 'packs/pf2e/equipment/steel-shield.json @ v14-dev',
  'adventurers-pack.json': 'packs/pf2e/equipment/adventurers-pack.json @ v14-dev',
};

function fixtureBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

async function parseFile(name: string): Promise<PackFileParse> {
  return foundryPf2eEquipmentAdapter.parseFile(name, fixtureBytes(name));
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

describe('foundry-pf2e-equipment adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await parseFile('longsword.json');
    await parseFile('arrows.json');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is registered with the item entry noun', () => {
    expect(getPackAdapter(FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID).id).toBe(FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID);
    expect(PACK_ADAPTERS.map((adapter) => adapter.entryNoun)).toContain('item');
  });

  it('maps the longsword (weapon, single-coin price) onto an exact item payload', async () => {
    const entry = await firstItem('longsword.json');
    expect(entry.name).toBe('Longsword');
    expect(entry.item).toEqual({
      system: 'pathfinder2e',
      category: 'weapon',
      level: 0,
      priceDisplay: '1 gp',
      priceCp: 100,
      rarity: 'common',
      traits: ['versatile-p'],
      rulesEdition: null,
    });
    expect(entry.text).toContain('weapon · Level 0 · 1 gp · common');
    expect(entry.text).toContain('Traits: versatile-p');
    // The known unknown keys of the source doc are consumed but not re-serialized.
    expect('publication' in (entry as unknown as Record<string, unknown>)).toBe(false);
  });

  it('divides by the bundle count for ammunition (Arrows: 1 sp per 10 → 1 cp each)', async () => {
    const entry = await firstItem('arrows.json');
    expect(entry.item.category).toBe('ammo');
    expect(entry.item.priceCp).toBe(1);
    expect(entry.item.priceDisplay).toBe('1 sp (per 10)');
    expect(entry.text).toContain('1 sp (per 10)');
  });

  it('sums zero-filled multi-coin maps (Dawnfire Beacon: {cp:0,gp:45,pp:0,sp:0})', async () => {
    const entry = await firstItem('dawnfire-beacon.json');
    expect(entry.item.category).toBe('equipment');
    expect(entry.item.level).toBe(3);
    expect(entry.item.rarity).toBe('uncommon');
    expect(entry.item.priceCp).toBe(4500);
    expect(entry.item.priceDisplay).toBe('45 gp');
    expect(entry.item.traits).toEqual(['aura', 'light', 'magical']);
  });

  it('treats an explicit `per: 1` as the no-op default (Rations)', async () => {
    const entry = await firstItem('rations.json');
    expect(entry.item.category).toBe('consumable');
    expect(entry.item.priceCp).toBe(40);
    expect(entry.item.priceDisplay).toBe('4 sp');
  });

  it('maps a kit document with a null level (Adventurer\'s Pack)', async () => {
    const entry = await firstItem('adventurers-pack.json');
    expect(entry.item.category).toBe('kit');
    expect(entry.item.level).toBeNull();
    expect(entry.item.priceCp).toBe(150);
    expect(entry.item.priceDisplay).toBe('15 sp');
    expect(entry.text.startsWith('kit · 15 sp · common')).toBe(true);
  });

  it('covers every accepted item type with a pinned real document', async () => {
    const pins: Readonly<Record<string, { file: string; priceCp: number }>> = {
      weapon: { file: 'longsword.json', priceCp: 100 },
      armor: { file: 'chain-mail.json', priceCp: 600 },
      shield: { file: 'steel-shield.json', priceCp: 200 },
      equipment: { file: 'torch.json', priceCp: 1 },
      consumable: { file: 'rations.json', priceCp: 40 },
      treasure: { file: 'alabaster-idol.json', priceCp: 1000 },
      ammo: { file: 'arrows.json', priceCp: 1 },
      backpack: { file: 'backpack.json', priceCp: 10 },
      kit: { file: 'adventurers-pack.json', priceCp: 150 },
    };
    expect([...PF2E_ITEM_TYPES].sort()).toEqual(Object.keys(pins).sort());
    for (const [category, pin] of Object.entries(pins)) {
      const entry = await firstItem(pin.file);
      expect(entry.item.category, pin.file).toBe(category);
      expect(entry.item.priceCp, pin.file).toBe(pin.priceCp);
    }
  });

  it('keeps the leveled consumable\'s rarity and level (Anointing Oil)', async () => {
    const entry = await firstItem('anointing-oil.json');
    expect(entry.item.level).toBe(4);
    expect(entry.item.rarity).toBe('uncommon');
    expect(entry.item.priceCp).toBe(1800);
    expect(entry.item.rulesEdition).toBeNull();
  });

  it('skips non-item documents by design and counts them (folders, NPCs)', async () => {
    const bytes = new TextEncoder().encode(
      [JSON.stringify(folderDoc()), JSON.stringify(baseNpc('Charau-ka'))].join('\n'),
    );
    const result = await foundryPf2eEquipmentAdapter.parseFile('mixed.db', bytes);
    expect(result.entries).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(2);
    expect(result.failures).toEqual([]);
  });

  it('accepts NDJSON .db files (legacy pack format)', async () => {
    const longsword = JSON.parse(readFileSync(join(FIXTURE_DIR, 'longsword.json'), 'utf8')) as unknown;
    const arrows = JSON.parse(readFileSync(join(FIXTURE_DIR, 'arrows.json'), 'utf8')) as unknown;
    const ndjson = `${JSON.stringify(longsword)}\n${JSON.stringify(arrows)}\n`;
    const result = await foundryPf2eEquipmentAdapter.parseFile(
      'equipment.db',
      new TextEncoder().encode(ndjson),
    );
    expect(result.items?.map((entry) => entry.name)).toEqual(['Longsword', 'Arrows']);
    expect(result.failures).toEqual([]);
  });

  it('fails the file loudly when empty or unparseable', async () => {
    await expect(foundryPf2eEquipmentAdapter.parseFile('empty.json', new Uint8Array())).rejects.toThrow(
      'file is empty',
    );
    await expect(
      foundryPf2eEquipmentAdapter.parseFile('bad.json', new TextEncoder().encode('{nope')),
    ).rejects.toThrow('not valid JSON');
  });

  it('collects a loud per-entry failure on an unsupported coin (never a silent zero)', async () => {
    const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, 'longsword.json'), 'utf8')) as {
      system: { price: { value: Record<string, number> } };
    };
    doc.system.price.value = { gp: 1, tibnar: 2 };
    const result = await foundryPf2eEquipmentAdapter.parseFile(
      'hostile.json',
      new TextEncoder().encode(JSON.stringify(doc)),
    );
    expect(result.items).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain('unsupported pf2e price coin "tibnar"');
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
          system: 'pathfinder2e',
          filename: 'equipment.json',
          pageCount: 0,
          status: 'ready',
          errorMessage: '',
          origin: 'pack',
          packMeta,
        }),
      failBook: () => Promise.resolve(),
    };
    const result = await importPack(
      FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID,
      [
        { name: 'longsword.json', bytes: fixtureBytes('longsword.json') },
        { name: '_folders.json', bytes: encodeJson(folderDoc()) },
      ],
      { title: 'PF2e Equipment', deps },
    );
    expect(result.imported).toBe(1);
    expect(result.itemsImported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.book.packMeta?.itemsImported).toBe(1);
    const chunk = persisted.flat()[0];
    expect(chunk?.chunkType).toBe('item');
    expect(chunk?.statBlock).toBeNull();
    expect(chunk?.itemData?.category).toBe('weapon');
  });

  it('parses every committed fixture with zero failures (corpus sweep pin)', async () => {
    const names = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(11);
    for (const name of names) {
      const parsed = await parseFile(name);
      expect(parsed.failures, name).toEqual([]);
      expect(parsed.items?.length ?? 0, name).toBe(1);
      // The SOURCE_PATHS map pins every fixture to its live upstream path.
      expect(SOURCE_PATHS[name], name).toBeDefined();
    }
  });
});
