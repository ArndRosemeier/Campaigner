import { useLiveQuery } from 'dexie-react-hooks';

import { countChunksByBook } from '@/db/chunkRepo';
import { listRulebooks } from '@/db/rulebookRepo';
import type { Rulebook } from '@/domain/rulebook';

export interface RulebookSummary {
  book: Rulebook;
  chunkCount: number;
}

/** Live book list with chunk counts (most recently updated first). */
export function useRulebookSummaries(): RulebookSummary[] | undefined {
  return useLiveQuery(async () => {
    const books = await listRulebooks();
    return Promise.all(
      books.map(async (book) => ({
        book,
        chunkCount: await countChunksByBook(book.id),
      })),
    );
  }, []);
}
