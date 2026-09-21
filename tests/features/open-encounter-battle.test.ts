import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnyArtifact, Battle, Id } from '@/domain';
import type * as runBattleSeedModule from '@/features/play/run-battle-seed';

/**
 * THE OPEN-OR-SEED SEAM (docs/17 row 298).
 *
 * `openEncounterBattle` is the ONE implementation of "open this encounter's
 * battle, or seed it the first time". `RunBattleButton` carried it inline until
 * the module text's encounter link and the battle surface's empty state needed
 * the same act; the extraction is only behaviour-preserving if the rules the
 * button had survive here, and they are exactly what these pins measure:
 *
 *  - an EXISTING battle is returned and `runBattle` is NEVER called (the
 *    owner-directed "a press never re-seeds a board" rule, docs/17 row 254);
 *  - no battle ⇒ the seed runs ONCE and the KEY IT NAMED is returned (the
 *    library→adopted-copy hop, docs/17 row 268);
 *  - a FAILED seed returns `null` and stays LOUD (AGENTS rules 1/2) — the
 *    caller must not navigate.
 *
 * `runBattle` is wrapped with the REAL implementation so the failure arm runs
 * the actual catch/toast path; the seed itself (`seedBattleFromEncounter`) and
 * the toast surface are mocked, so no Dexie or Toaster is needed.
 */

vi.mock('@/db/battleRepo', () => ({ getBattleForEncounter: vi.fn() }));
vi.mock('@/db/battleSeed', () => ({ seedBattleFromEncounter: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/features/play/run-battle-seed', async (importOriginal) => {
  const actual = await importOriginal<typeof runBattleSeedModule>();
  return { ...actual, runBattle: vi.fn(actual.runBattle) };
});

const { getBattleForEncounter } = await import('@/db/battleRepo');
const { seedBattleFromEncounter } = await import('@/db/battleSeed');
const { toastError } = await import('@/lib/toast');
const { runBattle } = await import('@/features/play/run-battle-seed');
const { openEncounterBattle } = await import('@/features/play/open-encounter-battle');

const getBattleMock = vi.mocked(getBattleForEncounter);
const seedMock = vi.mocked(seedBattleFromEncounter);
const runBattleMock = vi.mocked(runBattle);
const toastErrorMock = vi.mocked(toastError);

const campaignId: Id = '00000000-0000-4000-8000-0000000000c1';
const moduleId: Id = '00000000-0000-4000-8000-0000000000m1';
const encounter = {
  id: '00000000-0000-4000-8000-0000000000e1',
  kind: 'encounter',
  name: 'Ford Ambush',
} as unknown as AnyArtifact & { kind: 'encounter' };

/** A battle row carrying only the field the seam reads. */
function battleRow(encounterArtifactId: Id | null): Battle {
  return { encounterArtifactId } as Battle;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openEncounterBattle', () => {
  it('returns an EXISTING battle and never re-seeds it (runBattle is not called)', async () => {
    getBattleMock.mockResolvedValue(battleRow('00000000-0000-4000-8000-0000000000a1'));

    const key = await openEncounterBattle({ campaignId, moduleId, encounter });

    expect(key).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(getBattleMock).toHaveBeenCalledTimes(1);
    expect(getBattleMock).toHaveBeenCalledWith(campaignId, encounter.id);
    expect(runBattleMock).not.toHaveBeenCalled();
    expect(seedMock).not.toHaveBeenCalled();
  });

  it('falls back to the clicked encounter when the existing row carries no key', async () => {
    getBattleMock.mockResolvedValue(battleRow(null));

    expect(await openEncounterBattle({ campaignId, moduleId, encounter })).toBe(encounter.id);
    expect(runBattleMock).not.toHaveBeenCalled();
  });

  it('seeds ONCE when there is no battle and returns the key the seed named', async () => {
    getBattleMock.mockResolvedValue(undefined);
    seedMock.mockResolvedValue({
      battle: battleRow('00000000-0000-4000-8000-0000000000ad'),
      statless: [],
    });

    const key = await openEncounterBattle({ campaignId, moduleId, encounter });

    // The key is the seed's own — the ADOPTED copy when the encounter was a
    // library row — never the clicked id unconditionally.
    expect(key).toBe('00000000-0000-4000-8000-0000000000ad');
    expect(runBattleMock).toHaveBeenCalledTimes(1);
    expect(runBattleMock).toHaveBeenCalledWith(campaignId, moduleId, encounter);
    expect(seedMock).toHaveBeenCalledTimes(1);
    expect(seedMock).toHaveBeenCalledWith(campaignId, moduleId, encounter.id);
  });

  it('falls back to the clicked encounter when the fresh seed names no key', async () => {
    getBattleMock.mockResolvedValue(undefined);
    seedMock.mockResolvedValue({ battle: battleRow(null), statless: [] });

    expect(await openEncounterBattle({ campaignId, moduleId, encounter })).toBe(encounter.id);
  });

  it('returns null and stays LOUD when the seed fails, so the caller cannot navigate', async () => {
    getBattleMock.mockResolvedValue(undefined);
    const failure = new Error('the board refused to seed');
    seedMock.mockRejectedValue(failure);

    const key = await openEncounterBattle({ campaignId, moduleId, encounter });

    expect(key).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith('Could not seed the battle', failure);
  });
});
