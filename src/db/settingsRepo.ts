import {
  defaultSettings,
  settingsSchema,
  userPromptStyleSchema,
  withRecentChatModel,
  type Settings,
} from '@/domain';
import { z } from 'zod';

/** One stored (always user-authored) style. */
type UserPromptStyle = z.infer<typeof userPromptStyleSchema>;
import { db } from '@/db/db';

/** The settings row WITHOUT the prompt styles (read on their own below). */
const coreSettingsSchema = settingsSchema.omit({ promptStyles: true });

/** The styles field on its own — the same schema the row validates on write. */
const promptStylesFieldSchema = z.array(userPromptStyleSchema).nullable().default(null);

/**
 * The user's prompt styles, with the read's verdict — the removed New Module draft's
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
 * The row's load-bearing settings, with the styles read on their own. `promptStyles: null` here means the same as above — unreadable, never
 * "no styles" — so a caller that cannot see the error still cannot mistake the
 * state for an empty list.
 */
function coreSettingsFromRow(existing: Record<string, unknown>): Settings {
  const core = coreSettingsSchema.parse({ ...defaultSettings(), ...existing });
  const styles = promptStylesFromRow(existing);
  return { ...core, promptStyles: styles.styles };
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
 * THE app's background-parallelism worker count (docs/17 row 315): the owner's
 * "Parallel requests" setting resolved into the number the app fans work out
 * with, floored at 1 so a corrupt or legacy row can never mean "run nothing".
 * ONE derivation, and it lives beside `getSettings` because this is the module
 * that knows which setting bounds concurrency: the three image queues pass it
 * straight to `createJobQueue` as their `workerCount` (matching that factory's
 * own `() => Promise<number>` shape, not wrapping it in a second identical
 * arrow), and `features/modules/entity-batch` passes it to
 * `lib/parallel.mapWithConcurrency`. Four byte-identical spellings of
 * `Math.max(1, settings.maxParallelRequests)` existed until the duplicate-body
 * tripwire named the three `workerCount` copies as group `7422a6200878f5a8`.
 */
export async function maxParallelWorkers(): Promise<number> {
  const settings = await getSettings();
  return Math.max(1, settings.maxParallelRequests);
}

/**
 * Pure read (no default-row write) — for read-only contexts such as Dexie
 * liveQuery; callers see defaults without persisting them.
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

/**
 * Records `model` as the most recently used GLOBAL first-try chat model
 * (docs/17 row 193). THE ONE recording seam: the read, the merge and the write
 * run inside ONE rw transaction, so two recorders serialize instead of racing
 * a stale read — a component-side read-modify-write would silently lose an
 * entry (AGENTS rule 1). The ordering itself is the ONE pure
 * `withRecentChatModel`; the write rides `updateSettings`, the ONE settings
 * write, so validation and the prompt-styles carry-forward are unchanged. The
 * empty string is not a model and records nothing.
 */
export async function recordRecentChatModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (trimmed === '') return;
  await db.transaction('rw', db.settings, async () => {
    const current = await readSettings();
    await updateSettings({
      recentChatModels: withRecentChatModel(current.recentChatModels, trimmed),
    });
  });
}
