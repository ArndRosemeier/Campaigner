import { getModule } from '@/db/moduleRepo';
import { advisorLens, type AdvisorCard } from '@/domain/advisors';
import { moduleDocumentFromView, moduleDocumentSections } from '@/domain/moduleDocument';
import { askAdvisor, type AdvisorHistoryEntry } from '@/llm/advisors';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { newChatId, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import type { GenerationLevelRange } from '@/features/modules/generation-selection';
import { toastError } from '@/lib/toast';

/**
 * The advisor turn (docs/17 row 396): the owner's explicit click asks the ticked
 * lenses; each answer lands as its own ADVISOR CARD in the module thread
 * (`CanvasChatMessage.advisor`), persisted with it. Nothing here touches the
 * document or the writer's send path; APPROVE is `advisorApprovalText` handed to
 * the ONE existing send (the sidebar's `send`), so the main model alone decides
 * changes through its normal commands.
 */

export interface AskAdvisorsInput {
  moduleId: string;
  /** The module chat's store key. */
  key: string;
  lensIds: readonly string[];
  /** Optional level range (the generation dialog's own type); null = whole document. */
  range: GenerationLevelRange | null;
  /** The document as the owner sees it now (live editor text when mounted). */
  liveDocument: string | null;
  /** The advisor model pick; null = the global chat model. */
  model: string | null;
  signal?: AbortSignal | undefined;
}

function proseHistory(key: string): AdvisorHistoryEntry[] {
  return useCanvasChatStore
    .getState()
    .module(key)
    .messages.filter(
      (message) => message.advisor == null && message.status === 'ok' && message.text !== '',
    )
    .map((message) => ({ role: message.role, text: message.text }));
}

export async function askAdvisors(input: AskAdvisorsInput): Promise<void> {
  const module = await getModule(input.moduleId);
  if (module === undefined) throw new Error('Module no longer exists');
  const full = input.liveDocument ?? moduleDocumentFromView(module);
  const range = input.range;
  const document =
    range === null
      ? full
      : moduleDocumentSections(full, module.spine?.partPlan ?? [])
          .filter((s) => s.number >= range.min && s.number <= range.max)
          .map((s) => `[${s.number === 0 ? 'Premise' : `Level ${String(s.number)}: ${s.title}`}]\n${s.text}`)
          .join('\n\n');
  const history = proseHistory(input.key);
  await Promise.all(
    input.lensIds.map(async (lensId) => {
      const lensName = advisorLens(lensId)?.name ?? lensId;
      const base = { lensId, lensName, range: input.range, state: 'pending' as const };
      const store = useCanvasChatStore.getState();
      try {
        const reply = await askAdvisor({
          lensId,
          document,
          history,
          model: input.model ?? undefined,
          signal: input.signal,
        });
        store.addMessage(input.key, {
          id: newChatId('msg'),
          role: 'assistant',
          text: reply.text,
          raw: null,
          status: 'ok',
          error: null,
          outcomes: [],
          createdAt: Date.now(),
          advisor: { ...base, model: reply.modelUsed },
        });
      } catch (error) {
        if (input.signal?.aborted === true) return;
        toastError(`The ${lensName} advisor failed`, error);
        store.addMessage(input.key, {
          id: newChatId('msg'),
          role: 'assistant',
          text: '',
          raw: null,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          outcomes: [],
          createdAt: Date.now(),
          advisor: { ...base, model: input.model ?? '' },
        });
      }
    }),
  );
  scheduleChatPersist(input.moduleId, input.key);
}

/** Records the card's decision; persists with the thread. */
export function setAdvisorState(
  moduleId: string,
  key: string,
  messageId: string,
  card: AdvisorCard,
  state: AdvisorCard['state'],
): void {
  useCanvasChatStore.getState().updateMessage(key, messageId, { advisor: { ...card, state } });
  scheduleChatPersist(moduleId, key);
}
