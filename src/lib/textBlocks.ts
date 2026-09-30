/**
 * Structured PLAIN TEXT → BLOCKS — the ONE rule for how the text a model wrote
 * becomes paragraphs and line breaks, so every renderer honours the SAME
 * structure (AGENTS rule 4; docs/17 row 146, docs/18 §2.3).
 *
 * WHY IT EXISTS. Model-authored stat-block fields arrive as structured plain
 * text: a trait's body is several paragraphs separated by a BLANK LINE, and a
 * single newline inside one of them is a line break (a `Reactions` entry that
 * lists two triggers, a speed line that wraps). Both renderers used to throw
 * that structure away — the app's `StatBlockCard` printed the text inside a
 * `<span>`, where HTML collapses every newline to one space, and the PDF's
 * `labeledSection` put the whole body in ONE run, where pdfmake prints the
 * blank line as an empty line — so the owner read *"big text blobs without any
 * paragraph… walls of text, no formatting at all, describing monsters"*.
 * Neither renderer may split text on its own: a second paragraph rule is
 * exactly the drift this seam removes.
 *
 * THE RULE, in three lines:
 *
 * - a **blank line** (a line that is empty or whitespace only, however many in
 *   a row) separates two blocks — a PARAGRAPH BREAK;
 * - a **single newline** stays INSIDE one block — a LINE BREAK, never a
 *   paragraph break;
 * - leading and trailing blank lines carry no block, and the trailing
 *   whitespace of a line is dropped (trailing spaces are an artefact of the
 *   model's wrap, not content), while leading indentation is kept.
 *
 * It is deliberately about TEXT and nothing else: no markdown, no headings, no
 * wiki links, no numbering. The markdown→pdfmake seam (`lib/mdToPdfmake`) and
 * the wiki seams answer other questions and are untouched.
 *
 * A consumer renders the blocks it gets — `<p>` per block and a line break per
 * line (the app) or one run per block with `\n` inside it (pdfmake, which
 * prints `\n` as a line break) — and NEVER re-splits the text itself. Sections
 * stay distinct by construction: a consumer calls this per FIELD (one trait
 * row, one `Reactions` entry, one `extras` value), so two sections can never be
 * merged into one block run.
 */

/** One block of structured text. */
export interface TextBlock {
  /**
   * The block's lines, in order. A single newline in the source is a LINE BREAK
   * between two of these, never a paragraph break — a renderer that shows them
   * as separate blocks has changed the text's structure.
   */
  readonly lines: readonly string[];
}

/** A line that carries no text: the PARAGRAPH BREAK of the source. */
const BLANK_LINE = /^[ \t]*$/;

/**
 * The text's blocks, in order. Whitespace-only input carries no block at all
 * (`[]`), so a caller renders NOTHING rather than an empty paragraph — the
 * renderers' pre-existing "an empty field prints nothing" rule.
 */
export function textBlocks(text: string): TextBlock[] {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks: TextBlock[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (BLANK_LINE.test(line)) {
      if (current.length > 0) {
        blocks.push({ lines: current });
        current = [];
      }
      continue;
    }
    current.push(line.trimEnd());
  }
  if (current.length > 0) blocks.push({ lines: current });
  return blocks;
}

/**
 * One block AS ONE TEXT RUN, its line breaks included — the form a renderer
 * that draws `\n` as a line break (pdfmake) needs, and the form the app's
 * `whitespace-pre-line` block carries for the same reason. It is NOT a
 * paragraph separator: a caller that joins two blocks this way has merged them.
 */
export function blockText(block: TextBlock): string {
  return block.lines.join('\n');
}
