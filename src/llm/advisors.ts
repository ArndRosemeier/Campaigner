import { getSettings } from '@/db/settingsRepo';
import { advisorScopeLines, type AdvisorLens, type AdvisorScopeTarget } from '@/domain/advisors';
import { chat, type ChatMessage } from '@/llm/openrouter';
import { recordGlobalChatModelInUse } from '@/llm/recentChatModel';

/**
 * ONE ADVISOR CALL (docs/17 rows 396/400). A separate model call with its OWN
 * context — never the writer's thread: the document (whole, or the caller's
 * already-selected level range), the recent chat PROSE for intent, and the
 * lens prompt from the ONE lens list (`domain/advisors.ADVISOR_LENSES`).
 *
 * The advisor is NEVER told the chat's command vocabulary and can never write:
 * this seam returns plain critique text and has no path to the document. The
 * reply is free text and passes through UNTOUCHED — no regex, no command parse
 * (AGENTS rule 5). An empty reply is a loud error, never an empty critique
 * (rule 1). The model is the caller's session pick, else the global chat model
 * (recorded as in use only in the latter case, like canvasChat).
 */

/** How much recent chat the advisor sees for INTENT (prose only). */
export const ADVISOR_HISTORY_TURNS = 12;

export interface AdvisorHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface AdvisorCallInput {
  lens: AdvisorLens;
  /** What to concentrate on. CONTEXT is always the whole document (row 400). */
  target: AdvisorScopeTarget;
  /** The WHOLE document text, for every scope. */
  document: string;
  /** Recent chat prose, oldest first (assistant PROSE, never raw replies). */
  history: readonly AdvisorHistoryEntry[];
  /** Session model pick; undefined/'' = the global chat model. */
  model?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface AdvisorReply {
  lens: AdvisorLens;
  text: string;
  modelUsed: string;
}

const ADVISOR_SYSTEM =
  'You are an advisor reviewing a tabletop RPG campaign document for its author. You only advise: point out what is not good or could be better, or offer ideas when your task asks for them, concretely and with reference to the places you mean. You always see the whole document; your task may ask you to concentrate on a part of it. You do not rewrite the text and you do not produce finished replacement text. Answer in plain prose, at most a few short paragraphs or a short list.';

/** The outgoing messages — exported so the pin asserts on exactly what is sent. */
export function buildAdvisorMessages(
  lens: AdvisorLens,
  document: string,
  target: AdvisorScopeTarget,
  history: readonly AdvisorHistoryEntry[],
): ChatMessage[] {
  const recent = history.slice(-ADVISOR_HISTORY_TURNS);
  const chatBlock =
    recent.length === 0
      ? ''
      : `\n\nRecent conversation between the author and their writing assistant (for intent only):\n${recent
          .map((entry) => `${entry.role === 'user' ? 'Author' : 'Assistant'}: ${entry.text}`)
          .join('\n')}`;
  return [
    { role: 'system', content: `${ADVISOR_SYSTEM}\n\nYour task — ${lens.name}: ${lens.instruction}` },
    {
      role: 'user',
      content: `The document under review:\n\n${document}${chatBlock}\n\n${advisorScopeLines(target).join('\n')}\n\nGive your answer for your task.`,
    },
  ];
}

export async function askAdvisor(input: AdvisorCallInput): Promise<AdvisorReply> {
  const { lens } = input;
  const settings = await getSettings();
  const explicit = input.model !== undefined && input.model !== '';
  const model = explicit ? input.model : settings.defaultChatModel;
  if (!explicit) recordGlobalChatModelInUse(settings.defaultChatModel);
  const { text, modelUsed } = await chat(buildAdvisorMessages(lens, input.document, input.target, input.history), {
    model: model ?? settings.defaultChatModel,
    temperature: 0.7,
    reasoningEffort: settings.defaultReasoningEffort,
    signal: input.signal,
  });
  if (text.trim() === '') {
    throw new Error(`the ${lens.name} advisor returned an empty reply`);
  }
  return { lens, text, modelUsed };
}
