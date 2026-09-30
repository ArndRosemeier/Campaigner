import { z } from 'zod';

import type { GameSystem } from '@/domain/gameSystem';

/**
 * The encounter budget policy (docs/17 row 180, owner request): WHICH rule
 * decides how a room's challenge is bounded during encounter generation. It
 * used to be hard-coded per game system inside the budget loop
 * (`roomBudgetMode(system)`): dnd5e ran the documented numeric band,
 * pathfinder2e shipped no numbers at all. That made the owner's PF2E module —
 * a Dungeon filled at grade 75 — ship ONE easy fight per room forever, because
 * "no numbers" meant the displayed fill grade never became a target and the
 * Cartographer was never authorized to stock a complex.
 *
 * The policy is a persisted, zod-validated value (module row field +
 * New Module draft) resolved ONCE per run and threaded to every budget
 * consumer — never re-derived from the system at each call site.
 *
 * Exactly three values, each documented:
 *
 * - `'system'` — the compatibility mode: today's per-system behaviour, i.e.
 *   the numeric dnd5e band for dnd5e and the "ship no numbers" verbatim rule
 *   for pathfinder2e. A module row that predates the field resolves here, so
 *   every legacy row behaves byte-identically.
 * - `'pf2e-budget'` — PF2E-native numeric stocking: a per-room target derived
 *   from the encounter's party level and size, with the fill grade read as the
 *   share of a standard encounter budget. Retrieved GM Core excerpts are
 *   obeyed VERBATIM when they are in context; otherwise Campaigner's OWN
 *   documented approximation applies and a LOUD advisory is persisted. Paizo's
 *   tables are never embedded in code (the docs/12 §13.2/§14 licensing
 *   stance is binding).
 * - `'verbatim'` — ship no numbers; obey source statblocks as written. This is
 *   today's PF2E behaviour, byte-identical, and it stays selectable because
 *   shipping no Paizo numbers is a deliberate licensing stance (docs/11 D12).
 */
export const ENCOUNTER_BUDGET_POLICIES = ['system', 'pf2e-budget', 'verbatim'] as const;

export const encounterBudgetPolicySchema = z.enum(ENCOUNTER_BUDGET_POLICIES);

export type EncounterBudgetPolicy = z.infer<typeof encounterBudgetPolicySchema>;

/** Human labels for the New Module dialog (one source, never re-spelled). */
export const ENCOUNTER_BUDGET_POLICY_LABELS: Readonly<Record<EncounterBudgetPolicy, string>> = {
  system: 'By game system (compatibility)',
  'pf2e-budget': "PF2e encounter budget (Campaigner's approximation)",
  verbatim: 'Verbatim — ship no numbers',
};

/**
 * The SENSIBLE per-system default applied at module creation: a
 * `pathfinder2e` module defaults to `'pf2e-budget'` so a filled dungeon
 * actually produces a level-appropriate challenge; every other system
 * defaults to `'system'` (its numeric dnd5e band already worked). This is the
 * default the New Module dialog shows, and the value the creation path stamps
 * on the row when the caller recorded no explicit choice.
 */
export function defaultEncounterBudgetPolicy(system: GameSystem): EncounterBudgetPolicy {
  return system === 'pathfinder2e' ? 'pf2e-budget' : 'system';
}

/**
 * The ONE policy resolver every run reads: a module's OWN recorded policy when
 * it has one; `'system'` otherwise. `'system'` is the legacy reading — a row
 * written before the field, and any encounter with no owning module at all —
 * so old modules behave exactly as today (docs/17 row 180).
 */
export function resolveEncounterBudgetPolicy(
  module: { encounterBudgetPolicy?: EncounterBudgetPolicy | null | undefined } | null | undefined,
): EncounterBudgetPolicy {
  return module?.encounterBudgetPolicy ?? 'system';
}
