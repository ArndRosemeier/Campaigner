import { z } from 'zod';

import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackFileParse, PackSectionEntry } from './types';

/**
 * `foundry-pf2e-journal` pack adapter (rules-text packs arc, docs/12 §15):
 * rules-TEXT pages from the Foundry VTT PF2e system journal packs
 * ([foundryvtt/pf2e](https://github.com/foundryvtt/pf2e)
 * `packs/pf2e/journals/*.json` @ `v14-dev`). One JournalEntry document per
 * file — for the GM Screen: `{name: 'GM Screen', pages: [61]}`, where each
 * page is `{name, text: {content: HTML}, title: {level, show}}`. The adapter
 * turns ONE CHUNK PER PAGE: the page name is the heading, the HTML content is
 * stripped to plain text (table-aware — the Encounter Budget table must stay
 * readable), and the page's own source footer is preserved.
 *
 * Verified shapes (live `v14-dev` `journals/gm-screen.json`, 2026-09-07;
 * fixture tests pin the consumed subset):
 *
 * - Grouping lives IN THE PAGE HTML as a footer —
 *   `<em>Section: Running the Game</em>` — not in `page.category` (null on
 *   every page; the journal's `categories` array is empty). The parsed
 *   section becomes the chunk's category segment; a page without a footer
 *   (the level-1 divider pages, e.g. "Running the Game" listing its sources)
 *   keeps headingPath `[pageName]`.
 * - The page citation footer —
 *   `<span style="float:right"><em>Pathfinder GM Core pg. 75</em></span>` —
 *   is extracted and re-emitted verbatim as a trailing
 *   `Source: Pathfinder GM Core pg. 75` line.
 * - @-notation resolves label-first: `@UUID[.id]{Basic Actions}` →
 *   "Basic Actions"; the plain `@Kind[inner]` form falls back to the inner
 *   reference's last dot-segment (the creature adapter's rule).
 *
 * The GM Screen journal SUMMARIZES Pathfinder GM Core (Paizo–Foundry
 * partnership) — the book label says so and per-page citations are kept.
 */

export const FOUNDRY_PF2E_JOURNAL_ADAPTER_ID = 'foundry-pf2e-journal';

export const FOUNDRY_PF2E_JOURNAL_LICENSE =
  'PF2e GM Screen journal from the Foundry VTT PF2e system packs (Paizo Inc. ' +
  'via the Foundry Gaming LLC partnership) — SUMMARIZES Pathfinder GM Core; ' +
  'per-page citations to the GM Core source are preserved. User-imported for ' +
  'personal use under Paizo\'s Community Use Policy — not for redistribution.';

// --- Source schemas (consumed subset of the Foundry JournalEntry document;
// unknown keys are ignored — the document is never re-serialized). ----------

const journalPageSchema = z.object({
  name: z.string().min(1),
  text: z.object({ content: z.string() }),
});

const journalEntrySchema = z.object({
  name: z.string().min(1),
  pages: z.array(z.unknown()),
});

type ParsedPage = z.infer<typeof journalPageSchema>;

// --- Helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whole-file JSON when possible, otherwise newline-delimited JSON (the older
 * `.db` pack format). A line that fails to parse fails the file loudly.
 */
function parseDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    // Fall through to NDJSON — this branch decides nothing, the loop below
    // still fails loudly per line.
  }
  const docs: unknown[] = [];
  for (const [index, line] of trimmed.split('\n').entries()) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      docs.push(JSON.parse(candidate) as unknown);
    } catch (error) {
      throw new Error(`${fileName}: line ${String(index + 1)} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
  }
  return docs;
}

/** The page's grouping footer, verbatim from the HTML (`null` when absent). */
function extractSection(html: string): string | null {
  const match = /<em>Section:\s*([^<>]+?)\s*<\/em>/i.exec(html);
  return match?.[1] ?? null;
}

/**
 * The page's source citation footer ("Pathfinder GM Core pg. 75"), verbatim
 * from the HTML (`null` when the page cites no page number).
 */
function extractCitation(html: string): string | null {
  const match = /<em>([^<>]+?\bpg\.\s*[^<>]*?)\s*<\/em>/i.exec(html);
  return match?.[1] ?? null;
}

/**
 * Strips pf2e journal HTML to plain text — the creature adapter's rules plus
 * TABLE AWARENESS (journal pages are dominated by rules tables; naive tag
 * stripping would run every cell together). `<tr>` opens a line, a `</td>`/
 * `</th>` followed by another cell inserts a ` | ` separator, and block
 * closers break lines. @-notation resolves label-first.
 */
function stripJournalHtml(html: string): string {
  const withoutNotation = html
    .replace(/@(\w+)\[([^\]]*)\]\{([^}]*)\}/g, (_match, _kind: string, _inner: string, label: string) => label)
    .replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
      const beforePipe = inner.split('|')[0] ?? '';
      return beforePipe.split('.').pop() ?? '';
    });
  return withoutNotation
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|blockquote|div|caption|table)>/gi, '\n')
    .replace(/<tr[^>]*>/gi, '')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>\s*(?=<t[dh])/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// --- Mapping ---------------------------------------------------------------

function mapPage(page: ParsedPage): PackSectionEntry {
  const rawHtml = page.text.content;
  const section = extractSection(rawHtml);
  const citation = extractCitation(rawHtml);
  // The section/citation footers are re-expressed structurally (the section
  // becomes the heading category, the citation a dedicated Source line), so
  // their raw HTML is removed before stripping — never duplicated.
  const contentHtml = rawHtml
    .replace(/<em>Section:\s*[^<>]+?\s*<\/em>\s*/gi, '')
    .replace(/<span[^>]*>\s*<em>[^<>]+?\bpg\.\s*[^<>]*?\s*<\/em>\s*<\/span>\s*/gi, '');
  const content = stripJournalHtml(contentHtml);
  const lines: string[] = [page.name];
  if (content !== '') lines.push(content);
  if (citation !== null) lines.push(`Source: ${citation}`);
  return {
    categories: section === null ? [] : [section],
    name: page.name,
    text: lines.join('\n'),
  };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into a promise by `parseFile`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseDocs(text, fileName);
  const sections: PackSectionEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    // A JournalEntry document is `name` + `pages`; anything else in the pack
    // (folder docs, entities) is a counted skip, never a silent drop.
    if (!isRecord(doc) || doc.pages === undefined) {
      skipped += 1;
      continue;
    }
    const parsed = journalEntrySchema.safeParse(doc);
    if (!parsed.success) {
      failures.push({
        file: fileName,
        name: typeof doc.name === 'string' ? doc.name : '',
        message: `document ${String(index)}: ${errorMessage(parsed.error)}`,
      });
      continue;
    }
    for (const [pageIndex, page] of parsed.data.pages.entries()) {
      const candidate = journalPageSchema.safeParse(page);
      if (!candidate.success) {
        failures.push({
          file: fileName,
          name: isRecord(page) && typeof page.name === 'string' ? page.name : '',
          message: `page ${String(pageIndex)}: ${errorMessage(candidate.error)}`,
        });
        continue;
      }
      sections.push(mapPage(candidate.data));
    }
  }
  return { entries: [], sections, skipped, failures };
}

function parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse> {
  try {
    return Promise.resolve(parseFileSync(fileName, bytes));
  } catch (error) {
    // Rejections instead of sync throws: the adapter contract is promise-based.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export const foundryPf2eJournalAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_JOURNAL_ADAPTER_ID,
  label: 'PF2e GM Screen & journals (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_JOURNAL_LICENSE,
  extensions: ['.json', '.db'],
  entryNoun: 'journal page',
  parseFile,
};
