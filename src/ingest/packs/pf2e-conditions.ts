import { z } from 'zod';

import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackFileParse, PackSectionEntry } from './types';

/**
 * `foundry-pf2e-conditions` pack adapter (rules-text packs arc, docs/12 §15):
 * condition entries from the Foundry VTT PF2e system content
 * ([foundryvtt/pf2e](https://github.com/foundryvtt/pf2e)
 * `packs/pf2e/conditions/` @ `v14-dev` — 43 per-condition JSON documents,
 * flat, verified 2026-09-07). A PARALLEL rules-text lane to the journal one:
 * it accepts `type: 'condition'` documents and skips everything else
 * (counted, never silently dropped).
 *
 * Field mapping verified against live `v14-dev` documents (Blinded,
 * Frightened; fixture tests pin the consumed subset):
 *
 * - `system.description.value` HTML → stripped plain text (@-notation
 *   resolves label-first, e.g. `@UUID[…]{Dazzled}` → "Dazzled").
 * - `system.traits.value` → the trait line when non-empty.
 * - `system.publication` `{license, remaster, title}` (present at 100% on the
 *   sampled corpus, e.g. `{license: 'ORC', remaster: true, title: 'Pathfinder
 *   Player Core'}`) → the trailing `Source: …` line — per-entry licensing is
 *   PRESERVED, not dropped.
 * - The condition's `value`/`duration`/`group`/`rules` fields are internal
 *   application data or already restated in the description text — not
 *   rendered (the description carries the mechanical rules).
 */

export const FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID = 'foundry-pf2e-conditions';

export const FOUNDRY_PF2E_CONDITIONS_LICENSE =
  'Pathfinder Second Edition conditions from the Foundry VTT PF2e system packs ' +
  '(Paizo Inc. via the Foundry Gaming LLC partnership; per-entry licensing ' +
  'ORC/OGL, preserved on each entry\'s Source line). User-imported for personal ' +
  'use under Paizo\'s Community Use Policy — not for redistribution.';

// --- Source schemas (consumed subset of the Foundry document; unknown keys
// are ignored — the document is never re-serialized). ------------------------

const pf2eConditionSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  system: z.object({
    description: z.object({ value: z.string().default('') }).default({ value: '' }),
    traits: z.object({ value: z.array(z.string()).default([]) }).default({ value: [] }),
    publication: z
      .object({
        title: z.string().default(''),
        license: z.string().default(''),
      })
      .nullish(),
  }),
});

type ParsedCondition = z.infer<typeof pf2eConditionSchema>;

// --- Helpers (the journal adapter's exact text rules; adapters stay
// self-contained per 12-BESTIARY-PACKS §5's precedent) ------------------------

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

/** Strips pf2e description HTML to plain text, resolving @-notation. */
function stripHtml(html: string): string {
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

/** The per-entry source line — verbatim `publication`, never dropped. */
export function publicationSourceLine(
  publication: { title: string; license: string } | null | undefined,
): string | null {
  if (publication === undefined || publication === null) return null;
  const title = publication.title.trim();
  const license = publication.license.trim();
  if (title === '' && license === '') return null;
  if (title === '') return `Source: ${license}`;
  return `Source: ${title}${license === '' ? '' : ` (${license})`}`;
}

// --- Mapping ---------------------------------------------------------------

function mapCondition(doc: ParsedCondition): PackSectionEntry {
  const lines: string[] = [doc.name];
  if (doc.system.traits.value.length > 0) {
    lines.push(`(${doc.system.traits.value.join(', ')})`);
  }
  const description = stripHtml(doc.system.description.value);
  if (description !== '') lines.push(description);
  const source = publicationSourceLine(doc.system.publication);
  if (source !== null) lines.push(source);
  return { categories: [], name: doc.name, text: lines.join('\n') };
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
    if (!isRecord(doc) || doc.type !== 'condition') {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      sections.push(mapCondition(pf2eConditionSchema.parse(doc)));
    } catch (error) {
      failures.push({
        file: fileName,
        name,
        message: `document ${String(index)}: ${errorMessage(error)}`,
      });
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

export const foundryPf2eConditionsAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
  label: 'PF2e Conditions (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_CONDITIONS_LICENSE,
  extensions: ['.json', '.db'],
  entryNoun: 'condition',
  parseFile,
};
