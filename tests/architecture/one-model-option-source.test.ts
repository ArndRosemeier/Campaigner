import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODE, countsIn } from '../helpers/sourceCode';

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

const OPTION_SEAM = 'src/features/settings/model-options.ts';
const MODEL_WIDGET = 'src/features/settings/model-widget.tsx';
const SETTINGS_REPO = 'src/db/settingsRepo.ts';
const RECENT_CHAT_MODEL = 'src/llm/recentChatModel.ts';

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
  // 2 since docs/17 row 420: the global chat model AND the global image model
  // (the image trigger carries no recents — see RECENTS_MOUNTS below).
  'src/app/layout/TopBar.tsx': 2,
  'src/features/idea-board/IdeaBoardPage.tsx': 1,
  'src/features/modules/canvas/ChatSidebar.tsx': 2,
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

/** Comments are skipped (`CODE`): the scan is about CODE, and the widget's own
 *  docstring names the shapes it replaced while explaining them. */
function countsOf(needle: string): Map<string, number> {
  return new Map(countsIn(CODE, 'src/', needle));
}

function sorted(map: Map<string, number> | Record<string, number>): [string, number][] {
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

describe('one model-picking widget and one account model-id source (SOURCE SCAN, docs/17 rows 193/199)', () => {
  it('routes every model-option list through listModelIds, and no new /models fetch exists', () => {
    const files = Object.keys(CODE);
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
    const files = Object.keys(CODE);

    // The superseded components are GONE, not wrapped.
    for (const deleted of DELETED_COMPONENTS) {
      expect(files).not.toContain(deleted);
      expect(existsSync(join(process.cwd(), deleted))).toBe(false);
    }
    const code = Object.values(CODE).join('\n');
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
    // Everything else is the definition and the ONE in-use recording seam
    // (`llm/recentChatModel.recordGlobalChatModelInUse`, docs/17 row 198), which
    // every non-UI global-model path calls — the run funnel included.
    expect(sorted(countsOf('recordRecentChatModel('))).toEqual(
      sorted({ [MODEL_WIDGET]: 1, [RECENT_CHAT_MODEL]: 1, [SETTINGS_REPO]: 1 }),
    );
  });

  it('the widget reads the ONE option seam and never listModels directly', () => {
    const text = CODE[MODEL_WIDGET] ?? '';
    expect(text).toContain('listModelIds');
    expect(text).not.toContain('listModels(');
  });
});
