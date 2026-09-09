import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CanvasChatParseError,
  MAX_COMMANDS_PER_REPLY,
  MAX_CONTEXT_MESSAGES,
  buildCanvasChatPayload,
  canvasEditCommandSchema,
  chatProseSoFar,
  composeFailureReport,
  parseCanvasChatReply,
  resolveCanvasEdit,
  sendCanvasChatMessage,
  type CanvasChatTurnInput,
} from '@/llm/canvasChat';
import { ModuleBusyError } from '@/llm/moduleGen';
import { refineModuleText } from '@/llm/canvasRefine';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { saveModule, patchModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Canvas CHAT contract (08-MODULE-DESIGNER §Module canvas chat): the XML
 * command protocol is parsed by a STRICT extractor (malformed/unbalanced/
 * over-cap replies fail loud, never partially), commands are zod-validated,
 * the tolerant match ladder resolves search text against the CURRENT doc
 * (exact → case → whitespace-collapse; zero matches report the closest
 * candidate), and every payload pins the CURRENT document + the doc-is-
 * current note with the conversation tail capped. The transport is mocked —
 * extractor, ladder and boundary logic run for real.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

const DOC = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the gate.\n\nRain hammers the stones.';

async function seedModule(): Promise<void> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'The premise.',
      themes: [],
      partPlan: [{ title: 'The Gate Bargain', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: DOC,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seedModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCanvasChatReply (strict extractor)', () => {
  it('parses one command plus prose', () => {
    const raw = [
      'Let me make that scene rainier.',
      '<edit all="false"><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>',
    ].join('\n');
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.prose).toBe('Let me make that scene rainier.');
    expect(parsed.commands).toEqual([
      { search: 'Rain hammers the stones.', replace: 'Rain drowns every word.', all: false },
    ]);
  });

  it('parses multiple commands and defaults all to false on a bare <edit>', () => {
    const raw = [
      '<edit><search>gate</search><replace>portal</replace></edit>',
      'And the second spot:',
      '<edit all="true"><search>Rain</search><replace>Mist</replace></edit>',
    ].join('\n');
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands[0]).toEqual({ search: 'gate', replace: 'portal', all: false });
    expect(parsed.commands[1]).toEqual({ search: 'Rain', replace: 'Mist', all: true });
  });

  it('keeps search/replace bodies verbatim (newlines, pipes, brackets)', () => {
    const raw =
      '<edit><search>line one\nline **two** | [[Gate]]</search><replace>one\n\ntwo</replace></edit>';
    const parsed = parseCanvasChatReply(raw);
    expect(parsed.commands[0]?.search).toBe('line one\nline **two** | [[Gate]]');
    expect(parsed.commands[0]?.replace).toBe('one\n\ntwo');
  });

  it('a reply with zero commands parses to prose only', () => {
    const parsed = parseCanvasChatReply('Just an answer, no edits needed.');
    expect(parsed.prose).toBe('Just an answer, no edits needed.');
    expect(parsed.commands).toEqual([]);
  });

  it('fails loud on a stray closing tag', () => {
    expect(() => parseCanvasChatReply('oops </edit> here')).toThrow(CanvasChatParseError);
  });

  it('fails loud on an unterminated block (missing </edit>)', () => {
    expect(() =>
      parseCanvasChatReply('<edit><search>a</search><replace>b</replace>'),
    ).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<edit><search>a')).toThrow(CanvasChatParseError);
  });

  it('fails loud on a missing > in the open tag and on self-closing edits', () => {
    expect(() => parseCanvasChatReply('<edit all="false"><search>a')).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply('<edit/>')).toThrow(CanvasChatParseError);
  });

  it('fails loud on unexpected content between the children', () => {
    expect(() =>
      parseCanvasChatReply('<edit>junk<search>a</search><replace>b</replace></edit>'),
    ).toThrow(CanvasChatParseError);
  });

  it('fails loud on unknown attributes and invalid all values', () => {
    expect(() => parseCanvasChatReply('<edit mode="x"><search>a</search><replace>b</replace></edit>')).toThrow(
      CanvasChatParseError,
    );
    expect(() => parseCanvasChatReply('<edit all="yes"><search>a</search><replace>b</replace></edit>')).toThrow(
      CanvasChatParseError,
    );
  });

  it('fails loud over the per-reply command cap', () => {
    const block = '<edit><search>x</search><replace>y</replace></edit>';
    const raw = block.repeat(MAX_COMMANDS_PER_REPLY + 1);
    expect(() => parseCanvasChatReply(raw)).toThrow(CanvasChatParseError);
    expect(() => parseCanvasChatReply(block.repeat(MAX_COMMANDS_PER_REPLY))).not.toThrow();
  });

  it('every parsed command passes the zod boundary', () => {
    expect(canvasEditCommandSchema.safeParse({ search: 'a', replace: 'b', all: false }).success).toBe(true);
    expect(canvasEditCommandSchema.safeParse({ search: 'a', replace: 42, all: false }).success).toBe(false);
  });
});

describe('chatProseSoFar (streaming display, best effort)', () => {
  it('hides complete blocks and flags a still-open tail', () => {
    expect(chatProseSoFar('Hello.')).toEqual({ prose: 'Hello.', composing: false });
    expect(chatProseSoFar('Hello.<edit><search>a</search><replace>b</replace></edit> bye')).toEqual({
      prose: 'Hello. bye',
      composing: false,
    });
    expect(chatProseSoFar('Working…<edit><search>a')).toEqual({ prose: 'Working…', composing: true });
  });
});

describe('resolveCanvasEdit (tolerant ladder)', () => {
  it('level 1 — exact match, unique', () => {
    const resolution = resolveCanvasEdit(DOC, 'Rain hammers the stones.');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.ranges).toEqual([
      { from: DOC.indexOf('Rain'), to: DOC.indexOf('Rain') + 'Rain hammers the stones.'.length },
    ]);
  });

  it('level 2 — case-insensitive fallback', () => {
    const resolution = resolveCanvasEdit(DOC, 'rain HAMMERS the stones');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(DOC.slice(resolution.ranges[0]?.from ?? 0, resolution.ranges[0]?.to ?? 0)).toBe(
      'Rain hammers the stones',
    );
  });

  it('level 3 — whitespace-collapse fallback (runs of whitespace ≡ one space)', () => {
    const doc = 'The party  enters.\n\nThe   gate opens.';
    const resolution = resolveCanvasEdit(doc, 'The party enters.\n\nThe gate opens.');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(doc.slice(resolution.ranges[0]?.from ?? 0, resolution.ranges[0]?.to ?? 0)).toBe(
      'The party  enters.\n\nThe   gate opens.',
    );
  });

  it('multiple exact matches come back as multiple ranges (caller decides all)', () => {
    const doc = 'Rain here.\nRain there.\nDone.';
    const resolution = resolveCanvasEdit(doc, 'Rain');
    expect(resolution.status).toBe('found');
    if (resolution.status !== 'found') throw new Error('unreachable');
    expect(resolution.ranges).toHaveLength(2);
    expect(resolution.ranges[0]).toEqual({ from: 0, to: 4 });
  });

  it('zero matches report the closest candidate snippet, never an auto-apply', () => {
    const doc = '## The Gate Bargain\n\nThe party bargains bravely with the keeper.\n\nRain hammers.';
    const resolution = resolveCanvasEdit(doc, 'The party bargains boldy with the keeper.');
    expect(resolution.status).toBe('none');
    if (resolution.status !== 'none') throw new Error('unreachable');
    expect(resolution.closest).toContain('bargains bravely');
    expect(resolution.closestFrom).not.toBeNull();
  });

  it('an empty search never matches', () => {
    expect(resolveCanvasEdit(DOC, '')).toEqual({ status: 'none', closest: '', closestFrom: null });
  });
});

describe('buildCanvasChatPayload (context contract)', () => {
  const history = Array.from({ length: MAX_CONTEXT_MESSAGES + 3 }, (_unused, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `turn ${String(index)}`,
  }));

  it('pins the CURRENT doc into the final user turn and states the doc-is-current contract', () => {
    const messages = buildCanvasChatPayload({
      document: DOC,
      instruction: 'make it rain',
      history: [],
    });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('CURRENT state');
    expect(messages[0]?.content).toContain('all="true"');
    const last = messages[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain(DOC);
    expect(last?.content).toContain('Instruction: make it rain');
  });

  it('caps the conversation tail and notes the omission', () => {
    const messages = buildCanvasChatPayload({
      document: DOC,
      instruction: 'next',
      history,
    });
    const userTurns = messages.filter((message) => message.role === 'user');
    // 12 capped history user turns + the new turn (rough check below).
    expect(userTurns.length).toBeLessThanOrEqual(MAX_CONTEXT_MESSAGES / 2 + 2);
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.content).toContain('earlier message(s)');
    expect(messages[messages.length - 1]?.content).toContain('Instruction: next');
  });

  it('older user turns are re-rendered instruction-only (stale docs never ride along)', () => {
    const messages = buildCanvasChatPayload({
      document: DOC,
      instruction: 'next',
      history: [{ role: 'user', text: 'make it rain' }, { role: 'assistant', text: 'Done.' }],
    });
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('[earlier instruction] make it rain');
    expect(messages[1]?.content).not.toContain('<document>');
    // Assistant replies keep their raw commands (the model sees its own work).
    expect(messages[2]?.content).toBe('Done.');
  });
});

describe('composeFailureReport (report-to-LLM loop)', () => {
  it('carries the error, the verbatim command and the doc excerpt', () => {
    const report = composeFailureReport({
      errorText: 'the search text does not appear in the current document',
      command: { search: 'old text', replace: 'new text', all: false },
      document: `${'x'.repeat(400)}the keeper bargains here${'y'.repeat(400)}`,
      failureFrom: 400,
    });
    expect(report).toContain('could not be applied');
    expect(report).toContain('the search text does not appear');
    expect(report).toContain('<edit all="false"><search>old text</search><replace>new text</replace></edit>');
    expect(report).toContain('the keeper bargains here');
    expect(report).toContain('Re-send the corrected command');
  });

  it('a parse failure (no command, no anchor) still names the error', () => {
    const report = composeFailureReport({
      errorText: 'unbalanced <edit> block',
      command: null,
      document: DOC,
      failureFrom: null,
    });
    expect(report).toContain('unbalanced <edit> block');
    expect(report).not.toContain('<excerpt>');
  });
});

describe('sendCanvasChatMessage (engine)', () => {
  function baseInput(overrides: Partial<CanvasChatTurnInput> = {}): CanvasChatTurnInput {
    return {
      moduleId: world.moduleId,
      document: DOC,
      instruction: 'make the gate scene rainier',
      history: [],
      ...overrides,
    };
  }

  it('sends the CURRENT doc + system note and returns the parsed reply', async () => {
    const raw =
      'Done — one edit.\n<edit><search>Rain hammers the stones.</search><replace>Rain drowns every word.</replace></edit>';
    chatMock.mockResolvedValue({ text: raw, modelUsed: 'test-model', fallback: null });
    const result = await sendCanvasChatMessage(baseInput());
    expect(result.parse.prose).toBe('Done — one edit.');
    expect(result.parse.commands).toHaveLength(1);
    expect(result.modelUsed).toBe('test-model');

    const [messages, opts] = chatMock.mock.calls[0] ?? [];
    expect(messages?.[0]?.role).toBe('system');
    expect(messages?.[0]?.content).toContain('CURRENT state');
    const last = messages?.[messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toContain(DOC);
    expect(last?.content).toContain('Instruction: make the gate scene rainier');
    // No strict JSON response format — the XML protocol is deliberately not
    // a JSON contract (docs/17 row 50).
    expect(opts?.responseFormat).toBeUndefined();
  });

  it('uses the Settings defaultChatModel and honors the canvas selection override', async () => {
    chatMock.mockResolvedValue({ text: 'ok', modelUsed: 'm', fallback: null });
    await sendCanvasChatMessage(baseInput());
    const settings = await (await import('@/db/settingsRepo')).getSettings();
    expect(chatMock.mock.calls[0]?.[1]?.model).toBe(settings.defaultChatModel);
    await sendCanvasChatMessage(baseInput({ model: 'custom/canvas-model' }));
    expect(chatMock.mock.calls[1]?.[1]?.model).toBe('custom/canvas-model');
  });

  it('a generating module refuses with ModuleBusyError (chat not called)', async () => {
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(ModuleBusyError);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a vanished module fails loud', async () => {
    await expect(sendCanvasChatMessage(baseInput({ moduleId: 'nope-nope' }))).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('chat and refine serialize on the shared registry (ONE generation per module)', async () => {
    let releaseFirst!: () => void;
    chatMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => {
            resolve({ text: JSON.stringify({ replacement: 'first' }), modelUsed: 'm', fallback: null });
          };
        }),
    );
    chatMock.mockResolvedValue({ text: 'ok', modelUsed: 'm', fallback: null });
    const refine = refineModuleText({
      moduleId: world.moduleId,
      scope: 'part',
      instruction: 'rewrite',
      fullMarkdown: DOC,
      selectedText: '',
      enclosingBlock: '',
    });
    // Let the refine reach its chat await so the registry is genuinely held.
    for (let round = 0; round < 20 && chatMock.mock.calls.length === 0; round += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(ModuleBusyError);
    releaseFirst();
    await expect(refine).resolves.toBe('first');
    // After release, a chat turn goes through.
    await expect(sendCanvasChatMessage(baseInput())).resolves.toMatchObject({ modelUsed: 'm' });
  });

  it('a malformed reply throws CanvasChatParseError (loud, whole reply failed)', async () => {
    chatMock.mockResolvedValue({
      text: 'Here you go: <edit><search>abc</search><replace>def',
      modelUsed: 'm',
      fallback: null,
    });
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow(CanvasChatParseError);
  });

  it('an empty instruction fails before any model call', async () => {
    await expect(sendCanvasChatMessage(baseInput({ instruction: '   ' }))).rejects.toThrow(/instruction/i);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a pre-aborted signal throws AbortError before any model call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sendCanvasChatMessage(baseInput({ signal: controller.signal }))).rejects.toThrow(/abort/i);
    expect(chatMock).not.toHaveBeenCalled();
  });
});
