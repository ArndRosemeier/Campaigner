import { defaultSettings, settingsSchema, type Settings } from '@/domain';
import { db } from '@/db/db';

/**
 * Reads the single settings row, creating the default row on first access so
 * callers never have to handle "no settings yet". Rows written by older app
 * versions are merged over the defaults so newly added fields (M3: images)
 * always have values.
 */
export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings');
  if (existing === undefined) {
    const created = defaultSettings();
    await db.settings.put(created);
    return created;
  }
  return settingsSchema.parse({ ...defaultSettings(), ...existing });
}

/**
 * Pure read (no default-row write) — for read-only contexts such as Dexie
 * liveQuery; callers see defaults without persisting them.
 */
export async function readSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings');
  if (existing === undefined) return defaultSettings();
  return settingsSchema.parse({ ...defaultSettings(), ...existing });
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
