import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mdToPdfmakeContent, parseInline, type InlineRun } from '@/lib/mdToPdfmake';
import {
  extractWikiLinks,
  stripWikiLinks,
  WIKI_LINK_PATTERN,
  WIKI_LINK_TOKEN,
} from '@/lib/wikilinks';

/**
 * THE wiki-token GRAMMAR is ONE source — its "exactly one" pin (AGENTS
 * §Centralization item 2, docs/17 row 145, docs/18 §2.3/§4).
 *
 * ## Why this file exists
 *
 * `lib/wikilinks.WIKI_LINK_PATTERN` and a private `WIKI_TOKEN` inside
 * `lib/mdToPdfmake` carried the SAME byte-identical grammar, and no test had
 * ever declared there was one way to write a `[[token]]`. Nothing failed when
 * the second copy was born; that is what duplication looks like.
 *
 * ## The trap this file exists to make un-repeatable
 *
 * The obvious centralization — "import `WIKI_LINK_PATTERN` into `mdToPdfmake`"
 * — is WRONG, and the pin below is the proof. `mdToPdfmake.pushWithWiki` LOOPS
 * with `exec` over one string, and a GLOBAL regex carries `lastIndex` between
 * calls, so the second loop over a fresh slice resumes where the first stopped:
 * the shared global pattern silently DROPS every second wiki link from a
 * rendered PDF. MEASURED — `['Ash Gate','Kael','Pier']` rendered `['Ash Gate',
 * null, 'Pier']`, with no error anywhere (a silent output loss in a document a
 * GM prints). So the grammar is ONE string and the app has TWO flag variants of
 * it: `WIKI_LINK_PATTERN` (global, for `matchAll`/`replaceAll`) and
 * `WIKI_LINK_TOKEN` (non-global, for a caller that loops).
 *
 * ## What this file CANNOT prove
 *
 * No test can show that a future author will not write a third token regex: the
 * source scan below is a GUARD over the shapes anyone has used, not a proof. It
 * scans `src/` only, and it sees regex-shaped text, not intent.
 */
describe('the two consumers render the same token bytes', () => {
  /**
   * The shared sample: every token shape the app writes, plus the two lookalikes
   * that must stay LITERAL, driven through the export consumer
   * (`stripWikiLinks` — what every export renders) and the PDF consumer
   * (`parseInline`, whose runs are what `mdToPdfmakeContent` emits). No other
   * markdown in these strings, so the two are expected to agree byte-for-byte.
   */
  const SAMPLE = [
    '[[Ash Gate]]',
    '[[Ash Gate|the gate]]',
    'the [[ Ash Gate |the gate]] at night.',
    // Two DISTINCT links on purpose: `extractWikiLinks` dedupes by NAME
    // (case-insensitively), so a repeated name would make the "same links" pin
    // below compare one deduped entry against two bold runs — the strip pin
    // above is the one that covers the repeated-name case byte-for-byte.
    '[[Kael]] answers to [[Halvar|the smith]].',
    'a [[Encounter:Ash Gate|the gate]] and [[Pier]]',
    '[[Name|]] is not a token',
    'an [[unclosed token',
    'no tokens here',
  ] as const;

  const rendered = (runs: readonly InlineRun[]): string => runs.map((run) => run.text).join('');

  it('has a sample on both sides of the grammar', () => {
    expect(SAMPLE).toHaveLength(8);
    // Non-vacuity: the agreement half must have tokens to agree about, and the
    // lookalikes must be real (a sample of only well-formed tokens proves less).
    expect(SAMPLE.filter((text) => extractWikiLinks(text).length > 0).length).toBe(5);
    expect(stripWikiLinks('[[Name|]] is not a token')).toBe('[[Name|]] is not a token');
  });

  it.each(SAMPLE.map((text) => [text] as const))(
    'the export strip and the PDF runs agree on %s',
    (text) => {
      expect(rendered(parseInline(text))).toBe(stripWikiLinks(text));
    },
  );

  it.each(SAMPLE.map((text) => [text] as const))(
    'both consumers name the same links in %s',
    (text) => {
      const names = extractWikiLinks(text).map((link) => link.display);
      const bold = parseInline(text)
        .filter((run) => run.bold === true)
        .map((run) => run.text);
      expect(bold).toEqual(names);
    },
  );
});

describe('a token after a markdown segment still renders (the vanished-link case)', () => {
  /**
   * THE REVERT-PROVEN case, and the reason the non-global companion exists:
   * `parseInline` calls `pushWithWiki` once per slice around every markdown run,
   * so the SECOND slice is where a global pattern's carried `lastIndex` eats the
   * first token it should have matched. `**bold**` is here precisely to force
   * that second slice.
   */
  const BODY = 'plain **bold** [[Ash Gate]] and [[Kael]] and [[Pier]].';

  it('renders every link through parseInline', () => {
    expect(parseInline(BODY).filter((run) => run.bold === true).map((run) => run.text)).toEqual([
      'bold',
      'Ash Gate',
      'Kael',
      'Pier',
    ]);
    // The same three names the export consumer sees — one text, one answer.
    expect(extractWikiLinks(BODY).map((link) => link.name)).toEqual(['Ash Gate', 'Kael', 'Pier']);
  });

  it('renders every link in the REAL PDF content, not only in the parser', () => {
    // `lib/modulePdf` renders module prose through this one entry point.
    const content = JSON.stringify(mdToPdfmakeContent(BODY));
    for (const name of ['Ash Gate', 'Kael', 'Pier']) {
      expect(content, `the rendered PDF content lost ${name}`).toContain(name);
    }
    expect(content).not.toContain('[[');
  });

  it('the loss the shared GLOBAL pattern would cause is real, on this exact string', () => {
    // A local re-implementation of the loop `pushWithWiki` runs, driven by the
    // GLOBAL pattern. This is not testing our code — it is pinning WHY the code
    // is shaped this way, so a future "simplification" back to one global
    // constant fails here with the MEASURED consequence rather than shipping it:
    // the loop's second slice resumes at the first slice's `lastIndex`, which is
    // past `[[Kael]]`, so Kael is silently dropped.
    WIKI_LINK_PATTERN.lastIndex = 0;
    const lost = (): string[] => {
      const names: string[] = [];
      const push = (text: string): void => {
        let rest = text;
        for (;;) {
          const match = WIKI_LINK_PATTERN.exec(rest);
          if (match?.index === undefined) break;
          names.push((match[1] ?? '').trim());
          rest = rest.slice(match.index + match[0].length);
        }
      };
      // The two slices `parseInline` hands it around the `**bold**` run.
      push('plain ');
      push(' [[Ash Gate]] and [[Kael]] and [[Pier]].');
      return names;
    };
    expect(lost()).toEqual(['Ash Gate', 'Pier']);
    expect(lost()).not.toContain('Kael');
    WIKI_LINK_PATTERN.lastIndex = 0;
    // …and the non-global companion, on the same two slices, loses NOTHING.
    const kept: string[] = [];
    const push = (text: string): void => {
      let rest = text;
      for (;;) {
        const match = WIKI_LINK_TOKEN.exec(rest);
        if (match?.index === undefined) break;
        kept.push((match[1] ?? '').trim());
        rest = rest.slice(match.index + match[0].length);
      }
    };
    push('plain ');
    push(' [[Ash Gate]] and [[Kael]] and [[Pier]].');
    expect(kept).toEqual(['Ash Gate', 'Kael', 'Pier']);
  });
});

describe('ONE grammar, two flag variants', () => {
  it('both patterns are built from the same grammar source', () => {
    expect(WIKI_LINK_TOKEN.source).toBe(WIKI_LINK_PATTERN.source);
    expect(WIKI_LINK_PATTERN.global).toBe(true);
    expect(WIKI_LINK_TOKEN.global).toBe(false);
    expect(WIKI_LINK_TOKEN.lastIndex).toBe(0);
  });

  it('a non-global exec never carries state across calls', () => {
    const slice = ' [[Ash Gate]] and [[Kael]] and [[Pier]].';
    const first = WIKI_LINK_TOKEN.exec(slice);
    const second = WIKI_LINK_TOKEN.exec(slice);
    expect(first?.[1]).toBe('Ash Gate');
    // A global pattern's second call would have jumped past `Ash Gate` here.
    expect(second?.[1]).toBe('Ash Gate');
    expect(WIKI_LINK_TOKEN.lastIndex).toBe(0);
  });
});

// --- The "exactly one" half: the SOURCE -------------------------------

const SRC = 'src';

function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir)).sort()) {
    const path = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) out.push(...srcFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Where an escaped-backslash `\[\[` may appear in CODE (a doc comment naming the
 * token is not a regex and is skipped — `lib/markdown.ts:28` is one).
 *
 * TWO sites, and the second is a DIFFERENT grammar, declared here rather than
 * silently tolerated: `src/ingest/packs/text.ts` rewrites Foundry's dnd5e
 * DOCUMENT dialect (`[[target]]{Label}` / `[[target|label]]` → the label, and a
 * label-less `[[target]]` → nothing) at import time. That is not the app's
 * wiki-link grammar — it resolves nothing and has no `display` slot — and it
 * must not be folded onto `WIKI_LINK_TOKEN` (docs/17 row 143 kept the ingest
 * layer's text conventions out of this landing on purpose).
 */
const DECLARED_TOKEN_REGEX_SITES: Readonly<Record<string, number>> = {
  'src/lib/wikilinks.ts': 1,
  'src/ingest/packs/text.ts': 2,
};

/** Lines holding the escaped pair, minus comment lines. */
function tokenRegexLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.includes('\\[\\['))
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

describe('the token grammar is written down in ONE place (SOURCE SCAN)', () => {
  it('no second `[[…]]` token regex exists outside the declared sites', () => {
    const files = srcFiles();
    // Non-vacuity: the walk must see the whole `src/` tree.
    expect(files.length).toBeGreaterThan(200);

    const found: Record<string, number> = {};
    for (const file of files) {
      const lines = tokenRegexLines(readFileSync(join(process.cwd(), file), 'utf8'));
      if (lines.length > 0) found[file] = lines.length;
    }
    expect(found).toEqual(DECLARED_TOKEN_REGEX_SITES);
    // Rot check: a declared site that no longer holds its regex is a stale
    // carve-out licensing the shape it excused.
    for (const site of Object.keys(DECLARED_TOKEN_REGEX_SITES)) {
      expect(found[site], `${site} no longer holds a token regex`).toBeDefined();
    }
  });

  it('the PDF renderer reads the companion and declares no pattern of its own', () => {
    const mdToPdfmake = readFileSync(join(process.cwd(), 'src/lib/mdToPdfmake.ts'), 'utf8');
    expect(mdToPdfmake).toContain("import { WIKI_LINK_TOKEN } from '@/lib/wikilinks';");
    expect(mdToPdfmake).toContain('WIKI_LINK_TOKEN.exec(rest)');
    // The GLOBAL pattern must never reach the looping caller.
    expect(mdToPdfmake).not.toContain('WIKI_LINK_PATTERN');
    expect(tokenRegexLines(mdToPdfmake)).toEqual([]);
  });

  it('the grammar module declares the companion from the same source string', () => {
    const wikilinks = readFileSync(join(process.cwd(), 'src/lib/wikilinks.ts'), 'utf8');
    expect(wikilinks).toContain('const WIKI_LINK_GRAMMAR = String.raw');
    expect(wikilinks).toContain("export const WIKI_LINK_PATTERN = new RegExp(WIKI_LINK_GRAMMAR, 'g');");
    expect(wikilinks).toContain('export const WIKI_LINK_TOKEN = new RegExp(WIKI_LINK_GRAMMAR);');
    // ONE literal: the grammar appears once, so the two variants cannot drift.
    expect(tokenRegexLines(wikilinks)).toHaveLength(1);
  });
});
