import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

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
 * This pin is a SOURCE SCAN because both halves are invisible to behaviour:
 * a leftover `getBattleByModule` call would re-introduce the singleton the
 * moment a reader resolved through it (and would still pass every test that
 * seeds one battle per module), and a re-added module-wide "Battle table"
 * button renders identically to the encounter card's own button. The needles
 * are the dead identifier, the live resolver population, and the label that
 * must survive in exactly one place.
 */

const SRC_DIR = join(process.cwd(), 'src');

function sourceFiles(dir: string = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Every src file whose text contains `needle`, repo-relative, sorted. */
function filesContaining(needle: string): string[] {
  return sourceFiles()
    .filter((file) => readFileSync(file, 'utf8').includes(needle))
    .map((file) => relative(process.cwd(), file));
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
    const routes = readFileSync(join(process.cwd(), 'src/app/routes.ts'), 'utf8');
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
    const db = readFileSync(join(process.cwd(), 'src/db/db.ts'), 'utf8');
    expect(db).toContain("battles: 'id, campaignId, moduleId, encounterArtifactId'");
    expect(db).toContain('this.version(25)');
  });

  it('leaves no module-wide Battle table entry anywhere', () => {
    // The label survives in exactly ONE place: the chrome breadcrumb that
    // orients the ENCOUNTER route you are on (not an affinity to start one).
    expect(filesContaining('Battle table')).toEqual(['src/app/layout/CampaignBar.tsx']);
    const reader = readFileSync(
      join(process.cwd(), 'src/features/modules/ModuleReaderPage.tsx'),
      'utf8',
    );
    expect(reader).not.toContain('battlePath');
    expect(reader).not.toContain('battle-table-header-link');
    const goTo = readFileSync(
      join(process.cwd(), 'src/features/quickfind/go-to.ts'),
      'utf8',
    );
    expect(goTo).not.toContain('battlePath');
    expect(goTo).not.toContain('Battle table');
  });
});
