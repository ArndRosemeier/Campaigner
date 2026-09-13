import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, newId } from '@/domain';
import { exportSuggestedName } from '@/lib/exportImport';
import { fileSlug } from '@/lib/fileSlug';
import { pdfFileName } from '@/lib/pdfExport';

/**
 * "Turn this title into a URL-safe filename stem" — the ONE seam (AGENTS rule
 * 4, docs/18 §2.3, docs/17 row 130, docs/08 §The one way to build a filename
 * stem).
 *
 * WHAT IT IS. `fileSlug(name, fallback)` = lower-cased, every run of characters
 * outside `[a-z0-9]` collapsed to ONE `-`, leading and trailing dashes trimmed,
 * `fallback` when the input reduces to nothing. It was hand-rolled FOUR times
 * (`lib/exportImport.ts`'s `sanitize`, `lib/pdfExport.ts`'s `pdfFileName`,
 * `features/campaign/components/export-single-artifact.ts`'s `artifactSlug` and
 * `features/modules/module-pdf-button.tsx`'s `modulePdfFileName`), the first
 * three character-identical apart from their names and the fourth differing
 * only in its fallback (`'module'` where the others said `'artifact'`, with no
 * stated reason). The fold keeps every emitted filename BYTE-IDENTICAL, so the
 * fallback is passed EXPLICITLY by every caller and the scan below counts those
 * explicit arguments.
 *
 * WHAT IT IS NOT. A filename. The SUFFIX is each caller's own vocabulary and
 * stays there: `pdfFileName` appends a PDF TEMPLATE name (`gm-notes`/
 * `handout`), `modulePdfFileName` appends an AUDIENCE word (`gm`/`player`), and
 * the export callers append `-<date>.<json|zip>`. Merging the two PDF naming
 * roles would answer two different questions with one word (docs/18 §2.3).
 *
 * WHY THERE IS A SOURCE SCAN HERE. A fold is byte-identical by construction, so
 * reverting any one of the four sites to its hand-rolled form emits the SAME
 * filename and leaves every behavioural pin green — measured five times on this
 * repo's sibling folds (77, 176, 60, 18, 60 pins — docs/08). The scan is
 * labelled as a scan in its own names.
 */

describe('fileSlug — the ONE way to build a filename stem', () => {
  it('lower-cases, collapses every punctuation RUN to ONE dash, and trims the dashes', () => {
    expect(fileSlug('The Drowned Vault')).toBe('the-drowned-vault');
    expect(fileSlug('Grimm')).toBe('grimm');
    expect(fileSlug('R2-D2')).toBe('r2-d2');
    // A RUN of separators is one dash, whatever it is made of.
    expect(fileSlug('a--b')).toBe('a-b');
    expect(fileSlug('Ash Gate — Part 2')).toBe('ash-gate-part-2');
    expect(fileSlug('(Draft) 2')).toBe('draft-2');
    // Surrounding separators are TRIMMED, not turned into leading/trailing
    // dashes (a stem starting with '-' is not a filename).
    expect(fileSlug('  Grix the Bold  ')).toBe('grix-the-bold');
    expect(fileSlug('-x-')).toBe('x');
    expect(fileSlug('A/B')).toBe('a-b');
    // The alphabet is ASCII by design: a letter outside [a-z0-9] is a
    // separator and can therefore VANISH (pinned rather than discovered).
    expect(fileSlug('Æther')).toBe('ther');
  });

  it('falls back when the input reduces to nothing, with the default being `artifact`', () => {
    expect(fileSlug('???', 'module')).toBe('module');
    expect(fileSlug('—', 'artifact')).toBe('artifact');
    expect(fileSlug('   ')).toBe('artifact');
    expect(fileSlug('')).toBe('artifact');
  });
});

describe('every caller emits its filename STILL BYTE-IDENTICAL', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the artifact PDF names both templates exactly as before', () => {
    const artifact = createArtifact({
      campaignId: newId(),
      kind: 'npc',
      name: 'Grimm',
    });

    expect(pdfFileName(artifact, 'gm')).toBe('grimm-gm-notes.pdf');
    expect(pdfFileName(artifact, 'player')).toBe('grimm-handout.pdf');
    // The TEMPLATE vocabulary is this caller's own (the module PDF uses
    // audience words) — the slug is the only shared half.
    expect(pdfFileName(artifact, 'player')).not.toContain('player');
  });

  it('the pre-built export save name keeps its slug-date shape, fallback included', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));

    expect(exportSuggestedName('The Drowned Vault', 'json')).toBe(
      'the-drowned-vault-2026-03-04.json',
    );
    expect(exportSuggestedName('Ash Gate — Part 2', 'zip')).toBe('ash-gate-part-2-2026-03-04.zip');
    // The fallback half, byte-exact — never pinned before this fold.
    expect(exportSuggestedName('???', 'json')).toBe('artifact-2026-03-04.json');
  });
});

describe('the slug rule is composed in ONE file (SOURCE SCAN)', () => {
  /** The dash-mapping idiom, with its replacement INSIDE the needle so a
   * space-mapping neighbour (`domain/creatureName`) is not mistaken for it. */
  const DASH_IDIOM = /\[\^a-z0-9\]\+\/g,\s*'-'/;
  /** The trim idiom (byte-exact substring, as the doc convention does). */
  const TRIM_IDIOM = '/^-+|-+$/g';
  const SEAM = 'lib/fileSlug.ts';

  /** Every caller, with the COUNT of seam calls it must contain (a count, not
   * `>= 1`: reopening ONE copy of the slug must be visible). */
  const CALLERS: Record<string, number> = {
    'lib/exportImport.ts': 3,
    'lib/pdfExport.ts': 1,
    'features/campaign/components/export-single-artifact.ts': 1,
    'features/modules/module-pdf-button.tsx': 1,
  };

  function srcFiles(): string[] {
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
        found.push(full.slice(root.length + 1).replace(/\\/g, '/'));
      }
    };
    walk(root);
    return found.sort();
  }

  const source = (file: string): string => readFileSync(join(process.cwd(), 'src', file), 'utf8');
  const calls = (text: string, needle: string): number => text.split(needle).length - 1;

  it('scan: both slug idioms live in exactly one file — the seam', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must actually see the app, and the needles must
    // actually match the seam, or this pin proves nothing about either.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(SEAM);
    expect(DASH_IDIOM.test(source(SEAM)), 'the seam carries the dash-mapping idiom').toBe(true);
    expect(source(SEAM).includes(TRIM_IDIOM), 'the seam carries the trim idiom').toBe(true);

    // The rule, pinned as a VALUE so a reword has to be a deliberate,
    // test-visible act.
    expect(source(SEAM)).toContain("export function fileSlug(name: string, fallback = 'artifact'): string {");

    expect(files.filter((file) => DASH_IDIOM.test(source(file))), 'dash-mapping holders').toEqual([
      SEAM,
    ]);
    expect(
      files.filter((file) => source(file).includes(TRIM_IDIOM)),
      'trim-dash holders',
    ).toEqual([SEAM]);
  });

  for (const [file, count] of Object.entries(CALLERS)) {
    it(`scan: every filename stem in ${file} comes from the seam, with its own fallback spelled out`, () => {
      const text = source(file);
      expect(calls(text, 'fileSlug('), `${file}: fileSlug( calls`).toBe(count);
      // The fallback is EXPLICIT at every call site: that is what keeps each
      // emitted filename byte-identical, so a call that leans on the default is
      // a deliberate act rather than a silent one.
      expect(
        [...text.matchAll(/fileSlug\([^)]*,\s*'[a-z]+'\)/g)].length,
        `${file}: every call passes its own fallback`,
      ).toBe(count);
      // A reverted fold is byte-identical in behaviour — these are what red.
      expect(DASH_IDIOM.test(text), `${file}: must not re-derive the dash mapping`).toBe(false);
      expect(text.includes(TRIM_IDIOM), `${file}: must not re-derive the dash trim`).toBe(false);
      // MEASURED (injection I4, docs/08): an EQUIVALENT spelling that keeps the
      // character class but replaces `replaceAll` with
      // `split(/[^a-z0-9]+/).filter(Boolean).join('-')` carried NEITHER idiom, so
      // only this file's seam-call COUNT red it. The class is therefore banned
      // outright in a caller: a caller has no business naming the alphabet.
      expect(
        text.includes('[^a-z0-9]'),
        `${file}: must not name the slug alphabet itself`,
      ).toBe(false);
    });
  }

  it('scan: the module PDF keeps its own audience suffix, and the artifact PDF its template suffix', () => {
    // The two naming ROLES are deliberately NOT merged (docs/18 §2.3): a
    // later "unification" onto one suffix would change an emitted filename and
    // must be a deliberate, test-visible act.
    expect(source('features/modules/module-pdf-button.tsx')).toContain(
      "`${slug}-${audience === 'gm' ? 'gm' : 'player'}.pdf`",
    );
    expect(source('lib/pdfExport.ts')).toContain(
      "`${slug}-${template === 'gm' ? 'gm-notes' : 'handout'}.pdf`",
    );
  });
});
