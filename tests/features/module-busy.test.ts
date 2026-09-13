import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';

import { ModuleBusyError } from '@/llm/moduleGen';
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
 *    so the owner read a friendly sentence plus an internal row id);
 * 3. every folded CALL SITE still routes through the helper. Only the board
 *    site is reachable behaviourally (`module-board-rewrite.test.tsx` pins the
 *    mocked `toastError` call), so the other six are held by the SOURCE SCAN
 *    below — named as such rather than pretended into a behavioural pin.
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

/**
 * `entity-panel.tsx` still carries the blocked-control sentence inline
 * (`generateAllBlockedReason`). It is a known remaining copy, NOT a mistake in
 * this pin: that file belongs to a different slice, so this check is a SUBSET
 * (any other holder fails, and the carve-out may be deleted the day it folds).
 */
const KNOWN_REMAINING_COPY = ['features/modules/entity-panel.tsx'];

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
  it('toasts the shared title, WITHOUT the uuid-bearing error message as the detail line', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const busyError = new ModuleBusyError('module-3f2e-91ab-4c77');
    // The id IS the error's own message — so the pin below is not vacuous: the
    // seam has something to leak and does not.
    expect(busyError.message).toContain('module-3f2e-91ab-4c77');

    toastModuleBusy(busyError);

    // ONE argument: no `{ description }` at all. The title already names the
    // state and both ways out, so a description could only restate it or leak
    // the row id.
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(MODULE_BUSY_TOAST_TITLE);
    // Still loud: the raw error is one click away in devtools, not swallowed.
    expect(consoleSpy).toHaveBeenCalledWith(busyError);
    consoleSpy.mockRestore();
  });

  it('drops the uuid for a directly-toasted busy refusal too (the seam, not the helper)', () => {
    // Belt for the same fact at the seam itself: `toastError` is reached with a
    // busy error's object by other paths as well, and the uuid must not reach
    // the owner through any of them.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const busyError = new ModuleBusyError('module-77aa-0b31');

    toastError(MODULE_BUSY_TOAST_TITLE, busyError);

    expect(toastErrorMock).toHaveBeenCalledWith(MODULE_BUSY_TOAST_TITLE);
    expect(consoleSpy).toHaveBeenCalledWith(busyError);
    consoleSpy.mockRestore();
  });
});

describe('module-busy fold', () => {
  it('leaves the toast sentence in exactly ONE source file', () => {
    expect(srcFilesContaining(MODULE_BUSY_TOAST_TITLE)).toEqual([
      'features/modules/module-busy.ts',
    ]);
  });

  it('leaves the blocked-control sentence only in the fold plus the documented carve-out', () => {
    const holders = srcFilesContaining(MODULE_GENERATING_REASON);
    expect(holders).toContain('features/modules/module-busy.ts');
    for (const file of holders) {
      if (file === 'features/modules/module-busy.ts') continue;
      expect(KNOWN_REMAINING_COPY).toContain(file);
    }
    for (const folded of FOLDED_FILES) expect(holders).not.toContain(folded);
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
