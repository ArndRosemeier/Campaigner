import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings, updateSettings } from '@/db/settingsRepo';
import { applyLanguageDirective, languageDirective } from '@/llm/language';
import { chat } from '@/llm/openrouter';
import { clearDatabase } from '../db/helpers';

/**
 * Generation-language enforcement: the settings-selected language (default
 * English) must reach every generation prompt via a system directive
 * injected at the chat() choke point.
 */

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const SETTINGS_BASE = {
  id: 'settings' as const,
  openRouterApiKey: 'test-key',
  defaultChatModel: 'm',
  defaultReasoningEffort: 'default' as const,
  embeddingModel: 'e',
  embeddingsEnabled: false,
  imageModel: 'img',
  imagesEnabled: false,
  fallbackChatModel: '',
  fallbackImageModel: '',
  artifactScopes: {
    workspace: { global: false, campaign: true, module: true },
    moduleView: { global: true, campaign: true, module: true },
  },
  encounterMapAspect: '4:3' as const,
  encounterVerifyModel: '',
  retiredSessionNotesRemoved: 0,
};

beforeEach(async () => {
  await clearDatabase();
  await saveSettings({ ...SETTINGS_BASE, language: 'en' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('languageDirective', () => {
  it('names the chosen language (English default, German when picked)', () => {
    expect(languageDirective('en')).toContain('in English');
    expect(languageDirective('de')).toContain('in Deutsch (German)');
  });

  it('falls back to English for unknown codes', () => {
    expect(languageDirective('xx')).toContain('in English');
  });
});

describe('applyLanguageDirective', () => {
  it('appends to the last system message, preserving the persona prompt', () => {
    const out = applyLanguageDirective(
      [
        { role: 'system', content: 'You are the Lorekeeper.' },
        { role: 'user', content: 'Draft an NPC.' },
        { role: 'system', content: 'Also reply as JSON.' },
      ],
      'de',
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.content).toBe('You are the Lorekeeper.');
    expect(out[2]?.content).toContain('Also reply as JSON.');
    expect(out[2]?.content).toContain('in Deutsch (German)');
  });

  it('prepends a system message when none exists', () => {
    const out = applyLanguageDirective([{ role: 'user', content: 'hi' }], 'en');
    expect(out[0]?.role).toBe('system');
    expect(out[0]?.content).toContain('in English');
    expect(out[1]?.content).toBe('hi');
  });

  it('does not mutate the input array', () => {
    const input = [{ role: 'system' as const, content: 'persona' }];
    applyLanguageDirective(input, 'fr');
    expect(input[0]?.content).toBe('persona');
  });
});

describe('chat language enforcement', () => {
  it('sends the directive with the settings-selected language (de)', async () => {
    await updateSettings({ language: 'de' });
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat(
      [
        { role: 'system', content: 'You are the Cartographer.' },
        { role: 'user', content: 'Draft a location.' },
      ],
      { model: 'm', temperature: 0.5 },
      [1, 1],
    );

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      messages?: { role: string; content: string }[];
    };
    const system = body.messages?.find((message) => message.role === 'system');
    expect(system?.content).toContain('You are the Cartographer.');
    expect(system?.content).toContain('in Deutsch (German)');
  });

  it('uses English when the setting is at its default', async () => {
    const fetchMock = vi.fn((_url: unknown, _init?: { body?: string }) =>
      Promise.resolve(sseResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);

    await chat([{ role: 'user', content: 'hi' }], { model: 'm', temperature: 0.5 }, [1, 1]);

    const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      messages?: { role: string; content: string }[];
    };
    expect(body.messages?.[0]?.role).toBe('system');
    expect(body.messages?.[0]?.content).toContain('in English');
  });
});
