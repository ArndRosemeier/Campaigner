import { unzipSync } from 'fflate';

import { stampNewEntity, type Id } from '@/domain/entity';
import type { GameSystem } from '@/domain/gameSystem';
import { itemDataSchema, type ItemData } from '@/domain/itemData';
import type { PackMeta, PackProvenance, Rulebook } from '@/domain/rulebook';
import { ruleChunkSchema, type RuleChunk } from '@/domain/rulebook';
import { spellCorpusEntries, spellDataSchema } from '@/domain/spellData';
import type { StatBlock } from '@/domain/statblock';
import { statBlockSchema } from '@/domain/statblock';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, failPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { errorMessage } from '@/lib/errors';
import { ingestLockName, withGenerationLock } from '@/lib/generationLocks';

import { getPackAdapter } from './packs/registry';
import { extensionOf } from './packs/types';
import type {
  PackAdapter,
  PackEntry,
  PackEntryFailure,
  PackInputFile,
  PackItemEntry,
  PackSectionEntry,
} from './packs/types';

/**
 * Bestiary pack import runner (12-BESTIARY-PACKS §6/§13; docs/12 §15): expands
 * zip inputs, hands files to the selected adapter, validates creature entries
 * at the `statBlockSchema` boundary, item entries at the `itemDataSchema`
 * boundary and rules-text entries at the `section`/`spell`-chunk boundary,
 * persists `statblock`, `item`, `section` and `spell` RuleChunks in batches,
 * and finalizes the pack book with its import report. Failure policy is loud:
 * per-entry problems are collected into the report, and a selection with zero
 * valid entries fails the book (`status: 'error'`) and throws — an empty
 * "ready" book is forbidden.
 *
 * NO CREATED BOOK IS EVER LEFT `'processing'` (docs/17 row 277). The row exists
 * from `createBook` onward, and ANY throw after it lands the row in `'error'`
 * carrying the failure's own message before the error is rethrown — a parse
 * failure, a persist failure and a finalize failure alike. The guard is
 * EXACTLY-ONCE: the zero-entry arm writes its own message and marks it, so the
 * outer guard never re-fails a row that already landed. The post-create pass
 * also holds the ONE cross-tab ingest lease (`lib/generationLocks`), which is
 * what lets `ingest/ingestReconcile` tell this live import from a row a
 * discarded tab left behind.
 *
 * THE SYSTEM-AGREEMENT CHECK (docs/17 row 209). A book's `system` is a
 * constant per adapter (`adapter.system`, written to the book at
 * `createBook`), while an adapter's parsed payloads THEMSELVES carry a game
 * system (`StatBlock.system`, `ItemData.system`, `SpellData.system`). Nothing
 * used to compare the two, so a mis-chosen adapter could store a PF2e rules
 * pack as dnd5e — invisible to every PF2e campaign. Every emitted payload is
 * now checked against the adapter's declared system BEFORE it is imported: a
 * disagreement is a LOUD per-entry failure in the report the importer already
 * builds (never a `console` line, never a silent drop, never a coerced
 * payload), the agreeing entries still import, and a whole selection that
 * disagrees hits the EXISTING zero-entry failure path above. A payload that
 * makes no system claim is not a disagreement.
 *
 * The Dexie deps are injectable so tests run the whole flow in memory; the
 * UI integration points are `importPack(adapterId, await Promise.all(files.map
 * (fileToPackInput)))` from the /rules import dialog and, for fetched packs,
 * `fetchAndImportPack(...)` in `./packFetch.ts` (16-BESTIARY-FETCH), which
 * hands downloaded bytes in as `PackInputFile`s and passes its collected
 * download failures + provenance through `options` — no pipeline fork.
 */

export interface PackImportProgress {
  bookId: Id;
  done: number;
  total: number;
}

export interface PackImportResult {
  book: Rulebook;
  /**
   * The game system this book was stored as — the ADAPTER's DECLARED system
   * (`PackAdapter.system`, the value `createBook` was handed), docs/17 row
   * 209. Every payload the import accepted carries this same system (the
   * agreement check in `importPack` refuses one that claims another), so the
   * import report can state "this pack went in as <system>" without asking
   * the book row back. It is a REPORT field only: the check and this line
   * never change what an adapter emits, its declared system or the schemas.
   */
  system: GameSystem;
  chunkCount: number;
  /** Valid entries the import produced — creature AND item lanes combined. */
  imported: number;
  /** Valid item entries (the `item` chunk lane, 12-BESTIARY-PACKS §13). */
  itemsImported: number;
  /**
   * Valid rules-text entries (the `section`/`spell` chunk lane, docs/12 §15):
   * journal pages, conditions, feats, spells, actions, class features. It
   * MIXES the spell lane in, which is why the report also states
   * `spellsImported` separately (docs/17 row 204).
   */
  sectionsImported: number;
  /**
   * The SPELL rows this import produced, through the SAME corpus projection
   * the Spells page renders (`domain/spellData.spellCorpusEntries`: a `spell`
   * chunk that carries a validated payload and a name) — docs/17 row 204. It
   * is a SUBSET of `sectionsImported` (every spell rides the rules-text lane)
   * and it means "the spells this book's list will actually show": the
   * importer cannot write a payload-less `spell` chunk (`sectionChunk` parses
   * the payload or fails loudly), and a corrupt one would be a loud data-error
   * row on the page rather than a counted spell.
   */
  spellsImported: number;
  skipped: number;
  failed: PackEntryFailure[];
}

export interface PackImportDeps {
  createBook(input: { title: string; system: GameSystem; filename: string }): Promise<Rulebook>;
  persistChunks(chunks: RuleChunk[]): Promise<void>;
  finalizeBook(id: Id, packMeta: PackMeta): Promise<Rulebook>;
  failBook(id: Id, message: string): Promise<void>;
}

export interface PackImportOptions {
  /** Book title; derived from the first selection file when omitted. */
  title?: string | undefined;
  onProgress?: ((progress: PackImportProgress) => void) | undefined;
  deps?: PackImportDeps | undefined;
  /**
   * Failures collected BEFORE parsing (16-BESTIARY-FETCH §8: failed pack
   * downloads). Folded into the report and `packMeta.entriesFailed` so a
   * fetched book's failure count covers the whole fetch→import action.
   */
  extraFailures?: readonly PackEntryFailure[] | undefined;
  /** Fetch provenance stamped on `packMeta` (absent for manual imports). */
  provenance?: PackProvenance | undefined;
}

export const dexiePackImportDeps: PackImportDeps = {
  createBook: (input) => createPackBook(input),
  persistChunks: (chunks) => putChunks(chunks),
  finalizeBook: (id, packMeta) => finalizePackBook(id, packMeta),
  failBook: (id, message) => failPackBook(id, message),
};

const CHUNK_BATCH = 250;

// --- File expansion ---------------------------------------------------------

type ExpandedFile =
  | { kind: 'parse'; file: PackInputFile }
  // An explicitly selected file the adapter cannot read: a loud failure.
  | { kind: 'unsupported-input'; file: PackInputFile }
  // A zip member that is not pack content (code, images, other packs): skipped.
  | { kind: 'unsupported-member'; file: PackInputFile };

function isParseable(adapter: PackAdapter, name: string): boolean {
  return adapter.extensions.includes(extensionOf(name));
}

function isJunkMember(name: string): boolean {
  const base = name.split('/').pop() ?? '';
  return name.endsWith('/') || base.startsWith('.');
}

function* expandFiles(
  inputs: readonly PackInputFile[],
  adapter: PackAdapter,
): Generator<ExpandedFile> {
  for (const input of inputs) {
    if (extensionOf(input.name) === '.zip') {
      const members = unzipSync(input.bytes);
      for (const [name, bytes] of Object.entries(members)) {
        if (isJunkMember(name)) continue;
        const member: PackInputFile = { name, bytes };
        yield isParseable(adapter, name)
          ? { kind: 'parse', file: member }
          : { kind: 'unsupported-member', file: member };
      }
      continue;
    }
    yield isParseable(adapter, input.name)
      ? { kind: 'parse', file: input }
      : { kind: 'unsupported-input', file: input };
  }
}

// --- Title derivation -------------------------------------------------------

function baseTitle(name: string): string {
  return name.split('/').pop()?.replace(/\.[^.]+$/, '').trim() ?? '';
}

export function derivePackTitle(inputs: readonly PackInputFile[]): string {
  const zips = inputs.filter((input) => extensionOf(input.name) === '.zip');
  if (zips.length === 1) {
    const first = zips[0];
    if (first !== undefined) return baseTitle(first.name);
  }
  const first = inputs[0];
  return first === undefined ? '' : baseTitle(first.name);
}

// --- Runner -----------------------------------------------------------------

function* batches<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

/**
 * The game system an adapter-emitted payload CLAIMS, or null when it states
 * none (docs/17 row 209).
 *
 * Only a payload that exists AND carries a system can disagree. A rules-text
 * entry with no structured `spell` half (a journal page, a condition, a feat)
 * carries NO payload and therefore makes NO claim — absent is not
 * disagreement, and this helper must never invent one. Every payload that
 * DOES exist is schema-bound to a `GameSystem` id, never a display label, so
 * the comparison below is id-to-id.
 */
function claimedSystem(payload: { system?: unknown } | undefined): string | null {
  const value = payload?.system;
  return typeof value === 'string' ? value : null;
}

/**
 * THE import-time system-agreement refusal (docs/17 row 209) — the ONE
 * sentence, produced once and rendered by the report's existing failure list.
 * `claimed === null` means the payload made no claim (see `claimedSystem`) and
 * is NOT a failure; an agreement is not a failure either.
 */
function systemAgreementFailure(
  adapter: PackAdapter,
  file: string,
  lane: string,
  name: string,
  claimed: string | null,
): PackEntryFailure | null {
  if (claimed === null || claimed === adapter.system) return null;
  return {
    file,
    name,
    message:
      `the ${lane} is for game system "${claimed}", but adapter "${adapter.id}" ` +
      `declares "${adapter.system}"`,
  };
}

/**
 * Splits one lane's emitted entries into the ones whose payload agrees with
 * the adapter's declared system and the LOUD per-entry refusals for the ones
 * that claim another. ONE mechanism for all three lanes (docs/17 row 209).
 */
function partitionAgreeing<T>(
  list: readonly T[],
  adapter: PackAdapter,
  file: string,
  lane: string,
  nameOf: (entry: T) => string,
  payloadOf: (entry: T) => { system?: unknown } | undefined,
): { accepted: T[]; failures: PackEntryFailure[] } {
  const accepted: T[] = [];
  const failures: PackEntryFailure[] = [];
  for (const entry of list) {
    const failure = systemAgreementFailure(
      adapter,
      file,
      lane,
      nameOf(entry),
      claimedSystem(payloadOf(entry)),
    );
    if (failure === null) accepted.push(entry);
    else failures.push(failure);
  }
  return { accepted, failures };
}

export async function importPack(
  adapterId: string,
  inputs: readonly PackInputFile[],
  options: PackImportOptions = {},
): Promise<PackImportResult> {
  const adapter = getPackAdapter(adapterId);
  if (inputs.length === 0) throw new Error('pack import received no files');
  const deps = options.deps ?? dexiePackImportDeps;

  const entries: PackEntry[] = [];
  const items: PackItemEntry[] = [];
  const sections: PackSectionEntry[] = [];
  const failures: PackEntryFailure[] = [...(options.extraFailures ?? [])];
  let skipped = 0;
  for (const expanded of expandFiles(inputs, adapter)) {
    if (expanded.kind === 'unsupported-input') {
      failures.push({
        file: expanded.file.name,
        name: '',
        message: `adapter "${adapter.id}" cannot parse ${extensionOf(expanded.file.name) || 'files without extension'}`,
      });
      continue;
    }
    if (expanded.kind === 'unsupported-member') {
      skipped += 1;
      continue;
    }
    try {
      const parsed = await adapter.parseFile(expanded.file.name, expanded.file.bytes);
      // The system-agreement check (docs/17 row 209) runs on EVERY emitted
      // payload, per lane, BEFORE the chunk-building step parses it: an entry
      // whose payload claims a system other than the adapter's declared one is
      // refused into the SAME `failures` list the adapter's own per-entry
      // problems use — never dropped silently, never coerced, never imported.
      const creatures = partitionAgreeing(
        parsed.entries,
        adapter,
        expanded.file.name,
        'stat block',
        (entry) => entry.name,
        (entry) => entry.statBlock,
      );
      const itemLane = partitionAgreeing(
        parsed.items ?? [],
        adapter,
        expanded.file.name,
        'item',
        (entry) => entry.name,
        (entry) => entry.item,
      );
      const sectionLane = partitionAgreeing(
        parsed.sections ?? [],
        adapter,
        expanded.file.name,
        'spell',
        (entry) => entry.name,
        (entry) => entry.spell,
      );
      entries.push(...creatures.accepted);
      items.push(...itemLane.accepted);
      sections.push(...sectionLane.accepted);
      failures.push(...creatures.failures, ...itemLane.failures, ...sectionLane.failures);
      skipped += parsed.skipped;
      failures.push(...parsed.failures);
    } catch (error) {
      failures.push({ file: expanded.file.name, name: '', message: errorMessage(error) });
    }
  }

  const title = options.title ?? derivePackTitle(inputs);
  if (title === '') {
    throw new Error('pack import needs a title (pass options.title or select a named file/zip)');
  }
  const firstInput = inputs[0];
  const book = await deps.createBook({
    title,
    system: adapter.system,
    filename: firstInput === undefined ? title : firstInput.name,
  });

  // THE PACK-IMPORT LEASE (docs/17 row 266's lease, held by packs since row
  // 277): the whole post-create pass runs under the ONE ingest lease, exactly
  // as `ingest/ingestFiles.ingestPdf` runs a PDF's extraction + persistence.
  // It is what makes `ingest/ingestReconcile`'s
  // `isGenerationLockHeld(ingestLockName(bookId))` guard NON-VACUOUS on a pack
  // book: without it a start-up in another tab would read this book's
  // `'processing'` row, find no lease, and fail an import that is genuinely
  // running. Advisory like every generation lock — with no Web Locks API the
  // work runs directly (`lib/generationLocks`).
  return withGenerationLock(ingestLockName(book.id), async () => {
    // ANY throw after the row exists must leave it NAMED, never `'processing'`
    // forever (the row-241 residual this slice closes; docs/18 §5). Exactly
    // once: a failure this pass has ALREADY written through `deps.failBook`
    // (the zero-entry arm below) sets `bookFailed`, so the row is never
    // double-failed by this guard.
    //
    // The PDF twin of this guard is `ingest/ingestFiles.ingestPdf`'s own catch
    // (`:142-146`). They are deliberately left as siblings rather than folded
    // into one seam: this one carries the extra exactly-once state, and
    // re-plumbing the ingest's book creation is explicitly out of row 277's
    // scope (docs/18 §5(b)). A later slice that touches ingest book creation
    // should fold them.
    let bookFailed = false;
    try {
      const base = Date.now();
      const chunks: RuleChunk[] = [];
      for (const [index, entry] of entries.entries()) {
        const statBlock = statBlockSchema.parse(entry.statBlock);
        chunks.push(await ruleChunk(entry, statBlock, book.id, base + index));
      }
      // The item lane (12-BESTIARY-PACKS §13): stamps continue after the
      // creature lane so `createdAt` ordering stays unique across the combined
      // chunk list.
      for (const [index, entry] of items.entries()) {
        const item = itemDataSchema.parse(entry.item);
        chunks.push(await itemChunk(entry, item, book.id, base + entries.length + index));
      }
      // The rules-text lane (docs/12 §15): stamps continue after the item lane.
      for (const [index, entry] of sections.entries()) {
        chunks.push(
          await sectionChunk(entry, book.id, base + entries.length + items.length + index),
        );
      }

      // The per-lane SPELL count (docs/17 row 204): counted from the chunks
      // this run BUILT, through the ONE seam below — never a second pass over
      // the documents and never a re-derivation.
      const spellsImported = spellsImportedFromChunks(chunks);

      let done = 0;
      for (const batch of batches(chunks, CHUNK_BATCH)) {
        await deps.persistChunks([...batch]);
        done += batch.length;
        options.onProgress?.({ bookId: book.id, done, total: chunks.length });
      }

      const packMeta: PackMeta = {
        sourceId: adapter.id,
        license: adapter.license,
        entriesImported: entries.length + items.length + sections.length,
        entriesSkipped: skipped,
        entriesFailed: failures.length,
        itemsImported: items.length,
        sectionsImported: sections.length,
        ...options.provenance,
      };

      if (entries.length === 0 && items.length === 0 && sections.length === 0) {
        const fetchedCount = inputs.length + (options.extraFailures?.length ?? 0);
        // 16-BESTIARY-FETCH §6: when the selection validates nothing, the error
        // leads with a representative failure (the first entry's issue) so the
        // toast and the error-state book show the reason, not just a count. The
        // noun comes from the adapter so an item pack's error says "item".
        const noun = adapter.entryNoun ?? 'creature';
        const representative = leadFailure(failures);
        const message =
          (representative === null ? '' : `${representative} — `) +
          `no valid ${noun} entries in the pack selection ` +
          `(${String(skipped)} skipped, ${String(failures.length)} failed` +
          (options.extraFailures === undefined
            ? ''
            : ` of ${String(fetchedCount)} fetched files`) +
          `)`;
        await deps.failBook(book.id, message);
        bookFailed = true;
        throw new Error(`${message} — book "${title}" marked as error`);
      }

      const ready = await deps.finalizeBook(book.id, packMeta);
      return {
        book: ready,
        system: adapter.system,
        chunkCount: chunks.length,
        imported: entries.length + items.length + sections.length,
        itemsImported: items.length,
        sectionsImported: sections.length,
        spellsImported,
        skipped,
        failed: failures,
      };
    } catch (error) {
      if (!bookFailed) {
        // A failing `failBook` must NOT replace the import failure (AGENTS rule
        // 1): the row is gone, so there is nothing left to name, and BOTH
        // messages must survive in one loud throw. The cause stays the ORIGINAL
        // import error — that is the failure the owner has to act on.
        let markError: unknown;
        try {
          await deps.failBook(book.id, errorMessage(error));
        } catch (caught) {
          markError = caught;
        }
        if (markError !== undefined) {
          throw new Error(
            `${errorMessage(error)} — the book could not be marked as error: ` +
              errorMessage(markError),
            { cause: error },
          );
        }
      }
      throw error;
    }
  });
}

/**
 * The spells a built chunk list will actually show (docs/17 row 204) — the ONE
 * count the import report states, and the meaning "the spell count" has.
 *
 * It is the corpus's OWN projection over the chunks
 * (`domain/spellData.spellCorpusEntries` — a `spell` chunk with a validated
 * payload AND a name), NOT a bare `chunkType === 'spell'` tally: a `spell`
 * chunk with no payload is a loud `data-error` row on the Spells page (or on a
 * mob that cites it), never a spell, so this number can never be inflated by a
 * corrupt row. The importer itself cannot write one (`sectionChunk` parses the
 * payload or throws), which is why the two agree on imported data.
 */
export function spellsImportedFromChunks(chunks: readonly RuleChunk[]): number {
  return spellCorpusEntries(chunks).length;
}

/**
 * The representative failure for a zero-entry import (16-BESTIARY-FETCH §6):
 * the first entry failure, as a readable "file (name): issue" line. Null when
 * nothing failed (e.g. every file was skipped) — no invented reason.
 */
function leadFailure(failures: PackEntryFailure[]): string | null {
  const first = failures[0];
  if (first === undefined) return null;
  const subject = first.name === '' ? first.file : `${first.file} (${first.name})`;
  return `${subject}: ${first.message}`;
}

/**
 * Validates + stamps one entry as a `statblock` RuleChunk (12-BESTIARY-PACKS
 * §4): page numbers are meaningless for packs (schema requires positive ints),
 * the creature name is the heading, and the rendered text drives search and
 * the contentHash embedding-cache key.
 */
async function ruleChunk(
  entry: PackEntry,
  statBlock: StatBlock,
  bookId: Id,
  stampBase: number,
): Promise<RuleChunk> {
  const text = entry.text;
  return ruleChunkSchema.parse({
    ...stampNewEntity(stampBase),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'statblock',
    headingPath: [entry.name],
    text,
    statBlock,
    contentHash: await sha256Hex(text),
  });
}

/**
 * Validates + stamps one item entry as an `item` RuleChunk (12-BESTIARY-PACKS
 * §13): same conventions as the creature lane — page numbers are meaningless
 * for packs, the item name is the heading, `statBlock` stays null, and the
 * rendered text drives search, display and the `contentHash` cache key.
 */
async function itemChunk(
  entry: PackItemEntry,
  item: ItemData,
  bookId: Id,
  stampBase: number,
): Promise<RuleChunk> {
  const text = entry.text;
  return ruleChunkSchema.parse({
    ...stampNewEntity(stampBase),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: 'item',
    headingPath: [entry.name],
    text,
    statBlock: null,
    itemData: item,
    contentHash: await sha256Hex(text),
  });
}

/**
 * Validates + stamps one rules-text entry as a `section` RuleChunk (docs/12
 * §15): same conventions as the other two lanes — page numbers are
 * meaningless for packs, the adapter supplies the full heading path
 * (category segments first, the entry name last), `statBlock` stays null and
 * the rendered text drives search, display and the `contentHash` cache key.
 * An entry that carries a structured `spell` payload becomes a `spell` chunk
 * instead (the spells arc): the SAME lane, the SAME bytes, one validated
 * payload — a non-spell entry omits the key and stays a `section` chunk, so
 * legacy rows and all other rules text parse and behave unchanged.
 */
async function sectionChunk(
  entry: PackSectionEntry,
  bookId: Id,
  stampBase: number,
): Promise<RuleChunk> {
  const text = entry.text;
  const spell = entry.spell === undefined ? null : spellDataSchema.parse(entry.spell);
  return ruleChunkSchema.parse({
    ...stampNewEntity(stampBase),
    bookId,
    pageStart: 1,
    pageEnd: 1,
    chunkType: spell === null ? 'section' : 'spell',
    headingPath: [...entry.categories, entry.name],
    text,
    statBlock: null,
    ...(spell === null ? {} : { spellData: spell }),
    contentHash: await sha256Hex(text),
  });
}
