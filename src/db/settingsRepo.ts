import {
  defaultSettings,
  newModuleDraftSchema,
  settingsSchema,
  userPromptStyleSchema,
  type NewModuleDraft,
  type Settings,
} from '@/domain';
import { z } from 'zod';

/** One stored (always user-authored) style. */
type UserPromptStyle = z.infer<typeof userPromptStyleSchema>;
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
const coreSettingsSchema = settingsSchema.omit({ newModuleDraft: true, promptStyles: true });

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

/** The styles field on its own — the same schema the row validates on write. */
const promptStylesFieldSchema = z.array(userPromptStyleSchema).nullable().default(null);

/**
 * The user's prompt styles, with the read's verdict — the `newModuleDraft`
 * precedent, for the same reason: styles are a few KB of authored text and a
 * blob that no longer parses must fail in the ONE surface that can report it
 * (the styles editor) instead of taking down every settings read in the app.
 * `styles` is `null` whenever the field is unreadable; `error` then carries the
 * reason. An empty array is a real value (no styles of your own yet).
 */
export interface StoredPromptStyles {
  styles: UserPromptStyle[] | null;
  error: Error | null;
}

/** Reads the stored prompt styles on their own (the editor's and creation's seam). */
export async function readPromptStyles(): Promise<StoredPromptStyles> {
  const existing = await db.settings.get('settings');
  if (existing === undefined) return { styles: [], error: null };
  return promptStylesFromRow(existing);
}

/** The styles field of a loaded row, with the read's verdict. */
function promptStylesFromRow(existing: Record<string, unknown>): StoredPromptStyles {
  const parsed = promptStylesFieldSchema.safeParse(existing.promptStyles ?? null);
  if (!parsed.success) return { styles: null, error: new Error(parsed.error.message) };
  return { styles: parsed.data ?? [], error: null };
}

/**
 * The row's load-bearing settings, with the draft and the styles read on their
 * own. `promptStyles: null` here means the same as above — unreadable, never
 * "no styles" — so a caller that cannot see the error still cannot mistake the
 * state for an empty list.
 */
function coreSettingsFromRow(existing: Record<string, unknown>): Settings {
  const core = coreSettingsSchema.parse({ ...defaultSettings(), ...existing });
  const styles = promptStylesFromRow(existing);
  return { ...core, newModuleDraft: draftFromRow(existing).draft, promptStyles: styles.styles };
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
    const existing = await db.settings.get('settings');
    const current = existing === undefined ? defaultSettings() : coreSettingsFromRow(existing);
    const candidate: Record<string, unknown> = { ...current, ...patch };
    // A field this write does NOT own is carried forward VERBATIM from the
    // stored row. The user's styles are authored work: a settings write that
    // neither read nor touched them must never be the thing that drops an
    // unreadable blob on the floor (AGENTS rule 1 — no silent data loss). A
    // carried-forward blob that fails the schema fails THIS write loudly
    // instead, naming the problem where the user can see it.
    if (patch.promptStyles === undefined && existing !== undefined && 'promptStyles' in existing) {
      candidate.promptStyles = existing.promptStyles;
    }
    const updated = settingsSchema.parse(candidate);
    await db.settings.put(updated);
    return updated;
  });
}
