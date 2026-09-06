import { describe, expect, it } from 'vitest';

import { stampNewEntity } from '@/domain/entity';
import {
  DND5E_COIN_LADDER,
  PF2E_COIN_LADDER,
  formatItemText,
  itemDataSchema,
  normalizeDnd5ePrice,
  normalizePf2ePrice,
  type ItemData,
} from '@/domain/itemData';
import { ruleChunkSchema } from '@/domain/rulebook';

describe('coin ladders (12-BESTIARY-PACKS §12, binding)', () => {
  it('pin the printed 10:1 staircase with cp as the base coin', () => {
    expect(PF2E_COIN_LADDER).toEqual({ cp: 1, sp: 10, gp: 100, pp: 1000 });
    // dnd5e adds electrum: 1 ep = 5 sp.
    expect(DND5E_COIN_LADDER).toEqual({ cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 });
  });
});

describe('normalizePf2ePrice', () => {
  it('sums a single-coin map into cp', () => {
    expect(normalizePf2ePrice({ value: { sp: 2 } })).toEqual({ priceCp: 20, priceDisplay: '2 sp' });
    expect(normalizePf2ePrice({ value: { gp: 1 } })).toEqual({ priceCp: 100, priceDisplay: '1 gp' });
    expect(normalizePf2ePrice({ value: { cp: 1 } })).toEqual({ priceCp: 1, priceDisplay: '1 cp' });
  });

  it('renders multi-coin maps in descending denomination order', () => {
    expect(normalizePf2ePrice({ value: { gp: 1, sp: 5 } })).toEqual({
      priceCp: 150,
      priceDisplay: '1 gp, 5 sp',
    });
    expect(normalizePf2ePrice({ value: { cp: 3, gp: 2, sp: 1 } })).toEqual({
      priceCp: 213,
      priceDisplay: '2 gp, 1 sp, 3 cp',
    });
  });

  it('skips zero-filled coins in the display but not from the sum', () => {
    // The live v14-dev serialization zero-fills the other coins
    // (Dawnfire Beacon: {cp:0, gp:45, pp:0, sp:0} — prints "45 gp").
    expect(normalizePf2ePrice({ value: { cp: 0, gp: 45, pp: 0, sp: 0 } })).toEqual({
      priceCp: 4500,
      priceDisplay: '45 gp',
    });
  });

  it('divides by the bundle count `per` for the canonical per-unit price', () => {
    // Arrows: {sp:1} per 10 — "1 sp (per 10)" → 1 cp each.
    expect(normalizePf2ePrice({ value: { sp: 1 }, per: 10 })).toEqual({
      priceCp: 1,
      priceDisplay: '1 sp (per 10)',
    });
    // `per: 1` (Rations stores it explicitly) is the no-op default: no suffix.
    expect(normalizePf2ePrice({ value: { sp: 4 }, per: 1 })).toEqual({
      priceCp: 40,
      priceDisplay: '4 sp',
    });
  });

  it('maps an empty or all-zero coin map to no stated price (null / "—")', () => {
    expect(normalizePf2ePrice({ value: {} })).toEqual({ priceCp: null, priceDisplay: '—' });
    expect(normalizePf2ePrice({ value: { cp: 0, gp: 0, pp: 0, sp: 0 } })).toEqual({
      priceCp: null,
      priceDisplay: '—',
    });
  });

  it('fails loudly on unknown coins, bad amounts, and bad bundle counts', () => {
    expect(() => normalizePf2ePrice({ value: { gp: 1, tibnar: 2 } })).toThrow('unsupported pf2e price coin "tibnar"');
    expect(() => normalizePf2ePrice({ value: { sp: -1 } })).toThrow('unsupported pf2e price coin amount');
    expect(() => normalizePf2ePrice({ value: { sp: Number.NaN } })).toThrow('unsupported pf2e price coin amount');
    expect(() => normalizePf2ePrice({ value: { sp: 1 }, per: 0 })).toThrow('unsupported price bundle count');
    expect(() => normalizePf2ePrice({ value: { sp: 1 }, per: -2 })).toThrow('unsupported price bundle count');
  });
});

describe('normalizeDnd5ePrice', () => {
  it('converts a value+denomination pair into cp and keeps the display verbatim', () => {
    expect(normalizeDnd5ePrice({ value: 10, denomination: 'gp' })).toEqual({ priceCp: 1000, priceDisplay: '10 gp' });
    expect(normalizeDnd5ePrice({ value: 2, denomination: 'cp' })).toEqual({ priceCp: 2, priceDisplay: '2 cp' });
    expect(normalizeDnd5ePrice({ value: 2, denomination: 'ep' })).toEqual({ priceCp: 100, priceDisplay: '2 ep' });
    expect(normalizeDnd5ePrice({ value: 3, denomination: 'pp' })).toEqual({ priceCp: 3000, priceDisplay: '3 pp' });
  });

  it('maps an absent price to no stated price and keeps a stated 0 a real 0', () => {
    expect(normalizeDnd5ePrice(null)).toEqual({ priceCp: null, priceDisplay: '—' });
    expect(normalizeDnd5ePrice(undefined)).toEqual({ priceCp: null, priceDisplay: '—' });
    expect(normalizeDnd5ePrice({ value: 0, denomination: 'gp' })).toEqual({ priceCp: 0, priceDisplay: '0 gp' });
  });

  it('fails loudly on an unknown denomination or a negative amount', () => {
    expect(() => normalizeDnd5ePrice({ value: 5, denomination: 'gems' })).toThrow('unsupported dnd5e price coin "gems"');
    expect(() => normalizeDnd5ePrice({ value: -1, denomination: 'gp' })).toThrow('unsupported dnd5e price coin amount');
  });
});

describe('formatItemText', () => {
  const pf2eItem: ItemData = {
    system: 'pathfinder2e',
    category: 'weapon',
    level: 0,
    priceDisplay: '1 gp',
    priceCp: 100,
    rarity: 'common',
    traits: ['versatile-p'],
    rulesEdition: null,
  };

  it('renders the pf2e summary line, description and trait line deterministically', () => {
    // The description arrives already stripped — the adapters own HTML
    // stripping; formatItemText is a pure function of the normalized payload.
    expect(formatItemText(pf2eItem, 'One-edged or two-edged swords.')).toBe(
      'weapon · Level 0 · 1 gp · common\nOne-edged or two-edged swords.\nTraits: versatile-p',
    );
  });

  it('omits absent parts instead of placeholders (5e item without level/rarity)', () => {
    const shield: ItemData = {
      system: 'dnd5e',
      category: 'equipment',
      level: null,
      priceDisplay: '10 gp',
      priceCp: 1000,
      rarity: '',
      traits: [],
      rulesEdition: '2024',
    };
    expect(formatItemText(shield, 'You gain the Armor Class benefit.')).toBe(
      'equipment · 10 gp · 2024 rules\nYou gain the Armor Class benefit.',
    );
  });

  it('keeps the stated "—" price and renders no description line when empty', () => {
    const priceless: ItemData = { ...pf2eItem, priceDisplay: '—', priceCp: null, traits: [] };
    expect(formatItemText(priceless, '  ')).toBe('weapon · Level 0 · — · common');
  });

  it('round-trips through itemDataSchema', () => {
    expect(itemDataSchema.parse(pf2eItem)).toEqual(pf2eItem);
  });
});

describe('item chunks in ruleChunkSchema (additive, no migration)', () => {
  const base = {
    ...stampNewEntity(1),
    bookId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    pageStart: 1,
    pageEnd: 1,
    headingPath: ['Longsword'],
    text: 'weapon · Level 0 · 1 gp · common',
    statBlock: null,
    contentHash: 'a'.repeat(64),
  };

  it('parses a pre-arc row without itemData to no item payload (old-row safety)', () => {
    // `.nullish()` is deliberate: raw pre-arc rows genuinely lack the key,
    // so the parsed value is undefined — never a masked null.
    const chunk = ruleChunkSchema.parse({ ...base, chunkType: 'statblock' });
    expect(chunk.itemData).toBeUndefined();
  });

  it('parses an item chunk with a validated payload', () => {
    const item: ItemData = {
      system: 'pathfinder2e',
      category: 'weapon',
      level: 0,
      priceDisplay: '1 gp',
      priceCp: 100,
      rarity: 'common',
      traits: ['versatile-p'],
      rulesEdition: null,
    };
    const chunk = ruleChunkSchema.parse({ ...base, chunkType: 'item', itemData: item });
    expect(chunk.chunkType).toBe('item');
    expect(chunk.itemData).toEqual(item);
  });

  it('accepts the legacy chunk types unchanged', () => {
    for (const chunkType of ['section', 'statblock', 'table'] as const) {
      expect(() => ruleChunkSchema.parse({ ...base, chunkType })).not.toThrow();
    }
  });

  it('rejects a null itemData default replacement with a non-object payload', () => {
    expect(() => ruleChunkSchema.parse({ ...base, chunkType: 'item', itemData: { category: '' } })).toThrow();
  });
});
