/**
 * ONE regex-literal escape for the whole app (docs/17 row 300, AGENTS rule 4).
 *
 * WHY IT EXISTS. The metacharacter class this function holds was spelled at SIX
 * sites — `domain/battle/board.matchesSlotLabel`, `llm/language.levelWordsPattern`,
 * `llm/promptScaffolding`'s marker builders, `llm/campaignGrounding.wordBoundaryPattern`,
 * `llm/roomBudget.withoutEntityLevelHintLines` and
 * `features/rules/search-browser.Highlight` — each quoting its OWN literal for a
 * `RegExp` source. A drift here does not throw: it silently changes WHICH
 * characters a pattern treats literally, so a name or a marker containing a `.`
 * or a `(` starts matching differently. One escaping rule, one home.
 *
 * THE BYTES ARE THE CONTRACT. Every call site's result becomes a `RegExp`
 * source, and three of them (`levelWordsPattern`, the scaffolding markers,
 * `wordBoundaryPattern`) feed text that is sent to the MODEL or matched against
 * what it wrote, where the prompt-byte pins hold the exact strings. So this is
 * the EXACT expression the six sites spelled, MOVED — never a "cleaner" or
 * wider escaping. A caller that needs a different class wants a different
 * function, not a change here.
 *
 * THE HOME, CHOSEN BY THE DEPENDENCY DIRECTION (docs/18 §1). `src/lib` is NOT a
 * leaf: the layer map is `app → features → {db, llm, search, ingest, lib} →
 * domain`, and `domain → lib` is an UPWARD import — the two that exist are
 * enumerated as known debt in docs/18 §5, which forbids adding another. One of
 * the six sites (`domain/battle/board`) IS in `domain`, so a `lib/` home would
 * need that third exception. `domain` is the layer every other layer already
 * imports downward, so the seam lives here — the same reasoning that puts the
 * one-line `domain/plural` here (docs/17 row 248).
 *
 * `tests/architecture/one-slot-label-pattern.test.ts` holds it single-site: the
 * class may appear in THIS file and nowhere else under `src/**`, and the six
 * declared sites must import this function rather than spell it.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
