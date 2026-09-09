import type { Module } from '@/domain/module';

/**
 * The WHOLE-module parts document (canvas v3, 08-MODULE-DESIGNER §Module
 * canvas + §Module canvas chat, docs/17 ledger row 53): the canvas editor
 * doc and the chat's context are THE SAME format — every planned part in
 * `spine.partPlan` order, the spine premise EXCLUDED (it lives on the
 * Board/reader), each section introduced by its scaffold label line and
 * separated by a blank line + a line of exactly ten `=` + a blank line.
 *
 * This module owns BOTH directions of that format, pure (domain layer — no
 * IO, no React):
 * - `assembleModulePartsDocument` builds the document from the module row
 *   (the editor's initial doc),
 * - `splitPartsDocument` / `splitModulePartsDocument` are the INVERSE: they
 *   pair the sections of an existing document back to the plan and FAIL
 *   LOUDLY (typed `ModulePartsDocumentError` naming the offending
 *   line/section) when the scaffolding is missing/malformed/duplicated, the
 *   section count does not match the plan, or a label contradicts the plan.
 *
 * The designed guard (never silent re-splitting): a part's CONTENT may
 * contain a bare `==========` line (harmless — the LABEL line identifies a
 * section start), but content that fakes a full section header fails the
 * split loudly. The scaffolding is ordinary editable text in the editor; it
 * is validated only at the boundaries that need the split (save, chat send,
 * proposal ranges).
 */

/** The scaffold delimiter between part sections (exactly ten `=`). */
export const CANVAS_PARTS_DELIMITER = '==========';

/**
 * The scaffold label line introducing one part section:
 * `[Part <n> of <total> — <title>]` (n = 1-based position in the plan).
 * Without a usable title the label falls back to `[Part <n> of <total>]`.
 * For an EMPTY (not-yet-written) part the label line is the only anchor:
 * a chat command whose search EXACTLY equals it fills that part (the
 * replace must start with the same label line).
 */
export function canvasPartLabel(position: number, total: number, title: string): string {
  const head = `Part ${String(position)} of ${String(total)}`;
  const clean = title.trim();
  return clean === '' ? `[${head}]` : `[${head} — ${clean}]`;
}

/**
 * One part section of the parts document. `textFrom`/`textTo` are the
 * section's TEXT range in whole-document coordinates (the label line and
 * the separators are scaffolding OUTSIDE the range) — they power block
 * proposals, chat command application and restores without re-scanning.
 */
export interface ModulePartsSection {
  planIndex: number;
  title: string;
  text: string;
  textFrom: number;
  textTo: number;
}

/**
 * A malformed parts document — the split refuses loudly (AGENTS 1). The
 * message names the offending line/section; `name` is stable for callers
 * that branch on the failure class (e.g. the save path's scaffolding toast).
 */
export class ModulePartsDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModulePartsDocumentError';
  }
}

export interface AssembleModulePartsInput {
  /** The plan in order — position i IS planIndex i (08 §Module canvas). */
  partPlan: readonly { title: string }[];
  /** Row parts; text joined by planIndex (missing/empty part → ''). */
  parts: readonly { planIndex: number; markdown: string }[];
}

/**
 * Assembles the WHOLE-module parts document (PURE): every planned part in
 * `partPlan` order, the spine premise EXCLUDED (owner: "without premise"),
 * each section introduced by its scaffold label line and separated by the
 * `==========` delimiter. Returns the document AND the per-part sections
 * with their whole-document text ranges.
 */
export function assembleModulePartsDocument(input: AssembleModulePartsInput): {
  document: string;
  parts: ModulePartsSection[];
} {
  const total = input.partPlan.length;
  if (total === 0) {
    throw new Error('assembleModulePartsDocument needs at least one planned part');
  }
  const sections: ModulePartsSection[] = [];
  let document = '';
  for (let index = 0; index < total; index += 1) {
    const title = input.partPlan[index]?.title ?? '';
    const label = canvasPartLabel(index + 1, total, title);
    const text = input.parts.find((part) => part.planIndex === index)?.markdown ?? '';
    if (index > 0) document += `\n\n${CANVAS_PARTS_DELIMITER}\n\n`;
    document += `${label}\n`;
    const textFrom = document.length;
    document += text;
    sections.push({ planIndex: index, title, text, textFrom, textTo: document.length });
  }
  return { document, parts: sections };
}

/** A line that IS a full section header (the fake-header guard pattern). */
const LABEL_LINE_PATTERN = /^\[Part \d+ of \d+(?: — [^\]]*)?\]$/;

/** First line of `text` that is exactly a section header (null when none). */
function firstLabelShapedLine(text: string): { line: string; offset: number } | null {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (LABEL_LINE_PATTERN.test(line)) return { line, offset };
    offset += line.length + 1;
  }
  return null;
}

/** Short quoted excerpt for error messages (first line, capped). */
function describeLine(doc: string, from: number): string {
  const newline = doc.indexOf('\n', from);
  const line = doc.slice(from, newline === -1 ? doc.length : newline);
  const capped = line.length > 80 ? `${line.slice(0, 80)}…` : line;
  return JSON.stringify(capped);
}

/**
 * Splits a WHOLE-module parts document back into its per-part sections
 * (PURE — the inverse of `assembleModulePartsDocument`). Sections pair to
 * the plan by position + exact label line. FAILS LOUDLY with a
 * `ModulePartsDocumentError` naming the offending line/section when:
 * - the module has no planned parts,
 * - the document does not open with part 1's label line,
 * - a separator (blank line + exactly ten `=` + blank line) or a label line
 *   is missing/malformed, or a label's title contradicts the plan,
 * - the section count does not match the planned part count (an extra
 *   section's header shows up as a header line inside the last section's
 *   text; a missing one fails the label search),
 * - a section's TEXT contains a full section-header line (content faking
 *   the scaffolding — the designed guard, never silent re-splitting).
 * A bare `==========` line inside a part's content is harmless.
 */
export function splitPartsDocument(
  doc: string,
  partPlan: readonly { title: string }[],
): ModulePartsSection[] {
  const total = partPlan.length;
  if (total === 0) {
    throw new ModulePartsDocumentError('the module has no planned parts — nothing to split');
  }
  const sections: ModulePartsSection[] = [];
  let textStart = -1;
  for (let index = 0; index < total; index += 1) {
    const title = partPlan[index]?.title ?? '';
    const label = canvasPartLabel(index + 1, total, title);
    if (index === 0) {
      if (!doc.startsWith(`${label}\n`)) {
        throw new ModulePartsDocumentError(
          `the document must open with the label line ${JSON.stringify(label)} — found ${describeLine(doc, 0)}`,
        );
      }
      textStart = label.length + 1;
      continue;
    }
    const needle = `\n\n${CANVAS_PARTS_DELIMITER}\n\n${label}\n`;
    const at = doc.indexOf(needle, textStart);
    if (at === -1) {
      const labelAt = doc.indexOf(`${label}\n`, textStart);
      if (labelAt !== -1) {
        throw new ModulePartsDocumentError(
          `the separator before the label line of part ${String(index + 1)} of ${String(total)} is missing or malformed — every section after the first is introduced by a blank line, a line of exactly ten "=" and a blank line (label found at offset ${String(labelAt)})`,
        );
      }
      const prefixAt = doc.indexOf(`[Part ${String(index + 1)} of ${String(total)}`, textStart);
      if (prefixAt !== -1) {
        throw new ModulePartsDocumentError(
          `the label line of part ${String(index + 1)} of ${String(total)} contradicts the plan — found ${describeLine(doc, prefixAt)} but the plan titles this part ${JSON.stringify(title)}`,
        );
      }
      throw new ModulePartsDocumentError(
        `the label line of part ${String(index + 1)} of ${String(total)} is missing — every section opens with its "[Part <n> of <total> — <title>]" label`,
      );
    }
    const previous = index - 1;
    sections.push({
      planIndex: previous,
      title: partPlan[previous]?.title ?? '',
      text: doc.slice(textStart, at),
      textFrom: textStart,
      textTo: at,
    });
    textStart = at + needle.length;
  }
  const last = total - 1;
  sections.push({
    planIndex: last,
    title: partPlan[last]?.title ?? '',
    text: doc.slice(textStart),
    textFrom: textStart,
    textTo: doc.length,
  });
  for (const section of sections) {
    const offending = firstLabelShapedLine(section.text);
    if (offending !== null) {
      throw new ModulePartsDocumentError(
        `the text of part ${String(section.planIndex + 1)} of ${String(total)} contains a section header line ${JSON.stringify(offending.line)} at offset ${String(section.textFrom + offending.offset)} — part content must not fake the parts-document scaffolding`,
      );
    }
  }
  return sections;
}

/**
 * The module-row convenience wrapper: splits a whole-module parts document
 * against the module's spine plan (loud when the module has no planned
 * parts). See `splitPartsDocument` for the splitting contract.
 */
export function splitModulePartsDocument(
  doc: string,
  module: Pick<Module, 'spine'>,
): ModulePartsSection[] {
  return splitPartsDocument(doc, module.spine?.partPlan ?? []);
}
