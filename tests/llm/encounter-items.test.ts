import { describe, expect, it } from 'vitest';

import type { Id, Rulebook, RuleChunk } from '@/domain';
import { ruleChunkSchema } from '@/domain';
import type { ItemData } from '@/domain/itemData';
import {
  buildItemPool,
  collectItemPool,
  collectItemPoolWithRetry,
  formatItemPoolSection,
  itemLevelSort,
  itemPoolNameIndex,
  ITEM_POOL_ATTEMPTS,
  ITEM_POOL_LIMIT,
  type ItemPoolDeps,
  type ItemPoolEntry,
} from '@/llm/encounterItems';

function itemData(overrides: Partial<ItemData> = {}): ItemData {
  return {
    system: 'pathfinder2e',
    category: 'treasure',
    level: 0,
    priceDisplay: '10 gp',
    priceCp: 1000,
    rarity: 'common',
    traits: [],
    rulesEdition: null,
    ...overrides,
  };
}

function itemChunk(name: string, data: ItemData, bookId = crypto.randomUUID()): RuleChunk {
  return ruleChunkSchema.parse({
    id: crypto.randomUUID(),
    createdAt: 1,
    updatedAt: 1,
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'item',
    headingPath: [name],
    text: `${name} — treasure · Level 0 · 10 gp · common`,
    statBlock: null,
    itemData: data,
    contentHash: crypto.randomUUID().replaceAll('-', '0').padEnd(64, '0'),
  });
}

function book(overrides: Partial<Rulebook> = {}): Rulebook {
  return {
    id: 'book-1',
    createdAt: 1,
    updatedAt: 1,
    title: 'Equipment',
    system: 'pathfinder2e',
    filename: 'equipment.json',
    pageCount: 0,
    status: 'ready',
    errorMessage: '',
    origin: 'pack',
    packMeta: null,
    ...overrides,
  };
}

function entry(overrides: Partial<ItemPoolEntry> = {}): ItemPoolEntry {
  return {
    name: 'Longsword',
    category: 'weapon',
    level: '0',
    priceDisplay: '1 gp',
    rarity: '',
    chunkId: crypto.randomUUID(),
    levelSort: 0,
    priceSort: 100,
    bookId: 'book-1',
    bookTitle: 'Equipment',
    ...overrides,
  };
}

function depsOf(
  books: readonly Rulebook[],
  chunks: readonly RuleChunk[],
  options: { listChunksThrows?: Error } = {},
): ItemPoolDeps {
  return {
    listBooks: () => Promise.resolve([...books]),
    listChunks: (bookIds) =>
      options.listChunksThrows === undefined
        ? Promise.resolve(chunks.filter((chunk) => bookIds.includes(chunk.bookId)))
        : Promise.reject(options.listChunksThrows),
  };
}

describe('itemLevelSort', () => {
  it('orders printed item levels numerically', () => {
    expect(itemLevelSort('0')).toBe(0);
    expect(itemLevelSort('3')).toBe(3);
    expect(itemLevelSort('20')).toBe(20);
  });

  it('sorts the level-less dnd5e items (—) after every leveled item', () => {
    expect(itemLevelSort('—')).toBe(Number.POSITIVE_INFINITY);
    expect(itemLevelSort('—')).toBeGreaterThan(itemLevelSort('20'));
  });

  it('rejects levels that cannot be ordered', () => {
    expect(() => itemLevelSort('odd')).toThrow('cannot order items by level');
  });
});

describe('buildItemPool (12-BESTIARY-PACKS §13)', () => {
  it('caps the window at the pool limit and counts truncation', () => {
    const entries = Array.from({ length: ITEM_POOL_LIMIT + 7 }, (_unused, index) =>
      entry({ name: `Item ${String(index)}`, levelSort: index, level: String(index) }),
    );
    const pool = buildItemPool(entries);
    expect(pool.lines).toHaveLength(ITEM_POOL_LIMIT);
    expect(pool.total).toBe(ITEM_POOL_LIMIT + 7);
    expect(pool.truncated).toBe(7);
  });

  it('orders by level, then price (unpriced last), then name without a target', () => {
    const pool = buildItemPool([
      entry({ name: 'Gem', levelSort: 0, priceSort: Number.POSITIVE_INFINITY, priceDisplay: '—' }),
      entry({ name: 'Arrows', levelSort: 0, priceSort: 1, priceDisplay: '1 cp' }),
      entry({ name: 'Torch', levelSort: 0, priceSort: 1, priceDisplay: '1 cp' }),
      entry({ name: 'Idol', levelSort: 5, priceSort: 1000, level: '5' }),
    ]);
    expect(pool.lines.map((line) => line.split(' (')[0])).toEqual(['Arrows', 'Torch', 'Gem', 'Idol']);
  });

  it('orders by level distance with a target level, ties by level then price', () => {
    const pool = buildItemPool(
      [
        entry({ name: 'Far Idol', levelSort: 20, priceSort: 9000, level: '20' }),
        entry({ name: 'Near Gem', levelSort: 4, priceSort: 5000, level: '4' }),
        entry({ name: 'Near Sword', levelSort: 4, priceSort: 1500, level: '4' }),
      ],
      {},
      3,
    );
    expect(pool.lines.map((line) => line.split(' (')[0])).toEqual(['Near Sword', 'Near Gem', 'Far Idol']);
  });

  it('narrowing filters apply before ordering and the cap', () => {
    const entries = [
      entry({ name: 'Sword', category: 'weapon', levelSort: 1, level: '1', priceSort: 100 }),
      entry({ name: 'Armor', category: 'armor', levelSort: 2, level: '2', priceSort: 200 }),
      entry({ name: 'Crown', category: 'treasure', levelSort: 3, level: '3', priceSort: 300 }),
    ];
    const pool = buildItemPool(entries, { categories: ['weapon', 'treasure'] });
    expect(pool.total).toBe(2);
    expect(pool.lines.map((line) => line.split(' (')[0])).toEqual(['Sword', 'Crown']);
    expect(buildItemPool(entries, { level: 2 }).lines).toHaveLength(2);
    expect(buildItemPool(entries, { priceCp: 200 }).lines).toHaveLength(2);
    expect(buildItemPool(entries, { rarities: ['uncommon'] }).total).toBe(0);
  });

  it('suffixes only cross-book duplicate names with the book title', () => {
    const pool = buildItemPool([
      entry({ name: 'Longsword', bookId: 'a', bookTitle: 'Equipment A' }),
      entry({ name: 'longsword', bookId: 'b', bookTitle: 'Equipment B' }),
      entry({ name: 'Torch', bookId: 'a', bookTitle: 'Equipment A' }),
    ]);
    const lines = pool.lines;
    // Unique names stay bare; both duplicate spellings get the suffix.
    expect(lines.find((line) => line.startsWith('Torch'))).toBe('Torch (weapon, Level 0, 1 gp)');
    const longswords = lines.filter((line) => / — Equipment [AB]$/.test(line));
    expect(longswords).toHaveLength(2);
    expect(longswords.every((line) => line.startsWith('Longsword (') || line.startsWith('longsword ('))).toBe(true);
  });

  it('renders null-level dnd5e items without a Level segment', () => {
    const pool = buildItemPool([entry({ name: 'Candle', level: '—', levelSort: Number.POSITIVE_INFINITY })]);
    expect(pool.lines[0]).toBe('Candle (weapon, 1 gp)');
  });
});

describe('itemPoolNameIndex (roster convention)', () => {
  it('resolves duplicate names by most recently updated book, then order', () => {
    const first = entry({ name: 'Longsword', bookId: 'old', levelSort: 9 });
    const second = entry({ name: 'Longsword', bookId: 'new', levelSort: 1 });
    const index = itemPoolNameIndex([first, second], new Map([['new', 0], ['old', 1]]));
    expect(index.get('longsword')).toBe(second.chunkId);
    const noRank = itemPoolNameIndex([first, second]);
    expect(noRank.get('longsword')).toBe(second.chunkId); // level/price/name order decides
  });
});

describe('formatItemPoolSection', () => {
  it('returns null for an empty pool and names the truncation', () => {
    expect(formatItemPoolSection([], 0)).toBeNull();
    const section = formatItemPoolSection(['Arrows (ammo, Level 0, 1 cp)'], 3) ?? '';
    expect(section.startsWith('Item pool — equipment available in the imported pack books:')).toBe(true);
    expect(section).toContain('(pool truncated; 3 more)');
    expect(section).toContain('"treasure" field');
  });
});

describe('collectItemPool (12-BESTIARY-PACKS §13)', () => {
  it('collects item chunks from ready pack books with itemsImported > 0', async () => {
    const itemsBookId = crypto.randomUUID();
    const creaturesBookId = crypto.randomUUID();
    const itemBook = book({
      id: itemsBookId,
      title: 'PF2e Equipment',
      packMeta: {
        sourceId: 'foundry-pf2e-equipment', license: 'Paizo CUP', sourceRef: 'v14-dev',
        sourceUrl: '', attemptedRefs: [], entriesImported: 2,
        entriesSkipped: 0, entriesFailed: 0, itemsImported: 2,
      },
    });
    const creatureBook = book({ id: creaturesBookId, title: 'Monster Core' });
    const items = [
      itemChunk('Arrows', itemData({ category: 'ammo', level: 0, priceDisplay: '1 sp (per 10)', priceCp: 1 }), itemsBookId),
      itemChunk('Dawnfire Beacon', itemData({ category: 'equipment', level: 3, priceDisplay: '45 gp', priceCp: 4500, rarity: 'uncommon', traits: ['aura', 'light', 'magical'] }), itemsBookId),
    ];
    const pool = await collectItemPool(
      'pathfinder2e',
      depsOf([creatureBook, itemBook], [...items, itemChunk('Stray', itemData(), creaturesBookId)]),
    );
    expect(pool.entries.map((entry) => entry.name)).toEqual(['Arrows', 'Dawnfire Beacon']);
    expect(pool.entries.every((entry) => entry.bookTitle === 'PF2e Equipment')).toBe(true);
    expect(pool.chunkByName.get('arrows')).toBe(items[0]?.id);
    expect(pool.lines[1]).toBe(
      'Dawnfire Beacon (equipment, Level 3, 45 gp, uncommon)',
    );
  });

  it('excludes ready pack books without items, drafts, and other systems', async () => {
    const ready = book({ id: 'ready', packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    const noItems = book({ id: 'no-items', packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 0 } });
    const noMeta = book({ id: 'no-meta', packMeta: null });
    const draft = book({ id: 'draft', status: 'processing', packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    const wrongSystem = book({ id: 'wrong', system: 'dnd5e', packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    const seen: Id[][] = [];
    await collectItemPool('pathfinder2e', {
      listBooks: () => Promise.resolve([ready, noItems, noMeta, draft, wrongSystem]),
      listChunks: (bookIds) => {
        seen.push([...bookIds]);
        return Promise.resolve([]);
      },
    });
    expect(seen).toEqual([['ready']]);
  });

  it('fails loudly on an item chunk without validated item data', async () => {
    const bookId = crypto.randomUUID();
    const broken = ruleChunkSchema.parse({
      id: crypto.randomUUID(),
      createdAt: 1,
      updatedAt: 1,
      bookId,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'item',
      headingPath: ['Broken'],
      text: 'Broken',
      statBlock: null,
      contentHash: crypto.randomUUID().replaceAll('-', '0').padEnd(64, '0'),
    });
    const itemBook = book({ id: bookId, packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    await expect(collectItemPool('pathfinder2e', depsOf([itemBook], [broken]))).rejects.toThrow(
      'has no validated item data — re-import the pack',
    );
  });

  it('fails loudly on an item chunk without a usable heading name', async () => {
    const bookId = crypto.randomUUID();
    const unnamed = itemChunk('Temp', itemData(), bookId);
    const fixed = ruleChunkSchema.parse({ ...unnamed, headingPath: ['  '] });
    const itemBook = book({ id: bookId, packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    await expect(collectItemPool('pathfinder2e', depsOf([itemBook], [fixed]))).rejects.toThrow(
      'has no item name in its heading',
    );
  });
});

describe('collectItemPoolWithRetry (roster convention)', () => {
  it('retries transient failures and throws a named error after ITEM_POOL_ATTEMPTS', async () => {
    expect(ITEM_POOL_ATTEMPTS).toBe(2);
    let calls = 0;
    const itemBook = book({ packMeta: { sourceId: 's', license: 'test', sourceRef: 'r', sourceUrl: '', attemptedRefs: [], entriesImported: 1, entriesSkipped: 0, entriesFailed: 0, itemsImported: 1 } });
    const flaky: ItemPoolDeps = {
      listBooks: () => Promise.resolve([itemBook]),
      listChunks: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('transient read failure')) : Promise.resolve([]);
      },
    };
    const pool = await collectItemPoolWithRetry('pathfinder2e', flaky);
    expect(calls).toBe(2);
    expect(pool.total).toBe(0);
    await expect(collectItemPoolWithRetry('dnd5e', depsOf([], [], { listChunksThrows: new Error('persistent') }))).rejects.toThrow(
      'Item pack pool for system "dnd5e" failed after 2 attempts: persistent',
    );
  });
});
