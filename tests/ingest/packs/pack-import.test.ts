import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { PackMeta } from '@/domain/rulebook';
import type { RuleChunk } from '@/domain';
import {
  derivePackTitle,
  importPack,
  type PackImportDeps,
  type PackImportProgress,
} from '@/ingest/packImport';
import { sha256Hex } from '@/lib/hash';

import { baseNpc, encodeJson, folderDoc } from './fixtures';

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
    await expect(
      importPack('foundry-pf2e', [{ name: 'junk.json', bytes: encodeJson(folderDoc()) }], {
        title: 'Empty Pack',
        deps,
      }),
    ).rejects.toThrow('no valid creature entries');
    expect(deps.failed).toHaveLength(1);
    expect(deps.failed[0]?.message).toContain('1 skipped, 0 failed');
    expect(deps.finalized).toHaveLength(0);
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
