import { loadAll } from 'js-yaml';
import { z } from 'zod';

import { formatItemText, normalizeDnd5ePrice, type ItemData } from '@/domain/itemData';
import { DND5E_PROPERTY_LABELS } from './dnd5e-foundry';
import { errorMessage } from '@/lib/errors';

import type { PackAdapter, PackFileParse, PackItemEntry } from './types';

/**
 * `foundry-dnd5e-equipment` pack adapter (12-BESTIARY-PACKS §12): equipment/
 * item entries from the Foundry VTT dnd5e system content ([foundryvtt/dnd5e]
 * (https://github.com/foundryvtt/dnd5e) branch `6.0.x`, `packs/_source/`
 * folders `equipment24/` (2024 rules), `items/` (2014 rules) and
 * `tradegoods/` — 679 + 889 + 23 YAML documents at the corpus sweep,
 * 2026-09-07). A PARALLEL adapter to the creature one: it accepts the item
 * document types and skips everything else (counted, never silently
 * dropped); creature documents belong to `foundry-dnd5e-srd`.
 *
 * Field mapping verified against the LIVE 6.0.x corpus (ALL 1454 item
 * documents swept, 0 parse errors; fixture tests pin the consumed subset
 * per folder):
 *
 * - NO level — dnd5e items store none; `itemData.level` is always null.
 * - `system.price = {value, denomination}` — the sweep shows cp/sp/gp
 *   denominations only, but any ladder coin is accepted and others fail the
 *   entry loudly via `normalizeDnd5ePrice`.
 * - `system.rarity` — often `''` (the mundane "unstated" convention) or
 *   common/uncommon/rare/veryRare/legendary/artifact, kept VERBATIM (the
 *   camelCase `veryRare` is the stored form).
 * - top-level `type` → verbatim `itemData.category` (the sweep's full
 *   inventory: weapon, equipment, consumable, tool, loot).
 * - `system.source.rules` ('2014' | '2024') → verbatim `itemData.
 *   rulesEdition`; `system.source.license` is CC-BY-4.0 on these packs.
 * - `system.properties` (weapon/equipment property slugs like `ver`) →
 *   traits through the shared property-label table; unknown slugs are kept
 *   raw — never dropped silently.
 * - HTML `system.description.value` → stripped plain text (the creature
 *   adapter's exact stripDescription rules, incl. [[notation]]).
 */

export const FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID = 'foundry-dnd5e-equipment';

export const FOUNDRY_DND5E_EQUIPMENT_LICENSE =
  'D&D 5e equipment from the Foundry VTT dnd5e system packs (Wizards of the Coast ' +
  'SRD content under CC-BY-4.0; the in-document source.rules field records the ' +
  'rules edition, \'2014\' or \'2024\'). User-imported for personal use — not for redistribution.';

/** Item document types accepted from the equipment/items/tradegoods packs —
 *  the complete corpus inventory (1454-doc sweep). Anything else is a counted
 *  skip, never a failure (e.g. `_folder.yml` metadata). */
export const DND5E_ITEM_TYPES: ReadonlySet<string> = new Set([
  'weapon', 'equipment', 'consumable', 'tool', 'loot',
]);

const dnd5eEquipmentSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  system: z.object({
    description: z.object({ value: z.string().default('') }).nullish(),
    price: z
      .object({
        value: z.number(),
        denomination: z.string(),
      })
      .nullish(),
    rarity: z.string().nullish(),
    properties: z.array(z.string()).nullish(),
    source: z
      .object({
        rules: z.string().nullish(),
      })
      .nullish(),
  }),
});

type ParsedEquipment = z.infer<typeof dnd5eEquipmentSchema>;

// --- Helpers (the creature adapter's exact text rules; the property-label
// table is shared verbatim) ---------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses one YAML document per file (the `_source` shape). A multi-document
 *  or unparseable file fails loudly. */
function parseDocs(text: string, fileName: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error(`${fileName}: file is empty`);
  try {
    const docs: unknown[] = loadAll(trimmed);
    const parsed = docs.filter((doc) => doc !== null && doc !== undefined);
    if (parsed.length === 0) throw new Error(`${fileName}: no YAML document`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${fileName}:`)) throw error;
    throw new Error(`${fileName}: not valid YAML: ${errorMessage(error)}`, { cause: error });
  }
}

function stripDescription(html: string): string {
  return html
    .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, (_match, inner: string) => {
      // [[/condition conditions:Incapacitated|incapacitated]] → last label;
      // bracket links without a label segment render as nothing.
      const segments = inner.split('|');
      return segments.length > 1 ? (segments[segments.length - 1] ?? '') : '';
    })
    .replace(/&(amp;)?reference\[([^\]]*)\]/g, '$2')
    .replace(/@(\w+)\[([^\]]*)\]/g, (_match, _kind: string, inner: string) => {
      return (inner.split('|')[0] ?? '').split('.').pop() ?? '';
    })
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
  const price = normalizeDnd5ePrice(doc.system.price ?? null);
  // Property slugs → printed labels through the shared table; an unknown
  // slug is KEPT RAW — dropping it would silently lose stored data.
  const traits = (doc.system.properties ?? []).map(
    (slug) => DND5E_PROPERTY_LABELS[slug] ?? slug,
  );
  const item: ItemData = {
    system: 'dnd5e',
    category: doc.type,
    level: null,
    priceDisplay: price.priceDisplay,
    priceCp: price.priceCp,
    rarity: doc.system.rarity ?? '',
    traits,
    rulesEdition: doc.system.source?.rules ?? null,
  };
  const description = stripDescription(doc.system.description?.value ?? '');
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
    if (!isRecord(doc) || typeof doc.type !== 'string' || !DND5E_ITEM_TYPES.has(doc.type)) {
      skipped += 1;
      continue;
    }
    const name = typeof doc.name === 'string' ? doc.name : '';
    try {
      items.push(mapEquipment(dnd5eEquipmentSchema.parse(doc)));
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

export const foundryDnd5eEquipmentAdapter: PackAdapter = {
  id: FOUNDRY_DND5E_EQUIPMENT_ADAPTER_ID,
  label: 'D&D 5e Equipment (Foundry VTT dnd5e system packs — SRD)',
  system: 'dnd5e',
  license: FOUNDRY_DND5E_EQUIPMENT_LICENSE,
  extensions: ['.yml', '.yaml'],
  entryNoun: 'item',
  parseFile,
};
