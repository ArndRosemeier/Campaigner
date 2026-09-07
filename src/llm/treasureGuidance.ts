import type { GameSystem } from '@/domain/gameSystem';

/**
 * Per-system treasure-budget guidance for the encounter prompts
 * (owner-ratified room-keys/treasure arc).
 *
 * Licensing shape (docs/12-BESTIARY-PACKS §13.2, §14):
 * - **dnd5e** — the DMG treasure tables are NOT licensable, so Campaigner
 *   ships its OWN documented approximation in our own words (no Wizards text
 *   is quoted or restated numerically from it). The ladder is deliberately
 *   coarse: it sizes pocket money vs hoards so the model's treasure stays
 *   level-appropriate, and it is recorded verbatim in docs/11.
 * - **pf2e** (system id `pathfinder2e`) — treasure budgets are Paizo's (GM
 *   Core Treasure chapter). We ship NO Paizo text; the model grounds amounts
 *   in the VERBATIM GM Core excerpts the retrieve step surfaced
 *   (treasure-rules retrieval, encounter personas) under Paizo's Community
 *   Use Policy for personal use. When no such excerpt is in the window the
 *   model gives unquantified treasure instead of inventing numbers — a
 *   paraphrased budget would be a silent fabrication (AGENTS rule 1).
 *
 * Coherence with the item pool (12 §13, `formatItemPoolSection`): that
 * section already instructs naming pool items VERBATIM in the treasure field
 * and forbids inventing magic items. These clauses add STRUCTURE (per-monster
 * carry, room hoards) and BUDGETS without repeating or contradicting it —
 * coins/gems are free to name, permanent/magic items never are.
 */

const SHARED_STRUCTURE = [
  'Treasure structure (owner-ratified): treasure text is a GM checklist — one item per line, item name + amount or hiding spot, never item stat blocks or rules text.',
  'Every monster entry carries a "treasure" string: what ONE instance of that creature carries (an empty string when it carries nothing). Encounter-scoped: what THESE creatures have here, never the species\' typical hoard.',
  'Hoards and hidden stashes do NOT go on monsters — they belong to the place. Coins, gems and trade goods are free to name; permanent/magic items come ONLY from the item pool by exact name (see the item-pool section), never invented.',
].join('\n');

const DND5E_BUDGET = [
  'Treasure budget (dnd5e — Campaigner\'s own documented approximation; the DMG is not licensable, so no DMG table is quoted or restated):',
  '- Individual carries stay pocket-level: roughly 5 × the creature\'s challenge rating in mixed coins (gp-equivalent), plus at most one mundane pool item per squad.',
  '- A hoard (a room\'s "keyTreasure", or the top-level "treasure" field) totals roughly 50 gp × the average encounter level, as coins, gems and trade goods; at most one magic item from the pool per two encounter levels.',
].join('\n');

const PF2E_BUDGET = [
  'Treasure budget (pathfinder2e): the GM Core treasure rules are the law — when the retrieved rule excerpts include the treasure chapter, follow its budgets VERBATIM (exact amounts, never a paraphrase of a Paizo number).',
  'When the excerpts do NOT include the treasure rules, do not invent amounts: describe what treasure exists and where, without numbers.',
  'Individual creature carries follow the creature-coin guidance in the excerpts; the party-facing hoard (a room\'s "keyTreasure", or the top-level "treasure" field) follows the party treasure by level.',
].join('\n');

/** The clause injected into the encounter draft/brief prompts for `system`. */
export function treasureGuidanceFor(system: GameSystem): string {
  const budget = system === 'pathfinder2e' ? PF2E_BUDGET : DND5E_BUDGET;
  return [SHARED_STRUCTURE, budget].join('\n');
}

/**
 * The room-key clause for the Cartographer brief only (the Smith drafts no
 * rooms). The map regeneration consequence is stated here so the model knows
 * keys are regenerated WITH the map, not authored-in-stone, and outdoor
 * staging areas carry keys exactly like dungeon rooms (owner-adjudicated).
 */
export function roomKeyGuidanceFor(): string {
  return [
    'Room keys: every room carries a "key" — 1–3 sentences of GM-only room information the GM reads when the party first enters (what the room looks like, who or what is here, anything interactable) — and a "keyTreasure" checklist of the treasure hidden in THAT room (one item per line; "" when none). Hoards live in "keyTreasure"; monsters only carry pocket-level "treasure".',
    'Outdoor encounters get room keys too: each staging area carries "key"/"keyTreasure" exactly like dungeon rooms (the key marker renders at the room\'s mob area).',
    'Room keys regenerate together with the map: rewriting them on a regeneration is expected, not a loss to avoid.',
  ].join('\n');
}
