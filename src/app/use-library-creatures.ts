import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { db } from '@/db/db';
import { canonicalCreatureName } from '@/db/mobPortraitCache';
import { setLibraryCreaturePool } from '@/lib/wikilinks';
import type { WikiLinkCreature } from '@/domain';

/**
 * Publishes the installed bestiary's creatures to the wiki-link resolver
 * (docs/11 D10) and keeps it current.
 *
 * WHY THIS EXISTS: a wiki-link that names a creature used to resolve to a
 * shared `npc` artifact. Under the ratified model there is no such artifact —
 * the mention IS the citation — so the resolver must be able to answer
 * "a creature of this name exists in the library" without a row. This hook is
 * that answer: it watches the library's stat-block chunks (`chunkType`
 * index) and republishes the pool whenever a book is imported, deleted or
 * re-embedded, so the reader's `[[Zombie]]` resolves the moment the pack
 * that carries it lands — never a dangling chip that a reload would fix.
 *
 * The read is the ONE canonical-naming rule (`canonicalCreatureName`, the same
 * one the portrait cache and the creature repo use), so a creature's wiki name
 * and its identity always agree.
 */
export function useLibraryCreaturePool(): void {
  const creatures = useLiveQuery(async () => {
    const chunks = await db.chunks.where('chunkType').equals('statblock').toArray();
    const pool: WikiLinkCreature[] = [];
    for (const chunk of chunks) {
      if (chunk.statBlock === null) continue;
      const name = canonicalCreatureName(chunk);
      if (name === null) continue;
      pool.push({ chunkId: chunk.id, name });
    }
    pool.sort((left, right) => left.name.localeCompare(right.name));
    return pool;
  }, []);

  useEffect(() => {
    // undefined = the live query has not answered yet (first run): publishing
    // an empty pool would make every creature mention flash as broken, so the
    // previous pool stands until the real one arrives.
    if (creatures === undefined) return;
    setLibraryCreaturePool(creatures);
  }, [creatures]);
}
