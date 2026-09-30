/**
 * THE wiki-link rules a writing model is given (docs/17 row 418) — ONE home, so
 * the module chat, the refine/rewrite core and the parts pass cannot drift.
 *
 * WHY THIS EXISTS: the rework made the canvas chat the way modules are written,
 * but only the SPELLING rule travelled with it — the sentence saying WHAT to
 * link stayed in the parts pass (`promptStyles`), and the one chat rule that
 * names kinds (the level statement) names only NPCs and encounters. Owner,
 * verbatim: "the only wikilinks they used were encounters and NPCs. No
 * locations, events or notes." Two capable models did exactly what they were
 * told.
 */

/** What to link: every proper noun and every scene, by kind. The parts pass's
 * sentence, moved here byte-identical. */
export const WIKI_LINK_WHAT_TO_LINK =
  '- Wiki-link every proper noun as [[Name]]: NPCs, locations, factions, artifacts, monsters — and every scene ([[Encounter Name]] for a fight, [[Event Name]] for anything else). Reuse the exact names of entities from earlier parts and the campaign index, consistently.';

/** How to write a token: canonical spelling, no inflection, display aliases. */
export const WIKI_TOKEN_RULES =
  '- Wiki-links are [[Name]] tokens (names, never IDs). Keep every token\'s EXACT canonical spelling when the instruction does not rename the entity; never inflect inside the token — write [[Halmund]]\'s tower, not [[Halmunds]] Haus; write [[Name|display]] when the surface text must differ from the canonical name; use [[Name|display]] for roles/titles ([[Halmund|the guard Halmund]]). When the instruction renames or introduces entities, update every affected token inside the replacement consistently. The same rules apply in any language.';
