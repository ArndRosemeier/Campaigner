import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL, PROMPT_STYLE_FREESTYLE_ID, RECENT_CHAT_MODELS_CAP } from '@/domain';
import { getSettings, readSettings, recordRecentChatModel, saveSettings, updateSettings } from '@/db/settingsRepo';
import { db } from '@/db/db';
import { clearDatabase } from './helpers';

describe('settingsRepo', () => {
  beforeEach(clearDatabase);

  it('creates the default settings row on first read', async () => {
    const settings = await getSettings();

    expect(settings.id).toBe('settings');
    expect(settings.openRouterApiKey).toBe('');
    expect(settings.defaultChatModel).toBe(DEFAULT_CHAT_MODEL);
    expect(settings.defaultReasoningEffort).toBe('default');
    expect(settings.embeddingModel).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(settings.embeddingsEnabled).toBe(false);
    expect(settings.fallbackChatModel).toBe('');
    expect(settings.fallbackImageModel).toBe('');
    // The PRODUCT default module prompt style for a fresh app is Freestyle
    // (owner request, docs/17 row 88): he generated with it and liked the output
    // better. A stored value — a stored 'classic' included — is honored
    // verbatim; this line is only about what a brand-new row is born with.
    expect(settings.defaultPromptStyleId).toBe(PROMPT_STYLE_FREESTYLE_ID);
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

  it('defaults the generation language to English and persists a change', async () => {
    const fresh = await getSettings();
    expect(fresh.language).toBe('en');

    const updated = await updateSettings({ language: 'de' });
    expect(updated.language).toBe('de');
    expect((await getSettings()).language).toBe('de');
  });

  it('rejects unsupported language codes', async () => {
    await expect(
      updateSettings({ language: 'klingon' as never }),
    ).rejects.toThrow();
  });

  it('fills the language default into legacy rows stored without it', async () => {
    const { language: _language, ...legacy } = await getSettings();
    // Simulate a row written by an older app version (no language field).
    await db.settings.put(legacy as unknown as Parameters<typeof db.settings.put>[0]);
    expect(await readSettings()).toMatchObject({ language: 'en' });
  });

  it('fills the fallback-model defaults into legacy rows stored without them', async () => {
    const { fallbackChatModel: _c, fallbackImageModel: _i, ...legacy } = await getSettings();
    // Simulate a row written before the model-fallback feature.
    await db.settings.put(legacy as unknown as Parameters<typeof db.settings.put>[0]);
    expect(await readSettings()).toMatchObject({ fallbackChatModel: '', fallbackImageModel: '' });
  });

  // --- Recently used chat models (docs/17 row 193) -------------------------
  // THE recording seam: the read, the merge and the write happen in ONE rw
  // transaction. Pin 3 of the row's brief (a pick writes the setting AND lands
  // at the front of the recents) is the picker's behaviour pin; these are the
  // seam's own.

  it('records a model at the FRONT of a fresh row', async () => {
    await recordRecentChatModel('openai/gpt-4o');
    expect((await getSettings()).recentChatModels).toEqual(['openai/gpt-4o']);
  });

  it('reads, reorders and caps in ONE transaction — two concurrent recorders both land', async () => {
    // The forbidden component-side read-modify-write would have both callers
    // read `[]` and the second write would drop the first entry. The seam's
    // transaction serializes them, so BOTH entries survive.
    await Promise.all([recordRecentChatModel('a/model'), recordRecentChatModel('b/model')]);
    const recents = (await getSettings()).recentChatModels;
    expect(recents).toHaveLength(2);
    expect([...recents].sort()).toEqual(['a/model', 'b/model']);
  });

  it('re-using a model moves it to the front without duplicating it', async () => {
    await recordRecentChatModel('a');
    await recordRecentChatModel('b');
    await recordRecentChatModel('a');
    expect((await getSettings()).recentChatModels).toEqual(['a', 'b']);
  });

  it('caps the list, dropping the OLDEST entry', async () => {
    for (let i = 0; i < RECENT_CHAT_MODELS_CAP; i += 1) await recordRecentChatModel(`m${String(i)}`);
    await recordRecentChatModel('fresh');
    const recents = (await getSettings()).recentChatModels;
    // m0 was used first, so it is the oldest and the one the cap drops.
    expect(recents).toEqual([
      'fresh',
      ...Array.from(
        { length: RECENT_CHAT_MODELS_CAP - 1 },
        (_, i) => `m${String(RECENT_CHAT_MODELS_CAP - 1 - i)}`,
      ),
    ]);
    expect(recents).toHaveLength(RECENT_CHAT_MODELS_CAP);
    expect(recents).not.toContain('m0');
  });

  it('ignores an empty model and a legacy row without the field parses as []', async () => {
    await recordRecentChatModel('   ');
    expect((await getSettings()).recentChatModels).toEqual([]);

    const { recentChatModels: _drop, ...legacy } = await getSettings();
    await db.settings.put(legacy as unknown as Parameters<typeof db.settings.put>[0]);
    expect((await readSettings()).recentChatModels).toEqual([]);
  });
});
