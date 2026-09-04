import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, type Settings } from '@/domain';
import { buildModelChain, resolveChatModel, resolveImageModel } from '@/llm/modelFallback';

const settings = {
  defaultChatModel: DEFAULT_CHAT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
} as Pick<Settings, 'defaultChatModel' | 'imageModel'>;

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
