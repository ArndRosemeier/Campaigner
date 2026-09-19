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
    expect(filesContaining('getBattleByEncounter(')).toEqual([
      'src/db/battleRepo.ts',
      'src/db/battleSeed.ts',
      'src/features/play/battle/use-battle.ts',
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
    // `battlePath(` is the ROUTE BUILDER plus the encounter card's own button.
    // A module reader link here is the removed global affordance returning.
    expect(filesContaining('battlePath(')).toEqual([
      'src/app/routes.ts',
      'src/features/play/run-battle.tsx',
    ]);
    // The dropped Dexie uniqueness: a module may hold one board per encounter.
    // The historical version blocks keep their own (immutable) schemas — the
    // file's own rule — so this pins the LIVE v25 shape; the runtime half (two
    // rows in one module, both resolving by encounter) is
    // tests/db/migration.test.ts.
    const db = readFileSync(join(ROOT, 'src/db/db.ts'), 'utf8');
    expect(db).toContain("battles: 'id, campaignId, moduleId, encounterArtifactId'");
    expect(db).toContain('this.version(25)');
  });

  it('leaves no module-wide Battle table entry anywhere', () => {
    // The label survives in exactly ONE place: the chrome breadcrumb that
    // orients the ENCOUNTER route you are on (not an affinity to start one).
    expect(filesContaining('Battle table')).toEqual(['src/app/layout/CampaignBar.tsx']);
    const reader = readFileSync(join(ROOT, 'src/features/modules/ModuleReaderPage.tsx'), 'utf8');
    expect(reader).not.toContain('battlePath');
    expect(reader).not.toContain('battle-table-header-link');
    const goTo = readFileSync(join(ROOT, 'src/features/quickfind/go-to.ts'), 'utf8');
    expect(goTo).not.toContain('battlePath');
    expect(goTo).not.toContain('Battle table');
  });
});
