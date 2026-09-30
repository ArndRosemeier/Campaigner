import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemData } from '@/domain/itemData';
import type { PackMeta } from '@/domain/rulebook';
import { statBlockSchema } from '@/domain/statblock';
import type { RuleChunk } from '@/domain';
import { listRulebooks } from '@/db/rulebookRepo';
import {
  derivePackTitle,
  dexiePackImportDeps,
  importPack,
  type PackImportDeps,
  type PackImportProgress,
} from '@/ingest/packImport';
import { PACK_ADAPTERS, getPackAdapter } from '@/ingest/packs/registry';
import type { PackAdapter, PackFileParse } from '@/ingest/packs/types';
import { sha256Hex } from '@/lib/hash';
import { ingestLockName } from '@/lib/generationLocks';

import { clearDatabase } from '../../db/helpers';
import { baseNpc, encodeJson, folderDoc } from './fixtures';

const DND5E_FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'dnd5e');

function dnd5eFixture(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(DND5E_FIXTURES, name), 'utf8'));
}

type MemoryDeps = PackImportDeps & {
  created: { title: string; system: string; filename: string }[];
  persisted: RuleChunk[][];
  finalized: { id: string; packMeta: PackMeta | null }[];
  failed: { id: string; message: string }[];
};

function memoryDeps(): MemoryDeps {
  const created: { title: string; system: string; filename: string }[] = [];
  const persisted: RuleChunk[][] = [];
  const finalized: { id: string; packMeta: PackMeta | null }[] = [];
  const failed: { id: string; message: string }[] = [];

  const deps: MemoryDeps = {
    createBook: (input) => {
      created.push(input);
      const id = crypto.randomUUID();
      return Promise.resolve({
        id,
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
      });
    },
    persistChunks: (chunks) => {
      persisted.push(chunks);
      return Promise.resolve();
    },
    finalizeBook: (id, packMeta) => {
      finalized.push({ id, packMeta });
      return Promise.resolve({
        id,
        createdAt: 1,
        updatedAt: 1,
        title: id,
        system: 'pathfinder2e',
        filename: 'pack.json',
        pageCount: 0,
        status: 'ready',
        errorMessage: '',
        origin: 'pack',
        packMeta,
      });
    },
    failBook: (id, message) => {
      failed.push({ id, message });
      return Promise.resolve();
    },
    created,
    persisted,
    finalized,
    failed,
  };
  return deps;
}

/**
 * `memoryDeps` plus the id `createBook` handed out — the book the post-create
 * guard must name. The wrapper exists so the shared `memoryDeps` helper (blessed
 * as a deliberate copy in the duplication baseline) stays byte-identical.
 */
function trackedDeps(): { deps: MemoryDeps; bookId: () => string | undefined } {
  const deps = memoryDeps();
  let id: string | undefined;
  // `.bind(deps)` keeps the method attached to its object (`unbound-method`).
  const createBook = deps.createBook.bind(deps);
  deps.createBook = async (input) => {
    const book = await createBook(input);
    id = book.id;
    return book;
  };
  return { deps, bookId: () => id };
}

describe('importPack', () => {
  it('imports loose files and a zip, persists validated chunks and finalizes', async () => {
    const deps = memoryDeps();
    const zip = zipSync({
      'age-of-ashes-bestiary/goblin.json': encodeJson(baseNpc('Goblin Warrior')),
      'age-of-ashes-bestiary/_folders.json': encodeJson(folderDoc()),
      'age-of-ashes-bestiary/readme.txt': strToU8('not pack content'),
    });
    const progress: PackImportProgress[] = [];
    const result = await importPack(
      'foundry-pf2e',
      [
        { name: 'charau-ka.json', bytes: encodeJson(baseNpc()) },
        { name: 'pack.zip', bytes: zip },
      ],
      { title: 'Age of Ashes Bestiary', deps, onProgress: (p) => progress.push(p) },
    );

    expect(deps.created).toEqual([
      { title: 'Age of Ashes Bestiary', system: 'pathfinder2e', filename: 'charau-ka.json' },
    ]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(2); // folder doc + .txt zip member
    expect(result.failed).toHaveLength(0);
    expect(result.book.status).toBe('ready');
    expect(result.book.packMeta?.sourceId).toBe('foundry-pf2e');
    expect(result.book.packMeta?.license).toContain('Pathfinder Second Edition');
    expect(result.book.packMeta?.entriesImported).toBe(2);
    expect(result.book.packMeta?.entriesSkipped).toBe(2);
    expect(result.book.packMeta?.entriesFailed).toBe(0);

    const chunks = deps.persisted.flat();
    expect(chunks).toHaveLength(2);
    const first = chunks[0];
    expect(first?.chunkType).toBe('statblock');
    expect(first?.pageStart).toBe(1);
    expect(first?.pageEnd).toBe(1);
    expect(first?.headingPath).toEqual(['Charau-ka']);
    expect(first?.statBlock?.ac).toBe(18);
    expect(first?.contentHash).toBe(await sha256Hex(first?.text ?? ''));
    expect(progress).toEqual([{ bookId: result.book.id, done: 2, total: 2 }]);
  });

  it('collects per-entry failures and still finalizes a ready book', async () => {
    const deps = memoryDeps();
    const broken = baseNpc('Broken Creature');
    const system = broken.system as Record<string, unknown>;
    delete (system.details as Record<string, unknown>).level;
    const result = await importPack(
      'foundry-pf2e',
      [
        { name: 'broken.json', bytes: encodeJson(broken) },
        { name: 'good.json', bytes: encodeJson(baseNpc('Good Creature')) },
      ],
      { title: 'Mixed Pack', deps },
    );
    expect(result.imported).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.file).toBe('broken.json');
    expect(result.failed[0]?.name).toBe('Broken Creature');
    expect(deps.finalized).toHaveLength(1);
    expect(deps.finalized[0]?.packMeta?.entriesFailed).toBe(1);
  });

  it('marks the book error and throws when zero entries validate', async () => {
    const deps = memoryDeps();
    const broken = baseNpc('Broken Creature');
    const system = broken.system as Record<string, unknown>;
    delete (system.details as Record<string, unknown>).level;
    await expect(
      importPack(
        'foundry-pf2e',
        [
          { name: 'junk.json', bytes: encodeJson(folderDoc()) },
          { name: 'broken.json', bytes: encodeJson(broken) },
        ],
        { title: 'Empty Pack', deps },
      ),
    ).rejects.toThrow('no valid creature entries');
    // 16-BESTIARY-FETCH §6: the error leads with the first failure's issue —
    // the user sees the reason, not just a count. The skipped folder doc is
    // not a failure, so the broken creature's zod issue leads.
    expect(deps.failed[0]?.message.startsWith('broken.json (Broken Creature): document 0: [')).toBe(
      true,
    );
    expect(deps.failed[0]?.message).toContain(
      '— no valid creature entries in the pack selection (1 skipped, 1 failed)',
    );
    // EXACTLY ONCE (docs/17 row 277): the zero-entry arm writes the row
    // itself, and the post-create guard must NOT fail it a second time.
    expect(deps.failed).toHaveLength(1);
    expect(deps.finalized).toHaveLength(0);
  });

  it('reports a skipped-only zero-entry import without an invented reason', async () => {
    const deps = memoryDeps();
    await expect(
      importPack('foundry-pf2e', [{ name: 'junk.json', bytes: encodeJson(folderDoc()) }], {
        title: 'Empty Pack',
        deps,
      }),
    ).rejects.toThrow('no valid creature entries in the pack selection (1 skipped, 0 failed)');
    expect(deps.failed[0]?.message.startsWith('no valid creature entries')).toBe(true);
  });

  it('fails loudly on an explicitly selected unsupported file', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      'foundry-pf2e',
      [
        { name: 'notes.txt', bytes: strToU8('hello') },
        { name: 'ok.json', bytes: encodeJson(baseNpc('Ok Creature')) },
      ],
      { title: 'With Notes', deps },
    );
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([
      { file: 'notes.txt', name: '', message: 'adapter "foundry-pf2e" cannot parse .txt' },
    ]);
  });

  it('derives the title from a single zip or the first loose file', () => {
    expect(
      derivePackTitle([{ name: '/tmp/Age of Ashes.zip', bytes: new Uint8Array() }]),
    ).toBe('Age of Ashes');
    expect(
      derivePackTitle([
        { name: 'charau-ka.json', bytes: new Uint8Array() },
        { name: 'other.json', bytes: new Uint8Array() },
      ]),
    ).toBe('charau-ka');
  });

  it('throws before creating a book when no title is derivable', async () => {
    const deps = memoryDeps();
    await expect(
      importPack('foundry-pf2e', [{ name: '.hidden', bytes: encodeJson(baseNpc()) }], { deps }),
    ).rejects.toThrow('pack import needs a title');
    expect(deps.created).toHaveLength(0);
  });

  it('rejects unknown adapters and empty file lists up front', async () => {
    await expect(importPack('foundry-4e', [], {})).rejects.toThrow('unknown pack adapter');
    await expect(importPack('foundry-pf2e', [], {})).rejects.toThrow('received no files');
  });
});

describe('importPack (foundry-dnd5e-srd, M-C)', () => {
  it('imports loose .yml files with the dnd5e license and reports failures loudly', async () => {
    const deps = memoryDeps();
    // The goblin (formerly a loud failure — no flat AC) imports; the
    // unsupported CR "0.75" in this real wolf document is the loud failure.
    const result = await importPack(
      'foundry-dnd5e-srd',
      [
        { name: 'monsters/beast/ape.yml', bytes: dnd5eFixture('ape.yml') },
        { name: 'monsters/humanoid/goblin.yml', bytes: dnd5eFixture('goblin.yml') },
        {
          name: 'monsters/beast/wolf.yml',
          bytes: new TextEncoder().encode(
            new TextDecoder().decode(dnd5eFixture('wolf.yml')).replace('cr: 0.25', 'cr: 0.75'),
          ),
        },
      ],
      { title: 'SRD Bestiary', deps },
    );
    expect(deps.created).toEqual([
      { title: 'SRD Bestiary', system: 'dnd5e', filename: 'monsters/beast/ape.yml' },
    ]);
    expect(result.imported).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.file).toBe('monsters/beast/wolf.yml');
    expect(result.failed[0]?.name).toBe('Wolf');
    expect(result.failed[0]?.message).toContain('unsupported CR "0.75"');
    // A creature-only selection reports ZERO spells: the count is the spell
    // lane, not a rename of the mixed sections lane (docs/17 row 204).
    expect(result.spellsImported).toBe(0);
    expect(result.sectionsImported).toBe(0);
    expect(result.book.status).toBe('ready');
    expect(result.book.packMeta?.sourceId).toBe('foundry-dnd5e-srd');
    expect(result.book.packMeta?.license).toContain('CC-BY-4.0');
    expect(result.book.packMeta?.entriesImported).toBe(2);
    expect(result.book.packMeta?.entriesFailed).toBe(1);

    // The §10 acceptance block survives the full runner boundary.
    const chunk = deps.persisted.flat()[0];
    expect(chunk?.headingPath).toEqual(['Ape']);
    expect(chunk?.statBlock?.abilities.str).toBe(16);
    expect(chunk?.statBlock?.ac).toBe(12);
    expect(chunk?.statBlock?.hp).toBe(19);
    expect(chunk?.statBlock?.hpFormula).toBe('3d8 + 6');
    // The armor-derived goblin AC survives too (12-BESTIARY-PACKS §5).
    const goblinChunk = deps.persisted.flat()[1];
    expect(goblinChunk?.headingPath).toEqual(['Goblin']);
    expect(goblinChunk?.statBlock?.ac).toBe(15);
    expect(goblinChunk?.statBlock?.acNote).toBe('Leather Armor, Shield');
  });

  it('expands a zip with nested monster folders and skips non-pack members', async () => {
    const deps = memoryDeps();
    const zip = zipSync({
      'monsters/beast/ape.yml': dnd5eFixture('ape.yml'),
      'monsters/beast/wolf.yml': dnd5eFixture('wolf.yml'),
      'docs/readme.md': strToU8('not pack content'),
    });
    const result = await importPack(
      'foundry-dnd5e-srd',
      [{ name: 'srd-bestiary.zip', bytes: zip }],
      { title: 'SRD Bestiary', deps },
    );
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(deps.persisted.flat().map((chunk) => chunk.headingPath[0])).toEqual(['Ape', 'Wolf']);
  });

  it('fails an explicitly selected non-YAML input loudly', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      'foundry-dnd5e-srd',
      [
        { name: 'goblin.json', bytes: encodeJson(baseNpc('Goblin Warrior')) },
        { name: 'ape.yml', bytes: dnd5eFixture('ape.yml') },
      ],
      { title: 'Mixed Selection', deps },
    );
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([
      { file: 'goblin.json', name: '', message: 'adapter "foundry-dnd5e-srd" cannot parse .json' },
    ]);
  });
});

// --- Item lane (12-BESTIARY-PACKS §13) ----------------------------------------
// A test adapter registered for the runner tests only: the real item adapters
// (foundry-pf2e-equipment / foundry-dnd5e-equipment) live in their own suites;
// this one exercises the LANE — accumulation, item chunks, packMeta counts,
// stamps and the zero-valid error noun — without depending on either corpus.

const TEST_ITEM_ADAPTER: PackAdapter = {
  id: 'test-item-adapter',
  label: 'Test item adapter',
  system: 'pathfinder2e',
  license: 'Test item license',
  extensions: ['.json'],
  entryNoun: 'item',
  parseFile: (fileName, bytes): Promise<PackFileParse> => {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { name?: string; kind?: string };
    const name = doc.name;
    if (name === undefined) return Promise.reject(new Error(`${fileName}: no name`));
    if (name === 'crash') return Promise.reject(new Error('file-level parse failure'));
    if (name === 'broken') {
      return Promise.resolve({
        entries: [],
        items: [],
        skipped: 0,
        failures: [{ file: fileName, name, message: 'bad item shape' }],
      });
    }
    const item: ItemData = {
      system: 'pathfinder2e',
      category: 'treasure',
      level: 0,
      priceDisplay: '10 gp',
      priceCp: 1000,
      rarity: 'common',
      traits: [],
      rulesEdition: null,
    };
    if (doc.kind === 'npc') {
      return Promise.resolve({
        entries: [
          {
            name,
            statBlock: statBlockSchema.parse({
              system: 'pathfinder2e',
              level: '1',
              size: 'Small',
              creatureType: 'humanoid',
              ac: 15,
              hp: 10,
              speed: '25 feet',
              abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              saves: '',
              skills: '',
              senses: '',
              languages: '',
            }),
            text: `${name} stat text`,
          },
        ],
        skipped: 0,
        failures: [],
      });
    }
    return Promise.resolve({
      entries: [],
      items: [{ name, item, text: `${name} item text` }],
      skipped: 0,
      failures: [],
    });
  },
};

describe('importPack item lane (12-BESTIARY-PACKS §13)', () => {
  beforeEach(() => {
    // Registration seam for the lane tests only — removed after every test.
    (PACK_ADAPTERS as PackAdapter[]).push(TEST_ITEM_ADAPTER);
  });
  afterEach(() => {
    const index = PACK_ADAPTERS.indexOf(TEST_ITEM_ADAPTER);
    if (index >= 0) (PACK_ADAPTERS as PackAdapter[]).splice(index, 1);
  });

  it('imports an item-only book into `item` chunks with item payloads', async () => {
    const deps = memoryDeps();
    const progress: PackImportProgress[] = [];
    const result = await importPack(
      'test-item-adapter',
      [
        { name: 'alabaster-idol.json', bytes: encodeJson({ name: 'Alabaster idol' }) },
        { name: 'bronze-chalice.json', bytes: encodeJson({ name: 'Bronze chalice' }) },
      ],
      { title: 'Treasure Pack', deps, onProgress: (p) => progress.push(p) },
    );
    expect(result.imported).toBe(2);
    expect(result.itemsImported).toBe(2);
    expect(result.failed).toHaveLength(0);
    expect(result.book.packMeta).toMatchObject({
      sourceId: 'test-item-adapter',
      entriesImported: 2,
      itemsImported: 2,
    });
    const chunks = deps.persisted.flat();
    expect(chunks).toHaveLength(2);
    const first = chunks[0];
    expect(first?.chunkType).toBe('item');
    expect(first?.statBlock).toBeNull();
    expect(first?.headingPath).toEqual(['Alabaster idol']);
    expect(first?.itemData).toMatchObject({ category: 'treasure', priceCp: 1000 });
    expect(first?.contentHash).toBe(await sha256Hex(first?.text ?? ''));
    expect(progress).toEqual([{ bookId: result.book.id, done: 2, total: 2 }]);
  });

  it('keeps both lanes in one book with continuing, unique stamps', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      'test-item-adapter',
      [
        { name: 'guard.json', bytes: encodeJson({ name: 'Guard', kind: 'npc' }) },
        { name: 'idol.json', bytes: encodeJson({ name: 'Alabaster idol' }) },
      ],
      { title: 'Mixed Pack', deps },
    );
    expect(result.imported).toBe(2);
    expect(result.itemsImported).toBe(1);
    const chunks = deps.persisted.flat();
    expect(chunks.map((entry) => entry.chunkType)).toEqual(['statblock', 'item']);
    expect(new Set(chunks.map((entry) => entry.createdAt)).size).toBe(2);
    expect(chunks[1]?.createdAt).toBeGreaterThan(chunks[0]?.createdAt ?? 0);
    expect(deps.finalized[0]?.packMeta?.entriesImported).toBe(2);
    expect(deps.finalized[0]?.packMeta?.itemsImported).toBe(1);
  });

  it('fails an item-only selection with the adapter noun, loudly', async () => {
    const deps = memoryDeps();
    await expect(
      importPack('test-item-adapter', [{ name: 'broken.json', bytes: encodeJson({ name: 'broken' }) }], {
        title: 'Empty Items',
        deps,
      }),
    ).rejects.toThrow('no valid item entries in the pack selection (0 skipped, 1 failed)');
    expect(deps.failed[0]?.message).toContain('broken.json (broken): bad item shape — no valid item entries');
    expect(deps.finalized).toHaveLength(0);
  });

  it('collects a file-level item parse failure and still fails the empty book', async () => {
    const deps = memoryDeps();
    await expect(
      importPack('test-item-adapter', [{ name: 'crash.json', bytes: encodeJson({ name: 'crash' }) }], {
        title: 'Crash Pack',
        deps,
      }),
    ).rejects.toThrow('no valid item entries');
    expect(deps.failed[0]?.message).toContain('crash.json: file-level parse failure');
  });
});

// --- System agreement (docs/17 row 209) ---------------------------------------
// A book's `system` is a CONSTANT per adapter (`createBook({ system:
// adapter.system })`) while the adapter's OWN payloads carry a system
// (`StatBlock.system`, `ItemData.system`, `SpellData.system`), and nothing
// compared the two — so a mis-chosen adapter could silently store a PF2e rules
// pack as dnd5e, invisible to every PF2e campaign. These pins drive the REAL
// adapters and the REAL fixtures: a fixture fed to the wrong adapter is refused
// LOUDLY with the entry and both systems named, a correct import is unchanged
// and states its system, an entry that makes NO system claim is not a failure,
// and a partial disagreement imports the rest while naming every refusal.

const CONDITIONS_FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'packs',
  'pf2e-conditions',
  'blinded.json',
);

/**
 * The row-209 probes: a REAL adapter's OWN parser under the OTHER declared
 * system — exactly the "user chose the wrong adapter in the dialog" case, with
 * no adapter modified and no second fixture set. Registered like the item-lane
 * probe above and removed after every test.
 */
const REAL_PF2E_CREATURE_ADAPTER = getPackAdapter('foundry-pf2e');
const REAL_DND5E_CREATURE_ADAPTER = getPackAdapter('foundry-dnd5e-srd');

const PF2E_FIXTURE_UNDER_DND5E: PackAdapter = {
  ...REAL_PF2E_CREATURE_ADAPTER,
  id: 'test-pf2e-fixture-under-dnd5e',
  system: 'dnd5e',
};
const DND5E_FIXTURE_UNDER_PF2E: PackAdapter = {
  ...REAL_DND5E_CREATURE_ADAPTER,
  id: 'test-dnd5e-fixture-under-pf2e',
  system: 'pathfinder2e',
};

/** Emits an item whose CLAIMED system comes from the document, so one
 *  selection can hold an agreeing entry beside a disagreeing one. */
const TEST_SYSTEM_MIX_ADAPTER: PackAdapter = {
  id: 'test-system-mix',
  label: 'Test system mix',
  system: 'pathfinder2e',
  license: 'Test system mix license',
  extensions: ['.json'],
  entryNoun: 'item',
  parseFile: (_fileName, bytes): Promise<PackFileParse> => {
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { name?: string; system?: string };
    const name = doc.name ?? '';
    const item: ItemData = {
      system: doc.system === 'dnd5e' ? 'dnd5e' : 'pathfinder2e',
      category: 'treasure',
      level: 0,
      priceDisplay: '10 gp',
      priceCp: 1000,
      rarity: 'common',
      traits: [],
      rulesEdition: null,
    };
    return Promise.resolve({
      entries: [],
      items: [{ name, item, text: `${name} item text` }],
      skipped: 0,
      failures: [],
    });
  },
};

describe('importPack system agreement (docs/17 row 209)', () => {
  beforeEach(() => {
    (PACK_ADAPTERS as PackAdapter[]).push(
      PF2E_FIXTURE_UNDER_DND5E,
      DND5E_FIXTURE_UNDER_PF2E,
      TEST_SYSTEM_MIX_ADAPTER,
    );
  });
  afterEach(() => {
    const adapters = PACK_ADAPTERS as PackAdapter[];
    for (const probe of [
      PF2E_FIXTURE_UNDER_DND5E,
      DND5E_FIXTURE_UNDER_PF2E,
      TEST_SYSTEM_MIX_ADAPTER,
    ]) {
      const index = adapters.indexOf(probe);
      if (index >= 0) adapters.splice(index, 1);
    }
  });

  it('refuses a pf2e-shaped fixture chosen under the dnd5e adapter, naming the entry and both systems', async () => {
    const deps = memoryDeps();
    await expect(
      importPack(
        'test-pf2e-fixture-under-dnd5e',
        [{ name: 'charau-ka.json', bytes: encodeJson(baseNpc('Charau-ka')) }],
        { title: 'Wrong Adapter', deps },
      ),
    ).rejects.toThrow('no valid creature entries');
    expect(deps.finalized).toHaveLength(0);
    expect(deps.failed[0]?.message).toContain(
      'charau-ka.json (Charau-ka): the stat block is for game system "pathfinder2e", ' +
        'but adapter "test-pf2e-fixture-under-dnd5e" declares "dnd5e"',
    );
  });

  it('mirror: refuses a dnd5e fixture chosen under the pf2e adapter', async () => {
    const deps = memoryDeps();
    await expect(
      importPack(
        'test-dnd5e-fixture-under-pf2e',
        [{ name: 'ape.yml', bytes: dnd5eFixture('ape.yml') }],
        { title: 'Wrong Adapter', deps },
      ),
    ).rejects.toThrow('no valid creature or spell entries');
    expect(deps.finalized).toHaveLength(0);
    expect(deps.failed[0]?.message).toContain(
      'ape.yml (Ape): the stat block is for game system "dnd5e", ' +
        'but adapter "test-dnd5e-fixture-under-pf2e" declares "pathfinder2e"',
    );
  });

  it('imports a correct selection unchanged and reports the system it went in as', async () => {
    const pf2eDeps = memoryDeps();
    const pf2e = await importPack(
      'foundry-pf2e',
      [{ name: 'charau-ka.json', bytes: encodeJson(baseNpc()) }],
      { title: 'PF2e Pack', deps: pf2eDeps },
    );
    expect(pf2e.failed).toHaveLength(0);
    expect(pf2e.system).toBe('pathfinder2e');
    // The report's system IS the adapter's declared system, checked against
    // the book the runner asked for at `createBook`.
    expect(pf2eDeps.created[0]?.system).toBe(pf2e.system);

    const dnd5eDeps = memoryDeps();
    const dnd5e = await importPack(
      'foundry-dnd5e-srd',
      [{ name: 'monsters/beast/ape.yml', bytes: dnd5eFixture('ape.yml') }],
      { title: 'SRD Pack', deps: dnd5eDeps },
    );
    expect(dnd5e.failed).toHaveLength(0);
    expect(dnd5e.system).toBe('dnd5e');
    expect(dnd5eDeps.created[0]?.system).toBe(dnd5e.system);
  });

  it('does not refuse an entry that carries NO system (the no-false-positive pin)', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      'foundry-pf2e-conditions',
      [
        {
          name: 'conditions/blinded.json',
          bytes: new TextEncoder().encode(readFileSync(CONDITIONS_FIXTURE, 'utf8')),
        },
      ],
      { title: 'Conditions', deps },
    );
    // A rules-text `section` entry carries no structured payload, so it makes
    // no system claim: absent is not disagreement.
    expect(result.failed).toHaveLength(0);
    expect(result.system).toBe('pathfinder2e');
    expect(result.sectionsImported).toBe(1);
    expect(deps.persisted.flat()[0]?.chunkType).toBe('section');
  });

  it('imports the agreeing rest of a partial disagreement and names every refusal', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      'test-system-mix',
      [
        { name: 'good.json', bytes: encodeJson({ name: 'Agreeing item' }) },
        { name: 'bad.json', bytes: encodeJson({ name: 'Foreign item', system: 'dnd5e' }) },
      ],
      { title: 'Mixed Systems', deps },
    );
    expect(result.system).toBe('pathfinder2e');
    expect(result.imported).toBe(1);
    expect(result.itemsImported).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ file: 'bad.json', name: 'Foreign item' });
    expect(result.failed[0]?.message).toContain('game system "dnd5e"');
    expect(result.failed[0]?.message).toContain('"pathfinder2e"');
    // The agreeing entry is imported and persisted; the refused one is not.
    expect(deps.persisted.flat().map((chunk) => chunk.headingPath[0])).toEqual(['Agreeing item']);
    expect(result.book.status).toBe('ready');
    expect(result.book.packMeta?.entriesImported).toBe(1);
    expect(result.book.packMeta?.entriesFailed).toBe(1);
  });
});

/**
 * The post-create failure guard (docs/17 row 277, the row-241 residual).
 *
 * `importPack` creates the Rulebook row FIRST, so ANY throw after that point
 * used to leave the book reading `processing…` FOREVER — nothing reconciled
 * pack books, and the row had no way forward. The guard is now: any throw after
 * `createBook` lands the row in `'error'` carrying the failure's own message and
 * rethrows LOUDLY (AGENTS rules 1–2), EXACTLY ONCE (the zero-entry arm writes
 * its own message and must not be double-failed by the guard).
 *
 * The `deps`-based pins hold the call shape; the real-Dexie pin is the one that
 * proves the ROW STATE — a book left `'processing'` is exactly the defect, and
 * only the database can be asked whether it happened.
 */
describe('importPack post-create failure guard (docs/17 row 277)', () => {
  const okNpc = (): { name: string; bytes: Uint8Array } => ({
    name: 'good.json',
    bytes: encodeJson(baseNpc('Ok Creature')),
  });

  it('names the book and rethrows when a persist fails after the row exists', async () => {
    const { deps, bookId } = trackedDeps();
    deps.persistChunks = () => Promise.reject(new Error('disk went away'));

    await expect(
      importPack('foundry-pf2e', [okNpc()], { title: 'Interrupted Pack', deps }),
    ).rejects.toThrow('disk went away');

    // The row the run created is the one that was named — with the failure's
    // OWN message, not a placeholder.
    expect(deps.failed).toEqual([{ id: bookId(), message: 'disk went away' }]);
    expect(deps.finalized).toHaveLength(0);
  });

  it('names the book and rethrows when finalizeBook fails', async () => {
    const { deps, bookId } = trackedDeps();
    deps.finalizeBook = () => Promise.reject(new Error('finalize exploded'));

    await expect(
      importPack('foundry-pf2e', [okNpc()], { title: 'Interrupted Pack', deps }),
    ).rejects.toThrow('finalize exploded');

    expect(deps.failed).toEqual([{ id: bookId(), message: 'finalize exploded' }]);
  });

  it('keeps BOTH failures visible when the row cannot be marked at all', async () => {
    const deps = memoryDeps();
    deps.persistChunks = () => Promise.reject(new Error('disk went away'));
    deps.failBook = () => Promise.reject(new Error('Rulebook not found: gone'));

    // The owner deleted the row mid-import: the import failure is still the
    // headline, and the un-nameable row is stated beside it — never swallowed.
    await expect(
      importPack('foundry-pf2e', [okNpc()], { title: 'Interrupted Pack', deps }),
    ).rejects.toThrow(
      'disk went away — the book could not be marked as error: Rulebook not found: gone',
    );
  });

  it('leaves NO processing book behind — the real Dexie row reaches `error`', async () => {
    await clearDatabase();
    const deps: PackImportDeps = {
      ...dexiePackImportDeps,
      persistChunks: () => Promise.reject(new Error('disk went away')),
    };

    await expect(
      importPack('foundry-pf2e', [okNpc()], { title: 'Interrupted Pack', deps }),
    ).rejects.toThrow('disk went away');

    const books = await listRulebooks();
    expect(books).toHaveLength(1);
    expect(books[0]?.status).toBe('error');
    expect(books[0]?.errorMessage).toBe('disk went away');
    expect(books[0]?.origin).toBe('pack');
  });

  it('still finalizes a healthy import (the guard is not a blanket failure)', async () => {
    await clearDatabase();
    const result = await importPack('foundry-pf2e', [okNpc()], {
      title: 'Healthy Pack',
      deps: dexiePackImportDeps,
    });
    expect(result.book.status).toBe('ready');
    expect((await listRulebooks())[0]?.status).toBe('ready');
  });

  it('holds the ONE ingest lease across the whole post-create pass', async () => {
    // The start-up reconcile's `isGenerationLockHeld(ingestLockName(bookId))`
    // guard is only meaningful if a live pack import HOLDS that lease
    // (docs/17 row 277). This pins the hold: the lock is named for the book the
    // run created, and it is still held while the chunks are being persisted.
    const requested: string[] = [];
    let held = false;
    let heldDuringPersist = false;
    const { deps, bookId } = trackedDeps();
    deps.persistChunks = () => {
      heldDuringPersist = held;
      return Promise.resolve();
    };
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, _options: unknown, callback: () => Promise<unknown>) => {
          requested.push(name);
          held = true;
          return Promise.resolve(callback()).finally(() => {
            held = false;
          });
        },
        query: () => Promise.resolve({ held: held ? [{ name: requested[0] }] : [], pending: [] }),
      },
    });

    try {
      const result = await importPack('foundry-pf2e', [okNpc()], {
        title: 'Leased Pack',
        deps,
      });
      expect(result.book.status).toBe('ready');
      expect(requested).toEqual([ingestLockName(bookId() ?? '')]);
      expect(heldDuringPersist).toBe(true);
      // …and released when the pass settles.
      expect(held).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
