import { defaultSettings, settingsSchema, type Settings } from '@/domain';
import { db } from '@/db/db';

/**
 * Reads the single settings row, creating the default row on first access so
 * callers never have to handle "no settings yet".
 */
export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings');
  if (existing) return existing;

  const created = defaultSettings();
  await db.settings.put(created);
  return created;
}

/**
 * Pure read (no default-row write) — for read-only contexts such as Dexie
 * liveQuery; callers see defaults without persisting them.
 */
export async function readSettings(): Promise<Settings> {
  return (await db.settings.get('settings')) ?? defaultSettings();
}

/** Overwrites the settings row wholesale (validated). */
export async function saveSettings(next: Settings): Promise<Settings> {
  const valid = settingsSchema.parse(next);
  await db.settings.put(valid);
  return valid;
}

export type SettingsPatch = Partial<Omit<Settings, 'id'>>;

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const current = await getSettings();
    const updated = settingsSchema.parse({ ...current, ...patch });
    await db.settings.put(updated);
    return updated;
  });
}
