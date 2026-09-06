import type { ItemData } from '@/domain/itemData';
import type { GameSystem } from '@/domain/gameSystem';
import type { StatBlock } from '@/domain/statblock';

/**
 * Pack adapter contracts (12-BESTIARY-PACKS §5/§12). An adapter turns one
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
 * PACKS §12). A PARALLEL lane to `PackEntry` — `PackEntry.statBlock` stays
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
   * Equipment/item entries (12-BESTIARY-PACKS §12). Optional — creature
   * adapters never set it; the runner treats a missing list as empty.
   */
  items?: PackItemEntry[];
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

/** A user-selected pack file already in memory (loose file or zip member). */
export interface PackInputFile {
  name: string;
  bytes: Uint8Array;
}

/** Converts a browser `File` (import UI integration point). */
export async function fileToPackInput(file: File): Promise<PackInputFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
