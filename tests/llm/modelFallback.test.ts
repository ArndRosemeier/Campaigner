import { describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, type Settings } from '@/domain';
import {
  buildModelChain,
  repairModel,
  resolveChatModel,
  resolveImageModel,
  visionRepairModel,
} from '@/llm/modelFallback';

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
