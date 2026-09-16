import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one signal per auto-heightened spell kind (docs/17 rows 189/191/194;
 * docs/18 §2.1). A PF2e cantrip is the source's own `cantrip` TRAIT — a
 * cantrip and a rank-1 spell BOTH store `system.level.value: 1`, so the level
 * is never the PF2e signal (docs/17 row 181). A dnd5e cantrip is the OPPOSITE
 * case (row 194): the system's own `system.level === 0` IS the signal and
 * there is no trait at all, so the 5e lane reads the level through ONE
 * predicate (`dnd5eSpellIsCantrip`) and NEVER through the PF2e one. A
 * non-cantrip PF2e FOCUS spell is the `focus` TRAIT (docs/17 row 191):
 * upstream's `SpellPF2e.isFocusSpell` also folds a tradition-less cantrip in,
 * but a cantrip is auto-heightened anyway, so the trait is the ONE thing a
 * focus spell adds. Each signal has ONE predicate in `domain/spellData.ts` /
 * `ingest/packs/dnd5e-foundry.ts`, read by the rules lane, the bestiary lane,
 * the heightening rule and the mob resolver.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-spelled `.includes('cantrip')` / `.includes('focus')` answers identically
 * today and diverges the day the signal changes — the exact class AGENTS'
 * centralization rule asks for a pin rather than discipline.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SEAM = 'src/domain/spellData.ts';
/** The dnd5e cantrip signal's own ONE home (row 194). */
const SEAM_5E = 'src/ingest/packs/dnd5e-foundry.ts';

/** The ONE spelling of each trait signal and the predicate that owns it. */
const SIGNALS: readonly {
  readonly trait: string;
  readonly needle: string;
  readonly predicate: string;
}[] = [
  { trait: 'cantrip', needle: ".includes('cantrip')", predicate: 'spellTraitsAreCantrip' },
  { trait: 'focus', needle: ".includes('focus')", predicate: 'spellTraitsAreFocus' },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/** Comments are skipped: the seam's own docstring NAMES the shapes it replaces. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one trait signal per spell kind (SOURCE SCAN, docs/17 rows 189/191)', () => {
  it.each(SIGNALS.map((signal) => [signal.trait, signal] as const))(
    'reads the `%s` trait in exactly one place',
    (_trait, signal) => {
      const files = sourceFiles(SRC_DIR);
      // Non-vacuity: the walk must see the whole tree, or it proves nothing.
      expect(files.length).toBeGreaterThan(300);
      expect(files).toContain(join(SRC_DIR, 'domain', 'spellData.ts'));

      const offenders: string[] = [];
      let seamHits = 0;
      for (const file of files) {
        const rel = relative(process.cwd(), file);
        const text = stripComments(readFileSync(file, 'utf8'));
        const hits = text.split(signal.needle).length - 1;
        if (hits === 0) continue;
        if (rel === SEAM) {
          seamHits += hits;
          continue;
        }
        offenders.push(`${rel} (${String(hits)})`);
      }
      expect(offenders).toEqual([]);
      expect(seamHits).toBe(1);
      // The predicate that owns this spelling is declared at the seam and
      // nowhere else (a second declaration would red the count above anyway,
      // but this names the predicate in the failure).
      const seamSource = readFileSync(join(process.cwd(), SEAM), 'utf8');
      expect(seamSource).toContain(`export function ${signal.predicate}(`);
    },
  );

  it('routes every consumer through the ONE predicate', () => {
    const consumers: readonly (readonly [string, string])[] = [
      // docs/17 row 189 — the two PF2e lanes.
      ['src/ingest/packs/pf2e-rules.ts', 'spellTraitsAreCantrip('],
      ['src/ingest/packs/pf2e-foundry.ts', 'spellTraitsAreCantrip('],
      // docs/17 row 191 — the importer, the heightening rule and the resolver.
      ['src/ingest/packs/pf2e-foundry.ts', 'spellTraitsAreFocus('],
      ['src/domain/spellHeightening.ts', 'spellTraitsAreFocus('],
      ['src/domain/mobSpells.ts', 'spellTraitsAreFocus('],
    ];
    for (const [consumer, call] of consumers) {
      const source = readFileSync(join(process.cwd(), consumer), 'utf8');
      expect(source, `${consumer} must call ${call}`).toContain(call);
      expect(source).toMatch(/from '@\/domain\/spellData'/);
    }
  });

  it('reads the dnd5e cantrip signal (system.level === 0) in exactly one place', () => {
    const files = sourceFiles(SRC_DIR);
    const offenders: string[] = [];
    let seamHits = 0;
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      const text = stripComments(readFileSync(file, 'utf8'));
      // The 5e signal is a LEVEL comparison, never a trait lookup.
      const hits = text.split('dnd5eSpellIsCantrip(').length - 1;
      if (hits === 0) continue;
      if (rel === SEAM_5E) {
        seamHits += hits;
        continue;
      }
      offenders.push(`${rel} (${String(hits)})`);
    }
    // The importer defines AND calls it; nothing else spells it out.
    expect(offenders).toEqual([]);
    expect(seamHits).toBeGreaterThanOrEqual(1);
    const seamSource = readFileSync(join(process.cwd(), SEAM_5E), 'utf8');
    expect(seamSource).toContain('export function dnd5eSpellIsCantrip(');
    // The PF2e trait predicate is never APPLIED in the 5e lane: the signal
    // scan above already reds a hand-spelled `.includes('cantrip')` outside
    // `spellData.ts`, and this asserts the 5e mapper compares the LEVEL
    // rather than looking a trait up.
    expect(seamSource).toContain('level === 0');
  });
});
