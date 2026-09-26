import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

/**
 * ONE canvas chat system prompt, parameterised by the surface (docs/17 row
 * 362; AGENTS §Centralization obligation 2).
 *
 * The defect this pin exists for is a SECOND PIPELINE born quietly: the cheap
 * way to add "GM assist" is a `gmAssistSystemPrompt()` beside the module one,
 * or a second payload builder that assembles its own system message — and both
 * READ correctly on the day they are written. This project has already rejected
 * a second turn controller, a second applier, a second thread store and a
 * second busy registry (docs/18 §2), so the framing must be a PARAMETER of the
 * one builder: exactly two framings, one registry, one builder, one call site,
 * one protocol literal — and every chat turn still goes through the one engine.
 *
 * A GUARD, not a proof: a third prompt written with entirely different words
 * would slip past the role-sentence count, which is why the behavioural pins
 * (`tests/llm/gmAssistFraming.test.ts`, `tests/features/gm-assist-chat.test.tsx`)
 * hold the other half.
 */

const LLM = 'src/llm/canvasChat.ts';
const TURN = 'src/features/modules/canvas/chatTurn.ts';
const CLEAR = 'src/features/modules/canvas/clearChat.ts';
const STORE = 'src/features/modules/canvas/chatStore.ts';
const SIDEBAR = 'src/features/modules/canvas/ChatSidebar.tsx';
const PAGE = 'src/features/modules/canvas/CanvasPage.tsx';

describe('ONE canvas chat system prompt, parameterised by framing (SOURCE SCAN, docs/17 row 362)', () => {
  it('declares exactly TWO framings over ONE builder, asked from ONE place', () => {
    // Non-vacuity: the glob sees the whole source tree.
    expect(Object.keys(CODE).length).toBeGreaterThan(300);
    // The two framings live in ONE file, and the module one is the default.
    expect(filesWith('export const GM_ASSIST_FRAMING')).toEqual([LLM]);
    expect(filesWith('const MODULE_CHAT_FRAMING')).toEqual([LLM]);
    expect(filesWith('const CHAT_FRAMINGS: Record<CanvasChatFraming, string>')).toEqual([LLM]);
    // Exactly ONE builder of the system message...
    expect(filesWith('function canvasChatSystemPrompt(')).toEqual([LLM]);
    // ...asked from exactly ONE place: the payload builder every canvas chat
    // turn goes through (its own declaration is the second match).
    expect(filesWith('canvasChatSystemPrompt(')).toEqual([LLM]);
    expect(CODE[LLM]?.match(/canvasChatSystemPrompt\(/g)?.length).toBe(2);
    // The registry is keyed by the ONE surface union — a third key cannot be
    // added without the union growing, and the union's own two spellings are
    // what the whole surface identity is built on.
    expect(CODE[LLM]?.match(/'gm-assist':/g)?.length).toBe(1);
    expect(CODE[LLM]?.includes("export type CanvasChatFraming = 'module' | 'gm-assist'")).toBe(true);
  });

  it('has ONE role sentence per framing and NO third prompt literal anywhere in src/', () => {
    // A second prompt literal is the defect: every canvas chat role sentence in
    // the source is one of the two framings, and both live in the ONE file.
    expect(filesWith('You are the Canvas chat')).toEqual([LLM]);
    expect(CODE[LLM]?.match(/You are the Canvas chat/g)?.length).toBe(2);
  });

  it('threads the framing through the ONE engine and onto BOTH of its calls', () => {
    // The engine has exactly ONE caller file (the turn controller), so a
    // second chat pipeline would red here.
    expect(filesWith('sendCanvasChatMessage(')).toEqual([TURN, LLM]);
    // The prompt builder reads the passed framing, and the framing reaches
    // every payload built for the turn: the engine's FIRST call, the round
    // trip's FOLLOW-UP call, and the follow-up builder's delegation into the
    // ONE shared payload builder (three sites, one value).
    expect(CODE[LLM]?.includes('canvasChatSystemPrompt(input.framing)')).toBe(true);
    expect(CODE[LLM]?.match(/framing: input\.framing/g)?.length).toBe(3);
    // The one controller passes the surface's framing down to the engine.
    expect(CODE[TURN]?.includes('framing: options.framing')).toBe(true);
    // The DEFAULT is declared in exactly TWO places and both are the document
    // wrappers that predate GM assist (the brief's contract: an omitted framing
    // is today's module chat, byte-identical); the prompt builder's own default
    // is the third and it is the same value.
    expect(CODE[LLM]?.includes("canvasChatSystemPrompt(framing: CanvasChatFraming = 'module')")).toBe(true);
    expect(filesWith("options.framing ?? 'module'")).toEqual([
      'src/features/modules/canvas/chatController.ts',
      'src/features/modules/canvas/snapshotChat.ts',
    ]);
  });

  it('names the persistence contract ONCE and asks it from both gates', () => {
    // `canvasChatThreadPersists` is the ONE rule for "this surface owns the
    // module row's chatThread half"; the turn's persist gate and the clear
    // seam both ask it instead of re-spelling `framing === 'module'`.
    expect(filesWith('canvasChatThreadPersists(')).toEqual([TURN, CLEAR, LLM]);
    expect(CODE[TURN]?.includes('canvasChatThreadPersists(options.framing)')).toBe(true);
    expect(CODE[CLEAR]?.includes('canvasChatThreadPersists(input.framing)')).toBe(true);
  });

  it('resolves the store key from the surface in ONE place, read by both the panel and the page', () => {
    // `gmAssistKey` is declared ONCE; the resolver is the only caller-facing
    // way to turn "which chat" into "which store key".
    expect(filesWith('gmAssistKey(')).toEqual([STORE]);
    expect(filesWith('canvasChatKeyFor(')).toEqual([PAGE, SIDEBAR, STORE]);
  });
});
