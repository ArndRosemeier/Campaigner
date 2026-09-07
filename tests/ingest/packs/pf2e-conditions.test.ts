import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PackMeta } from '@/domain/rulebook';
import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
  foundryPf2eConditionsAdapter,
  publicationSourceLine,
} from '@/ingest/packs/pf2e-conditions';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import type { PackSectionEntry } from '@/ingest/packs/types';

import { baseNpc, encodeJson, folderDoc } from './fixtures';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e-conditions');

/**
 * `foundry-pf2e-conditions` adapter tests (docs/12 §15): fixtures are REAL
 * upstream documents at v14-dev — Blinded (verbatim) and Frightened (verbatim;
 * the valued-condition shape). Pins: the condition → `section` entry mapping,
 * the description HTML strip with label-first @-notation resolution, the
 * per-entry `publication` → `Source:` line (licensing PRESERVED), counted
 * skips of non-condition documents, loud per-document failures, and the
 * importPack runner lane end-to-end.
 */

/** Verbatim live sources (docs/12 §10 lesson — no invented shapes). */
const SOURCE_PATHS: Readonly<Record<string, string>> = {
  'blinded.json': 'packs/pf2e/conditions/blinded.json @ v14-dev',
  'frightened.json': 'packs/pf2e/conditions/frightened.json @ v14-dev',
};

function conditionBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

async function firstSection(name: string): Promise<PackSectionEntry> {
  const parsed = await foundryPf2eConditionsAdapter.parseFile(`conditions/${name}`, conditionBytes(name));
  expect(parsed.failures).toEqual([]);
  const sections = parsed.sections ?? [];
  expect(sections, `${name} must yield exactly one section entry`).toHaveLength(1);
  expect(parsed.skipped).toBe(0);
  const section = sections[0];
  if (section === undefined) throw new Error(`unreachable: ${name} asserted to have one section`);
  return section;
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

describe('foundry-pf2e-conditions adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await firstSection('blinded.json');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is registered with the condition entry noun and the CUP license', () => {
    expect(getPackAdapter(FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID).id).toBe(FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID);
    expect(PACK_ADAPTERS.map((adapter) => adapter.entryNoun)).toContain('condition');
    expect(foundryPf2eConditionsAdapter.license).toContain('ORC/OGL');
    expect(foundryPf2eConditionsAdapter.license).toContain('not for redistribution');
  });

  it('maps the real Blinded document onto a section entry with its ORC source line', async () => {
    const entry = await firstSection('blinded.json');
    expect(SOURCE_PATHS['blinded.json']).toContain('blinded.json');
    expect(entry.categories).toEqual([]);
    expect(entry.name).toBe('Blinded');
    // The description strips clean and resolves the override link label-first.
    expect(entry.text).toContain("You can't see. All normal terrain is difficult terrain to you.");
    expect(entry.text).toContain('Blinded overrides Dazzled.');
    expect(entry.text).not.toMatch(/<[^>]+>/);
    expect(entry.text).not.toContain('@UUID');
    // Per-entry licensing is preserved, never dropped (docs/12 §15).
    expect(entry.text).toContain('Source: Pathfinder Player Core (ORC)');
  });

  it('maps the real Frightened (valued) document — the value stays in the description text', async () => {
    const entry = await firstSection('frightened.json');
    expect(entry.name).toBe('Frightened');
    expect(entry.text).toContain('The frightened condition always includes a value.');
    expect(entry.text).toContain('Source: Pathfinder Player Core (ORC)');
  });

  it('renders the Source line for every publication shape (title+license / license-only / none)', () => {
    expect(publicationSourceLine({ title: 'Pathfinder Player Core', license: 'ORC' })).toBe(
      'Source: Pathfinder Player Core (ORC)',
    );
    expect(publicationSourceLine({ title: '', license: 'OGL' })).toBe('Source: OGL');
    expect(publicationSourceLine({ title: 'GM Core', license: '' })).toBe('Source: GM Core');
    expect(publicationSourceLine({ title: '', license: '' })).toBeNull();
    expect(publicationSourceLine(null)).toBeNull();
    expect(publicationSourceLine(undefined)).toBeNull();
  });

  it('skips non-condition documents and fails broken ones loudly', async () => {
    const ndjson = [
      JSON.stringify(folderDoc()),
      JSON.stringify(baseNpc('Goblin Warrior')),
      // A condition with NO name fails the boundary loudly (the empty
      // system object is valid — description/traits default). 
      JSON.stringify({ type: 'condition', system: {} }),
    ].join('\n');
    const parsed = await foundryPf2eConditionsAdapter.parseFile(
      'conditions/mixed.db',
      new TextEncoder().encode(ndjson),
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.sections ?? []).toEqual([]);
    expect(parsed.skipped).toBe(2); // the Folder doc and the NPC doc
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]).toMatchObject({
      file: 'conditions/mixed.db',
      name: '',
    });
    expect(parsed.failures[0]?.message).toContain('document 2:');
  });

  it('imports into a ready book of `section` chunks with the lanes counted in packMeta', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
      [
        { name: 'conditions/blinded.json', bytes: conditionBytes('blinded.json') },
        { name: 'conditions/frightened.json', bytes: conditionBytes('frightened.json') },
      ],
      { title: 'Conditions', deps },
    );
    expect(result.imported).toBe(2);
    expect(result.sectionsImported).toBe(2);
    expect(result.itemsImported).toBe(0);
    expect(result.book.status).toBe('ready');
    const chunks = deps.persisted.flat();
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual(['section', 'section']);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([['Blinded'], ['Frightened']]);
    expect(chunks[0]?.statBlock).toBeNull();
    expect('itemData' in (chunks[0] ?? {})).toBe(false);
    expect(deps.finalized[0]?.packMeta).toMatchObject({
      sourceId: FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
      entriesImported: 2,
      itemsImported: 0,
      sectionsImported: 2,
    });
  });

  it('fails the book loudly naming the condition noun when nothing validates', async () => {
    const deps = memoryDeps();
    await expect(
      importPack(
        FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
        [{ name: 'conditions/folder.json', bytes: encodeJson(folderDoc()) }],
        { title: 'Conditions', deps },
      ),
    ).rejects.toThrow(/no valid condition entries in the pack selection/s);
    expect(deps.failed).toHaveLength(1);
    expect(deps.finalized).toHaveLength(0);
  });
});
