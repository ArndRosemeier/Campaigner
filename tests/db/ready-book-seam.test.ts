import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createPackBook, finalizePackBook, listReadyRulebooks, readyBookIds } from '@/db/rulebookRepo';
import { clearDatabase } from './helpers';

/**
 * THE one ready-book rule (docs/17 row 184, docs/18 §2.1).
 *
 * "Which books are ready — and of this system?" had THREE spellings: the
 * `readyBookIds` filter in `search/search.ts` and two identical
 * `(await listRulebooks()).filter((book) => book.status === 'ready')` reads in
 * `bestiary-roster.tsx` and `SpawnPicker.tsx`. The spell arc needed the answer
 * from `db/` (a `db` module importing the retrieval barrel was a layering
 * inversion AND a live coupling — three LLM tests mock `@/search` with only
 * `searchRules`), so the rule moved to the module that owns the rows and the two
 * component copies were folded onto `listReadyRulebooks`.
 *
 * The pins are BOTH halves: the behaviour (which rows, in which order, per
 * system) and a SOURCE SCAN over the exact idiom, because a fourth copy is
 * invisible until one of them drifts.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SEAM = 'src/db/rulebookRepo.ts';
/**
 * The predicate itself — the two component copies spelled it
 * `(book) => book.status === 'ready'` verbatim. A single book's status BADGE
 * (`book.status === 'ready'`, the Rules page) is a different question and is
 * deliberately not matched: this needle carries the filter's own arrow.
 */
const READY_FILTER_NEEDLE = "(book) => book.status === 'ready'";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

beforeEach(clearDatabase);

async function readyBook(title: string, system: 'pathfinder2e' | 'dnd5e') {
  const book = await createPackBook({ title, system, filename: 'pack.json' });
  return finalizePackBook(book.id, {
    sourceId: 'test-pack',
    license: 'CC-BY-4.0',
    entriesImported: 0,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
}

describe('the ONE ready-book rule', () => {
  it('lists ready books (most recently updated first) and filters by system', async () => {
    await readyBook('PF2e Rules', 'pathfinder2e');
    await readyBook('D&D SRD', 'dnd5e');

    const all = await listReadyRulebooks();
    expect(all.map((book) => book.title)).toEqual(['D&D SRD', 'PF2e Rules']);
    expect((await listReadyRulebooks('pathfinder2e')).map((book) => book.title)).toEqual([
      'PF2e Rules',
    ]);

    // The ID form is the SAME answer, mapped — not a second filter.
    expect(await readyBookIds()).toEqual(all.map((book) => book.id));
    expect(await readyBookIds('dnd5e')).toEqual(
      (await listReadyRulebooks('dnd5e')).map((book) => book.id),
    );
  });

  it('declares the ready filter ONCE, in db/rulebookRepo.ts (SOURCE SCAN)', () => {
    const owners = sourceFiles(SRC_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes(READY_FILTER_NEEDLE))
      .map((file) => relative(process.cwd(), file));
    expect(owners).toEqual([SEAM]);
  });
});
