import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE ONE model-picking widget (docs/17 rows 193 and 199, docs/18 §2.3).
 *
 * Two "exactly one" statements live here, both SOURCE SCANS because duplicated
 * markup and a duplicated fetch have no behavioural signature until they drift:
 *
 * 1. `features/settings/model-widget.ModelWidget` is the ONE model-picking
 *    component. It folded the deleted `ModelInput` (field variant, every
 *    settings/persona/board/canvas field) and `ModelPicker` (the top-bar trigger)
 *    into one implementation with two surface variants, so a future copy — a
 *    second component or a dropped-through inline picker — reds here. Every
 *    mount site is named by file and count.
 * 2. The account model-id list comes from the ONE `listModelIds` seam; the
 *    recents list is offered (`recentModels`) ONLY at the mounts that edit the
 *    GLOBAL first-try chat model, and the ONE recording seam
 *    (`settingsRepo.recordRecentChatModel`) has exactly one UI caller: the
 *    widget. A persona/image/embedding/fallback field showing or recording
 *    chat recents would lie about what the list means (docs/17 row 199).
 *
 * Two `listModels` callers are deliberately NOT the option seam and are
 * allowlisted BY NAME with their reason: the Settings "Test key" probe (it
 * tests the live endpoint and reports the count, docs/05 §Settings) and
 * `ReasoningEffortSelect` (it needs the full `OpenRouterModel` rows for their
 * reasoning metadata, not ids). Any OTHER file calling `listModels(` reds.
 */

const SRC_DIR = join(process.cwd(), 'src');
const OPTION_SEAM = 'src/features/settings/model-options.ts';
const MODEL_WIDGET = 'src/features/settings/model-widget.tsx';
const SETTINGS_REPO = 'src/db/settingsRepo.ts';
const RUN_ENGINE = 'src/llm/runEngine.ts';

/** The allowlisted `listModels(` call sites: the transport definition plus the
 *  two deliberately-different consumers (see the header). */
const LIST_MODELS_ALLOWLIST: Record<string, number> = {
  'src/llm/openrouter.ts': 1,
  'src/features/settings/model-options.ts': 1,
  'src/features/settings/settings-section.tsx': 1,
  'src/features/settings/reasoning-effort-select.tsx': 1,
};

/**
 * THE whole model-picking mount population (docs/17 row 199). Five Settings
 * fields (global chat, fallback chat, embedding, image, fallback image), the
 * persona override, the Idea Board's per-board model, the dense canvas-chat
 * field, the setup wizard's key-step field, and the top-bar trigger. A new
 * mount anywhere reds, and so does a deleted one.
 */
const WIDGET_MOUNTS: Record<string, number> = {
  'src/app/layout/TopBar.tsx': 1,
  'src/features/idea-board/IdeaBoardPage.tsx': 1,
  'src/features/modules/canvas/ChatSidebar.tsx': 1,
  'src/features/onboarding/SetupWizardDialog.tsx': 1,
  'src/features/settings/persona-section.tsx': 1,
  'src/features/settings/settings-section.tsx': 5,
};

/**
 * The mounts that edit `settings.defaultChatModel` — the ONLY ones allowed to
 * offer or record the global-chat recents. The top bar, the Settings chat-model
 * field (one of the five) and the wizard's key-step field.
 */
const RECENTS_MOUNTS: Record<string, number> = {
  'src/app/layout/TopBar.tsx': 1,
  'src/features/onboarding/SetupWizardDialog.tsx': 1,
  'src/features/settings/settings-section.tsx': 1,
};

/** The files that used to carry a second model-picking component. */
const DELETED_COMPONENTS = [
  'src/features/settings/model-input.tsx',
  'src/features/settings/model-picker.tsx',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the scan is about CODE, and the widget's own docstring
 *  names the shapes it replaced while explaining them. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function countsOf(needle: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const hits = text.split(needle).length - 1;
    if (hits > 0) counts.set(relative(process.cwd(), file), hits);
  }
  return counts;
}

function sorted(map: Map<string, number> | Record<string, number>): [string, number][] {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

describe('one model-picking widget and one account model-id source (SOURCE SCAN, docs/17 rows 193/199)', () => {
  it('routes every model-option list through listModelIds, and no new /models fetch exists', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);

    expect(sorted(countsOf('listModels('))).toEqual(sorted(LIST_MODELS_ALLOWLIST));

    // Non-vacuity for the seam itself: it is defined once and reached by the
    // ONE widget (both variants, every mount), never re-implemented.
    expect([...countsOf('export async function listModelIds(').entries()]).toEqual([
      [OPTION_SEAM, 1],
    ]);
    expect(sorted(countsOf('listModelIds('))).toEqual(
      sorted({ [MODEL_WIDGET]: 1, [OPTION_SEAM]: 1 }),
    );
  });

  it('is the ONE model-picking component, with its whole mount population named by file', () => {
    const files = sourceFiles(SRC_DIR).map((file) => relative(process.cwd(), file));

    // The superseded components are GONE, not wrapped.
    for (const deleted of DELETED_COMPONENTS) {
      expect(files).not.toContain(deleted);
      expect(existsSync(join(process.cwd(), deleted))).toBe(false);
    }
    const code = files
      .map((file) => stripComments(readFileSync(join(process.cwd(), file), 'utf8')))
      .join('\n');
    expect(code).not.toContain('ModelInput');
    expect(code).not.toContain('ModelPicker');

    // Exactly one definition, and every mount is expected and counted.
    expect([...countsOf('export function ModelWidget(').entries()]).toEqual([[MODEL_WIDGET, 1]]);
    expect(sorted(countsOf('<ModelWidget'))).toEqual(sorted(WIDGET_MOUNTS));
    // The widget never mounts itself.
    expect(countsOf('<ModelWidget').get(MODEL_WIDGET)).toBeUndefined();
  });

  it('offers the GLOBAL chat recents only at the mounts that edit the global chat model', () => {
    // `recentModels={` is the placement decision itself: its presence enables the
    // group AND the recording. Exactly the three global-chat mounts pass it.
    expect(sorted(countsOf('recentModels={'))).toEqual(sorted(RECENTS_MOUNTS));

    // The ONE recording seam has exactly one UI caller: the widget's choose.
    // Everything else is the definition and the run funnel (`executeFrom`).
    expect(sorted(countsOf('recordRecentChatModel('))).toEqual(
      sorted({ [MODEL_WIDGET]: 1, [RUN_ENGINE]: 1, [SETTINGS_REPO]: 1 }),
    );
  });

  it('the widget reads the ONE option seam and never listModels directly', () => {
    const text = stripComments(readFileSync(join(process.cwd(), MODEL_WIDGET), 'utf8'));
    expect(text).toContain('listModelIds');
    expect(text).not.toContain('listModels(');
  });
});
