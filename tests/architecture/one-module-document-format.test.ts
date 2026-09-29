import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { rawSourceText } from '../helpers/sourceCode';

/**
 * ONE module document format, and only ONE (docs/23 §2–§4, docs/17 row 386).
 *
 * Two text formats coexisted during the storage cut: the legacy `==========`
 * parts document (`domain/modulePartsDocument`, the pre-cut editor format) and
 * the module DOCUMENT (level 0 = the premise, then `=====Level N=====`
 * sections). Row 386 removed the last caller (the PDF lane assembled the
 * legacy document and split it back) and DELETED the legacy format with its
 * parser, its delimiter, its label builder and its pins.
 *
 * This is the slice's proof that the cut's two formats became one, and it is a
 * SOURCE SCAN because a revived second format is invisible to behaviour tests:
 * a parser that is never called still compiles, and the two formats would only
 * disagree the next time one of them is edited. The five identifiers below are
 * the legacy seam's whole vocabulary — if any of them reappears anywhere under
 * `src/` or `tests/`, this scan names the file. It reads RAW text (the ONE
 * `tests/helpers/sourceCode.rawSourceText` view) on purpose: a stale COMMENT
 * naming the deleted seam is the drift that actually happened.
 *
 * THE PIN NAMES ITSELF AS THE ONE CARRIER. The needles are written literally
 * here, so THIS file legitimately contains them; each arm requires the carrier
 * list to be exactly `[this file]`, which keeps the detector non-vacuous (the
 * needle is proven greppable in this very tree) and reds the moment a second
 * carrier appears. There is no silent self-exemption.
 */

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
/** This file, as the scan reports paths. */
const SELF = 'tests/architecture/one-module-document-format.test.ts';
const DOCUMENT_SEAM = 'src/domain/moduleDocument.ts';
const MODULE_PDF = 'src/lib/modulePdf.ts';
const READER = 'src/features/modules/ModuleReaderPage.tsx';
const ENGINE = 'src/llm/moduleGen.ts';

/** The DELETED module-parts document's exported vocabulary. */
const LEGACY_IDENTIFIERS = [
  'modulePartsDocument',
  'CANVAS_PARTS_DELIMITER',
  'canvasPartLabel',
  'splitPartsDocument',
  'assembleModulePartsDocument',
];

// The deleted parser's typed refusal class (`ModulePartsDocumentError`) is NOT
// in the list above on purpose: one stale COMMENT naming it survives in
// `src/features/modules/canvas/chatApply.ts`, which belongs to the row-381
// writer's half of the tree and this slice must not edit (the parallel-writer
// rule). The five identifiers above are the brief's own scan and they are the
// format's whole vocabulary; the stale comment is REPORTED to the dispatcher as
// a named remainder rather than swept from another writer's file.

/** `[path, hits]` per file under `prefix` whose raw text carries `needle`. */
function countsIn(
  raw: Record<string, string>,
  prefix: string,
  needle: string,
): [string, number][] {
  return Object.entries(raw)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, text]): [string, number] => [path, text.split(needle).length - 1])
    .filter(([, hits]) => hits > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

describe('ONE module document format (SOURCE SCAN, docs/17 row 386)', () => {
  it('sees a real tree, and the legacy format file is GONE', async () => {
    const raw = await rawSourceText();
    // Non-vacuity: a walk that saw nothing would make every count below
    // meaningless. Both trees are in the map.
    expect(Object.keys(raw).length).toBeGreaterThan(400);
    expect(Object.keys(raw).some((path) => path.startsWith('src/'))).toBe(true);
    expect(Object.keys(raw).some((path) => path.startsWith('tests/'))).toBe(true);
    // The file really was deleted, not emptied, and the ONE document seam
    // exists where it should.
    expect(existsSync(join(SRC_DIR, 'domain', 'modulePartsDocument.ts'))).toBe(false);
    expect(existsSync(join(ROOT, DOCUMENT_SEAM))).toBe(true);
  });

  it('carries no legacy identifier outside this pin', async () => {
    const raw = await rawSourceText();
    for (const needle of LEGACY_IDENTIFIERS) {
      // The pin is the ONLY carrier: it proves the needle is greppable in this
      // tree (non-vacuity), and any second carrier — a revived parser, a
      // re-export, a comment that reintroduces the name — reds by file.
      expect(countsIn(raw, '', needle).map(([path]) => path), needle).toEqual([SELF]);
    }
  });

  it('defines the ONE format and its ONE derived accessor exactly once', async () => {
    const raw = await rawSourceText();
    for (const definition of [
      'export function assembleModuleDocument(',
      'export function splitModuleDocument(',
      'export function moduleDocumentSections(',
      'export function moduleDocumentSectionsFromView(',
      'export function moduleDocumentFromView(',
      'export function moduleLevelSectionsFromView(',
    ]) {
      expect(countsIn(raw, 'src/', definition), definition).toEqual([[DOCUMENT_SEAM, 1]]);
    }
  });

  it('reads the stored module through the ONE accessor, and its LEVEL SECTIONS through the ONE level accessor', async () => {
    const raw = await rawSourceText();
    // Every surface that holds a module ROW's derived view reads its level
    // sections through the ONE accessor (`moduleLevelSectionsFromView`: the
    // derived list with level 0 dropped), so none of them can invent its own
    // level list — the reader's ToC, the PDF's per-level chapters and the
    // generation ENGINE's unit (docs/17 row 391). The canvas parses the document
    // it EDITS (`moduleDocumentSections` over the live text), which is the same
    // parser; anything else reaching for a level list would be another path.
    //
    // `moduleDocumentSectionsFromView` is then reached only through the level
    // accessor, whose definition lives in the seam — so the level-dropping rule
    // itself exists in exactly one place, and a fourth surface cannot grow its
    // own level list without this scan naming the file.
    expect(countsIn(raw, 'src/', 'moduleDocumentSectionsFromView(').map(([path]) => path)).toEqual([
      DOCUMENT_SEAM,
    ]);
    expect(countsIn(raw, 'src/', 'moduleLevelSectionsFromView(').map(([path]) => path)).toEqual([
      DOCUMENT_SEAM,
      READER,
      MODULE_PDF,
      ENGINE,
    ]);
  });
});
