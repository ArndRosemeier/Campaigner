import { listChunksByType } from '@/db/chunkRepo';
import {
  mobSpellIndex,
  spellCorpusEntries,
  spellDataSchema,
  type GameSystem,
  type Id,
  type MobSpellIndex,
  type RuleChunk,
  type StatBlock,
} from '@/domain';
import { readyBookIds } from '@/db/rulebookRepo';

/**
 * THE payload parse at the library read boundary (docs/17 row 304, docs/18
 * §2.1): the ONE seam that turns raw `spell` rows into a validated corpus.
 *
 * The schema the ingest wrote with is `domain/spellData.spellDataSchema` —
 * `ingest/packImport.sectionChunk` parses the adapter's `entry.spell` with it
 * and `chunkRepo.writeChunks` re-validates the chunk beside it — so this is the
 * SAME schema, applied at the SAME boundary from the other side. Deliberately
 * NOT `storedSpellDataSchema`: that is the transform-free COPY-ONLY variant
 * (docs/17 row 255c) whose whole reason to exist is that `z.toJSONSchema`
 * cannot represent the transform when the schema is embedded in an LLM
 * contract — it is a write/emit shape, not the library's read schema, and it
 * would skip the `filterAxis` derivation a library read owes its rows.
 *
 * WHY IT IS HERE AND NOT IN `spellCorpusEntries`:
 * `features/spells/spell-rows.buildSpellRows` reads `chunk.spellData` straight
 * off the chunks `loadSpellChunksFor` returns, so healing only in the
 * projection would leave the Spells page showing the stale payload.
 *
 * WHAT IT BUYS, exactly: `damage` (ledger 183) carries `.default({})` with the
 * comment *"keeps a payload written before this field readable"* — rows
 * physically written in the four-commit window before `c37e4de` lack the key,
 * and until row 304 nothing re-parsed them between Dexie and
 * `domain/spellHeightening.baseValues`'s `Object.entries(spell.damage)`, so a
 * mob with any of them threw `Cannot convert undefined or null to object`. A
 * payload that is GENUINELY invalid (`damage: null`, an unvalidated kind) is
 * NOT healed here: `parse` throws loudly, which is the contract `spellAtRank`'s
 * own doc comment states and what AGENTS rule 1 requires — a guard at the throw
 * site would instead mask a schema-invalid row and still leave it wrong on
 * every other surface that renders it (the spell card, the PDF detail).
 *
 * A chunk with NO payload passes through UNTOUCHED (never `null`-normalized):
 * the absent/`null` distinction is the Spells page's loud `data-error` row, and
 * that reporting stays where it is.
 */
export function parseSpellChunks(chunks: readonly RuleChunk[]): RuleChunk[] {
  return chunks.map((chunk) => {
    const payload = chunk.spellData;
    if (payload === undefined || payload === null) return chunk;
    return { ...chunk, spellData: spellDataSchema.parse(payload) };
  });
}

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
 * returns the chunks with their spell payloads PARSED (`parseSpellChunks`
 * above), so a legacy row heals through the schema's own default and a
 * genuinely invalid row fails loudly AT THE READ rather than one layer up.
 *
 * A cross-system chunk is dropped by the book-id intersection, never merged: a
 * Pathfinder 2e campaign must never assign a dnd5e spell.
 */
export async function loadSpellChunksFor(system: GameSystem): Promise<RuleChunk[]> {
  const ready = new Set<Id>(await readyBookIds(system));
  return parseSpellChunks(
    (await listChunksByType('spell')).filter((chunk) => ready.has(chunk.bookId)),
  );
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

/**
 * THE copy seam's live spell lookup (docs/17 row 255c): the index builder
 * above, LAZY (a mob with no spell costs no read) and cached per system
 * (`copyCreatureStats` hydrates a whole block from one read, and the cast path
 * copies one block per NPC).
 *
 * It exists so the two live callers — `db/libraryCopy.copyCreatureStatsFromDb`
 * and `db/creatureRepo.castCreatureAsNpc` — share ONE spelling of "read the
 * corpus once for this copy" instead of each caching a promise of its own. A
 * system with no imported corpus answers `undefined`, which the seam reads as
 * "no library" rather than an error.
 */
export function spellIndexLookup(): (
  system: GameSystem,
) => Promise<MobSpellIndex | undefined> {
  let indexes: Promise<Map<GameSystem, MobSpellIndex>> | null = null;
  return async (system) => {
    indexes ??= loadSpellIndexesFor([system]);
    return (await indexes).get(system);
  };
}
