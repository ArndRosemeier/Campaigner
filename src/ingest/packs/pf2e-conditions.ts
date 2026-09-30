import { z } from 'zod';

import { errorMessage } from '@/lib/errors';

import {
  htmlToText,
  isDocumentRecord,
  parseJsonDocs,
  publicationSourceLine,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} from './text';
import {
  asPackFileParser,
  type PackAdapter,
  type PackFileParse,
  type PackSectionEntry,
} from './types';

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

// --- Mapping ---------------------------------------------------------------

function mapCondition(doc: ParsedCondition): PackSectionEntry {
  const lines: string[] = [doc.name];
  if (doc.system.traits.value.length > 0) {
    lines.push(`(${doc.system.traits.value.join(', ')})`);
  }
  const description = htmlToText(doc.system.description.value, AT_BRACE_LABEL_BLOCK_AND_TABLE);
  if (description !== '') lines.push(description);
  const source = publicationSourceLine(doc.system.publication);
  if (source !== null) lines.push(source);
  return { categories: [], name: doc.name, text: lines.join('\n') };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into the promise contract by `asPackFileParser`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseJsonDocs(text, fileName);
  const sections: PackSectionEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isDocumentRecord(doc) || doc.type !== 'condition') {
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

const parseFile = asPackFileParser(parseFileSync);

export const foundryPf2eConditionsAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_CONDITIONS_ADAPTER_ID,
  label: 'PF2e Conditions (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_CONDITIONS_LICENSE,
  extensions: ['.json', '.db'],
  entryNoun: 'condition',
  parseFile,
};
