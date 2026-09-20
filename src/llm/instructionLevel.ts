import { z } from 'zod';

import { ENTITY_LEVEL_HINT_MAX, ENTITY_LEVEL_HINT_MIN } from '@/domain/module';
import type { ReasoningEffort } from '@/domain/settings';
import { errorMessage } from '@/lib/errors';
import { parseJsonReply, parseErrorSummary } from '@/llm/jsonReply';
import { chat, MissingApiKeyError } from '@/llm/openrouter';
import { schemaResponseFormat } from '@/llm/strictSchema';

/**
 * THE LEVEL THE OWNER'S INSTRUCTION ASKS FOR, READ BY THE MODEL (docs/17 row
 * 289, AGENTS.md engineering rule 5).
 *
 * WHY THIS EXISTS. The level an explicit instruction fixes is the TOP of the
 * stat-block precedence chain (docs/17 row 247) and it BINDS the reply — a
 * block that prints another level is repaired once and then rejected loudly
 * (row 197/247), because the app may not let a model invent the number it is
 * then judged against. That number used to be read by a REGEX over the owner's
 * free text (`roomBudget.instructionLevel` = `firstLevelInText`: a level word,
 * then whitespace, then 1–2 digits, first match wins). MEASURED against the
 * owner's actual instruction — *"…images are preserved, but level needs to be
 * bumped to 3."* — it resolved NOTHING, so the chain fell to the entity's
 * minted block and the stat block was bound to the OLD level while the prose
 * model, which reads the sentence itself, wrote the level he asked for. The
 * same grammar read the OLD level out of *"uplift this mob from level 1 to
 * level 3"* (first match wins). The owner's ruling is general and binding: free
 * text is read by the MODEL, never by a pattern; if a value must be exact, the
 * FORM becomes structured. A level really must be exact, so the reading is a
 * structured, zod-validated model call — and what it read is NAMED on the run
 * step so a wrong read is visible and correctable in one step.
 *
 * ONE MECHANISM. The pattern is NOT kept beside this as a "fast pre-read": two
 * authorities for one reading drift, and rule 5 allows a pre-read only where
 * the model read is the authority. `roomBudget.firstLevelInText` survives for
 * the module-prose family (docs/17 row 285), a DIFFERENT question about
 * app-authored text, not this one.
 *
 * HONEST `null`. The contract's `level` is nullable on purpose: `null` is the
 * model's answer when the instruction asks for no level, and the caller then
 * leaves the chain to the entity's block, its stored hint and the module's own
 * statement exactly as before. `null` is NOT a failure and never a number: a
 * malformed or schema-invalid reply THROWS (the caller lets the run fail
 * loudly), because a failed read silently becoming "no level" is precisely the
 * partial success this slice removes.
 */

/**
 * The reply contract: an ABSOLUTE level in the app's own domain (1..20, the
 * same bound `domain/module` fixes for a recorded `levelHint`), or the honest
 * `null` when the instruction asks for no level — plus the span it was read
 * from, so the owner can see WHY.
 *
 * The domain bound is enforced by THIS zod parse at the boundary (rule 3). The
 * strict decoder strips `minimum`/`maximum` from the emitted schema, so the
 * bound is also STATED in the prompt; a reply outside it is a loud parse
 * failure, never a clamp and never a fallback.
 */
export const instructionLevelReplySchema = z.object({
  level: z
    .number()
    .int()
    .min(ENTITY_LEVEL_HINT_MIN)
    .max(ENTITY_LEVEL_HINT_MAX)
    .nullable(),
  quote: z.string().nullable(),
});

export type InstructionLevelReply = z.infer<typeof instructionLevelReplySchema>;

/**
 * The reading prompt. ONE job, one JSON object, and the language rule is
 * explicit because the instruction is the game master's own words in ANY of the
 * languages the app generates in — there is no word list here and no pattern.
 * The RELATIVE case is stated because "bump it up two levels" is unreadable
 * without the current level, which the caller therefore supplies.
 */
const SYSTEM_PROMPT = [
  "You read ONE value out of a tabletop roleplaying game master's free-text instruction: the character level they want this entity built at.",
  'Answer with a JSON object only: {"level": <integer 1-20 or null>, "quote": <string or null>}.',
  '"level" is the level the instruction ASKS this entity to be, as an absolute number between 1 and 20. Answer null when the instruction asks for no level at all — a purely descriptive, cosmetic or narrative request, a question, or a request about something other than a level.',
  "The instruction is the game master's own words in ANY language. Read its MEANING; never require a particular word, word order, or adjacency between a word and a number.",
  'A level may be given as a bare number ("bump it to 3"), as a level word with a number in any language ("Stufe 3", "level 3"), or RELATIVE to the current level (example: "two levels higher", "zwei Stufen höher", "one level down"). Resolve a relative request against the CURRENT LEVEL below and answer the resulting ABSOLUTE number.',
  'When the instruction names TWO levels, answer the level the entity is being MOVED TO ("from level 1 to level 3" is 3), never the level it is leaving.',
  'When a relative request is made and no current level is given, answer null. Never invent a level the instruction does not ask for.',
  '"quote" is the shortest verbatim span of the instruction that states the level, or null when "level" is null.',
].join('\n');

export interface InstructionLevelRead {
  /** The absolute level the instruction asks for, or null when it asks for none. */
  readonly level: number | null;
  /** The verbatim span the level was read from, or null when there is none. */
  readonly quote: string | null;
}

/** Everything the ONE reading needs: the owner's words, the entity they are
 * about, the level that entity already has (for a relative request), and the
 * transport target. */
export interface ReadInstructionLevelInput {
  /** The owner's own instruction (never empty — the caller guards that). */
  readonly instruction: string;
  /** The entity's name, so the model reads the sentence WITH its subject. */
  readonly entityName: string;
  /** The entity's current level, or null when none is recorded. */
  readonly currentLevel: number | null;
  /** The model that serves this read (the run's own funnel model). */
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly signal: AbortSignal;
}

/**
 * The ONE consequence sentence every failure here carries: it names what the
 * chain would have done had the failure been swallowed — the owner's exact
 * partial success. Kept in one place so a transport failure and a contract
 * failure read the same to the owner.
 */
const FAILURE_CONSEQUENCE =
  'Nothing was written: the stat block would otherwise have been bound to this entity\'s existing ' +
  'level while your instruction asked for another. Rephrase the level, or change it by hand.';

/**
 * Reads the level an explicit instruction fixes, through ONE structured model
 * call. Throws on an empty instruction, on a transport failure, and on a reply
 * that does not satisfy `instructionLevelReplySchema` — a failed read is LOUD,
 * never "no level" (AGENTS rule 1: a silent fallback here is the owner's exact
 * bug). A successful read returns `{ level: null, quote: null }` when the
 * instruction genuinely asks for nothing — the honest answer, not an error.
 *
 * TWO FAILURES ARE DELIBERATELY NOT REBRANDED, because the run's own machinery
 * reads their TYPE and a wrapped copy would lose it: an `AbortError` is a CANCEL
 * the owner asked for (`failureKindOf` → `'cancelled'`), and a
 * `MissingApiKeyError` gets the app's own "No API key — add one in Settings"
 * surface (`runEngine.fail`). Both are still loud; neither is silent.
 */
export async function readInstructionLevel(
  input: ReadInstructionLevelInput,
): Promise<InstructionLevelRead> {
  const instruction = input.instruction.trim();
  if (instruction === '') {
    throw new Error('the instruction-level read was called with no instruction');
  }
  let text: string;
  try {
    const result = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            entity: input.entityName,
            currentLevel: input.currentLevel,
            instruction,
          }),
        },
      ],
      {
        model: input.model,
        // Nothing here is creative: the same words must read the same way twice.
        temperature: 0,
        reasoningEffort: input.reasoningEffort,
        responseFormat: schemaResponseFormat('instruction-level', instructionLevelReplySchema),
        signal: input.signal,
      },
    );
    text = result.text;
  } catch (error) {
    if (error instanceof MissingApiKeyError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(
      `Your instruction's level could not be read by the model (${errorMessage(error)}). ` +
        FAILURE_CONSEQUENCE,
      { cause: error },
    );
  }
  try {
    return instructionLevelReplySchema.parse(parseJsonReply(text));
  } catch (error) {
    // LOUD by name, and it names the CONSEQUENCE too: the chain would
    // otherwise bind the block to the entity's existing level while the
    // instruction asked for another — the owner's partial success. The caller
    // does not catch this: the run fails with this sentence (rule 1/2/3).
    throw new Error(
      `Your instruction's level could not be read by the model (${parseErrorSummary(error)}). ` +
        FAILURE_CONSEQUENCE,
      { cause: error },
    );
  }
}
