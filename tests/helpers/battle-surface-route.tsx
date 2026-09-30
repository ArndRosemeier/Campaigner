import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

import { listBattlesByModule } from '@/db/battleRepo';
import { db } from '@/db/db';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import type { Battle } from '@/domain';
import { actDrained, flushAsyncUpdates } from './flush';

/**
 * THE shared route render and battle reader for the battle-surface suites
 * (docs/17 row 254; the fold the test-tree duplication inventory declared —
 * `duplicateImplementationsTestsBaseline.json` recorded three copies of
 * `renderSurface` and two of `currentBattle` as debt "folds onto the shared
 * render-route helper").
 *
 * The route names ONE ENCOUNTER (`/c/:campaignId/m/:moduleId/battle/:encounterId`,
 * docs/17 row 254), so a caller that does not name one routes to the encounter
 * the module's battle belongs to — read off the row, which is what keeps the
 * ~150 existing call sites honest without re-deriving a module-keyed path.
 * A module with no battle, or a legacy battle with no provenance, routes to the
 * placeholder id: it resolves no battle and renders the surface's empty state,
 * which is why `expectBoard: false` exists for exactly those cases.
 */

/** A route target that names no battle at all — the surface's empty state. */
export const NO_BATTLE_ENCOUNTER_ID = '00000000-0000-4000-8000-0000000000ff';

export async function renderSurface(
  campaignId: string,
  moduleId: string,
  options: { encounterId?: string; expectBoard?: boolean } = {},
): Promise<void> {
  const target =
    options.encounterId ??
    (await db.battles.where('moduleId').equals(moduleId).first())?.encounterArtifactId ??
    NO_BATTLE_ENCOUNTER_ID;
  render(
    <MemoryRouter initialEntries={[`/c/${campaignId}/m/${moduleId}/battle/${target}`]}>
      <Routes>
        <Route path="/c/:campaignId/m/:moduleId/battle/:encounterId" element={<BattleSurface />} />
      </Routes>
    </MemoryRouter>,
  );
  if (options.expectBoard !== false) {
    await waitFor(() => {
      expect(screen.getByTestId('battle-board')).toBeInTheDocument();
    });
  }
  await flushAsyncUpdates(20);
}

/** The module's battle row, read inside one act drain (a bare Dexie read while
 * a tree is mounted emits its liveQuery update outside act — docs/08 §Console
 * guard). Tests use one battle per module, so `[0]` is unambiguous. */
export async function currentBattle(moduleId: string): Promise<Battle> {
  return actDrained(async () => {
    const [row] = await listBattlesByModule(moduleId);
    if (row === undefined) throw new Error('battle row missing');
    return row;
  });
}
