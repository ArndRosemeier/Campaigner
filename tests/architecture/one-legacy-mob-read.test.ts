import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE ONE legacy-read seam (docs/17 row 248c, AGENTS §Centralization
 * obligation 2).
 *
 * The mob-simplification arc leaves the live model with ONE representation
 * (`inline` / `none`), but the owner-forced failure arm keeps a POINTER on a row
 * the v24 migration could not convert — the start-up retry's only handle — and
 * `anyArtifactSchema` parses every artifact read. So the legacy shape and its
 * resolution must live in exactly ONE module: `domain/mobCopyLegacy`. This pin
 * holds four facts that drift invisibly:
 *
 * 1. the legacy source SHAPE is declared in the seam alone — `domain/artifact`
 *    composes the arms into the read schema instead of re-spelling them;
 * 2. the LIVE resolver (`resolveMonsterEntry`) is called from ONE module, the
 *    seam, so every stored entry reaches the dispatch and no consumer can grow a
 *    private legacy branch;
 * 3. the two NAMED consumers (the v24 migration and the missing-refs banner)
 *    carry no pointer read of their own;
 * 4. the sites that STILL spell a legacy pointer are DECLARED — the deletion's
 *    worklist — so a new one reds, and a cleaned file must delete its entry
 *    (a blessing cannot outlive the duplication).
 *
 * The source list comes from Vite's own `import.meta.glob`, deliberately: the
 * hand-rolled `sourceFiles` walker is a BASELINED multi-site population in this
 * suite (docs/17 row 212), and adding a copy of it would be the very defect this
 * file exists to pin.
 */

const ROOT = process.cwd();

const SOURCES: readonly string[] = Object.keys(import.meta.glob('/src/**/*.{ts,tsx}')).sort();

function repoPath(relativePath: string): string {
  return relativePath.replace(/^\//, '');
}

/** Comments out, whitespace collapsed: every consumer's docstring NAMES the
 * legacy form it no longer spells, and a scan over raw text would red on prose.
 * WHAT a file reads is code, never a comment. */
function codeOf(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

const SEAM = 'src/domain/mobCopyLegacy.ts';
const LIVE_RESOLVER = 'src/domain/encounterResolve.ts';
const MIGRATION = 'src/db/mobCopyRepair.ts';
const BANNER = 'src/features/campaign/components/missing-refs-banner.tsx';
const REPO_WIRED = 'src/db/monsterResolve.ts';

/** The legacy shape's own arm declarations: `z.literal('rulebook')` /
 * `z.literal('npc-ref')`. Only the seam may build them. */
const LEGACY_ARM_LITERAL = /z\.literal\(\s*'(rulebook|npc-ref)'\s*\)/g;

/** The live resolver, called. `resolveMonsterEntryWithRepos(` does NOT match —
 * the needle requires the open paren straight after the name. */
const LIVE_RESOLVER_CALL = /resolveMonsterEntry\(/g;

/** The dispatch every repo-wired reader goes through. */
const STORED_DISPATCH = /resolveStoredMonsterEntry\(/g;

/**
 * THE DELETION WORKLIST (docs/18 §5): every `src/` module that still spells a
 * legacy pointer — a `'rulebook'` / `'npc-ref'` source literal, or a
 * `creatureRef` read. The seam is deliberately in this list (it is where the
 * shape now lives); every other entry is a consumer the pointer-arm deletion has
 * yet to clean. The rot check below reds a file that no longer matches, so
 * cleaning one is a one-line removal from this list rather than a silent stale
 * blessing.
 */
const PENDING_DELETION: readonly string[] = [
  'src/db/artifactAutoPromote.ts',
  'src/db/artifactRepo.ts',
  'src/db/battleSeed.ts',
  'src/db/creatureCitations.ts',
  'src/db/creatureRepair.ts',
  'src/db/creatureRepo.ts',
  'src/db/orphanSweep.ts',
  'src/domain/artifact.ts',
  'src/domain/creature.ts',
  'src/domain/encounterResolve.ts',
  'src/domain/exportDependencies.ts',
  'src/domain/libraryCopy.ts',
  'src/domain/mobCopyLegacy.ts',
  'src/domain/settings.ts',
  'src/features/campaign/components/kind-forms.tsx',
  'src/features/campaign/components/mob-portraits-section.tsx',
  'src/features/campaign/components/monster-source.tsx',
  'src/features/campaign/mob-portrait-participants.ts',
  'src/features/campaign/mob-portrait-queue.ts',
  'src/features/onboarding/onboardingContent.ts',
  'src/features/play/artifact-cards.tsx',
  'src/features/play/battle/BattleSurface.tsx',
  'src/features/play/battle/SpawnPicker.tsx',
  'src/lib/exportImport.ts',
  'src/lib/modulePdf.ts',
  'src/lib/pdfExport.ts',
  'src/llm/canvasChat.ts',
  'src/llm/roomBudget.ts',
  'src/llm/runEngine.ts',
];

/** Does this file's CODE spell a legacy pointer at all? */
function spellsLegacyPointer(relativePath: string): boolean {
  const code = codeOf(relativePath);
  return code.includes("'rulebook'") || code.includes("'npc-ref'") || code.includes('creatureRef');
}

describe('one legacy-read seam (SOURCE SCAN, docs/17 row 248c)', () => {
  it('declares the legacy source arms in the seam and nowhere else', () => {
    // Non-vacuity: the glob sees the whole source tree.
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES.map(repoPath)).toContain(SEAM);

    const offenders = SOURCES.map(repoPath).filter(
      (path) => path !== SEAM && (codeOf(path).match(LEGACY_ARM_LITERAL) ?? []).length > 0,
    );
    expect(offenders).toEqual([]);
    // The seam really builds BOTH arms, so a scan that matched nothing anywhere
    // cannot pass by accident.
    expect((codeOf(SEAM).match(LEGACY_ARM_LITERAL) ?? []).length).toBe(2);
    // `domain/artifact` COMPOSES the arms instead of re-spelling them.
    const artifact = codeOf('src/domain/artifact.ts');
    expect(artifact).toContain('LEGACY_MONSTER_SOURCE_ARMS');
    expect((artifact.match(LEGACY_ARM_LITERAL) ?? []).length).toBe(0);
  });

  it('routes every stored entry through the seam: the live resolver has ONE caller', () => {
    const offenders = SOURCES.map(repoPath).filter((path) => {
      if (path === LIVE_RESOLVER || path === SEAM) return false;
      return (codeOf(path).match(LIVE_RESOLVER_CALL) ?? []).length > 0;
    });
    expect(offenders).toEqual([]);
    // Non-vacuity on both halves: the seam calls the live resolver for the live
    // arm, and it really is the ONLY caller.
    expect((codeOf(SEAM).match(LIVE_RESOLVER_CALL) ?? []).length).toBe(1);
    // ...and the repo-wired reader goes through the dispatch, so the banner,
    // battles, canvas chat and export import all read a stored pointer here.
    expect((codeOf(REPO_WIRED).match(STORED_DISPATCH) ?? []).length).toBe(1);
    expect((codeOf(REPO_WIRED).match(LIVE_RESOLVER_CALL) ?? []).length).toBe(0);
  });

  it('leaves the v24 migration and the missing-refs banner no pointer read of their own', () => {
    const migration = codeOf(MIGRATION);
    expect((migration.match(/storedRulebookCitation\(/g) ?? []).length).toBe(1);
    expect((migration.match(/storedNpcCitation\(/g) ?? []).length).toBe(1);
    expect(spellsLegacyPointer(MIGRATION)).toBe(false);

    const banner = codeOf(BANNER);
    expect((banner.match(/resolveMonsterEntryWithRepos\(/g) ?? []).length).toBe(1);
    expect(spellsLegacyPointer(BANNER)).toBe(false);
  });

  it('declares every module that still spells a legacy pointer — the deletion worklist', () => {
    const offenders = SOURCES.map(repoPath).filter(
      (path) => spellsLegacyPointer(path) && !PENDING_DELETION.includes(path),
    );
    // A NEW site reds here: it is either a copy of the seam's own job or a
    // consumer the deletion must know about, never an accident.
    expect(offenders).toEqual([]);

    // ROT CHECK: a declared file that no longer spells a pointer must drop its
    // entry — a blessing may not outlive the code it blessed.
    const stale = PENDING_DELETION.filter((path) => !spellsLegacyPointer(path));
    expect(stale).toEqual([]);
    // Non-vacuity: the seam is on the list and does spell the shape.
    expect(PENDING_DELETION).toContain(SEAM);
  });
});
