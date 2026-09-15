/**
 * THE ONE ingest document-parser seam — its "exactly one" pin (AGENTS
 * §Centralization item 2, docs/17 row 147, docs/18 §2.2/§5, docs/08 §One
 * document-parser seam for the ingest layer).
 *
 * ## Why this file exists
 *
 * `parseDocs` used to be spelled SEVEN times across the seven pack adapters in
 * THREE bodies (five byte-identical JSON/NDJSON bodies, two YAML bodies), and
 * the two YAML bodies DISAGREED:
 *
 * | input | `dnd5e-foundry.ts` (`loadAll` raw) | `dnd5e-equipment.ts` (filter nulls → throw) |
 * |---|---|---|
 * | `'# comment only'` | `[]` — NO THROW | THROW `no YAML document` |
 * | `'---\n'` / `'null\n'` | `[null]` — no throw | THROW |
 * | `'   \n'` | THROW `file is empty` | THROW `file is empty` |
 * | unparseable | THROW `invalid YAML: …` | THROW `not valid YAML: …` |
 *
 * Through the one per-file door (`packImport.ts`) the comment-only file made
 * the foundry adapter contribute **`{entries: 0, skipped: 0, failures: []}`** —
 * accounted NOWHERE, with no user-visible surface at all. That is the AGENTS
 * rule 1 shape (a silent drop), and it was pinned by NOTHING. Nothing failed
 * when the copies were born, which is exactly why the pin has to exist.
 *
 * ## The rule, and the half that is deliberately NOT a failure
 *
 * The JSON family has always held this invariant: **every non-empty input
 * either yields at least one document or throws.** `parseYamlDocs` now holds
 * the same rule. Two halves, and the second is the one that is easy to get
 * wrong:
 *
 * - a YAML stream that yields NO document at all is a LOUD file-level failure;
 * - a document that parses to `null` is RETURNED and counted as a SKIP — not a
 *   failure and not nothing. `docs.filter((doc) => doc != null)` is the silent
 *   drop, not a tidy-up, and the accounting pins below go red on it.
 *
 * ## What this file CANNOT prove
 *
 * No test can show that a future adapter author will not write an eighth
 * parser: the source scan is a GUARD, not a proof. A parser built from shapes
 * nobody has used would slip past it — and a copy computed through an
 * intermediate variable (`const parse = pickParser(); parse(text, name)`) is
 * invisible to a textual scan, because the scan looks for the two helper NAMES.
 * A future author can also legitimately add a THIRD declared input shape (a
 * TOML lane, say) — that is not a copy, it is a new document dialect, and it
 * belongs in `text.ts` beside these two rather than in an adapter.
 *
 * ## The Source: line is DIFFERENT
 *
 * The sibling duplication `publicationSourceLine` is pinned in
 * `tests/ingest/packs/source-line.test.ts`, not here: it is a text convention,
 * not a document parser, and docs/17 row 147 deliberately did NOT fold it
 * (docs/12 §15.5 still describes the two copies as carried).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACK_ADAPTERS } from '@/ingest/packs/registry';
import { parseJsonDocs, parseYamlDocs } from '@/ingest/packs/text';

import { baseNpc, folderDoc } from './fixtures';

const PACKS_DIR = 'src/ingest/packs';

function packSources(): string[] {
  return readdirSync(join(process.cwd(), PACKS_DIR))
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

const source = (file: string): string =>
  readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');

/**
 * The seven call sites and the input shape each DECLARES. This is the whole
 * point of the refactor stated as data: seven sites, two helpers, no site with
 * a parser body of its own. `callCount` is exact so reverting ONE site fails
 * rather than hiding behind another.
 */
const CALL_SITES: readonly {
  readonly file: string;
  readonly helper: 'parseJsonDocs' | 'parseYamlDocs';
}[] = [
  { file: 'pf2e-foundry.ts', helper: 'parseJsonDocs' },
  { file: 'pf2e-equipment.ts', helper: 'parseJsonDocs' },
  { file: 'pf2e-journal.ts', helper: 'parseJsonDocs' },
  { file: 'pf2e-conditions.ts', helper: 'parseJsonDocs' },
  { file: 'pf2e-rules.ts', helper: 'parseJsonDocs' },
  { file: 'dnd5e-foundry.ts', helper: 'parseYamlDocs' },
  { file: 'dnd5e-equipment.ts', helper: 'parseYamlDocs' },
];

/** Shapes that are a PARSER, not a use of one: none may live outside text.ts. */
const PARSER_SHAPES: readonly { readonly shape: string; readonly why: string }[] = [
  { shape: 'JSON.parse', why: 'the JSON document parse' },
  { shape: 'loadAll', why: 'the YAML document-stream parse' },
  { shape: "from 'js-yaml'", why: 'the YAML parser import' },
  { shape: 'function parseDocs', why: 'the retired per-adapter parser name' },
];

/**
 * The lanes that ask "is this parsed value a document?" — the seven from which
 * the private `isRecord` copies were folded (docs/17 row 171). This is the same
 * seven as `CALL_SITES`, stated as its own list so the predicate scan reds when
 * a lane stops going through the seam, not only when a parser is re-spelled.
 */
const DOCUMENT_RECORD_SITES: readonly string[] = [
  'pf2e-foundry.ts',
  'pf2e-equipment.ts',
  'pf2e-journal.ts',
  'pf2e-conditions.ts',
  'pf2e-rules.ts',
  'dnd5e-foundry.ts',
  'dnd5e-equipment.ts',
];

/**
 * Shapes that belong to the ONE seam: a privately-spelt predicate, a call to
 * one, or a second top-level-array unwrap. `Array.isArray` is the load-bearing
 * needle for the unwrap because it is the only way both halves are written —
 * `isDocumentRecord`'s `!Array.isArray` arm and the two unwrap arms in
 * `parseJsonDocs`/`parseYamlDocs` — so a copy of EITHER reds here wherever it
 * appears. The non-vacuity assertion below proves the seam still carries them.
 */
const RECORD_SHAPES: readonly { readonly shape: string; readonly why: string }[] = [
  { shape: 'function isRecord', why: 'a revived private copy of the predicate' },
  { shape: 'isRecord(', why: 'a call to a privately-spelt predicate' },
  { shape: 'Array.isArray', why: 'the predicate body or a second array unwrap' },
];

const encoder = new TextEncoder();

// --- The rule the two helpers hold -----------------------------------------

describe('the ingest document-parser seam: the rule', () => {
  it('fails a YAML stream that yields NO document at all, loudly and by name', () => {
    // MEASURED: js-yaml returns `[]` for both of these. The old foundry body
    // returned that `[]` straight to the adapter, which then contributed
    // `{entries: 0, skipped: 0, failures: []}` — accounted nowhere.
    for (const input of ['# comment only', '# a comment\n# another']) {
      expect(() => parseYamlDocs(input, 'silent.yml')).toThrow('silent.yml: no YAML document');
    }
  });

  it('returns a document that parses to null, so the adapter counts a SKIP', () => {
    // Not a failure, not nothing: `---` and `null` ARE documents. `'# c\n---\n# c2'`
    // is the sharp one — a separator between two comment-only regions still
    // DECLARES a document, so it is a skip, not the no-document failure above.
    expect(parseYamlDocs('---\n', 'bare.yml')).toEqual([null]);
    expect(parseYamlDocs('null\n', 'null.yml')).toEqual([null]);
    expect(parseYamlDocs('---\n~', 'tilde.yml')).toEqual([null]);
    expect(parseYamlDocs('# c\n---\n# c2', 'comments.yml')).toEqual([null]);
    // A real document followed by an empty one keeps BOTH, in order.
    expect(parseYamlDocs('name: Ape\n---\n', 'mixed.yml')).toEqual([{ name: 'Ape' }, null]);
  });

  it('fails a whitespace-only YAML file with the empty-file failure', () => {
    for (const input of ['', '   ', '\n\n', '\t \n']) {
      expect(() => parseYamlDocs(input, 'empty.yml')).toThrow('empty.yml: file is empty');
    }
  });

  it('fails an unparseable YAML file with the parser message, keeping the cause', () => {
    // The wording is `invalid YAML` — the sentence a PRE-EXISTING assertion
    // already named as a literal (`dnd5e-foundry.test.ts`), which is why the
    // retired equipment body's `not valid YAML` was the one that changed.
    expect(() => parseYamlDocs('name: [unclosed', 'broken.yml')).toThrow('broken.yml: invalid YAML');
    let caught: unknown;
    try {
      parseYamlDocs('name: [unclosed', 'broken.yml');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('keeps the JSON family\'s own invariant: every non-empty input yields a document or throws', () => {
    // Whole-file JSON, NDJSON, and the values JSON can carry at top level.
    expect(parseJsonDocs('{"a": 1}', 'one.json')).toEqual([{ a: 1 }]);
    expect(parseJsonDocs('42\n', 'scalar.json')).toEqual([42]);
    expect(parseJsonDocs('null\n', 'null.json')).toEqual([null]);
    // A top-level array is a STREAM: its elements are the documents (docs/17
    // row 171), not the array itself.
    expect(parseJsonDocs('[{ "a": 1 }]\n', 'array.json')).toEqual([{ a: 1 }]);
    expect(parseJsonDocs('{"a": 1}\n{"b": 2}\n', 'two.db')).toEqual([{ a: 1 }, { b: 2 }]);
    // Empty and whitespace-only: the loud empty-file failure.
    for (const input of ['', '   ', '\n\n']) {
      expect(() => parseJsonDocs(input, 'empty.json')).toThrow('empty.json: file is empty');
    }
    // Unparseable: the 1-BASED line that failed, never a silent empty result.
    expect(() => parseJsonDocs('{"a": 1}\nnot json', 'broken.db')).toThrow(
      'broken.db: line 2 is not valid JSON',
    );
    expect(() => parseJsonDocs('not json', 'broken.json')).toThrow(
      'broken.json: line 1 is not valid JSON',
    );
  });

  it('never returns an empty array for a non-empty input — the invariant, stated directly', () => {
    // Each entry names the parser that OWNS that shape, so this cannot pass by
    // routing an input to the wrong helper.
    const cases: readonly { readonly parse: () => unknown[]; readonly input: string }[] = [
      { parse: () => parseYamlDocs('# comment only', 'probe'), input: '# comment only' },
      { parse: () => parseYamlDocs('# c\n---\n# c2', 'probe'), input: '# c\n---\n# c2' },
      { parse: () => parseYamlDocs('# a comment\n# another', 'probe'), input: '(comments only)' },
      { parse: () => parseYamlDocs('---\n', 'probe'), input: '---\n' },
      { parse: () => parseYamlDocs('null\n', 'probe'), input: 'null\n' },
      { parse: () => parseYamlDocs('name: Ape\n', 'probe'), input: 'name: Ape\n' },
      { parse: () => parseYamlDocs('', 'probe'), input: '(empty yaml)' },
      { parse: () => parseYamlDocs('   ', 'probe'), input: '(whitespace yaml)' },
      { parse: () => parseYamlDocs('name: [unclosed', 'probe'), input: 'name: [unclosed' },
      { parse: () => parseJsonDocs('{"a": 1}', 'probe'), input: '{"a": 1}' },
      { parse: () => parseJsonDocs('{"a": 1}\n{"b": 2}', 'probe'), input: 'ndjson' },
      { parse: () => parseJsonDocs('42', 'probe'), input: '42' },
      { parse: () => parseJsonDocs('[]', 'probe'), input: '[]' },
      { parse: () => parseJsonDocs('null', 'probe'), input: 'null' },
      { parse: () => parseJsonDocs('', 'probe'), input: '(empty json)' },
      { parse: () => parseJsonDocs('   ', 'probe'), input: '(whitespace json)' },
      { parse: () => parseJsonDocs('not json', 'probe'), input: 'not json' },
    ];
    for (const { parse, input } of cases) {
      let docs: unknown[] | null = null;
      let threw = false;
      try {
        docs = parse();
      } catch {
        threw = true;
      }
      expect(threw || (docs !== null && docs.length > 0), `input ${input}`).toBe(true);
    }
  });
});

// --- The top-level array is a document STREAM (docs/17 row 171) ------------

/**
 * The array defect, as the brief measured it (docs/18 §5): `parseJsonDocs`
 * tried `JSON.parse(whole file)` FIRST, so a top-level array succeeded and
 * became ONE document. Every adapter then skipped it as "not a document I
 * know", and the user-visible reason was FALSE — the documents were there,
 * wrapped: `no valid creature entries in the pack selection (1 skipped, 0
 * failed)`. The same two creatures as NDJSON imported fine.
 *
 * The fix unwraps in the ONE seam, for BOTH formats. YAML is not "already
 * correct": MEASURED with the repo's own js-yaml, `loadAll('- a\n- b\n')` is
 * ONE document, the array `[['a', 'b']]`, so the YAML family carried the SAME
 * defect and gets the SAME fix. The rule has three boundaries, each pinned
 * below: unwrap exactly ONE level; leave a document's own array FIELDS alone;
 * never return zero documents for a non-empty file.
 */
describe('a top-level array is a document stream, unwrapped exactly once at the seam', () => {
  it('JSON: a top-level array yields N documents, one per element', () => {
    expect(parseJsonDocs('[{"a": 1}, {"b": 2}]', 'pack.json')).toEqual([{ a: 1 }, { b: 2 }]);
    // A ONE-element array is still an array: one document, not the array.
    expect(parseJsonDocs('[{"a": 1}]', 'one.json')).toEqual([{ a: 1 }]);
  });

  it('YAML: a top-level sequence yields N documents, mirroring JSON', () => {
    // The pin that records WHY this is a fix and not a declaration: pre-171
    // this was `[['a', 'b']]` — one document — so the mirror rule is measured,
    // not assumed.
    expect(parseYamlDocs('- a\n- b\n', 'seq.yml')).toEqual(['a', 'b']);
    // A stream mixes real documents with sequences; each sequence unwraps in
    // place and the stream ORDER survives.
    expect(parseYamlDocs('name: Ape\n---\n- a\n- b\n', 'mixed.yml')).toEqual([
      { name: 'Ape' },
      'a',
      'b',
    ]);
  });

  it('unwraps exactly ONE level — an element that is itself an array stays a document', () => {
    // Rule 3, pinned: NOT recursive. The seam hands back the inner arrays as
    // documents; the shared `isDocumentRecord` rejects them and the lane counts
    // each as ONE skip. A recursive flatten would silently invent documents.
    expect(parseJsonDocs('[[{"a": 1}], [{"b": 2}]]', 'nested.json')).toEqual([
      [{ a: 1 }],
      [{ b: 2 }],
    ]);
    expect(parseYamlDocs('- - a\n  - b\n', 'nested.yml')).toEqual([['a', 'b']]);
  });

  it("leaves a document's OWN array FIELDS intact", () => {
    // Only the top level of the FILE is a stream. A creature's `items[]` must
    // survive byte-for-byte — unwrapping it would shred every real document.
    expect(parseJsonDocs('{"name": "Ape", "items": [1, 2, 3]}', 'field.json')).toEqual([
      { name: 'Ape', items: [1, 2, 3] },
    ]);
    expect(parseYamlDocs('name: Ape\nitems:\n  - 1\n  - 2\n', 'field.yml')).toEqual([
      { name: 'Ape', items: [1, 2] },
    ]);
  });

  it('does NOT unwrap a line of an NDJSON stream — there the top level IS the line stream', () => {
    // The deliberate asymmetry, pinned: an array on ONE line of a multi-line
    // `.db` file is a document (rejected by the predicate → one skip), while
    // the same bytes as the WHOLE file are a stream. The NDJSON arm's top level
    // is the line stream, so it has nothing to unwrap.
    expect(parseJsonDocs('{"a": 1}\n[{"b": 2}]\n', 'lines.db')).toEqual([{ a: 1 }, [{ b: 2 }]]);
  });

  it('throws LOUDLY, by name, when a top-level array holds NO documents', () => {
    // Rule 4 — the invariant: every non-empty input yields at least one
    // document or throws. Returning `[]` would be a file accounted NOWHERE,
    // exactly the hole the invariant forbids. Both formats, both named.
    expect(() => parseJsonDocs('[]', 'empty-array.json')).toThrow(
      'empty-array.json: top-level array holds no documents',
    );
    expect(() => parseJsonDocs('[]\n', 'empty-array.json')).toThrow(
      'empty-array.json: top-level array holds no documents',
    );
    expect(() => parseYamlDocs('[]\n', 'empty-array.yml')).toThrow(
      'empty-array.yml: top-level array holds no documents',
    );
    // A stream whose ONLY document is an empty sequence is the same file shape
    // in the YAML family: no documents, so it fails rather than resolving `[]`.
    expect(() => parseYamlDocs('---\n[]\n', 'empty-array.yml')).toThrow(
      'empty-array.yml: top-level array holds no documents',
    );
  });

  it('an empty top-level array sits INSIDE the no-empty-result invariant, not outside it', () => {
    // The invariant table above calls `parseJsonDocs('[]')` — it must THROW,
    // which is what "yields a document or throws" means. Asserted directly so
    // a future `return []` cannot pass by throwing a different sentence.
    let threw = false;
    try {
      parseJsonDocs('[]', 'probe');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// --- The accounting, through the REAL adapters -----------------------------

describe('a comment-only YAML file is accounted as a FAILURE, never as nothing', () => {
  it('foundry-dnd5e-srd records the file-level failure instead of a silent empty result', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-dnd5e-srd');
    if (adapter === undefined) throw new Error('no adapter foundry-dnd5e-srd');
    // THE DEFECT, pinned: before docs/17 row 147 this resolved to
    // `{entries: [], skipped: 0, failures: []}` — the file was accounted
    // NOWHERE, so the import reported a clean book that had silently lost it.
    await expect(
      adapter.parseFile('silent.yml', encoder.encode('# comment only')),
    ).rejects.toThrow('silent.yml: no YAML document');
  });

  it('the same file is a loud failure through BOTH dnd5e lanes, with identical wording', async () => {
    const foundry = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-dnd5e-srd');
    const equipment = PACK_ADAPTERS.find(
      (candidate) => candidate.id === 'foundry-dnd5e-equipment',
    );
    if (foundry === undefined || equipment === undefined) throw new Error('missing dnd5e adapter');
    // The two bodies used to DISAGREE on exactly this input (one threw, one
    // returned `[]`). Same bytes in, same sentence out — that is the rule.
    for (const adapter of [foundry, equipment]) {
      await expect(adapter.parseFile('silent.yml', encoder.encode('# comment only'))).rejects.toThrow(
        'silent.yml: no YAML document',
      );
      await expect(adapter.parseFile('white.yml', encoder.encode('   \n'))).rejects.toThrow(
        'white.yml: file is empty',
      );
      await expect(
        adapter.parseFile('broken.yml', encoder.encode('name: [unclosed')),
      ).rejects.toThrow('broken.yml: invalid YAML');
    }
  });

  it('a bare `---` document is ONE counted skip in BOTH dnd5e lanes — not a failure, not nothing', async () => {
    for (const id of ['foundry-dnd5e-srd', 'foundry-dnd5e-equipment']) {
      const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === id);
      if (adapter === undefined) throw new Error(`no adapter ${id}`);
      for (const input of ['---\n', 'null\n']) {
        const parsed = await adapter.parseFile('empty-doc.yml', encoder.encode(input));
        // The three counters TOGETHER are the pin: `skipped: 1` alone would
        // pass if the document had been dropped into `failures` as well.
        expect(parsed.entries, `${id} ${JSON.stringify(input)} entries`).toEqual([]);
        expect(parsed.items ?? [], `${id} ${JSON.stringify(input)} items`).toEqual([]);
        expect(parsed.sections ?? [], `${id} ${JSON.stringify(input)} sections`).toEqual([]);
        expect(parsed.skipped, `${id} ${JSON.stringify(input)} skipped`).toBe(1);
        expect(parsed.failures, `${id} ${JSON.stringify(input)} failures`).toEqual([]);
      }
    }
  });

  it('counts each null document of a real stream, in order, alongside the real ones', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-dnd5e-equipment');
    if (adapter === undefined) throw new Error('no adapter foundry-dnd5e-equipment');
    // A real document, a bare `---`, then a real but NON-ITEM document: 1 item,
    // 2 counted skips, 0 failures. The null document contributes a SKIP — it is
    // the case the retired `filter((doc) => doc !== null)` dropped silently.
    const real = readFileSync(
      join(process.cwd(), 'tests', 'fixtures', 'packs', 'dnd5e-equipment', 'longsword.yml'),
      'utf8',
    );
    const parsed = await adapter.parseFile(
      'mixed.yml',
      encoder.encode(`${real}\n---\n\n---\nname: Bandit\ntype: npc\nsystem: {}\n`),
    );
    expect(parsed.items?.map((item) => item.name)).toEqual(['Longsword']);
    expect(parsed.skipped).toBe(2);
    expect(parsed.failures).toEqual([]);
  });
});

// --- The array defect CURES, through the REAL adapters ----------------------

/**
 * The seam rule above is a unit pin; these are the OUTCOME pins the brief
 * required, because the user-visible defect was never the parse itself — it was
 * `{entries: 0, skipped: 1, failures: 0}` with a false reason. The pre-171
 * behaviour is stated in each comment.
 */
describe('an array-shaped pack file IMPORTS its documents (through the REAL adapters)', () => {
  it('foundry-pf2e: one creature + one folder as a top-level array is 1 entry and 1 TRUTHFUL skip', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-pf2e');
    if (adapter === undefined) throw new Error('no adapter foundry-pf2e');
    // BEFORE row 171 these same bytes resolved to `{entries: [], skipped: 1,
    // failures: []}` — one document, the array — and the import failed with
    // `no valid creature entries … (1 skipped, 0 failed)`. The count was right;
    // the REASON was false: the creature was in the file, wrapped.
    const parsed = await adapter.parseFile(
      'pack.json',
      encoder.encode(JSON.stringify([baseNpc(), folderDoc()])),
    );
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Charau-ka']);
    // The skip is PER ELEMENT now: the folder document is the ONE skip — so
    // `1 skipped` finally means one skipped DOCUMENT, not one skipped array.
    expect(parsed.skipped).toBe(1);
    expect(parsed.failures).toEqual([]);
  });

  it('the same two documents as NDJSON import identically — the stream shapes agree', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-pf2e');
    if (adapter === undefined) throw new Error('no adapter foundry-pf2e');
    // The docs/18 §5 measurement, re-run as a pin: NDJSON always worked, and it
    // still does. The array form now reaches the same counter values.
    const ndjson = `${JSON.stringify(baseNpc())}\n${JSON.stringify(folderDoc())}\n`;
    const parsed = await adapter.parseFile('pack.db', encoder.encode(ndjson));
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Charau-ka']);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failures).toEqual([]);
  });

  it('a single-document file is unchanged, and its own array FIELD is consumed intact', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-pf2e');
    if (adapter === undefined) throw new Error('no adapter foundry-pf2e');
    const parsed = await adapter.parseFile('one.json', encoder.encode(JSON.stringify(baseNpc())));
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Charau-ka']);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failures).toEqual([]);
    // The document's OWN `items[]` array supplied the stat block's actions —
    // proof the unwrap did not touch an array FIELD of a document.
    expect(parsed.entries[0]?.statBlock.actions.map((action) => action.name)).toContain(
      'Shrieking Frenzy',
    );
  });

  it('N skipped finally means N: two non-document elements are TWO skips', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-pf2e');
    if (adapter === undefined) throw new Error('no adapter foundry-pf2e');
    // Before the unwrap this was `1 skipped` for the whole array; now it is the
    // honest per-element count. No message was special-cased — the COUNT moved
    // because the PARSE did.
    const parsed = await adapter.parseFile(
      'folders.json',
      encoder.encode(JSON.stringify([folderDoc('Book 1'), folderDoc('Book 2')])),
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.skipped).toBe(2);
    expect(parsed.failures).toEqual([]);
    // One level only: an array OF arrays yields the inner arrays, each of which
    // is one non-document element — ONE skip, not a recursive flatten.
    const nested = await adapter.parseFile(
      'nested.json',
      encoder.encode(JSON.stringify([[baseNpc()], [baseNpc('Wolf')]])),
    );
    expect(nested.entries).toEqual([]);
    expect(nested.skipped).toBe(2);
    expect(nested.failures).toEqual([]);
  });

  it('foundry-dnd5e-equipment: a top-level YAML sequence imports each item document', async () => {
    const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-dnd5e-equipment');
    if (adapter === undefined) throw new Error('no adapter foundry-dnd5e-equipment');
    // MEASURED: `loadAll` returns ONE document (the array) for this stream, so
    // pre-171 the same false-reason defect existed in the YAML family. The
    // mirror fix unwraps it, and the lane maps BOTH item documents.
    const sequence = [
      '- {name: Longsword, type: weapon, system: {}}',
      '- {name: Candle, type: consumable, system: {}}',
    ].join('\n');
    const parsed = await adapter.parseFile('items.yml', encoder.encode(`${sequence}\n`));
    expect(parsed.items?.map((item) => item.name)).toEqual(['Longsword', 'Candle']);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failures).toEqual([]);
  });
});

// --- The "exactly one" source scan -----------------------------------------

describe('the ingest document-parser seam is the ONLY one (SOURCE SCAN)', () => {
  it('leaves every parser shape in text.ts and nowhere else in the directory', () => {
    const files = packSources();
    // Non-vacuity: the walk must see the whole directory (7 adapters + the seam
    // + `registry` + `types`), or this proves nothing about it.
    expect(files).toHaveLength(10);
    expect(files).toContain('text.ts');

    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'text.ts') continue;
      const text = source(file);
      for (const { shape, why } of PARSER_SHAPES) {
        if (text.includes(shape)) offenders.push(`${file}: ${why} (\`${shape}\`)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('defines each helper EXACTLY once, in the seam', () => {
    const text = source('text.ts');
    const jsonDefs = text.match(/export function parseJsonDocs\(/g) ?? [];
    const yamlDefs = text.match(/export function parseYamlDocs\(/g) ?? [];
    expect(jsonDefs).toHaveLength(1);
    expect(yamlDefs).toHaveLength(1);
    // Non-vacuity: the seam really does own both parsers.
    expect(text).toContain('JSON.parse(');
    expect(text).toContain('loadAll(');
  });

  it('has every one of the seven call sites taking its documents from the seam', () => {
    expect(CALL_SITES).toHaveLength(7);
    // The adapter inventory is the same seven the registry declares, so a NEW
    // adapter that does not appear above fails here rather than being missed.
    expect(PACK_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      'foundry-pf2e',
      'foundry-dnd5e-srd',
      'foundry-pf2e-equipment',
      'foundry-dnd5e-equipment',
      'foundry-pf2e-journal',
      'foundry-pf2e-conditions',
      'foundry-pf2e-rules',
    ]);
    for (const { file, helper } of CALL_SITES) {
      const text = source(file);
      expect(text, `${file} does not import ${helper}`).toContain(helper);
      const calls = text.match(new RegExp(`${helper}\\(text, fileName\\)`, 'g')) ?? [];
      expect(calls.length, `${file}: ${helper} call count`).toBe(1);
      // Exactly ONE document-parsing entry point per adapter: a file that
      // called BOTH helpers would be building a second stream.
      const total =
        (text.match(/parseJsonDocs\(text, fileName\)/g) ?? []).length +
        (text.match(/parseYamlDocs\(text, fileName\)/g) ?? []).length;
      expect(total, `${file}: document-parsing call count`).toBe(1);
    }
  });

  it('declares each adapter\'s input shape as data, and every declared shape is real', () => {
    // The YAML lanes take `.yml`/`.yaml`; the JSON lanes take `.json`/`.db`.
    // Reading this from the registry keeps the table above honest: a lane that
    // switched shapes without switching helpers fails here.
    const yamlIds = PACK_ADAPTERS.filter((adapter) =>
      adapter.extensions.includes('.yml'),
    ).map((adapter) => adapter.id);
    expect(yamlIds).toEqual(['foundry-dnd5e-srd', 'foundry-dnd5e-equipment']);
    const declaredYaml = CALL_SITES.filter((site) => site.helper === 'parseYamlDocs').map(
      (site) => site.file,
    );
    expect(declaredYaml).toEqual(['dnd5e-foundry.ts', 'dnd5e-equipment.ts']);
  });
});

// --- The document-record predicate and the unwrap are the SEAM's (row 171) --

describe('the document-record predicate is the ONLY one (SOURCE SCAN)', () => {
  it('states "this parsed value is a document" exactly once, in the seam', () => {
    const files = packSources();
    // Non-vacuity: the walk must still see the whole directory (7 adapters +
    // the seam + `registry` + `types`) or this proves nothing about it.
    expect(files).toHaveLength(10);
    expect(files).toContain('text.ts');

    const seam = source('text.ts');
    expect(seam.match(/export function isDocumentRecord\(/g) ?? []).toHaveLength(1);
    // Non-vacuity for the `Array.isArray` needle: the seam really does carry
    // the predicate body AND the two unwrap arms (JSON + YAML) — the exact
    // three sites the ban below is measured against. If this count changes,
    // the scan must be re-read, not relaxed.
    expect(seam.match(/Array\.isArray\(/g) ?? []).toHaveLength(3);
    expect(seam).toContain('isDocumentRecord(');

    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'text.ts') continue;
      const text = source(file);
      for (const { shape, why } of RECORD_SHAPES) {
        if (text.includes(shape)) offenders.push(`${file}: ${why} (\`${shape}\`)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has every lane ask the seam, and no file that does not', () => {
    // Non-vacuity AGAIN, at the population level: the scan must see exactly
    // the seven lanes it polices — a copied predicate in a NEW file would show
    // up as an eighth user (and as an offender above).
    expect(DOCUMENT_RECORD_SITES).toHaveLength(7);
    const users = packSources()
      .filter((file) => file !== 'text.ts')
      .filter((file) => source(file).includes('isDocumentRecord'));
    expect(users.sort()).toEqual([...DOCUMENT_RECORD_SITES].sort());
    for (const file of DOCUMENT_RECORD_SITES) {
      const text = source(file);
      expect(text, `${file} does not import isDocumentRecord from ./text`).toMatch(
        /import \{[^}]*isDocumentRecord[^}]*\} from '\.\/text';/,
      );
      expect(
        (text.match(/isDocumentRecord\(/g) ?? []).length,
        `${file} does not call isDocumentRecord`,
      ).toBeGreaterThan(0);
    }
  });
});

// --- The measured divergence, kept as the record of the defect -------------

describe('the retired divergence, recorded as the reason the pin exists', () => {
  it('a comment-only file is a FAILURE in both lanes today, where they used to disagree', async () => {
    // BEFORE row 147, measured with the repo's own js-yaml:
    //   foundry body  → loadAll → `[]`  → `{entries: 0, skipped: 0, failures: []}`
    //   equipment body→ filter nulls → THROW `no YAML document`
    // The consequence was an import that reported a CLEAN book while the file
    // was accounted NOWHERE (`packImport.ts` pushes `parsed.failures` only).
    // A whole-file failure is now the ONE outcome for both, and the copy is
    // owned by `text.ts` rather than by either adapter.
    const foundry = PACK_ADAPTERS.find((candidate) => candidate.id === 'foundry-dnd5e-srd');
    const equipment = PACK_ADAPTERS.find(
      (candidate) => candidate.id === 'foundry-dnd5e-equipment',
    );
    if (foundry === undefined || equipment === undefined) throw new Error('missing dnd5e adapter');
    const messages: string[] = [];
    for (const adapter of [foundry, equipment]) {
      try {
        await adapter.parseFile('silent.yml', encoder.encode('# comment only'));
        messages.push('NO THROW — accounted nowhere');
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(messages).toEqual([
      'silent.yml: no YAML document',
      'silent.yml: no YAML document',
    ]);
  });
});
