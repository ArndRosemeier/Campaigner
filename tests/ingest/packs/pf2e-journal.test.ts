import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PackMeta } from '@/domain/rulebook';
import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  FOUNDRY_PF2E_JOURNAL_ADAPTER_ID,
  foundryPf2eJournalAdapter,
} from '@/ingest/packs/pf2e-journal';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import type { PackFileParse, PackSectionEntry } from '@/ingest/packs/types';

import { encodeJson, folderDoc } from './fixtures';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e-journal');

/**
 * `foundry-pf2e-journal` adapter tests (docs/12 §15): the fixture is the REAL
 * upstream GM Screen journal trimmed to three whole pages — "Bonuses and
 * Penalties" (its proficiency table trimmed to two body rows), "Encounter
 * Budget" (kept byte-for-byte — the advisory-grounding page), and the
 * level-1 "Running the Game" divider (real, no Section footer). Everything
 * else is upstream-shape preservation: one chunk per page, HTML stripped
 * table-aware, the `Section:` footer becoming the heading category and the
 * `pg.` footer the trailing Source line.
 */

/** Verbatim-trimmed live source (docs/12 §10 lesson). */
const FIXTURE_SOURCE = 'packs/pf2e/journals/gm-screen.json @ v14-dev (61 pages; trimmed to 3)';

function journalBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

async function parseFixture(): Promise<PackFileParse> {
  return foundryPf2eJournalAdapter.parseFile('journals/gm-screen.json', journalBytes('gm-screen.json'));
}


/** Indexed access under noUncheckedIndexedAccess — an out-of-range index is a test bug, loudly. */
function sectionAt(sections: PackSectionEntry[], index: number): PackSectionEntry {
  const section = sections[index];
  if (section === undefined) throw new Error(`unreachable: section ${String(index)} asserted`);
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

describe('foundry-pf2e-journal adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await parseFixture();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is registered with the journal-page entry noun and the GM Screen license', () => {
    expect(getPackAdapter(FOUNDRY_PF2E_JOURNAL_ADAPTER_ID).id).toBe(FOUNDRY_PF2E_JOURNAL_ADAPTER_ID);
    expect(PACK_ADAPTERS.map((adapter) => adapter.entryNoun)).toContain('journal page');
    expect(foundryPf2eJournalAdapter.license).toContain('SUMMARIZES Pathfinder GM Core');
    expect(foundryPf2eJournalAdapter.license).toContain('Community Use Policy');
  });

  it('maps the real GM Screen fixture one-chunk-per-page with the section categories', async () => {
    const parsed = await parseFixture();
    expect(parsed.failures).toEqual([]);
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries).toEqual([]);
    const sections = parsed.sections ?? [];
    expect(FIXTURE_SOURCE).toContain('trimmed to 3');
    expect(sections.map((section) => section.name)).toEqual([
      'Bonuses and Penalties',
      'Encounter Budget',
      'Running the Game',
    ]);
    expect(sections.map((section) => section.categories)).toEqual([
      ['Playing the Game'],
      ['Running the Game'],
      [], // the level-1 divider page carries no Section footer
    ]);
  });

  it('strips the HTML table-aware — the Encounter Budget table stays readable', async () => {
    const parsed = await parseFixture();
    const budget = sectionAt(parsed.sections ?? [], 1);
    expect(budget.text).toContain('Difficulty | XP Budget | Character Adjustment');
    expect(budget.text).toContain('Trivial | 40 or less | 10 or less');
    expect(budget.text).toContain('Low | 60 | 20');
    expect(budget.text).toContain('Moderate | 80 | 20');
    expect(budget.text).toContain('Severe | 120 | 30');
    expect(budget.text).toContain('Extreme | 160 | 40');
    // No raw tags or unresolved notation survive the strip.
    expect(budget.text).not.toMatch(/<[^>]+>/);
    expect(budget.text).not.toContain('@UUID');
  });

  it('keeps the page citation as a trailing Source line and drops the duplicated footer', async () => {
    const parsed = await parseFixture();
    const budget = sectionAt(parsed.sections ?? [], 1);
    expect(budget.text).toContain('Source: Pathfinder GM Core pg. 75');
    // The raw footer paragraph must not survive the strip (no duplication).
    expect(budget.text).not.toContain('Section: Running the Game');
    // The divider page lists its sources in the body — no citation footer.
    const divider = sectionAt(parsed.sections ?? [], 2);
    expect(divider.text).toContain('Pathfinder GM Core');
    expect(divider.text).toContain('Pathfinder Monster Core');
    expect(divider.text).not.toContain('Source: Pathfinder GM Core pg.');
  });

  it('resolves @-notation label-first and keeps plain prose (Bonuses page)', async () => {
    const parsed = await parseFixture();
    const bonuses = sectionAt(parsed.sections ?? [], 0);
    expect(bonuses.text).toContain('Proficiency Rank | Proficiency Bonus');
    expect(bonuses.text).toContain('Untrained | 0');
    expect(bonuses.text).toContain('Your level + 2');
    expect(bonuses.text).toContain("you can use only the highest bonus on a given roll");
  });

  it('accepts the NDJSON `.db` layout and skips non-journal documents', async () => {
    const ndjson = [
      JSON.stringify(folderDoc()),
      JSON.stringify({ name: 'Hero Point Deck', pages: [
        { name: 'Gain a Hero Point', text: { content: '<p>At the start of each session…</p>' } },
      ] }),
    ].join('\n');
    const parsed = await foundryPf2eJournalAdapter.parseFile('journals/deck.db', new TextEncoder().encode(ndjson));
    expect(parsed.skipped).toBe(1); // the Folder document
    expect((parsed.sections ?? []).map((section) => section.name)).toEqual(['Gain a Hero Point']);
  });

  it('fails the offending page loudly and keeps the healthy ones', async () => {
    const doc = {
      name: 'GM Screen',
      pages: [
        { name: 'Healthy Page', text: { content: '<p>Fine.</p>' } },
        { name: 'Broken Page', text: { content: 42 } },
        { text: { content: '<p>No name.</p>' } },
      ],
    };
    const parsed = await foundryPf2eJournalAdapter.parseFile('journals/broken.json', encodeJson(doc));
    expect((parsed.sections ?? []).map((section) => section.name)).toEqual(['Healthy Page']);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0]).toMatchObject({ file: 'journals/broken.json', name: 'Broken Page' });
    expect(parsed.failures[0]?.message).toContain('page 1:');
    expect(parsed.failures[1]).toMatchObject({ file: 'journals/broken.json', name: '' });
    expect(parsed.failures[1]?.message).toContain('page 2:');
  });

  it('imports into a ready book of `section` chunks with the lanes counted in packMeta', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      FOUNDRY_PF2E_JOURNAL_ADAPTER_ID,
      [{ name: 'journals/gm-screen.json', bytes: journalBytes('gm-screen.json') }],
      { title: 'PF2e GM Screen (Paizo–Foundry partnership; summarizes GM Core)', deps },
    );
    expect(result.imported).toBe(3);
    expect(result.sectionsImported).toBe(3);
    expect(result.itemsImported).toBe(0);
    expect(result.book.status).toBe('ready');
    const chunks = deps.persisted.flat();
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual(['section', 'section', 'section']);
    expect(chunks.map((chunk) => chunk.headingPath[0])).toEqual([
      'Playing the Game',
      'Running the Game',
      'Running the Game',
    ]);
    const budget = chunks[1];
    if (budget === undefined) throw new Error('unreachable: budget chunk asserted');
    expect(budget.headingPath).toEqual(['Running the Game', 'Encounter Budget']);
    expect(budget.statBlock).toBeNull();
    expect('itemData' in budget).toBe(false);
    expect(budget.text).toContain('Source: Pathfinder GM Core pg. 75');
    expect(deps.finalized[0]?.packMeta).toMatchObject({
      sourceId: FOUNDRY_PF2E_JOURNAL_ADAPTER_ID,
      entriesImported: 3,
      itemsImported: 0,
      sectionsImported: 3,
    });
  });

  it('fails the book loudly naming the journal-page noun when a fetch validates zero pages', async () => {
    const deps = memoryDeps();
    const empty = { name: 'Empty Journal', pages: [folderDoc()] };
    await expect(
      importPack(
        FOUNDRY_PF2E_JOURNAL_ADAPTER_ID,
        [{ name: 'journals/empty.json', bytes: encodeJson(empty) }],
        { title: 'Empty Journal', deps },
      ),
    ).rejects.toThrow(/no valid journal page entries in the pack selection/s);
    expect(deps.failed).toHaveLength(1);
    expect(deps.finalized).toHaveLength(0);
  });
});
