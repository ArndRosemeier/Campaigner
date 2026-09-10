import {
  defaultSettings,
  newModuleDraftSchema,
  settingsSchema,
  type NewModuleDraft,
  type Settings,
} from '@/domain';
import { db } from '@/db/db';

/**
 * The settings row WITHOUT the New Module draft. The draft is a typing
 * convenience (`docs/17`): it is validated on its own by
 * `readStoredNewModuleDraft` so a draft that no longer validates can never take
 * down every settings read in the app — the failure stays scoped to the draft,
 * and the ONE consumer that shows it (the creation dialog) reports it loudly.
 * Everything else in the row is still validated here, strictly: a broken
 * load-bearing setting must fail the read (AGENTS 1).
 */
const coreSettingsSchema = settingsSchema.omit({ newModuleDraft: true });

/** The draft field on its own — the same schema the row validates on write. */
const newModuleDraftFieldSchema = newModuleDraftSchema.nullable().default(null);

/**
 * The stored New Module draft, with the read's verdict. The value is `null`
 * whenever there is nothing to prefill from OR the stored draft no longer
 * validates; `error` carries that failure so its ONE consumer can surface it
 * instead of silently prefilling a half-empty form (AGENTS 1 and 2). A draft
 * that fails validation is never returned as a value.
 */
export interface StoredNewModuleDraft {
  draft: NewModuleDraft | null;
  error: Error | null;
}

/**
 * Reads the stored New Module draft on its own (the dialog's prefill seam).
 * Never throws for a bad DRAFT: the failure comes back in `error`.
 */
export async function readStoredNewModuleDraft(): Promise<StoredNewModuleDraft> {
  const existing = await db.settings.get('settings');
  if (existing === undefined) return { draft: null, error: null };
  return draftFromRow(existing);
}

/** The draft field of a loaded row, with the read's verdict (one row, two parts). */
function draftFromRow(existing: Record<string, unknown>): StoredNewModuleDraft {
  const parsed = newModuleDraftFieldSchema.safeParse(existing.newModuleDraft ?? null);
  if (!parsed.success) return { draft: null, error: new Error(parsed.error.message) };
  return { draft: parsed.data, error: null };
}

/** The row's load-bearing settings, with the draft read on its own. */
function coreSettingsFromRow(existing: Record<string, unknown>): Settings {
  const core = coreSettingsSchema.parse({ ...defaultSettings(), ...existing });
  return { ...core, newModuleDraft: draftFromRow(existing).draft };
}

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
  return coreSettingsFromRow(existing);
}

/**
 * Pure read (no default-row write) — for read-only contexts such as Dexie
 * liveQuery; callers see defaults without persisting them. A stored draft that
 * no longer validates reads as `null` here instead of failing the whole row:
 * use `readStoredNewModuleDraft` where the draft's own failure has to be seen.
 */
export async function readSettings(): Promise<Settings> {
  const existing = await db.settings.get('settings');
  if (existing === undefined) return defaultSettings();
  return coreSettingsFromRow(existing);
}

/** Overwrites the settings row wholesale (validated). */
export async function saveSettings(next: Settings): Promise<Settings> {
  const valid = settingsSchema.parse(next);
  await db.settings.put(valid);
  return valid;
}

export type SettingsPatch = Partial<Omit<Settings, 'id'>>;

/**
 * Applies a patch to the single settings row. Validated as a whole — the draft
 * included, so an invalid draft can never be WRITTEN. A stored draft that no
 * longer validates (read as `null` above) is not carried forward by the first
 * settings write: the app cannot keep honoring a value it cannot parse, and the
 * dialog reports the unreadable draft before any of this (docs/17).
 */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const current = await getSettings();
    const updated = settingsSchema.parse({ ...current, ...patch });
    await db.settings.put(updated);
    return updated;
  });
}
