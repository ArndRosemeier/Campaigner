/**
 * The ONE form of an "additional instruction" — the paragraph that carries a
 * caller's free-text change request into a prompt (docs/17 row 101).
 *
 * The form is not new: it is the paragraph the run engine has always rendered
 * for its `extraInstruction` parameter (the Details view's "retry this step
 * with an instruction"), and this module exists so that the engine and the
 * specialists that compose BRIEFS render the same bytes from the same place
 * instead of three copies of one template string. `runEngine`'s four render
 * sites (draft, statblock, review check, encounter brief) and the brief
 * builders the change seam drives (`features/modules/persona-request`,
 * `features/campaign/encounterRegen`) all go through it.
 *
 * TWO PROPERTIES ARE LOAD-BEARING:
 *
 * 1. **Empty means absent, byte-for-byte.** `additionalInstructionSection('')`
 *    is `null` and `withAdditionalInstruction(brief, '')` returns `brief`
 *    UNCHANGED — no separator, no empty paragraph, no trailing whitespace. A
 *    run with nothing extra asked therefore sends the prompt it always sent
 *    (the no-instruction pins: docs/18 §4 "an additive instruction must leave
 *    the no-instruction prompt byte-identical").
 * 2. **The instruction only ever ADDS a paragraph.** It is appended, never
 *    spliced into an existing clause, never allowed to rewrite a contract the
 *    specialist states — a brief that contradicts the instruction still
 *    governs, and a reply that violates it fails loud (never a partial apply).
 *
 * No trimming happens here on purpose: normalizing the text is the CALLER's
 * boundary (`changeArtifact` trims once at entry, mirroring
 * `moduleGen`'s `options.extraInstruction.trim()`), so the retry path's bytes
 * stay exactly what the UI handed over.
 */

/** The paragraph for `instruction`, or `null` when there is none to render —
 * the form every prompt section list uses (`.filter((part) => part !== null)`). */
export function additionalInstructionSection(instruction: string): string | null {
  return instruction === '' ? null : `Additional instruction: ${instruction}`;
}

/** `brief` with the instruction appended as its own final paragraph, or
 * `brief` BYTE-IDENTICAL when there is no instruction. */
export function withAdditionalInstruction(brief: string, instruction: string): string {
  const section = additionalInstructionSection(instruction);
  return section === null ? brief : `${brief}\n\n${section}`;
}
