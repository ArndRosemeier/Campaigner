import { expect, it } from 'vitest';

/**
 * THE ONE BATTLE-VIEW SEAM and THE ONE SCREEN-WAKE-LOCK SITE (docs/17 row
 * 262b, docs/18 §2.3, AGENTS §Centralization obligation 2).
 *
 * Two ideas landed in this slice, and both are the kind that decay invisibly:
 *
 * 1. the persisted VIEW (the player-safe flag, zoom/pan, rail selections) has
 *    exactly ONE reader — `domain/battle/view.resolveBattleView` — and ONE
 *    typed writer — `db/battleRepo.saveBattleView`. A second `safeParse` of the
 *    stored field could disagree about the fail-safe, and a second writer could
 *    persist a partial view; either one re-opens the leak this slice closes.
 * 2. the SCREEN WAKE LOCK has exactly ONE acquisition site. A second
 *    `navigator.wakeLock.request` anywhere (a stray component, a "just in case"
 *    re-request) is a second mechanism for one idea, and the surface's honest
 *    `data-wake-lock` status would stop describing what is actually held.
 *
 * The source list comes from Vite's own `import.meta.glob` with `?raw`: the
 * hand-rolled source walker is a BASELINED multi-site population in this suite
 * (docs/17 row 212), and adding a copy of it would be the very defect this file
 * pins.
 */

const RAW: Record<string, string> = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The `src/` files whose text contains `needle`, repo-relative and sorted.
 * ONE definition: two inlined copies of this body are themselves a duplicate
 * population, and the tripwire (row 212) reds them — as it did on this file's
 * first draft. */
const filesWith = (needle: string): string[] =>
  Object.entries(RAW)
    .filter(([, source]) => source.includes(needle))
    .map(([path]) => path.replace(/^\//, ''))
    .sort();

it('reads and writes the stored battle view through exactly one seam', () => {
  // The schema is DECLARED and PARSED in one module only.
  expect(filesWith('battleViewSchema')).toEqual(['src/domain/battle/view.ts']);
  expect(filesWith('resolveBattleView(')).toEqual([
    'src/domain/battle/view.ts',
    'src/features/play/battle/use-battle-view.ts',
  ]);
  // The persisted field is LENIENT at the row boundary on purpose, and the
  // reason is in the source: a corrupt preference must not fail the battle row.
  expect(RAW['/src/domain/battle.ts']).toContain('view: z.unknown().default(null)');
  // ONE typed writer over the existing row patch path.
  expect(filesWith('saveBattleView(')).toEqual([
    'src/db/battleRepo.ts',
    'src/features/play/battle/use-battle-view.ts',
  ]);
  // The surface consumes the hook's typed fields — it never casts the raw
  // unknown field to what it hopes it is.
  const surface = RAW['/src/features/play/battle/BattleSurface.tsx'];
  expect(surface).toContain('= useBattleView(battle)');
  expect(surface).not.toContain('battle.view as');
  expect(surface).not.toContain('as BattleView');
});

it('acquires the screen wake lock from exactly one site — feature-detected, never imitated', () => {
  // The API read and the request live in ONE module.
  expect(filesWith('navigator as { wakeLock')).toEqual([
    'src/features/play/battle/use-screen-wake-lock.ts',
  ]);
  expect(filesWith("request('screen')")).toEqual([
    'src/features/play/battle/use-screen-wake-lock.ts',
  ]);
  // The ONE listener it re-acquires on is the page-liveness RESUME seam — a
  // file that grew its own visibilitychange listener would show up here.
  expect(RAW['/src/features/play/battle/use-screen-wake-lock.ts']).toContain('onPageResumed(');
  expect(RAW['/src/features/play/battle/use-screen-wake-lock.ts']).not.toContain('addEventListener(');
  // …and the surface publishes the honest status rather than assuming `held`.
  expect(RAW['/src/features/play/battle/BattleSurface.tsx']).toContain(
    'data-wake-lock={wakeLockStatus}',
  );
});
