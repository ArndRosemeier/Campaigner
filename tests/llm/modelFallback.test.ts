import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, type Settings } from '@/domain';
import { setCachedModels } from '@/llm/modelCache';
import {
  buildModelChain,
  repairModel,
  resolveChatModel,
  resolveImageModel,
  visionRepairModel,
  walkModelChain,
} from '@/llm/modelFallback';
import { OpenRouterError } from '@/llm/openrouterErrors';

const settings = {
  defaultChatModel: DEFAULT_CHAT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
} as Pick<Settings, 'defaultChatModel' | 'imageModel'>;

describe('walkModelChain', () => {
  /** A fallback-worthy failure (the walker escalates on this class). */
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

  it('rethrows unclassifiable errors and user cancels unchanged', async () => {
    await expect(
      walkModelChain(['a', 'b'], () => Promise.reject(new Error('bad request')), { kind: 'chat' }),
    ).rejects.toThrow('bad request');
    const abort = new DOMException('cancelled', 'AbortError');
    await expect(
      walkModelChain(['a', 'b'], () => Promise.reject(abort), { kind: 'chat' }),
    ).rejects.toBe(abort);
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

  it('resolves the verify model the same way: non-empty wins, empty = default', () => {
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

describe('visionRepairModel', () => {
  const models = [
    { id: 'vision/fallback', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'text/fallback', architecture: { input_modalities: ['text'] } },
  ];

  it('escalates the vision repair to a vision-capable fallback', () => {
    expect(visionRepairModel('cheap/primary', 'vision/fallback', models)).toBe('vision/fallback');
  });

  it('stays on the first-try model when the fallback cannot take images', () => {
    expect(visionRepairModel('cheap/primary', 'text/fallback', models)).toBe('cheap/primary');
  });

  it('attempts an unknown fallback — the failure would stay loud', () => {
    expect(visionRepairModel('cheap/primary', 'unknown/model', models)).toBe('unknown/model');
    expect(visionRepairModel('cheap/primary', 'vision/fallback', null)).toBe('vision/fallback');
  });
});
