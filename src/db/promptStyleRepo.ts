import { newId, promptStyleSchema, userPromptStyleSchema, validatePromptStyleTemplate, type PromptStyle } from '@/domain';
import { getSettings, readPromptStyles, updateSettings } from '@/db/settingsRepo';
import { BUILTIN_PROMPT_STYLES, builtinPromptStyle } from '@/llm/promptStyles';

/**
 * The user's module prompt styles (docs/17 row 86).
 *
 * STORAGE DECISION: styles live on the settings ROW (`settings.promptStyles`),
 * not in a Dexie table, and the reasons are concrete:
 *
 * - the app default is a settings PREFERENCE anyway, so the selection and the
 *   texts are read through ONE seam — the composer's creation path already
 *   reads settings, so a style never needs a second, differently-failing read;
 * - a style is a few KB of text and the row already carries a comparable
 *   per-feature object (`newModuleDraft`), while module rows carry whole module
 *   documents — this is in line with what the app already stores in a row;
 * - a Dexie table would mean a version bump plus a migration golden for a
 *   few KB of authored text, and the repo is in a testing phase: ceremony is
 *   not the blocker, but it is not free either, and the version bump is not
 *   needed for correctness here;
 * - backup/export already carries the settings row (a new table would have to
 *   be added to the restore's OPTIONAL_TABLES list as well), and no wipe path
 *   touches the settings row — campaign and generated-content wipes are
 *   campaign-scoped, so authored styles survive them like the rest of settings.
 *
 * The one hazard of a single shared row is a settings write clobbering styles:
 * `settingsRepo.updateSettings` carries a field it does not own forward
 * VERBATIM (see the comment there), so this repo is the only writer of
 * `promptStyles` and a write that cannot read the stored blob fails loudly
 * instead of replacing it.
 *
 * Built-ins are NOT stored: they ship in code and are immutable, and every
 * write here touches the user's list only.
 */

/** The styles a surface can choose from: the built-ins first, then the user's. */
export interface PromptStyleCatalog {
  builtins: readonly PromptStyle[];
  user: readonly PromptStyle[];
  /** The app default's id (may name a style that no longer exists). */
  defaultStyleId: string;
  /** Set when the stored user styles could not be read (never silently empty). */
  error: Error | null;
}

/** Built-ins plus the user's styles, in display order. */
export function catalogStyles(catalog: PromptStyleCatalog): readonly PromptStyle[] {
  return [...catalog.builtins, ...catalog.user];
}

/** One style of a catalog by id, or undefined. */
export function catalogStyle(catalog: PromptStyleCatalog, id: string): PromptStyle | undefined {
  return catalogStyles(catalog).find((style) => style.id === id);
}

/** Reads the catalog: built-ins from code, the app default and user styles from settings. */
export async function readPromptStyleCatalog(defaultStyleId: string): Promise<PromptStyleCatalog> {
  const stored = await readPromptStyles();
  return {
    builtins: BUILTIN_PROMPT_STYLES,
    user: stored.styles ?? [],
    defaultStyleId,
    error: stored.error,
  };
}

/** The stored user styles, or a loud failure — every write path starts here. */
async function writableStyles(): Promise<PromptStyle[]> {
  const stored = await readPromptStyles();
  if (stored.error !== null) {
    throw new Error(
      `Your saved prompt styles could not be read (${stored.error.message}), so nothing was written. ` +
        'Use “Discard unreadable styles” in Settings → Module prompt styles to start over.',
    );
  }
  return [...(stored.styles ?? [])];
}

/** Validates a style before it is stored: name, template and every clause. */
function assertSavable(style: PromptStyle): void {
  if (style.name.trim() === '') throw new Error('A prompt style needs a name');
  const issues = validatePromptStyleTemplate(style.templateText);
  if (issues.length > 0) {
    throw new Error(`“${style.name}” cannot be saved: ${issues.join(' ')}`);
  }
}

/**
 * Writes the whole user list (one atomic settings write). Names must be unique
 * across the picker — against the built-ins AND against each other — because
 * the New Module select shows names, and two identical ones are a choice the
 * user cannot make.
 */
async function writeStyles(styles: readonly PromptStyle[]): Promise<void> {
  for (const style of styles) assertSavable(style);
  const taken = new Map<string, string>();
  for (const builtin of BUILTIN_PROMPT_STYLES) taken.set(builtin.name.toLowerCase(), builtin.name);
  for (const style of styles) {
    const key = style.name.trim().toLowerCase();
    const clash = taken.get(key);
    if (clash !== undefined) {
      throw new Error(`A prompt style called “${clash}” already exists — pick another name`);
    }
    taken.set(key, style.name);
  }
  const valid = styles.map((style) => userPromptStyleSchema.parse(style));
  await updateSettings({ promptStyles: valid });
}

/** A free name for a copy: "X (copy)", then "X (copy 2)", "X (copy 3)"… */
function freeCopyName(source: PromptStyle, styles: readonly PromptStyle[]): string {
  const taken = new Set([
    ...BUILTIN_PROMPT_STYLES.map((style) => style.name.toLowerCase()),
    ...styles.map((style) => style.name.toLowerCase()),
  ]);
  const base = `${source.name.trim()} (copy)`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let nth = 2; nth < 100; nth += 1) {
    const candidate = `${base} ${String(nth)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Cannot find a free name for a copy of “${source.name}”`);
}

/**
 * Duplicates a style into a new user style. The copy records `basedOn`, so
 * "reset to the source" stays available afterwards.
 */
export async function duplicatePromptStyle(source: PromptStyle, name?: string): Promise<PromptStyle> {
  const styles = await writableStyles();
  const now = Date.now();
  const copy = promptStyleSchema.parse({
    id: newId(),
    name: name?.trim() ?? freeCopyName(source, styles),
    origin: 'user',
    basedOn: source.id,
    version: 1,
    templateText: source.templateText,
    createdAt: now,
    updatedAt: now,
  });
  assertSavable(copy);
  await writeStyles([...styles, copy]);
  return copy;
}

/** Creates an empty-to-edit user style (no source): the editor fills the template. */
export async function createPromptStyle(input: {
  name: string;
  templateText: string;
  basedOn?: string;
}): Promise<PromptStyle> {
  const styles = await writableStyles();
  const now = Date.now();
  const created = promptStyleSchema.parse({
    id: newId(),
    name: input.name.trim(),
    origin: 'user',
    ...(input.basedOn === undefined ? {} : { basedOn: input.basedOn }),
    version: 1,
    templateText: input.templateText,
    createdAt: now,
    updatedAt: now,
  });
  assertSavable(created);
  await writeStyles([...styles, created]);
  return created;
}

/**
 * Saves a user style's name and template. The VERSION is bumped whenever the
 * template text changed and only then: version = the template generation a
 * module records, which is exactly what the "adopt the current text" action
 * compares against.
 */
export async function savePromptStyle(
  id: string,
  patch: { name?: string; templateText?: string },
): Promise<PromptStyle> {
  const styles = await writableStyles();
  const current = styles.find((style) => style.id === id);
  if (current === undefined) {
    throw new Error(`The prompt style to save no longer exists (${id})`);
  }
  const templateText = patch.templateText ?? current.templateText;
  const changed = templateText !== current.templateText;
  const next = promptStyleSchema.parse({
    ...current,
    name: (patch.name ?? current.name).trim(),
    templateText,
    version: changed ? current.version + 1 : current.version,
    updatedAt: Date.now(),
  });
  assertSavable(next);
  await writeStyles(styles.map((style) => (style.id === id ? next : style)));
  return next;
}

/** Deletes a user style. Modules that recorded it keep their own copy of the text. */
export async function deletePromptStyle(id: string): Promise<void> {
  const styles = await writableStyles();
  if (!styles.some((style) => style.id === id)) {
    throw new Error(`The prompt style to delete no longer exists (${id})`);
  }
  await writeStyles(styles.filter((style) => style.id !== id));
}

/**
 * Resets a style to the CURRENT text of the style it was based on. The source
 * is the user style's `basedOn`; a style without one cannot be reset, and the
 * caller is told so rather than guessing a source.
 */
export async function resetPromptStyleToSource(id: string): Promise<PromptStyle> {
  const styles = await writableStyles();
  const target = styles.find((style) => style.id === id);
  if (target === undefined) {
    throw new Error(`The prompt style to reset no longer exists (${id})`);
  }
  const basedOn = target.basedOn;
  if (basedOn === undefined) {
    throw new Error(`“${target.name}” was not based on another style, so there is nothing to reset it to`);
  }
  const source = builtinPromptStyle(basedOn) ?? styles.find((style) => style.id === basedOn);
  if (source === undefined) {
    throw new Error(`The style “${target.name}” was based on "${basedOn}", which no longer exists`);
  }
  return savePromptStyle(id, { templateText: source.templateText });
}

/**
 * Sets the app-default style. The id must resolve — a default that points at
 * nothing would fail later, at creation time, where the user cannot see why —
 * so the catalog is re-read HERE rather than trusted from a render.
 */
export async function setDefaultPromptStyle(id: string): Promise<void> {
  const settings = await getSettings();
  const catalog = await readPromptStyleCatalog(settings.defaultPromptStyleId);
  const style = catalogStyle(catalog, id);
  if (style === undefined) {
    throw new Error(`Cannot make "${id}" the default: that style does not exist`);
  }
  await updateSettings({ defaultPromptStyleId: style.id });
}

/**
 * Discards the stored styles blob after an unreadable read, so the user is not
 * stuck: this is the ONE explicit way out, it writes an empty list, and the
 * caller states the consequence before it runs.
 */
export async function discardUnreadablePromptStyles(): Promise<void> {
  await updateSettings({ promptStyles: [] });
}
