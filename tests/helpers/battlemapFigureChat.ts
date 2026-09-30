import type { chat } from '@/llm/openrouter';

type ChatFn = typeof chat;
type ChatAnswer = Awaited<ReturnType<ChatFn>>;

/** The strict-schema name the shared vision reply contract is sent under. */
export const VISION_LOCATE_RESPONSE_FORMAT = 'vision-dungeon-locate';

/**
 * The classic stylize step's figure check (docs/11, docs/17 row 341) is a
 * `chat` call on the SAME contract the vision path's locate read uses, so
 * EVERY test that drives a classic encounter run past `schematic` must answer
 * it. These helpers are the ONE place that answer is composed — a per-file
 * copy would drift and the duplication tripwire would (rightly) red it.
 */

/** The honest empty answer to the figure check: `figures: []`. */
function emptyBattlemapAnswer(model: string): ChatAnswer {
  return { text: JSON.stringify({ marks: [], figures: [] }), modelUsed: model, fallback: null };
}

/** True for the classic figure check's chat call, by its strict-schema name. */
function isVisionLocateCall(options: Parameters<ChatFn>[1]): boolean {
  const format = options.responseFormat;
  return typeof format === 'object' && format.name === VISION_LOCATE_RESPONSE_FORMAT;
}

/**
 * Drops a blanket `chatMock.mockResolvedValue(briefReply)` in a test that
 * drives the classic encounter pipeline: the figure check is still answered
 * with the honest empty answer, while EVERY other call gets the brief reply
 * the test wanted.
 */
export function chatAnsweringClassicFigures(reply: string): ChatFn {
  return (_messages, options) =>
    Promise.resolve(
      isVisionLocateCall(options)
        ? emptyBattlemapAnswer(options.model)
        : { text: reply, modelUsed: 'test-model', fallback: null },
    );
}

/**
 * Installs the figure check's answer as the DEFAULT implementation, so tests
 * that queue `mockResolvedValueOnce` replies keep consuming those first and
 * only calls they did not queue reach here. Any OTHER unqueued call throws
 * LOUD (AGENTS rule 1, in test form): a swallowed missing mock would hide a
 * broken test instead of failing it.
 */
export function answerClassicBattlemapFigureChecks(chatMock: {
  mockImplementation: (implementation: ChatFn) => unknown;
}): void {
  chatMock.mockImplementation((_messages, options) => {
    if (!isVisionLocateCall(options)) {
      const format = options.responseFormat;
      const name = typeof format === 'object' ? format.name : String(format);
      throw new Error(`unexpected chat call in this test (contract ${name}) — queue a mockResolvedValueOnce for it`);
    }
    return Promise.resolve(emptyBattlemapAnswer(options.model));
  });
}
