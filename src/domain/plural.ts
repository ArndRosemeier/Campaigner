/**
 * ONE counted-noun phrase for every migration/report sentence in the app
 * (folded by docs/17 row 248).
 *
 * This replaces THREE byte-identical private copies (`creatureCitationRepair`,
 * `creatureKeyFold`, `mobCopyRepair`) — which is exactly why nothing ever failed
 * while they multiplied: a copy is invisible when it is BORN (AGENTS
 * §Centralization). It sat under the LANDED tripwire's 75-normalized-character
 * floor, so the detector never saw it either; the fold is deliberate, and any
 * further report sentence imports THIS rather than growing a fourth.
 */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}
