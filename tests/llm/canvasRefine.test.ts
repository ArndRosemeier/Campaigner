import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReplacementStreamExtractor,
  canvasRefineReplySchema,
  enclosingBlockOf,
  refineModuleText,
  type CanvasRefineInput,
} from '@/llm/canvasRefine';
import { ModuleBusyError } from '@/llm/moduleGen';
import { createCampaign } from '@/db/campaignRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Id,
} from '@/domain';
import { saveModule, getModule, patchModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Canvas refine CONTRACT (08-MODULE-DESIGNER §Module canvas): the reply is
 * zod-validated at the boundary (fail loud, never partial-apply), runs the
 * escape-debris scan (loud reject), reuses the settings model/gates (the
 * strict schema rides every attempt), honours ONE-generation-per-module
 * (ModuleBusyError, no queue), supports stop/cancel, and instructs the
 * [[wiki-link]] token semantics in the prompt. The transport is mocked —
 * the extractor and boundary logic run for real.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

const DOC = '## The Gate Bargain\n\nThe party bargains with [[Keeper Ilse]] at the gate.';

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

function baseInput(overrides: Partial<CanvasRefineInput> = {}): CanvasRefineInput {
  return {
    moduleId: world.moduleId,
    scope: 'selection',
    instruction: 'tighten the scene',
    text: 'The party bargains with [[Keeper Ilse]] at the gate.',
    enclosingBlock: 'The party bargains with [[Keeper Ilse]] at the gate.',
    // Default per-turn controller: the turn must be reachable by Stop all
    // (canvasBusy's registry pairs this controller with the model signal).
    turn: new AbortController(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seedModule();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canvasRefine contract', () => {
  it('sends the selection grounding + wiki-token rules + strict JSON contract, returns the validated replacement', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'The party bargains harder.' }),
      modelUsed: 'test-model',
      fallback: null,
    });
    const { replacement, modelUsed } = await refineModuleText(baseInput());
    expect(replacement).toBe('The party bargains harder.');
    // PROVENANCE (docs/17 row 93): the seam reports WHICH model served the
    // rewrite, so the caller that saves the accepted suggestion can record it
    // instead of guessing from settings.
    expect(modelUsed).toBe('test-model');

    expect(chatMock).toHaveBeenCalledTimes(1);
    const [messages, opts] = chatMock.mock.calls[0] ?? [];
    const user = messages?.[1]?.content ?? '';
    if (typeof user !== 'string') throw new Error('expected string user content');
    // Selection triple is grounded.
    expect(user).toContain('The party bargains with [[Keeper Ilse]] at the gate.');
    // v3: the grounding is the EXPLICIT selection only — the full part
    // text is never ambient context (cursor plays no role, and neither
    // does the surrounding part).
    expect(user).not.toContain('## The Gate Bargain');
    expect(user).toContain('tighten the scene');
    // Wiki-link token semantics are instructed.
    expect(user).toContain('[[Name|display]]');
    expect(user).toContain('never inflect inside the token');
    // Strict structured outputs ride the call (settings gates reused).
    expect(opts?.responseFormat).not.toBeNull();
    expect(opts?.responseFormat).not.toEqual('json');
  });

  it('whole-part scope asks for the COMPLETE part markdown without an H1', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: '## Rewritten\n\nNew text.' }),
      modelUsed: 'm',
      fallback: null,
    });
    await refineModuleText(baseInput({ scope: 'part', text: DOC, enclosingBlock: '' }));
    const user = (chatMock.mock.calls[0]?.[0]?.[1]?.content ?? '') as string;
    expect(user).toContain('COMPLETE new markdown');
    expect(user).toContain('NO H1');
  });

  it('streams extracted replacement deltas (cumulative) into onDelta', async () => {
    const deltas: string[] = [];
    chatMock.mockImplementation((_messages, opts) => {
      const raw = JSON.stringify({ replacement: 'First line.\\nSecond \\"quoted\\" line.' });
      for (let index = 0; index < raw.length; index += 8) {
        opts.onToken?.(raw.slice(index, index + 8));
      }
      return Promise.resolve({ text: raw, modelUsed: 'm', fallback: null });
    });
    const { replacement } = await refineModuleText(baseInput({ onDelta: (soFar) => deltas.push(soFar) }));
    // The extractor decodes exactly ONE JSON level: the mock's replacement
    // value itself carries literal backslash escapes, which survive it.
    const settled = 'First line.\\nSecond \\"quoted\\" line.';
    expect(replacement).toBe(settled);
    // Deltas grow monotonically and decode the JSON escapes (best-effort preview).
    expect(deltas.length).toBeGreaterThan(1);
    expect(
      deltas.every((delta, index) => {
        const previous = deltas[index - 1];
        return index === 0 || previous === undefined || delta.length >= previous.length;
      }),
    ).toBe(true);
    expect(deltas[deltas.length - 1]).toBe(settled);
  });

  it('a reply that violates the zod contract fails loud', async () => {
    chatMock.mockResolvedValue({ text: '{"replacement": 42}', modelUsed: 'm', fallback: null });
    await expect(refineModuleText(baseInput())).rejects.toThrow(/replacement/i);
    chatMock.mockResolvedValue({ text: 'no json at all', modelUsed: 'm', fallback: null });
    await expect(refineModuleText(baseInput())).rejects.toThrow(/no JSON object/i);
  });

  it('an escape-debris reply rejects loudly naming the debris (never repaired silently)', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'Der Flussm?fcndung steigt.' }),
      modelUsed: 'm',
      fallback: null,
    });
    await expect(refineModuleText(baseInput())).rejects.toThrow(/\?fc/);
  });

  it('an empty whole-part replacement fails loud', async () => {
    chatMock.mockResolvedValue({ text: JSON.stringify({ replacement: '  ' }), modelUsed: 'm', fallback: null });
    await expect(refineModuleText(baseInput({ scope: 'part', text: DOC, enclosingBlock: '' })))
      .rejects.toThrow(/empty replacement/i);
  });

  it('an empty instruction or empty selection fails loud before any model call', async () => {
    await expect(refineModuleText(baseInput({ instruction: '   ' }))).rejects.toThrow(/instruction/i);
    await expect(refineModuleText(baseInput({ text: '' }))).rejects.toThrow(/selected span/i);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a generating module refuses with ModuleBusyError (one generation per module)', async () => {
    await patchModule(world.moduleId, { status: 'generating', errorMessage: '' });
    await expect(refineModuleText(baseInput())).rejects.toThrow(ModuleBusyError);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('a vanished module fails loud', async () => {
    await expect(refineModuleText(baseInput({ moduleId: 'nope-nope' }))).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('a second concurrent refine on the same module is busy (no queue)', async () => {
    let releaseFirst!: (value: { text: string; modelUsed: string; fallback: null }) => void;
    chatMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'second' }),
      modelUsed: 'm',
      fallback: null,
    });
    const first = refineModuleText(baseInput());
    // Let the first call reach its chat await (fake-indexeddb turns on the
    // timed queue), so the registry is genuinely held before the second try.
    for (let round = 0; round < 20 && chatMock.mock.calls.length === 0; round += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(chatMock).toHaveBeenCalledTimes(1);
    await expect(refineModuleText(baseInput({ instruction: 'second try' }))).rejects.toThrow(
      ModuleBusyError,
    );
    releaseFirst({ text: JSON.stringify({ replacement: 'first' }), modelUsed: 'm', fallback: null });
    await expect(first).resolves.toMatchObject({ replacement: 'first', modelUsed: 'm' });
    // After the first settles, a third refine goes through.
    await expect(refineModuleText(baseInput({ instruction: 'third try' }))).resolves.toMatchObject({
      replacement: 'second',
      modelUsed: 'm',
    });
  });

  it('a pre-aborted signal throws AbortError before any model call', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refineModuleText(baseInput({ turn: controller }))).rejects.toThrow(
      /abort/i,
    );
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('the abort signal rides the chat call and follows the turn controller', async () => {
    const controller = new AbortController();
    // The call hangs so the turn is genuinely live while the abort lands
    // (releasing the turn drops the relay, so a settled turn is not the case
    // under test).
    chatMock.mockImplementation((_messages, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no signal passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const refine = refineModuleText(baseInput({ turn: controller }));
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalled();
    });
    // The model call carries the turn's composed signal (canvasBusy): a
    // caller abort reaches it, so the caller's controller stays the source
    // of truth for "the user stopped this".
    const carried = chatMock.mock.calls[0]?.[1]?.signal;
    expect(carried).toBeDefined();
    expect(carried?.aborted).toBe(false);
    controller.abort();
    expect(carried?.aborted).toBe(true);
    await expect(refine).rejects.toThrow();
  });
});

describe('ReplacementStreamExtractor', () => {
  it('extracts the replacement string incrementally and decodes escapes', () => {
    const extractor = new ReplacementStreamExtractor();
    expect(extractor.push('{"repl')).toBe('');
    expect(extractor.push('acement":"First \\"quo')).toBe('First "quo');
    expect(extractor.push('ted\\" and\\ncha')).toBe('First "quoted" and\ncha');
    expect(extractor.push('nged\\u00e4ndert"}')).toBe('First "quoted" and\nchangedändert');
  });

  it('never throws on malformed prefixes (best-effort preview only)', () => {
    // Fresh extractor per case — each push appends to one raw stream, so a
    // case that wants a clean state gets a clean extractor.
    expect(new ReplacementStreamExtractor().push('<think>hmm')).toBe('');
    expect(new ReplacementStreamExtractor().push('nothing')).toBe('');
    expect(new ReplacementStreamExtractor().push('{"other": 1')).toBe('');
    // A <think> prefix is skipped.
    const thinky = new ReplacementStreamExtractor();
    expect(thinky.push('<think>hmm')).toBe('');
    expect(thinky.push('</think>{"replacement": "ok')).toBe('ok');
    // Still inside the unterminated string: content keeps extending the
    // preview (the closing quote ends it — best effort either way).
    expect(thinky.push('nothing')).toBe('oknothing');
    // An unknown escape stops the preview instead of guessing.
    expect(new ReplacementStreamExtractor().push('{"replacement": "a\\x')).toBe('a');
  });

  it('the reply schema is the strict one-field contract', () => {
    expect(canvasRefineReplySchema.parse({ replacement: 'x' })).toEqual({ replacement: 'x' });
    expect(() => canvasRefineReplySchema.parse({ replacement: 42 })).toThrow();
    expect(() => canvasRefineReplySchema.parse({})).toThrow();
  });
});

describe('enclosingBlockOf', () => {
  it('returns the blank-line-delimited block containing the offset', () => {
    const markdown = 'First block line one.\nFirst block line two.\n\nSecond block here.\n\nThird.';
    // Offsets into the second block.
    const secondStart = markdown.indexOf('Second');
    expect(enclosingBlockOf(markdown, secondStart)).toBe('Second block here.');
    expect(enclosingBlockOf(markdown, 0)).toBe('First block line one.\nFirst block line two.');
    // Boundary at the very end falls back to the last starting block.
    expect(enclosingBlockOf(markdown, markdown.length)).toBe('Third.');
  });

  it('handles an empty document', () => {
    expect(enclosingBlockOf('', 0)).toBe('');
  });
});

describe('canvasRefine row truth', () => {
  it('the busy gate only blocks a GENERATING module — draft parts refine fine', async () => {
    chatMock.mockResolvedValue({
      text: JSON.stringify({ replacement: 'x' }),
      modelUsed: 'm',
      fallback: null,
    });
    expect((await getModule(world.moduleId))?.status).toBe('draft');
    await expect(refineModuleText(baseInput())).resolves.toMatchObject({
      replacement: 'x',
      modelUsed: 'm',
    });
  });
});
