import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL } from '@/domain';
import { getSettings, saveSettings, updateSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import { clearDatabase } from './helpers';

describe('settingsRepo', () => {
  beforeEach(clearDatabase);

  it('creates the default settings row on first read', async () => {
    const settings = await getSettings();

    expect(settings.id).toBe('settings');
    expect(settings.openRouterApiKey).toBe('');
    expect(settings.defaultChatModel).toBe(DEFAULT_CHAT_MODEL);
    expect(settings.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(settings.embeddingsEnabled).toBe(false);
    expect(await db.settings.count()).toBe(1);
  });

  it('is a singleton: repeated reads do not create more rows', async () => {
    await getSettings();
    const again = await getSettings();

    expect(again.id).toBe('settings');
    expect(await db.settings.count()).toBe(1);
  });

  it('updates and persists settings', async () => {
    const updated = await updateSettings({
      openRouterApiKey: 'sk-or-test',
      embeddingsEnabled: true,
    });

    expect(updated.openRouterApiKey).toBe('sk-or-test');
    expect(updated.embeddingsEnabled).toBe(true);
    // Untouched fields keep their defaults.
    expect(updated.defaultChatModel).toBe(DEFAULT_CHAT_MODEL);

    const reread = await getSettings();
    expect(reread.openRouterApiKey).toBe('sk-or-test');
  });

  it('saves a full settings row', async () => {
    const current = await getSettings();
    const saved = await saveSettings({ ...current, defaultChatModel: 'openai/gpt-4o' });

    expect(saved.defaultChatModel).toBe('openai/gpt-4o');
    expect((await getSettings()).defaultChatModel).toBe('openai/gpt-4o');
  });

  it('rejects invalid updates (schema-validated writes)', async () => {
    await expect(updateSettings({ defaultChatModel: '' })).rejects.toThrow();
  });
});
