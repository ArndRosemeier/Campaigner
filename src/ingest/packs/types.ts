import type { ItemData } from '@/domain/itemData';
import type { GameSystem } from '@/domain/gameSystem';
import type { SpellData } from '@/domain/spellData';
import type { StatBlock } from '@/domain/statblock';

/**
 * Pack adapter contracts (12-BESTIARY-PACKS §5/§13). An adapter turns one
 * machine-readable source format into validated creature and/or item
 * entries; the import runner (`/src/ingest/packImport.ts`) owns persistence,
 * progress and the report. Adapters parse only the bytes they are handed —
 * they never fetch.
 */

/** One creature entry ready to become a `statblock` RuleChunk. */
export interface PackEntry {
  /** Creature name — also becomes `headingPath[0]` and the roster key. */
  name: string;
  /** Exact stat block — best-effort is forbidden at this boundary. */
  statBlock: StatBlock;
  /** Rendered plain-text stat block (search text, display, contentHash). */
  text: string;
}

/**
 * One equipment/item entry ready to become an `item` RuleChunk (12-BESTIARY-
 * PACKS §13). A PARALLEL lane to `PackEntry` — `PackEntry.statBlock` stays
 * required, so the creature adapters and their tests are untouched; item
 * adapters return `items` and no `statBlock`.
 */
export interface PackItemEntry {
  /** Item name — becomes `headingPath[0]` and the item-pool name-index key. */
  name: string;
  /** Normalized item payload — validated with `itemDataSchema` by the runner. */
  item: ItemData;
  /** Rendered plain-text item block (search text, display, contentHash). */
  text: string;
}

/**
 * One rules-TEXT entry ready to become a `section` RuleChunk (rules-text
 * packs arc, docs/12 §15): a THIRD parallel lane after creatures and items —
 * journal pages, conditions, feats, spells, actions, class features. The
 * full heading path is supplied by the adapter (category segments first, the
 * entry name last); `statBlock`/`itemData` stay null/absent on the chunk.
 *
 * `spell` is the SAME lane's structured half (the spells arc, docs/12 §15):
 * a spell document carries its validated `SpellData` here and the runner
 * persists it as a `spell` chunk (the text stays byte-identical); a non-spell
 * entry omits it and stays a `section` chunk. No second lane, no second
 * parser — the existing pf2e-rules mapping produces both halves.
 */
export interface PackSectionEntry {
  /** Category path above the name, most general first (may be empty). */
  categories: string[];
  /** Entry name — the LAST `headingPath` element. */
  name: string;
  /** Rendered plain-text block (search text, display, contentHash). */
  text: string;
  /** Structured spell payload, when the document is a PF2e `type: 'spell'`. */
  spell?: SpellData;
}

/** One entry that failed creature/item mapping or validation. Always surfaced. */
export interface PackEntryFailure {
  file: string;
  /** Creature/item name when known, else ''. */
  name: string;
  message: string;
}

export interface PackFileParse {
  entries: PackEntry[];
  /**
   * Equipment/item entries (12-BESTIARY-PACKS §13). Optional — creature
   * adapters never set it; the runner treats a missing list as empty.
   */
  items?: PackItemEntry[];
  /**
   * Rules-text entries (rules-text packs arc, docs/12 §15). Optional —
   * creature/item adapters never set it; the runner treats a missing list
   * as empty. The third parallel lane: parsed into `section` chunks.
   */
  sections?: PackSectionEntry[];
  /** Documents that are not entries by design (folders, non-NPC/non-item). */
  skipped: number;
  failures: PackEntryFailure[];
}

export interface PackAdapter {
  id: string;
  label: string;
  system: GameSystem;
  /** Stored on the imported book and shown in the UI (12-BESTIARY-PACKS §2). */
  license: string;
  /** Lowercase file extensions (with dot) this adapter parses. */
  extensions: readonly string[];
  /**
   * The entry noun for the zero-valid-entries error message ('creature'
   * default; item adapters declare 'item') — the message stays accurate
   * without changing the creature-path text byte-identically.
   */
  entryNoun?: string;
  /**
   * Parses one file's bytes. Throws only for file-level failures (empty,
   * unparseable); per-entry problems are collected in `failures`.
   */
  parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse>;
}

/**
 * THE one pack-adapter promise seam (AGENTS §Centralization rule 4, docs/17 row
 * 214).
 *
 * `PackAdapter.parseFile` is deliberately PROMISE-based — `packImport` awaits
 * every adapter identically, and a synchronous throw escaping one lane would
 * break that contract — but each adapter's real parsing lives in its own
 * synchronous `parseFileSync` (a different body per lane), so each of the seven
 * hand-wrote the SAME wrapper around it: resolve the sync result, and re-wrap a
 * non-`Error` throw as an `Error` rejection. Seven byte-identical copies, born
 * correct and therefore invisible until the duplicate-body tripwire
 * (`tests/architecture/no-duplicate-implementations.test.ts`, docs/17 row 172)
 * named them as group `4849c733c9136aa8`.
 *
 * It lives HERE, in the module that declares the `PackAdapter` contract it
 * enforces (beside `fileToPackInput`, this module's other runtime adapter
 * helper), NOT in an adapter, and NOT in `text.ts`: `text.ts` is the ingest
 * layer's DOCUMENT-conventions home (HTML→text, the document stream), while this
 * is the adapter CONTRACT — a different idea. Every adapter keeps its own
 * `parseFileSync` (the parsing is not shared) and states the contract in one
 * line: `const parseFile = asPackFileParser(parseFileSync);`.
 *
 * The non-`Error` arm is deliberate, not defensive noise: a third-party parser
 * may throw a string or a plain object, and the import runner reads the
 * rejection's `.message` — re-wrapping keeps that read honest instead of letting
 * a raw value reach it (AGENTS rule 1: a failure is never silently reshaped).
 */
export function asPackFileParser(
  parseFileSync: (fileName: string, bytes: Uint8Array) => PackFileParse,
): (fileName: string, bytes: Uint8Array) => Promise<PackFileParse> {
  return (fileName, bytes) => {
    try {
      return Promise.resolve(parseFileSync(fileName, bytes));
    } catch (error) {
      // Rejections instead of sync throws: the adapter contract is promise-based.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/**
 * ABSENCE vs MISS for a section an adapter reads out of an UPSTREAM document's
 * own markup (AGENTS rules 1-2; docs/17 row 294).
 *
 * The adapters' VALUE patterns (an `At Higher Levels` heading, a `Heightened`
 * heading, an `<em>Section: …</em>` footer) read the upstream document's OWN
 * format, which the adapter is contractually given — a pattern over it is fine,
 * so rule 5 is NOT the defect here. THE DEFECT IS THE SILENCE: a document that
 * HAS the section under DIFFERENT markup is indistinguishable from one that
 * legitimately has none, so the imported row quietly loses content the owner can
 * never discover.
 *
 * This seam separates the two cases, ONCE for every family:
 *
 * - `probe` is a deliberately LOOSER test for "the section is present in this
 *   document at all" (the heading words, case-insensitive, without the value
 *   pattern's tag/spacing assumptions). `read === false` with the probe ABSENT
 *   is a legitimate ABSENCE — a spell with no heightening is normal — and
 *   NOTHING is reported.
 * - the probe PRESENT with the value pattern matching NOTHING is a MISS: ONE
 *   `PackEntryFailure` naming the document (`file` + `name`), the section and
 *   this ledger row, pushed into the SAME `PackFileParse.failures` list the
 *   adapters already feed — which `packImport` renders as
 *   `PackImportResult.failed`, `packMeta.entriesFailed` and
 *   `PackImportReport`. No second notice mechanism and no `console` line
 *   (rule 2). The entry STILL IMPORTS; only the miss is added.
 *
 * The probe is for DETECTION only: it never widens the value pattern, and `read`
 * is the VALUE pattern's own answer, so a heading whose prose happens to be
 * empty is READ, never a miss. `probe` is applied with `lastIndex` reset, so a
 * caller that hands a global regex in still gets one deterministic answer.
 */
export function sectionMissFailure(
  html: string,
  probe: RegExp,
  read: boolean,
  where: { file: string; name: string; section: string; entry: string },
): PackEntryFailure | null {
  if (read) return null;
  probe.lastIndex = 0;
  if (!probe.test(html)) return null;
  return {
    file: where.file,
    name: where.name,
    message:
      `"${where.section}" is present in this document's own markup, but the ` +
      `${where.entry} reader did not match it — that section was not read ` +
      `(docs/17 row 294)`,
  };
}

/** A user-selected pack file already in memory (loose file or zip member). */
export interface PackInputFile {
  name: string;
  bytes: Uint8Array;
}

/** Converts a browser `File` (import UI integration point). */
export async function fileToPackInput(file: File): Promise<PackInputFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
