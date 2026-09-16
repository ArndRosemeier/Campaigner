import { listChunksByType } from '@/db/chunkRepo';
import {
  mobSpellIndex,
  spellCorpusEntries,
  type GameSystem,
  type Id,
  type MobSpellIndex,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { readyBookIds } from '@/db/rulebookRepo';

/**
 * THE one spell-corpus read (docs/17 row 184, docs/18 §2.1).
 *
 * "Which spells does this campaign's system have?" is asked by three surfaces —
 * the Spells page, a mob's spell chips, and the run engine's stat-block
 * grounding/validation — and each of them needs the SAME answer: the `spell`
 * chunks of the campaign system's READY books. Before this module the Spells
 * page spelled that read inline (`readyBookIds` + `listRulebooks` +
 * `listChunksByType`); the mob arc would have been the second spelling, and the
 * run engine the third.
 *
 * It is NOT a second retrieval mechanism: no search, no embedding, no ranking.
 * It composes the two rules the app already owns — `db/rulebookRepo.readyBookIds` (the
 * ONE ready-book rule, shared with the retrieval pool) and
 * `chunkRepo.listChunksByType` (the ONE chunk-type read, docs/17 row 182) — and
 * returns the RAW chunks, so the caller keeps its own payload validation and
 * its own loud corrupt-row reporting (`features/spells/spell-rows`).
 *
 * A cross-system chunk is dropped by the book-id intersection, never merged: a
 * Pathfinder 2e campaign must never assign a dnd5e spell.
 */
export async function loadSpellChunksFor(system: GameSystem): Promise<RuleChunk[]> {
  const ready = new Set<Id>(await readyBookIds(system));
  return (await listChunksByType('spell')).filter((chunk) => ready.has(chunk.bookId));
}

/**
 * The distinct game systems these stat blocks carry — the systems an export
 * must build a spell corpus for. A block that is `null` (an unparsed library
 * citation) contributes nothing.
 */
export function statBlockSystems(blocks: Iterable<StatBlock | null | undefined>): Set<GameSystem> {
  const systems = new Set<GameSystem>();
  for (const block of blocks) {
    if (block !== null && block !== undefined) systems.add(block.system);
  }
  return systems;
}

/**
 * The ONE spell-index builder (docs/17 row 184): one `MobSpellIndex` per system,
 * over the corpus read above. Both PDF exporters and the run engine build their
 * index through this, so "which spells exist" has one answer per system.
 */
export async function loadSpellIndexesFor(
  systems: Iterable<GameSystem>,
): Promise<Map<GameSystem, MobSpellIndex>> {
  const indexes = new Map<GameSystem, MobSpellIndex>();
  for (const system of new Set(systems)) {
    const entries = spellCorpusEntries(await loadSpellChunksFor(system));
    indexes.set(
      system,
      mobSpellIndex(entries.map((entry) => ({ name: entry.name, spellData: entry.data }))),
    );
  }
  return indexes;
}
