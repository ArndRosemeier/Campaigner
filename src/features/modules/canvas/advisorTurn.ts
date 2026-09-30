import { getModule } from '@/db/moduleRepo';
import { advisorLens, type AdvisorCard, type AdvisorScope } from '@/domain/advisors';
import { resolveAdvisorTarget, type AdvisorScopeSource } from '@/features/modules/canvas/advisorScope';
import { moduleDocumentFromView } from '@/domain/moduleDocument';
import { readSettings } from '@/db/settingsRepo';
import { askAdvisor, type AdvisorHistoryEntry } from '@/llm/advisors';
import { scheduleChatPersist } from '@/features/modules/canvas/chatPersist';
import { newChatId, useCanvasChatStore } from '@/features/modules/canvas/chatStore';
import { toastError } from '@/lib/toast';

/**
 * The advisor turn (docs/17 rows 396/400): the owner's explicit click asks the ticked
 * advisors; each answer lands as its own ADVISOR CARD in the module thread
 * (`CanvasChatMessage.advisor`), persisted with it. Nothing here touches the
 * document or the writer's send path; APPROVE is `advisorApprovalText` handed to
 * the ONE existing send (the sidebar's `send`), so the main model alone decides
 * changes through its normal commands.
 */

export interface AskAdvisorsInput {
  moduleId: string;
  /** The module chat's store key. */
  key: string;
  /** The ticked advisors in TICK order, each with the scope it was asked at. */
  asks: readonly { lensId: string; scope: AdvisorScope }[];
  /** Caret / selection at the click; scopes resolve against it (unavailable = throws, nothing dispatched). */
  scopeSource: AdvisorScopeSource | null;
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
  const custom = (await readSettings()).customAdvisors;
  // Resolve EVERY target before the first call: an unavailable scope throws and
  // nothing is dispatched (never a silent widening).
  const planTitles = module.spine?.partPlan ?? [];
  const source = input.scopeSource ?? { doc: full, caret: null, selection: null };
  const resolved = input.asks.map(({ lensId, scope }) => ({
    lensId,
    target: resolveAdvisorTarget(scope, source, planTitles),
  }));
  const history = proseHistory(input.key);
  // Cards are added in TICK order, not completion order: the replies are
  // gathered concurrently and committed in one ordered pass (row 400).
  const settled = await Promise.all(
    resolved.map(async ({ lensId, target }) => {
      const lens = advisorLens(lensId, custom);
      const lensName = lens?.name ?? lensId;
      const base = { lensId, lensName, range: null, scope: target, state: 'pending' as const };
      try {
        if (lens === undefined) throw new Error(`unknown advisor "${lensId}"`);
        const reply = await askAdvisor({
          lens,
          target,
          document: full,
          history,
          model: input.model ?? undefined,
          signal: input.signal,
        });
        return {
          id: newChatId('msg'),
          role: 'assistant' as const,
          text: reply.text,
          raw: null,
          status: 'ok' as const,
          error: null,
          outcomes: [],
          createdAt: Date.now(),
          advisor: { ...base, model: reply.modelUsed },
        };
      } catch (error) {
        if (input.signal?.aborted === true) return null;
        toastError(`The ${lensName} advisor failed`, error);
        return {
          id: newChatId('msg'),
          role: 'assistant' as const,
          text: '',
          raw: null,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
          outcomes: [],
          createdAt: Date.now(),
          advisor: { ...base, model: input.model ?? '' },
        };
      }
    }),
  );
  const store = useCanvasChatStore.getState();
  for (const message of settled) if (message !== null) store.addMessage(input.key, message);
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
