import { unzipSync } from 'fflate';

import { stampNewEntity, type Id } from '@/domain/entity';
import type { GameSystem } from '@/domain/gameSystem';
import type { PackMeta, PackProvenance, Rulebook } from '@/domain/rulebook';
import { ruleChunkSchema, type RuleChunk } from '@/domain/rulebook';
import type { StatBlock } from '@/domain/statblock';
import { statBlockSchema } from '@/domain/statblock';
import { putChunks } from '@/db/chunkRepo';
import { createPackBook, failPackBook, finalizePackBook } from '@/db/rulebookRepo';
import { sha256Hex } from '@/lib/hash';
import { errorMessage } from '@/lib/errors';

import { getPackAdapter } from './packs/registry';
import type { PackAdapter, PackEntry, PackEntryFailure, PackInputFile } from './packs/types';

/**
 * Bestiary pack import runner (12-BESTIARY-PACKS §6): expands zip inputs,
 * hands files to the selected adapter, validates every entry at the
 * `statBlockSchema` boundary, persists `statblock` RuleChunks in batches, and
 * finalizes the pack book with its import report. Failure policy is loud:
 * per-entry problems are collected into the report, and a selection with zero
 * valid entries fails the book (`status: 'error'`) and throws — an empty
 * "ready" book is forbidden.
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
  chunkCount: number;
  imported: number;
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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

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

export async function importPack(
  adapterId: string,
  inputs: readonly PackInputFile[],
  options: PackImportOptions = {},
): Promise<PackImportResult> {
  const adapter = getPackAdapter(adapterId);
  if (inputs.length === 0) throw new Error('pack import received no files');
  const deps = options.deps ?? dexiePackImportDeps;

  const entries: PackEntry[] = [];
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
      entries.push(...parsed.entries);
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

  const base = Date.now();
  const chunks: RuleChunk[] = [];
  for (const [index, entry] of entries.entries()) {
    const statBlock = statBlockSchema.parse(entry.statBlock);
    chunks.push(
      await ruleChunk(entry, statBlock, book.id, base + index),
    );
  }

  let done = 0;
  for (const batch of batches(chunks, CHUNK_BATCH)) {
    await deps.persistChunks([...batch]);
    done += batch.length;
    options.onProgress?.({ bookId: book.id, done, total: chunks.length });
  }

  const packMeta: PackMeta = {
    sourceId: adapter.id,
    license: adapter.license,
    entriesImported: entries.length,
    entriesSkipped: skipped,
    entriesFailed: failures.length,
    ...options.provenance,
  };

  if (entries.length === 0) {
    const fetchedCount =
      inputs.length + (options.extraFailures?.length ?? 0);
    // 16-BESTIARY-FETCH §6: when the selection validates nothing, the error
    // leads with a representative failure (the first entry's issue) so the
    // toast and the error-state book show the reason, not just a count.
    const representative = leadFailure(failures);
    const message =
      (representative === null ? '' : `${representative} — `) +
      `no valid creature entries in the pack selection ` +
      `(${String(skipped)} skipped, ${String(failures.length)} failed` +
      (options.extraFailures === undefined ? '' : ` of ${String(fetchedCount)} fetched files`) +
      `)`;
    await deps.failBook(book.id, message);
    throw new Error(`${message} — book "${title}" marked as error`);
  }

  const ready = await deps.finalizeBook(book.id, packMeta);
  return {
    book: ready,
    chunkCount: chunks.length,
    imported: entries.length,
    skipped,
    failed: failures,
  };
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
