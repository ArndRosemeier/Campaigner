import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, type Settings } from '@/domain';
import { setCachedModels } from '@/llm/modelCache';
import {
  buildModelChain,
  repairModel,
  resolveChatModel,
  resolveImageModel,
  walkModelChain,
} from '@/llm/modelFallback';
import { MissingApiKeyError, OpenRouterError } from '@/llm/openrouterErrors';

const settings = {
  defaultChatModel: DEFAULT_CHAT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
} as Pick<Settings, 'defaultChatModel' | 'imageModel'>;

describe('walkModelChain', () => {
  /** A congestion-class failure (classifyable, escalates). */
  const congested = (): OpenRouterError => new OpenRouterError('stall', 500, 'stalled');

  it('returns the first try untouched when it succeeds', async () => {
    const result = await walkModelChain(['a', 'b'], (model) => Promise.resolve(`ok:${model}`), { kind: 'chat' });
    expect(result).toEqual({ value: 'ok:a', modelUsed: 'a', fallback: null });
  });

  it('escalates to the next entry on a fallback-worthy error and reports it', async () => {
    const fallbacks: unknown[] = [];
    let resets = 0;
    const result = await walkModelChain(
      ['a', 'b'],
      (model) => (model === 'a' ? Promise.reject(congested()) : Promise.resolve(`ok:${model}`)),
      {
        kind: 'chat',
        onFallback: (info) => fallbacks.push(info),
        onReset: () => {
          resets += 1;
        },
      },
    );
    expect(result.modelUsed).toBe('b');
    expect(result.fallback).toEqual({ from: 'a', to: 'b', reason: 'congestion' });
    expect(fallbacks).toEqual([{ from: 'a', to: 'b', reason: 'congestion' }]);
    expect(resets).toBe(1);
  });

  it('escalates on ANY error — the chain itself is the bound (owner headline pin)', async () => {
    // Every class the old gate used to stop: unclassifiable throws,
    // truncation, strict-schema rejections, opaque 400s (the owner's Meta
    // content-management body verbatim — never matched FILTER_PATTERN).
    const anyError = (): Error[] => [
      new Error('bad request'),
      new OpenRouterError('length', 200, 'truncated mid-answer'),
      new OpenRouterError('schema-rejected', 400, 'model "m" rejected the strict JSON-schema response format'),
      new OpenRouterError(
        'http',
        400,
        'The response was filtered due to the prompt triggering our content management policy.',
      ),
    ];
    for (const error of anyError()) {
      const attempts: string[] = [];
      const result = await walkModelChain(
        ['a', 'b'],
        (model) => {
          attempts.push(model);
          return model === 'a' ? Promise.reject(error) : Promise.resolve(`ok:${model}`);
        },
        { kind: 'chat' },
      );
      expect(attempts).toEqual(['a', 'b']);
      expect(result.modelUsed).toBe('b');
    }
  });

  it('reports reason "other" for an escalation the classifier cannot name', async () => {
    const fallbacks: unknown[] = [];
    const result = await walkModelChain(
      ['a', 'b'],
      (model) => (model === 'a' ? Promise.reject(new Error('opaque')) : Promise.resolve('ok')),
      { kind: 'chat', onFallback: (info) => fallbacks.push(info) },
    );
    expect(result.fallback).toEqual({ from: 'a', to: 'b', reason: 'other' });
    expect(fallbacks).toEqual([{ from: 'a', to: 'b', reason: 'other' }]);
  });

  it('escalates a strict-schema rejection to the next chain entry; exhaustion combines loudly', async () => {
    const rejected = new OpenRouterError(
      'schema-rejected',
      422,
      'provider cannot enforce strict JSON schemas',
    );
    let attempts = 0;
    // Another model may support strict mode: the walk advances.
    const result = await walkModelChain(
      ['a', 'b'],
      (model) => {
        attempts += 1;
        return model === 'a' ? Promise.reject(rejected) : Promise.resolve(`ok:${model}`);
      },
      { kind: 'chat' },
    );
    expect(attempts).toBe(2);
    expect(result.modelUsed).toBe('b');

    // Chain exhausted: the combined error names every model in order and
    // the LAST error's kind/status survive for outer instanceof/status
    // checks.
    await expect(
      walkModelChain(['a', 'b'], () => Promise.reject(rejected), { kind: 'chat' }),
    ).rejects.toMatchObject({
      kind: 'schema-rejected',
      status: 422,
    });
    await expect(
      walkModelChain(['a', 'b'], () => Promise.reject(rejected), { kind: 'chat' }),
    ).rejects.toThrow(/every chat model in the escalation chain failed.*“a”.*“b”/s);
  });

  it('escalates truncation (finish_reason "length") — another model may fit the answer', async () => {
    const attempts: string[] = [];
    const result = await walkModelChain(
      ['a', 'b'],
      (model) => {
        attempts.push(model);
        return model === 'a'
          ? Promise.reject(new OpenRouterError('length', 200, 'truncated'))
          : Promise.resolve(`ok:${model}`);
      },
      { kind: 'chat' },
    );
    expect(attempts).toEqual(['a', 'b']);
    expect(result.modelUsed).toBe('b');
  });

  it('does not escalate a user abort — the stop defies the chain', async () => {
    const abort = new DOMException('cancelled', 'AbortError');
    const attempts: string[] = [];
    await expect(
      walkModelChain(
        ['a', 'b'],
        (model) => {
          attempts.push(model);
          return Promise.reject(abort);
        },
        { kind: 'chat' },
      ),
    ).rejects.toBe(abort);
    expect(attempts).toEqual(['a']);
  });

  it('does not escalate a MissingApiKeyError — it fails identically for every model', async () => {
    const attempts: string[] = [];
    await expect(
      walkModelChain(
        ['a', 'b'],
        (model) => {
          attempts.push(model);
          return Promise.reject(new MissingApiKeyError());
        },
        { kind: 'chat' },
      ),
    ).rejects.toThrow(MissingApiKeyError);
    expect(attempts).toEqual(['a']);
  });

  it('rethrows the original error on a single-entry chain', async () => {
    const failure = congested();
    await expect(
      walkModelChain(['only'], () => Promise.reject(failure), { kind: 'image' }),
    ).rejects.toBe(failure);
  });

  it('combines a chain exhaustion into the chain error', async () => {
    await expect(
      walkModelChain(['a', 'b'], () => Promise.reject(congested()), { kind: 'image' }),
    ).rejects.toThrow(/every image model in the escalation chain failed/);
  });

  it('skips a cached text-only fallback when the request needs image input', async () => {
    setCachedModels([
      { id: 'potent/fallback', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    ]);
    const failure = congested();
    await expect(
      walkModelChain(['vision/primary', 'potent/fallback'], () => Promise.reject(failure), {
        kind: 'chat',
        needsImageInput: true,
      }),
    ).rejects.toBe(failure);
  });

  it('attempts unknown and vision-capable fallbacks despite image input (loud)', async () => {
    const failure = congested();
    // Unknown to the cache: attempted anyway — the attempt fails loudly.
    await expect(
      walkModelChain(['vision/primary', 'unknown/model'], () => Promise.reject(failure), {
        kind: 'chat',
        needsImageInput: true,
      }),
    ).rejects.toThrow(/every chat model in the escalation chain failed/);
    // Vision-capable: attempted (and its failure ends the chain).
    setCachedModels([
      { id: 'potent/fallback', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    ]);
    await expect(
      walkModelChain(['vision/primary', 'potent/fallback'], () => Promise.reject(failure), {
        kind: 'chat',
        needsImageInput: true,
      }),
    ).rejects.toThrow(/every chat model in the escalation chain failed/);
  });
});

describe('resolveChatModel', () => {
  it('uses the settings default when no preferred model is given', () => {
    expect(resolveChatModel(settings)).toBe(DEFAULT_CHAT_MODEL);
    expect(resolveChatModel(settings, '')).toBe(DEFAULT_CHAT_MODEL);
  });

  it('lets a persona/model override win over the default', () => {
    expect(resolveChatModel(settings, 'openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('resolves a preferred model the same way: non-empty wins, empty = default', () => {
    expect(resolveChatModel(settings, settings.defaultChatModel)).toBe(DEFAULT_CHAT_MODEL);
    expect(resolveChatModel(settings, 'qwen/qwen-2.5-vl')).toBe('qwen/qwen-2.5-vl');
  });
});

describe('resolveImageModel', () => {
  it('returns the configured image model', () => {
    expect(resolveImageModel(settings)).toBe(DEFAULT_IMAGE_MODEL);
  });
});

describe('buildModelChain', () => {
  it('is just the primary when the fallback is disabled', () => {
    expect(buildModelChain('a', '')).toEqual(['a']);
  });

  it('drops a fallback identical to the primary — a chain entry never repeats', () => {
    expect(buildModelChain('a', 'a')).toEqual(['a']);
  });

  it('is primary then fallback when an escalation tier is defined', () => {
    expect(buildModelChain('a', 'b')).toEqual(['a', 'b']);
  });
});

describe('repairModel', () => {
  it('sends the contract repair to the configured escalation tier', () => {
    expect(repairModel('cheap/primary', { fallbackChatModel: 'potent/fallback' })).toBe(
      'potent/fallback',
    );
  });

  it('keeps the pre-fallback behavior without a fallback or when identical', () => {
    expect(repairModel('cheap/primary', { fallbackChatModel: '' })).toBe('cheap/primary');
    expect(repairModel('cheap/primary', { fallbackChatModel: 'cheap/primary' })).toBe(
      'cheap/primary',
    );
  });
});
