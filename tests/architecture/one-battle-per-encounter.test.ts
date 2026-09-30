import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A BATTLE BELONGS TO ITS ENCOUNTER (docs/17 row 254, owner report
 * 2026-09-19): *"i did the same with ANOTHER encounter and opened the battle
 * from its card. I got the OLD encounter again… Lets get rid of the global
 * encounter."*
 *
 * The measured defect was a module-keyed singleton: ONE battle row per MODULE
 * (`getBattleByModule`), a module-keyed route, and `Battle.encounterArtifactId`
 * read only as provenance. The fix makes the encounter the identity — a second
 * encounter in one module owns a second board — and removes every MODULE-WIDE
 * affordance that implied a single "module's battle".
 *
 * This pin is a SOURCE SCAN because both halves are invisible to behaviour: a
 * leftover `getBattleByModule` call would re-introduce the singleton the moment
 * a reader resolved through it (and would still pass every test that seeds one
 * battle per module), and a re-added module-wide "Battle table" button renders
 * identically to the encounter card's own button. The needles are the dead
 * identifier, the live resolver population, and the label that must survive in
 * exactly one place.
 *
 * The source list comes from Vite's own `import.meta.glob`, deliberately: the
 * hand-rolled `sourceFiles` walker is a BASELINED multi-site population in this
 * suite (docs/17 row 212), and adding a copy of it would be the very defect
 * this file exists to pin.
 */

const ROOT = process.cwd();
const SRC_FILES: readonly string[] = Object.keys(import.meta.glob('/src/**/*.{ts,tsx}'))
  .map((path) => path.replace(/^\//, ''))
  .sort();

/** Every src file whose text contains `needle`, repo-relative, sorted. */
function filesContaining(needle: string): string[] {
  return SRC_FILES.filter((file) => readFileSync(join(ROOT, file), 'utf8').includes(needle));
}

describe('one battle per ENCOUNTER (SOURCE SCAN)', () => {
  it('has exactly one resolver and one creator, both keyed by the encounter', () => {
    // The module-keyed seam is GONE. `getBattleByModule` surviving anywhere
    // would quietly restore the singleton; the module-keyed `ensureBattle(`
    // creator is gone with it.
    expect(filesContaining('getBattleByModule')).toEqual([]);
    expect(filesContaining('ensureBattle(')).toEqual([]);
    // The IDENTITY lookup (docs/17 row 254): one keyed read, used by the
    // creator and by the seed. The UI never calls it directly any more — a
    // LIBRARY encounter card has no battle keyed to it (docs/17 row 268), so
    // the affordances go through the ONE adoption-aware resolver below.
    expect(filesContaining('getBattleByEncounter(')).toEqual([
      'src/db/battleRepo.ts',
      'src/db/battleSeed.ts',
    ]);
    // The ENCOUNTER→BATTLE resolver the route and the Run-battle button use
    // (docs/17 row 268): the keyed lookup PLUS the one campaign-copy hop, so a
    // battle seeded from a LIBRARY encounter opens from that card and from a
    // URL typed before the v29 re-key. A second hop written anywhere else reds
    // here. `run-battle.tsx` reads it for the button's LABEL only (docs/17 row
    // 298) — the press itself asks the ONE open-or-seed seam below.
    expect(filesContaining('getBattleForEncounter(')).toEqual([
      'src/db/battleRepo.ts',
      'src/features/play/battle/use-battle.ts',
      'src/features/play/open-encounter-battle.ts',
      'src/features/play/run-battle.tsx',
    ]);
    expect(filesContaining('ensureBattleForEncounter(')).toEqual([
      'src/db/battleRepo.ts',
      'src/db/battleSeed.ts',
    ]);
    // The ONE module-keyed read left is a LIST (a module may own several
    // boards), used by the module PDF's per-encounter map lookup.
    expect(filesContaining('listBattlesByModule(')).toEqual([
      'src/db/battleRepo.ts',
      'src/lib/modulePdf.ts',
    ]);
  });

  it('routes by encounter, and the encounter card is the only navigation into it', () => {
    const routes = readFileSync(join(ROOT, 'src/app/routes.ts'), 'utf8');
    expect(routes).toContain("battle: '/c/:campaignId/m/:moduleId/battle/:encounterId'");
    // `battlePath(` is the ROUTE BUILDER plus the three ENCOUNTER-keyed entries
    // (docs/17 row 298): the card's own button, the module text's encounter
    // link, and the battle surface's empty state — each one navigates to the
    // key the ONE open-or-seed seam answered. A module-wide "Battle table" link
    // here is the removed global affordance returning.
    expect(filesContaining('battlePath(')).toEqual([
      'src/app/routes.ts',
      'src/features/modules/ModuleReaderPage.tsx',
      'src/features/play/battle/BattleSurface.tsx',
      'src/features/play/run-battle.tsx',
    ]);
    // The dropped Dexie uniqueness: a module may hold one board per encounter.
    // The clean cut collapsed every historical version block into ONE
    // `version(31)` (docs/17 row 278), so the LIVE shape is pinned by the SINGLE
    // declaration and its store line; the runtime half (two rows in one module,
    // both resolving by encounter) is `tests/db/battleSeed.test.tsx`.
    const db = readFileSync(join(ROOT, 'src/db/db.ts'), 'utf8');
    expect(db).toContain("battles: 'id, campaignId, moduleId, encounterArtifactId'");
    expect(db).toContain('.version(DECLARED_DB_VERSION)');
  });

  it('opens-or-seeds a battle through ONE seam, used by its three callers', () => {
    // The open-or-seed ACT is ONE seam (docs/17 row 298): the encounter card's
    // button, the module text's encounter link and the battle surface's empty
    // state all call it. A second open/seed implementation — or a caller that
    // reaches the seed itself — reds here.
    expect(filesContaining('openEncounterBattle(')).toEqual([
      'src/features/modules/ModuleReaderPage.tsx',
      'src/features/play/battle/BattleSurface.tsx',
      'src/features/play/open-encounter-battle.ts',
      'src/features/play/run-battle.tsx',
    ]);
    // The seed action is reached by the open-or-seed seam and by the IN-BATTLE
    // destructive Reseed alone (docs/17 row 254): a prose click or a stale deep
    // link must never seed through a second path.
    expect(filesContaining('runBattle(')).toEqual([
      'src/features/play/battle/BattleSurface.tsx',
      'src/features/play/open-encounter-battle.ts',
      'src/features/play/run-battle-seed.ts',
    ]);
  });

  it('gates the battle header’s encounter-card affordance on a real encounter key', () => {
    // The affordance added by docs/17 row 298 is a DECLARED gate, not a
    // behavioural one: a board whose `encounterArtifactId` is null is
    // UNREACHABLE by route (docs/17 row 254 — `getBattleForEncounter` can only
    // answer a row keyed to the encounter the route names), so no rendered
    // fixture can produce that board. The gate and the destination are
    // therefore pinned at the source; the POINTS-AT half IS behavioural
    // (`open-encounter-card`'s href is asserted in `battle-surface.test.tsx`).
    const surface = readFileSync(join(ROOT, 'src/features/play/battle/BattleSurface.tsx'), 'utf8');
    expect(surface).toContain('{encounterArtifactId !== null && (');
    expect(surface).toContain('data-testid="open-encounter-card"');
    expect(surface).toContain('artifactPath(campaignId, encounterArtifactId)');
  });

  it('leaves no module-wide Battle table entry anywhere', () => {
    // The label survives in exactly ONE place: the chrome breadcrumb that
    // orients the ENCOUNTER route you are on (not an affinity to start one).
    expect(filesContaining('Battle table')).toEqual(['src/app/layout/CampaignBar.tsx']);
    // The reader DOES name `battlePath` now — as the destination of an
    // encounter LINK in the prose (docs/17 row 298), never as a module-wide
    // table entry. The header chrome stays clean, which is the claim here.
    const reader = readFileSync(join(ROOT, 'src/features/modules/ModuleReaderPage.tsx'), 'utf8');
    expect(reader).not.toContain('battle-table-header-link');
    const goTo = readFileSync(join(ROOT, 'src/features/quickfind/go-to.ts'), 'utf8');
    expect(goTo).not.toContain('battlePath');
    expect(goTo).not.toContain('Battle table');
  });
});
