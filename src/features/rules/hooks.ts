import { useLiveQuery } from 'dexie-react-hooks';

import { countChunksByBook, listChunksByType } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import { parseSpellChunks } from '@/db/spellRepo';
import { spellCorpusEntries, type Id, type RuleChunk } from '@/domain';
import type { Rulebook } from '@/domain/rulebook';

export interface RulebookSummary {
  book: Rulebook;
  chunkCount: number;
  /**
   * The spells THIS book's list will show (docs/17 row 204), counted live
   * through the same corpus projection the Spells page renders
   * (`domain/spellData.spellCorpusEntries`). It exists because the spell lane
   * is the ONE lane that cannot be read back from `packMeta`: the books the
   * spells arc (row 181) already imported carry `spell` chunks but predate the
   * stored `spellsImported` count, so a card that trusted `packMeta` alone
   * would print `0 spells` for a book whose page is full.
   */
  spellChunkCount: number;
}

/** Live book list with chunk counts (most recently updated first). */
export function useRulebookSummaries(): RulebookSummary[] | undefined {
  return useLiveQuery(async () => {
    const books = await listRulebooks();
    // ONE chunk-type read for the whole library (the docs/18 §2.1 seam),
    // grouped by book — never one query per book. The payloads are parsed
    // through the SAME seam the corpus read uses (`db/spellRepo
    // .parseSpellChunks`, docs/17 row 304): this is the SECOND raw `spell`
    // read in `src/`, and leaving it raw would let this count and the Spells
    // page disagree about the same legacy row (the count silently skipping one
    // the page just healed). It costs only the parse of a payload that is
    // already in memory.
    const spellChunksByBook = new Map<Id, RuleChunk[]>();
    for (const chunk of parseSpellChunks(await listChunksByType('spell'))) {
      const rows = spellChunksByBook.get(chunk.bookId);
      if (rows === undefined) spellChunksByBook.set(chunk.bookId, [chunk]);
      else rows.push(chunk);
    }
    return Promise.all(
      books.map(async (book) => ({
        book,
        chunkCount: await countChunksByBook(book.id),
        spellChunkCount: spellCorpusEntries(spellChunksByBook.get(book.id) ?? []).length,
      })),
    );
  }, []);
}
