import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * EVERY site that resolves the GLOBAL first-try chat model, and its decision
 * (docs/17 row 198).
 *
 * Row 193 recorded "the global model was in use" at exactly two sites (the
 * picker's choose and the run funnel), so a model SET IN SETTINGS and used only
 * in module generation, the planner, canvas refine/chat or the Idea Board never
 * reached the top bar's "Recently used" list. This SOURCE SCAN is the population
 * pin the fix could not be complete without: it names every file that resolves
 * `settings.defaultChatModel` (through `resolveChatModel(` or directly) and
 * whether it RECORDS through the ONE in-use seam or is deliberately EXCLUDED
 * with a reason — so a future site cannot silently skip the list, and a
 * NON-GLOBAL tier (persona override, fallback/escalation, image/embedding,
 * per-board or per-session selection) can never be recorded by accident.
 *
 * The reference counts are deliberately exact: a new site, or a new use inside
 * a known one, reds here and must be classified with its reason. `withReason`
 * below also refuses a population entry with no stated decision.
 *
 * The recording seam itself is `llm/recentChatModel.recordGlobalChatModelInUse`
 * (fire-and-forget with its own catch/toast, docs/17 rows 193/198); the WRITE is
 * still `db/settingsRepo.recordRecentChatModel`, whose caller population the
 * sibling scan `one-model-option-source.test.ts` pins (the widget's choose is
 * its only UI caller).
 */

const SRC_DIR = join(process.cwd(), 'src');
const IN_USE_SEAM_FILE = 'src/llm/recentChatModel.ts';

type Decision = 'record' | 'exclude';

interface SiteDecision {
  readonly decision: Decision;
  /** Why this site records, or why it is deliberately excluded. */
  readonly reason: string;
}

/**
 * The whole population: every `src/**` file that mentions `settings.defaultChatModel`
 * or calls `resolveChatModel(` (comments stripped), with its decision. Exact
 * counts are asserted below; these reasons are the written record of WHY.
 */
const DECISIONS: Record<string, SiteDecision> = {
  'src/llm/runEngine.ts': {
    decision: 'record',
    reason:
      'the run funnel: executeFrom records through recordChatModelInUse when resolveChatModel(settings, persona.model) === settings.defaultChatModel. Its other six resolveChatModel( sites are run steps reached only through that funnel (runVisionDungeonMap included, and the statblock step\'s instruction-level read added by docs/17 row 289 with them), so they need no second call; a persona-override or image-mode run is excluded by the funnel comparison itself',
  },
  'src/llm/moduleGen.ts': {
    decision: 'record',
    reason:
      'module generation runs on the global model OUTSIDE the run funnel: the spine pass, the parts pass (which covers rewritePart / generateMissingParts / approveSpineAndRun / createModuleAndRun) and the three normalization entry points (full pass, incremental classify, one-name classify) each record the global model they are about to call. The four repairModel(...) sites are the escalation tier by construction and are EXCLUDED',
  },
  'src/llm/modulePlan.ts': {
    decision: 'record',
    reason: 'the document planner is one global-model chat call outside the run funnel',
  },
  'src/llm/canvasRefine.ts': {
    decision: 'record',
    reason: 'canvas refine is one global-model chat call outside the run funnel',
  },
  'src/llm/canvasChat.ts': {
    decision: 'record',
    reason:
      'canvas chat records ONLY when input.model is unset, because then (and only then) the GLOBAL setting is what answers; a session selection (useCanvasChatStore.setModelSelection, docs/17 row 199) is a different tier and is excluded',
  },
  'src/llm/ideaBoard.ts': {
    decision: 'record',
    reason:
      "the Idea Board records ONLY when board.model is empty, because then the GLOBAL setting is what answers; a per-board model is a different tier and is excluded",
  },
  'src/features/lab/labClients.ts': {
    decision: 'exclude',
    reason:
      'the experiment lab is a diagnostic bench, linked from Settings only and never a generation surface (docs/05 §Routes); its labeled-dungeon vision probe must not enter the user-facing "what I have been generating with" shortlist. Its model IS the global one — the exclusion is about the surface, and this line is where that is stated',
  },
  'src/llm/modelFallback.ts': {
    decision: 'exclude',
    reason: 'the ONE resolver definition itself — it names the tier, it does not start a call',
  },
  'src/domain/settings.ts': {
    decision: 'exclude',
    reason: 'the settings schema and its default — data, not a model call',
  },
  'src/app/layout/TopBar.tsx': {
    decision: 'exclude',
    reason:
      'a mount that EDITS settings.defaultChatModel; a choose records through the widget (docs/17 row 199), never from the field value',
  },
  'src/features/settings/settings-section.tsx': {
    decision: 'exclude',
    reason:
      'edits/displays the setting; its ReasoningEffortSelect reads defaultChatModel for reasoning metadata only (no call). The chat-model field records a CHOOSE through the widget',
  },
  'src/features/settings/persona-section.tsx': {
    decision: 'exclude',
    reason: 'uses the global default as a persona field PLACEHOLDER; the persona tier is never recorded',
  },
  'src/features/modules/canvas/ChatSidebar.tsx': {
    decision: 'exclude',
    reason:
      'displays the effective model (session selection falling back to the global) and edits a SESSION-only selection; the global path is recorded by llm/canvasChat when no session model is set',
  },
  'src/features/onboarding/SetupWizardDialog.tsx': {
    decision: 'exclude',
    reason: 'a mount that EDITS the setting; the choose records through the widget (docs/17 row 199)',
  },
};

/**
 * The exact `resolveChatModel(` / `defaultChatModel` reference counts per file
 * (comments stripped). `resolveChatModel(` counts the CALLS plus its definition;
 * `defaultChatModel` counts every code reference (the resolver's own comparison,
 * a model argument, the helper call, a UI binding, the schema/default).
 */
const RESOLUTION_POPULATION: Record<string, { resolveChatModel: number; defaultChatModel: number }> = {
  'src/app/layout/TopBar.tsx': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/domain/settings.ts': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/features/lab/labClients.ts': { resolveChatModel: 1, defaultChatModel: 0 },
  'src/features/modules/canvas/ChatSidebar.tsx': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/features/onboarding/SetupWizardDialog.tsx': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/features/settings/persona-section.tsx': { resolveChatModel: 0, defaultChatModel: 1 },
  'src/features/settings/settings-section.tsx': { resolveChatModel: 0, defaultChatModel: 3 },
  'src/llm/canvasChat.ts': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/llm/canvasRefine.ts': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/llm/ideaBoard.ts': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/llm/modelFallback.ts': { resolveChatModel: 1, defaultChatModel: 2 },
  'src/llm/moduleGen.ts': { resolveChatModel: 0, defaultChatModel: 15 },
  'src/llm/modulePlan.ts': { resolveChatModel: 0, defaultChatModel: 2 },
  'src/llm/runEngine.ts': { resolveChatModel: 7, defaultChatModel: 1 },
};

/** The ONE in-use recording seam's call population (its definition counts). */
const IN_USE_RECORDERS: Record<string, number> = {
  'src/llm/canvasChat.ts': 1,
  'src/llm/canvasRefine.ts': 1,
  'src/llm/ideaBoard.ts': 1,
  'src/llm/moduleGen.ts': 5,
  'src/llm/modulePlan.ts': 1,
  'src/llm/recentChatModel.ts': 1,
  'src/llm/runEngine.ts': 1,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the scan is about CODE (a docstring may name the model id). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function countsOf(needle: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC_DIR)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const hits = text.split(needle).length - 1;
    if (hits > 0) counts[relative(process.cwd(), file)] = hits;
  }
  return counts;
}

function sorted<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

describe('every global-chat-model resolution site and its recording decision (SOURCE SCAN, docs/17 row 198)', () => {
  it('enumerates the whole resolution population, and every entry states a decision', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);

    const measured: Record<string, { resolveChatModel: number; defaultChatModel: number }> = {};
    for (const [file, count] of Object.entries(countsOf('resolveChatModel('))) {
      measured[file] = { ...(measured[file] ?? { defaultChatModel: 0 }), resolveChatModel: count };
    }
    for (const [file, count] of Object.entries(countsOf('defaultChatModel'))) {
      measured[file] = { ...(measured[file] ?? { resolveChatModel: 0 }), defaultChatModel: count };
    }

    expect(sorted(measured)).toEqual(sorted(RESOLUTION_POPULATION));

    // Each measured file must carry a written decision, and no decision may be
    // left behind for a file that no longer resolves the model.
    expect(Object.keys(DECISIONS).sort()).toEqual(Object.keys(RESOLUTION_POPULATION).sort());
    for (const [file, decision] of Object.entries(DECISIONS)) {
      expect(decision.reason.length, `no reason for ${file}`).toBeGreaterThan(20);
    }
  });

  it('records every recording site through the ONE in-use seam, and no other site', () => {
    expect(sorted(countsOf('recordGlobalChatModelInUse('))).toEqual(sorted(IN_USE_RECORDERS));

    // A file that calls the in-use seam must be a `record` decision — an
    // excluded file (the lab, a UI mount, the resolver) can never record. The
    // seam's own definition is the one non-caller entry in the map.
    for (const file of Object.keys(countsOf('recordGlobalChatModelInUse('))) {
      if (file === IN_USE_SEAM_FILE) continue;
      expect(DECISIONS[file]?.decision, `${file} records without a decision`).toBe('record');
    }
  });

  it('keeps the non-global tiers out: no fallback, image, persona, board or session site records', () => {
    // The escalation tier is never recorded: the four moduleGen repairModel( sites
    // must not have grown an in-use call beside them. The parts pass records the
    // GLOBAL model once; a fallback-model floor repair replaces it per part and
    // is deliberately silent.
    expect(countsOf('recordGlobalChatModelInUse(')['src/llm/moduleGen.ts']).toBe(5);
    // The lab's global-model vision probe stays out (see DECISIONS).
    expect(countsOf('recordGlobalChatModelInUse(')['src/features/lab/labClients.ts']).toBeUndefined();
    // The canvas-chat session selection and the Idea Board's per-board model are
    // conditional at the call site (behaviour pinned in tests/llm/*.test.ts).
    expect(countsOf('recordGlobalChatModelInUse(')['src/llm/canvasChat.ts']).toBe(1);
    expect(countsOf('recordGlobalChatModelInUse(')['src/llm/ideaBoard.ts']).toBe(1);
  });
});
