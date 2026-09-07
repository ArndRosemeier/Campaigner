import { z } from 'zod';

import { gameSystemSchema } from '@/domain/gameSystem';

/**
 * Normalized equipment/item payload (12-BESTIARY-PACKS §13, the item-corpus
 * arc): the exact, validated data carried by `chunkType: 'item'` RuleChunks,
 * mirroring the `statBlock` precedent — `null` on every non-item chunk. The
 * two source corpora map onto ONE shape so the retrieval pool and prompt
 * sections are system-agnostic:
 *
 * - pf2e (`packs/pf2e/equipment/` @ v14-dev): `system.level.value` (number),
 *   `system.price.value` = a multi-coin MAP whose keys may be zero-filled by
 *   the system's serialization (`{cp:0, gp:45, pp:0, sp:0}`), optional
 *   `system.price.per` = the BUNDLE COUNT the price applies to (Arrows:
 *   `{sp:1}, per: 10` — "1 sp per 10"; absent or `1` = per single unit),
 *   `system.traits.rarity` (always present, 'common'…'unique') +
 *   `.value` traits, HTML `system.description.value`. Document `type` is the
 *   verbatim category (weapon/armor/equipment/consumable/treasure/ammo/
 *   backpack/…).
 * - dnd5e (`packs/_source/{equipment24,items,tradegoods}/` @ 6.0.x): NO level
 *   (null), `system.price = {value, denomination}` (a single value + coin),
 *   `system.rarity` (often `''` — the mundane "unstated" convention),
 *   HTML `system.description.value`, and in-doc `system.source.rules`
 *   ('2014' | '2024') which is carried verbatim as `rulesEdition`.
 */

export const itemDataSchema = z.object({
  system: gameSystemSchema,
  /** Verbatim source category: the pf2e/dnd5e document `type`. Never normalized. */
  category: z.string().min(1),
  /** pf2e `system.level.value`; dnd5e items have no level → null. */
  level: z.number().int().nullable(),
  /**
   * Deterministic display price: the pf2e coin-map render ("1 gp, 5 sp",
   * "1 sp (per 10)") or the dnd5e verbatim "10 gp"; '—' when the source
   * states no price (pf2e empty/all-zero map, dnd5e absent price object).
   */
  priceDisplay: z.string(),
  /**
   * Canonical PER-UNIT price in the system's base coin (cp) — pf2e coin-map
   * sums divide by `price.per` when present. Fractional values are exact and
   * deterministic; they are never rendered (the display string is). Null =
   * no price stated.
   */
  priceCp: z.number().nonnegative().nullable(),
  /** Verbatim source rarity; '' = unstated (the dnd5e mundane convention). */
  rarity: z.string().default(''),
  /** pf2e trait strings; dnd5e weapon/equipment property labels. */
  traits: z.array(z.string()).default([]),
  /** Verbatim in-doc `system.source.rules` ('2014'|'2024'); pf2e → null. */
  rulesEdition: z.string().nullable(),
  /**
   * Per-entry source publication (hygiene rider, docs/12 §15): pf2e corpus
   * documents carry `system.publication {license, remaster, title}` at full
   * coverage — stored verbatim (title + license) and rendered as the text's
   * trailing `Source:` line. Nullish on pre-arc rows and dnd5e items (whose
   * license is book-level CC-BY-4.0, stored on the book).
   */
  publication: z
    .object({
      title: z.string().default(''),
      license: z.string().default(''),
    })
    .nullish(),
});

export type ItemData = z.infer<typeof itemDataSchema>;

/**
 * Coin ladders in the systems' printed 10:1 staircase, base coin = cp for
 * both. pf2e: 10 cp = 1 sp, 10 sp = 1 gp, 10 gp = 1 pp. dnd5e adds
 * electrum: 1 ep = 5 sp = 50 cp, 1 pp = 10 gp = 1000 cp.
 */
export const PF2E_COIN_LADDER: Readonly<Record<string, number>> = {
  cp: 1, sp: 10, gp: 100, pp: 1000,
};

export const DND5E_COIN_LADDER: Readonly<Record<string, number>> = {
  cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000,
};

/** Ladder keys in descending denomination order — the display order. */
const LADDER_ORDER = ['pp', 'gp', 'sp', 'ep', 'cp'] as const;

export interface NormalizedPrice {
  /** Canonical per-unit price in cp; null when the source states no price. */
  priceCp: number | null;
  /** Deterministic display string ('—' when no price is stated). */
  priceDisplay: string;
}

function coinValue(ladder: Readonly<Record<string, number>>, coin: string, value: number, what: string): number {
  const factor = ladder[coin];
  if (factor === undefined) {
    throw new Error(`unsupported ${what} coin "${coin}"`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`unsupported ${what} coin amount for "${coin}": ${String(value)}`);
  }
  return value * factor;
}

/**
 * pf2e price normalization: Σ value[coin]·ladder[coin] ÷ (per ?? 1). Unknown
 * coin keys, negative/non-finite amounts, or a non-positive `per` are LOUD
 * errors (per-entry adapter failures) — never silent zeros. An empty or
 * all-zero coin map is the system's serialization of "no price" → null/'—'
 * (the corpus zero-fills the other coins, e.g. `{cp:0, gp:45, pp:0, sp:0}`).
 */
export function normalizePf2ePrice(price: {
  value: Record<string, number>;
  per?: number | undefined;
}): NormalizedPrice {
  const per = price.per;
  if (per !== undefined && (typeof per !== 'number' || !Number.isFinite(per) || per <= 0)) {
    throw new Error(`unsupported price bundle count "per": ${String(per)}`);
  }
  let total = 0;
  for (const [coin, amount] of Object.entries(price.value)) {
    total += coinValue(PF2E_COIN_LADDER, coin, amount, 'pf2e price');
  }
  if (total === 0) return { priceCp: null, priceDisplay: '—' };
  const perUnit = per === undefined || per === 1 ? total : total / per;
  const parts = LADDER_ORDER.filter(
    (coin) => coin in PF2E_COIN_LADDER && (price.value[coin] ?? 0) > 0,
  ).map((coin) => {
    const amount = price.value[coin];
    return `${String(amount)} ${coin}`;
  });
  const bundle = per === undefined || per === 1 ? '' : ` (per ${String(per)})`;
  return { priceCp: perUnit, priceDisplay: `${parts.join(', ')}${bundle}` };
}

/**
 * dnd5e price normalization: `value · ladder[denomination]`. The display is
 * the stored pair verbatim ("10 gp"). An absent price object → null/'—'; a
 * stated 0 is a real 0 ({priceCp: 0}); an unknown denomination is a loud
 * per-entry failure.
 */
export function normalizeDnd5ePrice(
  price: { value: number; denomination: string } | null | undefined,
): NormalizedPrice {
  if (price === null || price === undefined) return { priceCp: null, priceDisplay: '—' };
  const value = coinValue(DND5E_COIN_LADDER, price.denomination, price.value, 'dnd5e price');
  return { priceCp: value, priceDisplay: `${String(price.value)} ${price.denomination}` };
}

/**
 * Deterministic chunk text for an item chunk (search text, display,
 * contentHash): one summary line of the normalized fields, then the stripped
 * description, then the trait line and the per-entry source line. Absent
 * parts render no line — never an empty placeholder. A stated '—' price is
 * kept (it is the source's "no price"), an unstated rarity/level/rules
 * edition render nothing.
 */
export function formatItemText(item: ItemData, description: string): string {
  const summary = [
    item.category,
    item.level === null ? null : `Level ${String(item.level)}`,
    item.priceDisplay,
    item.rarity === '' ? null : item.rarity,
    item.rulesEdition === null ? null : `${item.rulesEdition} rules`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  const traitLine = item.traits.length === 0 ? null : `Traits: ${item.traits.join(', ')}`;
  // Per-entry licensing preserved, never dropped (hygiene rider, docs/12 §15).
  const publication = item.publication;
  const title = publication?.title.trim() ?? '';
  const license = publication?.license.trim() ?? '';
  const sourceLine =
    title === '' && license === ''
      ? null
      : title === ''
        ? `Source: ${license}`
        : `Source: ${title}${license === '' ? '' : ` (${license})`}`;
  return [summary, description.trim(), traitLine, sourceLine]
    .filter((part) => part !== null && part !== '')
    .join('\n');
}
