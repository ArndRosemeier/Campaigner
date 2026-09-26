import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GM_ASSIST_FRAMING,
  buildCanvasChatFollowUpPayload,
  buildCanvasChatPayload,
  canvasChatSystemPrompt,
  canvasChatThreadPersists,
  type CanvasChatFraming,
} from '@/llm/canvasChat';
import {
  canvasChatKey,
  canvasChatKeyFor,
  gmAssistKey,
} from '@/features/modules/canvas/chatStore';

/**
 * The canvas chat's FRAMING seam (docs/17 row 362): ONE system prompt,
 * parameterised by the surface, with the module chat byte-identical.
 *
 * THE LOAD-BEARING PIN IS THE GOLDEN:
 * `tests/fixtures/gmAssistFraming/module-chat-golden.json` was captured from
 * the tree BEFORE the framing parameter landed, by rendering the REAL
 * `canvasChatSystemPrompt()` and BOTH payload builders over fixed inputs. The
 * default (and an explicit `'module'`) must reproduce it character for
 * character — that is what makes parameterising the prompt safe for the chat
 * the owner already uses.
 *
 * The rest holds the GM framing to its INTENT, in the owner's own words: the
 * story side of mastering (never encounters/battlemaps/tokens/initiative/stat
 * blocks), the GM's report IS the live state of the story, and the DEFAULT
 * ANSWER is 2-4 concrete ideas for what happens next — while the command
 * protocol below the framing stays the SAME shared text, because GM assist
 * keeps the module chat's edit capabilities.
 */

/** The input table the golden was captured with (bytes must not move). */
const DOCUMENT =
  '[Part 1 of 2 — The Gate Bargain]\nThe party bargains with [[Keeper Ilse]].\n\n==========\n[Part 2 of 2 — Under the Docks]\nRain hammers the stones.\n';
const GROUNDING = 'Campaign: Ember\n\nGame system: D&D 5e';
const INSTRUCTION = 'make it rain';
const HISTORY = [
  { role: 'user' as const, text: 'first instruction\n<document>\nSTALE SNAPSHOT\n</document>' },
  {
    role: 'assistant' as const,
    text: 'First reply <edit all="false"><search>a</search><replace>b</replace></edit>',
  },
];

interface Golden {
  system: string;
  payload: { role: string; content: unknown }[];
  followUp: { role: string; content: unknown }[];
}

function golden(): Golden {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'gmAssistFraming', 'module-chat-golden.json'),
      'utf8',
    ),
  ) as Golden;
}

/** The module framing's own opening paragraph (the pre-362 first line). */
const MODULE_FRAMING = golden().system.slice(0, golden().system.indexOf('\n'));

describe('the module chat is BYTE-IDENTICAL (framing golden, docs/17 row 362)', () => {
  it('the default system prompt is the pre-change bytes, character for character', () => {
    const before = golden();
    expect(before.system.length).toBeGreaterThan(1000);
    expect(canvasChatSystemPrompt()).toBe(before.system);
    // The explicit module framing is the SAME thing — the default is not a
    // second spelling of it.
    expect(canvasChatSystemPrompt('module')).toBe(before.system);
    expect(MODULE_FRAMING).toContain('You are the Canvas chat co-editor');
  });

  it('the full payload and the round-trip payload are unchanged', () => {
    const before = golden();
    expect(
      buildCanvasChatPayload({
        document: DOCUMENT,
        grounding: GROUNDING,
        instruction: INSTRUCTION,
        history: HISTORY,
      }),
    ).toEqual(before.payload);
    expect(
      buildCanvasChatFollowUpPayload({
        document: DOCUMENT,
        grounding: GROUNDING,
        instruction: INSTRUCTION,
        history: HISTORY,
        requestedReply: 'Asking. <request><name>Keeper Ilse</name></request>',
        details: 'Keeper Ilse: level 4, CR 2',
        changeResults: 'CHANGED: «Keeper Ilse»',
      }),
    ).toEqual(before.followUp);
    // The framing is threaded through the FOLLOW-UP builder too: the module
    // framing reproduces the golden's second call as well.
    expect(
      buildCanvasChatFollowUpPayload({
        document: DOCUMENT,
        grounding: GROUNDING,
        instruction: INSTRUCTION,
        history: HISTORY,
        requestedReply: 'Asking. <request><name>Keeper Ilse</name></request>',
        details: 'Keeper Ilse: level 4, CR 2',
        changeResults: 'CHANGED: «Keeper Ilse»',
        framing: 'module',
      }),
    ).toEqual(before.followUp);
  });
});

describe('the GM-assist framing (docs/17 row 362)', () => {
  it('states the role, the input model and the default answer', () => {
    // The ROLE: live-mastering help, the story side.
    expect(GM_ASSIST_FRAMING).toContain('you help the GM run the table during play');
    expect(GM_ASSIST_FRAMING).toContain('the STORY is your subject');
    // THE INPUT MODEL: the GM tells it what happened, and that report IS the
    // live state — never re-asked for, never invented.
    expect(GM_ASSIST_FRAMING).toContain('The GM keeps you informed as play goes on');
    expect(GM_ASSIST_FRAMING).toContain('what the party did, what they said, what they skipped');
    expect(GM_ASSIST_FRAMING).toContain('Treat every such report as the LIVE STATE of the story');
    expect(GM_ASSIST_FRAMING).toContain('never ask the GM to repeat it');
    expect(GM_ASSIST_FRAMING).toContain('never claim to know what happened unless the GM said it');
    // THE DEFAULT ANSWER, by name.
    expect(GM_ASSIST_FRAMING).toContain('YOUR DEFAULT ANSWER');
    expect(GM_ASSIST_FRAMING).toContain('2-4 concrete ideas for what happens next');
  });

  it('is the STORY side of mastering — never encounter or battle mechanics', () => {
    const lowered = GM_ASSIST_FRAMING.toLowerCase();
    for (const banned of ['encounter', 'battlemap', 'token', 'initiative', 'stat block']) {
      expect(lowered).not.toContain(banned);
    }
  });

  it('keeps the module chat\u2019s edit capabilities: the SAME shared protocol, one framing', () => {
    const gm = canvasChatSystemPrompt('gm-assist');
    expect(gm).not.toBe(canvasChatSystemPrompt());
    expect(gm).toContain(GM_ASSIST_FRAMING);
    // The command protocol below the framing is IDENTICAL — one literal, two
    // framings (never a second prompt).
    const modulePrompt = canvasChatSystemPrompt('module');
    const moduleTail = modulePrompt.slice(modulePrompt.indexOf('\n') + 1);
    const gmTail = gm.slice(GM_ASSIST_FRAMING.length + 1);
    expect(gmTail).toBe(moduleTail);
    for (const protocol of [
      '<edit all="false"><search>',
      '<request><name>',
      '<change operation="repopulate|everything">',
      '<change adversarial="premise">',
    ]) {
      expect(gm).toContain(protocol);
    }
  });
});

describe('the surface identity (docs/17 row 362)', () => {
  it('resolves the two store keys from ONE value — and they never collide', () => {
    const moduleId = 'a-module-id';
    expect(canvasChatKeyFor(moduleId, 'module')).toBe(canvasChatKey(moduleId));
    expect(canvasChatKeyFor(moduleId, 'gm-assist')).toBe(gmAssistKey(moduleId));
    expect(gmAssistKey(moduleId)).not.toBe(canvasChatKey(moduleId));
    const both: CanvasChatFraming[] = ['module', 'gm-assist'];
    expect(new Set(both.map((framing) => canvasChatKeyFor(moduleId, framing))).size).toBe(2);
  });

  it('names ONE persistence contract: only the module thread owns the row half', () => {
    expect(canvasChatThreadPersists('module')).toBe(true);
    expect(canvasChatThreadPersists('gm-assist')).toBe(false);
  });
});
