import type { IdeaBoard } from '@/domain/ideaBoard';
import { ideaBoardReplySchema } from '@/domain/ideaBoard';
import { getSettings } from '@/db/settingsRepo';
import { chat } from '@/llm/openrouter';
import { recordGlobalChatModelInUse } from '@/llm/recentChatModel';
import { parseJsonReply } from '@/llm/jsonReply';
import { schemaResponseFormat } from '@/llm/strictSchema';
import { generatedTextScanForFields } from '@/llm/generatedTextHygiene';

/**
 * The Idea Board refinement contract (`docs/21-IDEA-BOARD.md`): ONE chat call
 * that answers the owner's instruction and, when the instruction asks for a
 * rewrite, returns the COMPLETE replacement document.
 *
 * Why this is NOT the module canvas chat (`llm/canvasChat`): that protocol is
 * module-shaped end to end — it splits a parts document, grounds on campaign
 * and prior-module text, and replies with `<edit>`/`<request>`/`<change>`
 * commands that mutate artifacts through `changeArtifact`. A board document
 * has no parts, no campaign and no entities to resolve, so reusing it would
 * import semantics the board must not have. What IS shared is everything
 * below the contract: the transport (`openrouter.chat` — API key, escalation
 * chain, strict structured outputs, language directive, retries, abort), the
 * reply parser (`jsonReply`), the settings seam and the hygiene scan.
 *
 * Contract rules (binding — AGENTS 1/3):
 * - the reply is ZOD-validated at this boundary; a shape failure THROWS and
 *   nothing is applied (the owner sees a loud failed card, never a partial
 *   document);
 * - an edit that comes back EMPTY is refused by name rather than becoming a
 *   silently blank board (`document: null` is the contract's "no edit");
 * - the model-authored text runs the shared hygiene scan before it can be
 *   accepted, so escape debris or our own prompt scaffolding echoed back is a
 *   loud refusal, never persisted text (`docs/17` row 142);
 * - `modelUsed` is returned from the call that actually served this turn, so
 *   the board records the model that wrote it even after an escalation.
 */

/** The reply plus the provenance of the call that produced it. */
export interface IdeaBoardRefinement {
  /** The conversational answer (always present). */
  reply: string;
  /** The complete replacement text, or null when this turn only discussed. */
  document: string | null;
  /** The model that answered (the escalation winner, not the requested one). */
  modelUsed: string;
}

const SYSTEM_PROMPT = [
  'You help the user write on a general-purpose plain-text idea board.',
  'The document is ordinary text: it has NO wiki-links, NO campaign or module context, and no special markup semantics.',
  'Never introduce [[wiki-link]] tokens or app-specific markup.',
  'Answer the user\'s message in "reply".',
  'When the message asks you to write, rewrite or restructure the document, return the COMPLETE resulting text in "document" — never a fragment, a diff or a description of the change.',
  'When the message is a question, a discussion or an idea that should not replace the text, return "document": null.',
  'Preserve existing content unless the user asks you to change it, and answer in the user\'s language.',
].join(' ');

/**
 * Runs one refinement turn. Throws loudly on an empty instruction, a contract
 * failure (JSON/zod), an empty replacement and hygiene debris. A user abort
 * throws `AbortError` — callers decide "stopped, not failed" from
 * `signal.aborted`, never from the error type.
 */
export async function refineIdeaBoard(
  board: IdeaBoard,
  instruction: string,
  signal: AbortSignal,
): Promise<IdeaBoardRefinement> {
  const text = instruction.trim();
  if (text === '') throw new Error('Enter a message first.');
  const settings = await getSettings();
  const boardModel = board.model.trim();
  // Only an UNSET board model rides the GLOBAL first-try setting; a per-board
  // `board.model` is a different tier (docs/17 row 199), so recording it would
  // put a board-local pick in the global recents list (docs/17 row 198).
  if (boardModel === '') recordGlobalChatModelInUse(settings.defaultChatModel);
  const result = await chat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      ...board.messages.map((message) => ({ role: message.role, content: message.text })),
      {
        role: 'user',
        content: JSON.stringify({ document: board.document, instruction: text }),
      },
    ],
    {
      model: board.model.trim() === '' ? settings.defaultChatModel : board.model,
      temperature: 0.5,
      reasoningEffort: settings.defaultReasoningEffort,
      responseFormat: schemaResponseFormat('idea-board', ideaBoardReplySchema),
      signal,
    },
  );
  const reply = ideaBoardReplySchema.parse(parseJsonReply(result.text));
  const document = reply.document;
  if (document !== null && document.trim() === '') {
    // `min(1)` in the schema cannot see whitespace, and the strict decoder
    // strips minLength — so the whitespace-only case is refused HERE, by
    // name, rather than blanking the board.
    throw new Error('The model returned an empty document — nothing was changed.');
  }
  const scan = generatedTextScanForFields([
    { field: 'reply', text: reply.reply },
    ...(document === null ? [] : [{ field: 'document', text: document }]),
  ]);
  if (scan.issues.length > 0) {
    throw new Error(`The reply was refused: ${scan.issues.join('; ')}`);
  }
  return { reply: reply.reply, document, modelUsed: result.modelUsed };
}
