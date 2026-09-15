import { z } from 'zod';

import { formatItemText, normalizePf2ePrice, type ItemData } from '@/domain/itemData';
import { errorMessage } from '@/lib/errors';

import {
  htmlToText,
  isDocumentRecord,
  parseJsonDocs,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} from './text';
import type { PackAdapter, PackFileParse, PackItemEntry } from './types';

/**
 * `foundry-pf2e-equipment` pack adapter (12-BESTIARY-PACKS §13): equipment/
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
 * - HTML `system.description.value` → plain text through the ONE ingest
 *   HTML→text seam (`./text`), declaring the `@`-notation + block-and-table
 *   style. AMENDED by docs/17 row 149: through row 143 this lane declared the
 *   LINE-BREAKS-ONLY variant, which is what stored the brace residue
 *   (`Enfeebled{Enfeebled 1}`) and the collapsed table (`HardnessHPBT52010`).
 *   Read that row before changing the declaration again — a changed byte
 *   strands citations stored against the old one.
 *   AMENDED by docs/17 row 143: this lane used to carry its OWN copy of the
 *   creature adapter's strip rules ("self-contained per §5's precedent",
 *   docs/12 §5/§13.5) — that precedent produced seven copies and is retired.
 * - `system.publication` `{license, remaster, title}` → carried VERBATIM into
 *   `itemData.publication` (hygiene rider, docs/12 §15) and rendered as the
 *   text's trailing `Source:` line — per-entry licensing is preserved, never
 *   dropped (fixtures: Player Core ORC, Battlecry! ORC).
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
    // Per-entry source publication (hygiene rider, docs/12 §15) — carried
    // into the item payload verbatim instead of being dropped.
    publication: z
      .object({
        title: z.string().default(''),
        license: z.string().default(''),
      })
      .nullish(),
  }),
});

type ParsedEquipment = z.infer<typeof pf2eEquipmentSchema>;

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
    publication: doc.system.publication ?? null,
  };
  const description = htmlToText(doc.system.description?.value ?? '', AT_BRACE_LABEL_BLOCK_AND_TABLE);
  return { name: doc.name, item, text: formatItemText(item, description) };
}

// --- Adapter ---------------------------------------------------------------

/** Synchronous parse body — wrapped into a promise by `parseFile`. */
function parseFileSync(fileName: string, bytes: Uint8Array): PackFileParse {
  const text = new TextDecoder('utf-8').decode(bytes);
  const docs = parseJsonDocs(text, fileName);
  const items: PackItemEntry[] = [];
  const failures: PackFileParse['failures'] = [];
  let skipped = 0;
  for (const [index, doc] of docs.entries()) {
    if (!isDocumentRecord(doc) || typeof doc.type !== 'string' || !PF2E_ITEM_TYPES.has(doc.type)) {
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
