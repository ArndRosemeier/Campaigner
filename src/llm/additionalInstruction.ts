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

/**
 * The ONE spelling of the label (docs/17 row 247). Exported because the READER
 * below must recognize exactly the bytes the WRITER above produces — a second
 * literal at the read site is the drift this module exists to prevent.
 */
export const ADDITIONAL_INSTRUCTION_LABEL = 'Additional instruction:';

/** The paragraph for `instruction`, or `null` when there is none to render —
 * the form every prompt section list uses (`.filter((part) => part !== null)`). */
export function additionalInstructionSection(instruction: string): string | null {
  return instruction === '' ? null : `${ADDITIONAL_INSTRUCTION_LABEL} ${instruction}`;
}

/** `brief` with the instruction appended as its own final paragraph, or
 * `brief` BYTE-IDENTICAL when there is no instruction. */
export function withAdditionalInstruction(brief: string, instruction: string): string {
  const section = additionalInstructionSection(instruction);
  return section === null ? brief : `${brief}\n\n${section}`;
}

/**
 * The instruction a brief CARRIES, read back out of it — or `null` when the
 * brief carries none (docs/17 row 247). The exact inverse of
 * `withAdditionalInstruction`: `additionalInstructionOf(withAdditionalInstruction(b, i))`
 * is `i` for every non-empty `i`, and `null` for every brief written without
 * one.
 *
 * WHY A READER EXISTS AT ALL. The change seam (`features/modules/change-artifact`)
 * hands the user's instruction to the entity batch, which appends it to the
 * BRIEF through this same paragraph — that is the one channel a chat/change
 * instruction has. The run engine must be able to tell "the owner asked for
 * this" (an explicit instruction that OUTRANKS the module's recorded level,
 * and that a draft's `needsStatBlock: false` may not veto — docs/17 row 247)
 * from "the module's own text", and the paragraph the brief already carries is
 * the only place that fact lives on the run input. Reading it here, through the
 * label the writer uses, keeps the two from drifting.
 *
 * The instruction is ALWAYS the brief's final paragraph (the writer appends
 * it), so the LAST label wins; the returned text is verbatim — a multi-line
 * instruction survives intact.
 */
export function additionalInstructionOf(brief: string): string | null {
  const marker = `\n\n${ADDITIONAL_INSTRUCTION_LABEL} `;
  const at = brief.lastIndexOf(marker);
  if (at !== -1) return brief.slice(at + marker.length);
  const head = `${ADDITIONAL_INSTRUCTION_LABEL} `;
  return brief.startsWith(head) ? brief.slice(head.length) : null;
}

/**
 * THE direct instruction of ONE run step (docs/17 rows 247, 284): the owner's own
 * words about THIS entity, from the two places they can reach a step — the
 * Details view's retry/resume text (`extraInstruction`) and the brief's ONE
 * `Additional instruction:` paragraph (the change seam, read by
 * `additionalInstructionOf` above). Empty when the owner asked for nothing.
 *
 * WHY A COMPOSER AND NOT THE EXPRESSION AT EACH SITE. A step that REFUSES or
 * AUTHORS must read this before it decides, and TWO steps now decide on it — the
 * statblock step (may it author?) and `runFinalize`'s refill merge (may the
 * drafted block land?). Two spellings of "did the owner ask for something" would
 * drift the moment one of them learned a third source, and a merge that saw no
 * instruction while the step saw one would fail a run the owner explicitly
 * asked for — an instruction dropped in silence, which AGENTS rules 1-2 forbid.
 * The repair recursions deliberately do NOT pass their own text here: a repair
 * continuation is the app talking to itself (docs/17 row 247).
 */
export function directInstructionFor(brief: string, extraInstruction: string): string {
  return [extraInstruction, additionalInstructionOf(brief) ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n');
}
