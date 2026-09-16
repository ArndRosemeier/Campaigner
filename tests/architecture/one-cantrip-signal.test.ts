import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE one PF2e trait signal per auto-heightened spell kind (docs/17 rows
 * 189/191; docs/18 §2.1). A cantrip is the source's own `cantrip` TRAIT — a
 * cantrip and a rank-1 spell BOTH store `system.level.value: 1`, so the level
 * is never the signal (docs/17 row 181). A non-cantrip FOCUS spell is the
 * `focus` TRAIT (docs/17 row 191): upstream's `SpellPF2e.isFocusSpell` also
 * folds a tradition-less cantrip in, but a cantrip is auto-heightened anyway,
 * so the trait is the ONE thing a focus spell adds. Each signal has ONE
 * predicate in `domain/spellData.ts` (`spellTraitsAreCantrip`,
 * `spellTraitsAreFocus`), read by the rules lane, the bestiary lane, the
 * heightening rule and the mob resolver.
 *
 * The pin is a SOURCE SCAN because the drift it catches is invisible: a second
 * hand-spelled `.includes('cantrip')` / `.includes('focus')` answers identically
 * today and diverges the day the signal changes — the exact class AGENTS'
 * centralization rule asks for a pin rather than discipline.
 */

const SRC_DIR = join(process.cwd(), 'src');
const SEAM = 'src/domain/spellData.ts';

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
});
