import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';

import { ModuleBusyError } from '@/llm/moduleGen';
import { claimModuleGeneration, releaseModuleGeneration } from '@/llm/canvasBusy';
import { toastError } from '@/lib/toast';
import {
  MODULE_BUSY_TOAST_TITLE,
  MODULE_GENERATING_REASON,
  toastModuleBusy,
} from '@/features/modules/module-busy';

/**
 * "This module already has a generation running" is ONE condition with TWO
 * audiences, and this file pins both halves (docs/18 §2.3, docs/17 row 120).
 *
 * The audit found the condition written out SEVEN times as a toast literal
 * (ChatSidebar ×2, CanvasPage ×4, BoardPage ×1) and THREE times as a private
 * `MODULE_GENERATING_REASON` constant (CanvasPage, spine-checkpoint,
 * boardNodes). They are fold sites now: the sentences live in
 * `src/features/modules/module-busy.ts`, and the pins below hold the fold
 * closed from three directions —
 *
 * 1. the exported sentences are BYTE-IDENTICAL to the literals they replaced
 *    (a fold, never a reword) and deliberately NOT the same string as each
 *    other (a refused ACTION and a blocked CONTROL are different questions);
 * 2. the helper's user-visible outcome is pinned through the REAL toast seam:
 *    the shared title, and NO uuid-bearing description (the audit found
 *    `Module 3f2… is already generating` rendering as this toast's detail line,
 *    so the owner read a friendly sentence plus an internal row id). docs/17 row
 *    123 reworded that message into a sentence and moved the id into a
 *    structural `moduleId` field — the DESCRIPTION is still dropped on purpose
 *    (the title already says it), so the pin now asserts the id is ON the error
 *    and NOT in its message, and a separate pin drives the REAL refusal path
 *    (`llm/canvasBusy`'s second claim) to prove the sentence the owner meets;
 * 3. every folded CALL SITE still routes through the helper. Only the board
 *    site is reachable behaviourally (`module-board-rewrite.test.tsx` pins the
 *    mocked `toastError` call), so the other six are held by the SOURCE SCAN
 *    below — named as such rather than pretended into a behavioural pin.
 *
 * docs/17 row 123 folded the FOURTH copy of the blocked-control sentence
 * (`entity-panel.tsx`'s `generateAllBlockedReason`, the one carve-out this file
 * used to carry as a SUBSET check) and then made that check an EQUALITY: the
 * sentence is now stated in exactly one source file. Measured under the fold:
 * reverting `entity-panel.tsx` to the inline literal leaves all 19
 * `generate-everything.test.tsx` pins GREEN (byte-identical copy) and REDs ONLY
 * the equality scan, while changing that one executing line to a different
 * sentence REDs the panel's own title/reason pin and leaves the scan green. The
 * two halves reach different failures, which is why both exist.
 */

const toastErrorMock = vi.mocked(toast.error);

afterEach(() => {
  vi.clearAllMocks();
});

/** The five source files this slice folded (the seventh site lives in BoardPage). */
const FOLDED_FILES = [
  'features/modules/canvas/ChatSidebar.tsx',
  'features/modules/canvas/CanvasPage.tsx',
  'features/modules/board/BoardPage.tsx',
  'features/modules/board/boardNodes.tsx',
  'features/modules/spine-checkpoint.tsx',
];

/** How many `instanceof ModuleBusyError` branches each folded file must route
 * through the helper — a COUNT, not a `>= 0`: a new busy catch site that
 * forgets the helper, or a helper call that grows a second call site silently,
 * fails here with the file named. */
const ROUTED_SITES_PER_FILE: Record<(typeof FOLDED_FILES)[number], number> = {
  'features/modules/canvas/ChatSidebar.tsx': 2,
  'features/modules/canvas/CanvasPage.tsx': 4,
  'features/modules/board/BoardPage.tsx': 1,
  'features/modules/board/boardNodes.tsx': 0,
  'features/modules/spine-checkpoint.tsx': 0,
};

function srcFilesContaining(snippet: string): string[] {
  const root = join(process.cwd(), 'src');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (readFileSync(full, 'utf8').includes(snippet)) {
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe('module-busy sentences', () => {
  it('are byte-identical to the literals the fold replaced', () => {
    // The independent copies below are deliberate: a test that imported the
    // literal from the same module it checks would move with the source and pin
    // nothing.
    expect(MODULE_BUSY_TOAST_TITLE).toBe(
      'A generation is already running for this module — wait for it or stop it first',
    );
    expect(MODULE_GENERATING_REASON).toBe(
      'The module is generating right now — wait for it (or press Stop).',
    );
  });

  it('stay two DIFFERENT sentences (a refused action is not a blocked control)', () => {
    // Collapsing them is the failure this pin exists for: a disabled control
    // has no action to have been refused, and a refusal toast states nothing
    // about a control.
    expect(MODULE_BUSY_TOAST_TITLE).not.toBe(MODULE_GENERATING_REASON);
    expect(MODULE_BUSY_TOAST_TITLE.startsWith('A generation is already running')).toBe(true);
    expect(MODULE_GENERATING_REASON.startsWith('The module is generating right now')).toBe(true);
  });
});

describe('toastModuleBusy', () => {
  it("toasts the shared title, WITHOUT the refusal's own sentence as the detail line", () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const busyError = new ModuleBusyError('module-3f2e-91ab-4c77');
    // The branch fires on the class's NAME — pinned on the REAL class, so this
    // is the non-vacuity that belongs to the SUPPRESSION (the message contract
    // itself is pinned in the ModuleBusyError describe below, and
    // `lib/toast.test.ts` proves a plain Error's description still passes
    // through byte-identical, so the seam is not dropping descriptions for
    // everything).
    expect(busyError.name).toBe('ModuleBusyError');

    toastModuleBusy(busyError);

    // ONE argument: no `{ description }` at all. The title already names the
    // state and both ways out, so the refusal's own sentence as a description
    // would say the same thing twice in one toast.
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(MODULE_BUSY_TOAST_TITLE);
    // Still loud: the raw error is one click away in devtools, not swallowed.
    expect(consoleSpy).toHaveBeenCalledWith(busyError);
    consoleSpy.mockRestore();
  });

  it('drops the description for a directly-toasted busy refusal too (the seam, not the helper)', () => {
    // Belt for the same fact at the seam itself: `toastError` is reached with a
    // busy error's object by other paths as well, and the seam's own decision
    // (no description for this class) must hold through all of them.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const busyError = new ModuleBusyError('module-77aa-0b31');

    toastError(MODULE_BUSY_TOAST_TITLE, busyError);

    expect(toastErrorMock).toHaveBeenCalledWith(MODULE_BUSY_TOAST_TITLE);
    expect(consoleSpy).toHaveBeenCalledWith(busyError);
    consoleSpy.mockRestore();
  });
});

/**
 * docs/17 row 123: `ModuleBusyError`'s message is a SENTENCE for the owner, and
 * the row id it used to spell out rides STRUCTURALLY (`moduleId`). The expected
 * sentence below is an independent copy (never imported) so this pin moves only
 * when the source does, and the pin drives the REAL refusal path (the shared
 * registry's second claim), not a hand-built error.
 */
describe('ModuleBusyError', () => {
  const MODULE_ID = 'module-3f2e-91ab-4c77';
  const OWNER_SENTENCE =
    'This module is already generating — wait for it to finish or stop it first.';

  it('states a sentence for the owner, and carries the row id structurally', () => {
    const direct = new ModuleBusyError(MODULE_ID);
    expect(direct.message).toBe(OWNER_SENTENCE);
    expect(direct.message).not.toContain(MODULE_ID);
    expect(direct.moduleId).toBe(MODULE_ID);
    // The toast seam recognises the class BY NAME — the reword must not touch it.
    expect(direct.name).toBe('ModuleBusyError');

    // The refusal the owner actually meets is thrown by the shared registry.
    claimModuleGeneration(MODULE_ID);
    try {
      let caught: unknown;
      try {
        claimModuleGeneration(MODULE_ID);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ModuleBusyError);
      const busy = caught as ModuleBusyError;
      expect(busy.message).toBe(OWNER_SENTENCE);
      expect(busy.message).not.toContain(MODULE_ID);
      expect(busy.moduleId).toBe(MODULE_ID);
    } finally {
      releaseModuleGeneration(MODULE_ID);
    }
  });
});

describe('module-busy fold', () => {
  it('leaves the toast sentence in exactly ONE source file', () => {
    expect(srcFilesContaining(MODULE_BUSY_TOAST_TITLE)).toEqual([
      'features/modules/module-busy.ts',
    ]);
  });

  it('leaves the blocked-control sentence in exactly ONE source file', () => {
    // EQUALITY, not a subset: it was a SUBSET while `entity-panel.tsx` still
    // carried the sentence inline (a concurrent slice owned that file), and an
    // assertion shaped to tolerate the fourth copy must not outlive it — the
    // sentence is now stated in exactly one source file, and any new copy REDs
    // here with its path named.
    expect(srcFilesContaining(MODULE_GENERATING_REASON)).toEqual([
      'features/modules/module-busy.ts',
    ]);
  });

  it('routes every folded busy catch site through toastModuleBusy (SOURCE SCAN)', () => {
    for (const file of FOLDED_FILES) {
      const text = readFileSync(join(process.cwd(), 'src', file), 'utf8');
      expect(text).not.toContain(MODULE_BUSY_TOAST_TITLE);
      const lines = text.split('\n');
      let routed = 0;
      lines.forEach((line, index) => {
        if (!line.includes('instanceof ModuleBusyError')) return;
        // The branch body is the next three lines (a comment may sit between).
        const branch = lines.slice(index, index + 4).join('\n');
        expect(
          branch,
          `${file}:${String(index + 1)} handles ModuleBusyError without toastModuleBusy`,
        ).toContain('toastModuleBusy(');
        routed += 1;
      });
      expect(routed, `${file}: busy catch sites routed`).toBe(ROUTED_SITES_PER_FILE[file]);
    }
  });
});
