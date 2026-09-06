import { z } from 'zod';

import { formatItemText, normalizePf2ePrice, type ItemData } from '@/domain/itemData';
import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackFileParse, PackItemEntry } from './types';

/**
 * `foundry-pf2e-equipment` pack adapter (12-BESTIARY-PACKS §12): equipment/
 * item entries from the Foundry VTT PF2e system content ([foundryvtt/pf2e]
 * (https://github.com/foundryvtt/pf2e) `packs/pf2e/equipment/` @ `v14-dev` —
 * 5707 per-item JSON documents at the time of the corpus sweep). A PARALLEL
 * adapter to the creature one: it accepts the item document types and skips
 * everything else (counted, never silently dropped); creature documents
 * (`type: 'npc'`) belong to `foundry-pf2e`.
 *
 * Field mapping verified against the live `v14-dev` equipment corpus (2026-
 * 09-07; fixture tests pin the consumed subset per item type):
 *
 * - `system.level.value` → `itemData.level` (the corpus stores `null` on kit
 *   documents — Adventurer's Pack — which maps to a null level, not a skip).
 * - `system.price.value` = a multi-coin MAP (the corpus zero-fills absent
 *   coins, e.g. `{cp:0, gp:45, pp:0, sp:0}`) normalized via
 *   `normalizePf2ePrice` to a canonical per-unit cp price + deterministic
 *   display string; optional `system.price.per` is the BUNDLE COUNT the
 *   price applies to (Arrows: `{sp:1}, per: 10` — "1 sp (per 10)"). Unknown
 *   coins / negative amounts / bad `per` fail the entry loudly.
 * - `system.traits.rarity` (always present in the corpus, 'common'…
 *   'unique') → verbatim `itemData.rarity`; `.value` traits → the trait line.
 * - HTML `system.description.value` → stripped plain text (the creature
 *   adapter's exact stripHtml rules, incl. @-notation resolution).
 * - Document `type` → verbatim `itemData.category`.
 *
 * Legacy releases ship the same documents as NDJSON `.db` files — accepted
 * like the creature adapter. pf2e stores no rules-edition marker →
 * `rulesEdition: null`.
 */

export const FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID = 'foundry-pf2e-equipment';

export const FOUNDRY_PF2E_EQUIPMENT_LICENSE =
  'Pathfinder Second Edition equipment from the Foundry VTT PF2e system packs ' +
  '(Paizo Inc. via the Foundry Gaming LLC partnership; mechanics OGL). ' +
  'User-imported for personal use under Paizo\'s Community Use Policy — not for redistribution.';

/** Item document types accepted from the equipment pack — each pinned by a
 *  fixture test. Corpus-swept (408-doc sample + targeted probes): weapon,
 *  armor, shield, equipment, consumable, treasure, ammo, backpack, kit.
 *  Anything else is a counted skip, never a failure (the pack legitimately
 *  holds non-equipment documents, e.g. `_folders.json`). */
export const PF2E_ITEM_TYPES: ReadonlySet<string> = new Set([
  'weapon', 'armor', 'shield', 'equipment', 'consumable', 'treasure', 'ammo', 'backpack', 'kit',
]);

const pf2eEquipmentSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  system: z.object({
    // `null` on kit documents (Adventurer's Pack) — no level is stored.
    level: z.object({ value: z.number() }).nullish(),
    price: z.object({
      value: z.record(z.string(), z.number()),
      per: z.number().optional(),
    }),
    traits: z
      .object({
        value: z.array(z.string()).default([]),
        rarity: z.string().default('common'),
      })
      .nullish(),
    description: z.object({ value: z.string().default('') }).nullish(),
  }),
});

type ParsedEquipment = z.infer<typeof pf2eEquipmentSchema>;

// --- Helpers (the creature adapter's exact text rules; adapters stay
// self-contained per 12-BESTIARY-PACKS §5) -----------------------------------

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
  const withoutNotation = html.replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
    const beforePipe = inner.split('|')[0] ?? '';
    return beforePipe.split('.').pop() ?? '';
  });
  return withoutNotation
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// --- Mapping ---------------------------------------------------------------

function mapEquipment(doc: ParsedEquipment): PackItemEntry {
  const price = normalizePf2ePrice(doc.system.price);
  const traits = doc.system.traits ?? { value: [], rarity: 'common' };
  const item: ItemData = {
    system: 'pathfinder2e',
    category: doc.type,
    level: doc.system.level?.value ?? null,
    priceDisplay: price.priceDisplay,
    priceCp: price.priceCp,
    rarity: traits.rarity,
    traits: traits.value,
    rulesEdition: null,
  };
  const description = stripHtml(doc.system.description?.value ?? '');
  return { name: doc.name, item, text: formatItemText(item, description) };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into a promise by `parseFile`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseDocs(text, fileName);
  const items: PackItemEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isRecord(doc) || typeof doc.type !== 'string' || !PF2E_ITEM_TYPES.has(doc.type)) {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      items.push(mapEquipment(pf2eEquipmentSchema.parse(doc)));
    } catch (error) {
      failures.push({
        file: fileName,
        name,
        message: `document ${String(index)}: ${errorMessage(error)}`,
      });
    }
  }
  return { entries: [], items, skipped, failures };
}

function parseFile(fileName: string, bytes: Uint8Array): Promise<PackFileParse> {
  try {
    return Promise.resolve(parseFileSync(fileName, bytes));
  } catch (error) {
    // Rejections instead of sync throws: the adapter contract is promise-based.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export const foundryPf2eEquipmentAdapter: PackAdapter = {
  id: FOUNDRY_PF2E_EQUIPMENT_ADAPTER_ID,
  label: 'Pathfinder 2e Equipment (Foundry VTT PF2e system packs)',
  system: 'pathfinder2e',
  license: FOUNDRY_PF2E_EQUIPMENT_LICENSE,
  extensions: ['.json', '.db'],
  entryNoun: 'item',
  parseFile,
};
