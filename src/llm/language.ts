import { generationLanguageLabel } from '@/domain/settings';

/**
 * Generation-language enforcement: every LLM prompt sent through the
 * OpenRouter client carries a system-level directive requiring all generated
 * content in the language chosen in settings (default English). Injected at
 * the single `chat()` choke point so run engine, module generator, image
 * prompt drafting, and rule Q&A are all covered.
 */

/** Structural shape of a chat message (mirrors openrouter's ChatMessage). */
export interface DirectiveMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
}

/** The system-level instruction enforcing the generation language. */
export function languageDirective(language: string): string {
  const label = generationLanguageLabel(language);
  return [
    'Language requirement: Write ALL generated content (prose, descriptions,',
    `names, notes, and every free-text field) in ${label}. This overrides any`,
    'conflicting language hints elsewhere in this conversation.',
  ].join(' ');
}

/**
 * Returns the messages with the language directive attached: appended to the
 * LAST existing system message when one is present (keeping the persona's
 * system prompt first-class), otherwise as a leading system message.
 */
export function applyLanguageDirective<M extends DirectiveMessage>(
  messages: readonly M[],
  language: string,
): M[] {
  const directive = languageDirective(language);
  let lastSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'system') {
      lastSystemIndex = i;
      break;
    }
  }
  if (lastSystemIndex === -1) {
    return [{ role: 'system', content: directive } as M, ...messages];
  }
  return messages.map((message, i) => {
    if (i !== lastSystemIndex) return message;
    const content =
      typeof message.content === 'string'
        ? `${message.content}\n\n${directive}`
        : [...message.content, { type: 'text' as const, text: directive }];
    return { ...message, content };
  });
}
