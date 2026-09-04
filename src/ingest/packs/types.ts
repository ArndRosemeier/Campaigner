import type { GameSystem } from '@/domain/gameSystem';
import type { StatBlock } from '@/domain/statblock';

/**
 * Pack adapter contracts (12-BESTIARY-PACKS §5). An adapter turns one
 * machine-readable source format into validated creature entries; the import
 * runner (`/src/ingest/packImport.ts`) owns persistence, progress and the
 * report. Adapters parse only the bytes they are handed — they never fetch.
 */

/** One creature entry ready to become a `statblock` RuleChunk. */
export interface PackEntry {
  /** Creature name — also becomes `headingPath[0]` and the roster key. */
  name: string;
  /** Numeric level (pf2e level / dnd5e CR) for roster ordering. */
  levelSort: number;
  /** Descriptive trait strings for the encounter roster line. */
  traits: string[];
  /** Exact stat block — best-effort is forbidden at this boundary. */
  statBlock: StatBlock;
  /** Rendered plain-text stat block (search text, display, contentHash). */
  text: string;
}

/** One entry that failed creature mapping or validation. Always surfaced. */
export interface PackEntryFailure {
  file: string;
  /** Creature name when known, else ''. */
  name: string;
  message: string;
}

export interface PackFileParse {
  entries: PackEntry[];
  /** Documents that are not creature entries by design (folders, non-NPC). */
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
   * Parses one file's bytes. Throws only for file-level failures (empty,
   * unparseable); per-creature problems are collected in `failures`.
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
