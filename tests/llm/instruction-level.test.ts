import { afterEach, describe, expect, it, vi } from 'vitest';

import { instructionLevelReplySchema, readInstructionLevel } from '@/llm/instructionLevel';
import { chat } from '@/llm/openrouter';

/**
 * THE OWNER'S INSTRUCTION IS READ BY THE MODEL, NOT BY A PATTERN (docs/17 row
 * 289, AGENTS.md engineering rule 5).
 *
 * THE MEASURED DEFECT. The level an explicit instruction fixes is the TOP of
 * the stat-block precedence chain and it BINDS the reply (docs/17 rows
 * 197/247). It used to be read by a regex (`roomBudget.instructionLevel` =
 * `firstLevelInText`: a level word, then whitespace, then 1–2 digits, FIRST
 * match wins). The owner's own instruction — *"…images are preserved, but level
 * needs to be bumped to 3."* — resolved NOTHING through it, so the chain fell
 * to the entity's MINTED block, the stat block was bound to the OLD level, and
 * the prose model (which reads the sentence itself) wrote the level he asked
 * for. The same grammar read the OLD level out of *"uplift this mob from level
 * 1 to level 3"*. The rule the owner made general: free text is read by the
 * MODEL, never by a pattern.
 *
 * WHAT THIS FILE PINS, at the ONE seam (`llm/instructionLevel`): his sentence
 * resolves the number he meant; a RELATIVE request is read against the current
 * level the caller supplies; `null` is the honest answer for an instruction
 * that asks for nothing; EVERY failure is loud (never a silent "no level"), and
 * a reply outside the app's 1..20 domain is refused rather than clamped. The
 * end-to-end half — that the number BINDS the stat block and is NAMED on the
 * run step — lives in `tests/llm/runEngine.test.ts`; the source pin that the
 * regex authority is GONE lives in
 * `tests/architecture/one-level-resolution.test.ts`.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
}));

const chatMock = vi.mocked(chat);

/** The owner's own words from the report — the sentence the regex read as NOTHING. */
const OWNER_INSTRUCTION =
  'Keep the description and the images as they are — images are preserved, but level needs to be bumped to 3.';

/** Resolve the next `chat` call with a raw reply body. */
function replyWith(text: string): void {
  chatMock.mockResolvedValueOnce({ text, modelUsed: 'test-model', fallback: null });
}

/** Answer the next read with a contract-shaped reply. */
function answer(level: number | null, quote: string | null): void {
  replyWith(JSON.stringify({ level, quote }));
}

/** Read one instruction through the seam, with the entity's current level. */
function read(instruction: string, currentLevel: number | null = 1) {
  return readInstructionLevel({
    instruction,
    entityName: 'Vorarbeiter Jost Keil',
    currentLevel,
    model: 'test-model',
    signal: new AbortController().signal,
  });
}

/**
 * The MODEL-FACING user turn of one `chat` call — the prompt the model actually
 * received. It is LOUD when there is no such call (unlike a silent `''`), which
 * is what these pins want: a missing call is a failed setup, not an empty prompt.
 */
function promptOf(callIndex: number): string {
  const call = chatMock.mock.calls[callIndex];
  if (call === undefined) throw new Error(`no chat call at index ${String(callIndex)}`);
  const content = call[0].at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

afterEach(() => {
  chatMock.mockReset();
});

describe('the instruction level is read by the MODEL (docs/17 row 289)', () => {
  it('resolves the number the owner MEANT out of his own sentence — the exact regression', async () => {
    answer(3, 'level needs to be bumped to 3');
    const read0 = await read(OWNER_INSTRUCTION);
    expect(read0.level).toBe(3);
    expect(read0.quote).toBe('level needs to be bumped to 3');
    // THE FREE TEXT REACHED THE MODEL VERBATIM, as data: the reading is the
    // model's, so the words must arrive unchanged and in full.
    const content = promptOf(0);
    expect(content).toContain(OWNER_INSTRUCTION);
    expect(content).toContain('Vorarbeiter Jost Keil');
    // The contract is the app's own, named and structured — never a prose answer.
    expect(chatMock.mock.calls[0]?.[1].responseFormat).toMatchObject({
      kind: 'schema',
      name: 'instruction-level',
    });
    // A reading is not a creative act: the same words must read the same way twice.
    expect(chatMock.mock.calls[0]?.[1].temperature).toBe(0);
  });

  it('hands the model the CURRENT level, so a RELATIVE request resolves (docs/17 row 289)', async () => {
    answer(5, 'two levels higher');
    const read0 = await read('bump it up two levels please', 3);
    expect(read0.level).toBe(5);
    // The current level rides the SAME structured payload as the instruction —
    // without it "zwei Stufen höher" is unreadable, and the model would have to
    // guess the base it is relative to.
    expect(promptOf(0)).toContain('"currentLevel":3');
    // A relative request with NO current level is answered honestly elsewhere in
    // the contract; the caller may legitimately have none (a CREATE run).
    answer(null, null);
    expect((await read('make it two levels higher', null)).level).toBeNull();
    expect(promptOf(1)).toContain('"currentLevel":null');
  });

  it('takes `null` as the honest answer for an instruction that asks for no level', async () => {
    answer(null, null);
    const read0 = await read('make the portrait darker and rewrite the summary');
    expect(read0).toEqual({ level: null, quote: null });
    // The call still HAPPENED: the model is the authority, so "no level" is its
    // answer and never a pattern's silence.
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty instruction before spending a call, and keeps the domain 1..20', async () => {
    await expect(read('   ')).rejects.toThrow(/no instruction/);
    expect(chatMock).not.toHaveBeenCalled();
    expect(instructionLevelReplySchema.parse({ level: 1, quote: null })).toEqual({
      level: 1,
      quote: null,
    });
    expect(instructionLevelReplySchema.parse({ level: 20, quote: 'x' })).toEqual({
      level: 20,
      quote: 'x',
    });
    // A level the app's own domain cannot hold is a REFUSAL, never a clamp, and
    // a fractional level is not a level.
    expect(() => instructionLevelReplySchema.parse({ level: 0, quote: null })).toThrow();
    expect(() => instructionLevelReplySchema.parse({ level: 21, quote: null })).toThrow();
    expect(() => instructionLevelReplySchema.parse({ level: 3.5, quote: null })).toThrow();
  });

  it('fails LOUDLY on a reply outside the domain or off the contract — never a silent "no level"', async () => {
    answer(25, 'level 25');
    await expect(read('bump it to level 25')).rejects.toThrow(
      /could not be read by the model[\s\S]*Nothing was written/,
    );
    replyWith(JSON.stringify({ level: 3 }));
    await expect(read('make it level 3')).rejects.toThrow(/could not be read by the model/);
    replyWith('that is not JSON at all');
    await expect(read('make it level 3')).rejects.toThrow(/could not be read by the model/);
  });

  it('names a transport failure, while a CANCEL and a missing key keep their own machinery', async () => {
    chatMock.mockRejectedValueOnce(new Error('provider exploded'));
    await expect(read('make it level 3')).rejects.toThrow(/provider exploded/);
    // An aborted read is the owner's own STOP: the run records 'cancelled' from
    // the DOMException, so the read must NOT rebrand it as a failure.
    chatMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(read('make it level 3')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
