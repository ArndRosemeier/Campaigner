/**
 * The duplicate-body tripwire — a repo-wide detector for one idea implemented
 * twice (AGENTS `§Centralization` obligation 4; `docs/17` row 172).
 *
 * WHY THIS EXISTS. A copy is invisible when it is BORN: nothing fails and each
 * copy is correct where it was written, so duplication is caught by a pin, not
 * by discipline. The real case this answers: seven identical `isRecord`
 * helpers, one per pack adapter, that no test could see until a task happened
 * to grep the right word. This file is the generic detector; it is a TRIPWIRE,
 * not a proof (see WHAT IT CANNOT SEE below).
 *
 * WHAT IT SCANS. Every `src/**` file named `*.ts` or `*.tsx` — no path is
 * excluded, and the baseline header repeats that (if a path ever must be
 * excluded, the exclusion and its reason belong in the baseline header, never
 * silent). `tests/` is deliberately out of scope: fixtures legitimately repeat.
 *
 * WHAT IT EXTRACTS. NAMED functions/methods only, through the TypeScript
 * compiler API (`node.getText()`/the scanner are used for correctness — a
 * regex body extractor breaks on nested braces and template literals):
 *   * `function f(...) {...}` declarations;
 *   * `const f = (...) => {...}` and `const f = function (...) {...}`;
 *   * class and object-literal methods, class-property arrows, and get/set
 *     accessors.
 * Anonymous callbacks are not named, so they are not compared.
 *
 * NORMALIZATION, stated exactly:
 *   1. comments are stripped — the token stream is the PARSER's own child tree
 *      (`node.getChildren()`), in which comments are trivia and never appear;
 *   2. all formatting whitespace is collapsed — the body is re-emitted as its
 *      parser token stream joined with single spaces, so formatting differences
 *      vanish. Whitespace INSIDE a string/template/regex literal is data and is
 *      kept verbatim; a JSX text run's indentation is collapsed to single
 *      spaces. (A bare `scanner.scan()` loop is deliberately NOT used: measured
 *      at base `7b390de`, it mis-tokenizes a template's `${…}` tail and a JSX
 *      text run containing a stray quote — 735 of 2651 bodies hit an
 *      unterminated token that way, which silently skips comment stripping and
 *      whitespace collapse for the rest of the body.)
 *   3. the function's OWN name and its PARAMETER names are blanked to `$`,
 *      but only in VALUE/reference position: property keys (`obj.name`), object
 *      literal keys (`{ name: value }`), shorthand property keys (`{ name }`)
 *      and declaration names are NOT blanked. So a copy that renamed the
 *      function and its parameters is caught, while `artifact.name` and
 *      `entry.title` stay two different functions.
 *
 * THE FLOOR = 75 normalized characters (the const below). JUSTIFICATION, and
 * the deliberate deviation from this slice's brief: the brief's starting point
 * (about 120 characters / 4+ statements) CANNOT see the seven-copy `isRecord`,
 * whose normalized body is exactly 75 characters (`{ return typeof $ ===
 * 'object' && $ !== null && ! Array . isArray ( $ ) ; }`) and one statement —
 * i.e. it would be blind to the very duplication it was ordered for, and its
 * seven baseline entries could not exist. 75 is the LARGEST floor that keeps
 * the motivating case, which also keeps the blessed population as small as the
 * motivating case allows: measured at base `7b390de` (2651 named bodies in 390
 * files), floor 75 = 16 duplicate groups / 46 sites, floor 70 = 19, floor 65 =
 * 22, floor 60 = 25 (the brief's ~25 stop line), floor 40 = 29, floor 120 = 9
 * with `isRecord` MISSING. A reader who disagrees with 75 is meant to argue
 * with this paragraph. ONE known copy sits just under the floor: the three
 * `settledDetail` image-queue bodies normalize to 74 characters and are
 * therefore NOT compared — a floor decision for the next reader, named here
 * rather than left as a silent gap.
 *
 * NAMING THE PIN: the population below is keyed by the hash of the normalized
 * body, and a group is any normalized body with 2+ sites — whether in one file
 * or several. The failure message names every site as `file:function:line` and
 * the shared hash, so the fix starts at the seam question (can ONE seam carry
 * this?), never at "fix each copy".
 *
 * THE BASELINE IS DEBT, NOT A LICENCE. `duplicateImplementationsBaseline.json`
 * records the population that exists TODAY, one entry per group with every
 * `file:function` site and a written reason — the repo's captured-state pattern
 * (`tests/lib/pdfLayoutBaseline.json`). Folding a copy FORCES its baseline line
 * out: an entry whose sites no longer match the tree (folded, renamed or moved)
 * reds this test BY NAME, so a stale blessing cannot survive. Never add an
 * entry to make a new duplicate green; baseline it only with a reason and a
 * named fold slice.
 *
 * WHAT IT CANNOT SEE (stated plainly): paraphrases — two implementations of
 * one idea that differ by more than names and token whitespace (reordered
 * statements, a different local variable, `===` for `!==`, string quote style,
 * a different helper used) are NOT caught. Bodies below the floor are not
 * compared (a one-line `return x === null` is not evidence of duplication).
 * Anonymous callbacks and computed/numeric-only names are not extracted. The
 * tripwire catches identical copies, not duplicated INTENT.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The normalized-size floor. See the file doc comment for the measurement and
 * the argument for 75 rather than the brief's suggested 120.
 */
export const NORMALIZED_FLOOR = 75;

/** One extracted, normalized named function/method body. */
export interface ScannedFunction {
  /** Path relative to the repo root, e.g. `src/db/db.ts`. */
  file: string;
  name: string;
  /** 1-based line of the function node. */
  line: number;
  normalized: string;
  hash: string;
}

/** A normalized body that occurs at 2+ sites. */
export interface DuplicateGroup {
  hash: string;
  normalized: string;
  sites: ScannedFunction[];
}

const baselineEntrySchema = z.object({
  hash: z.string().min(1),
  reason: z.string().min(1),
  sites: z.array(z.string().min(1)).min(2),
});

const baselineSchema = z.object({
  note: z.string(),
  scope: z.string(),
  groups: z.array(baselineEntrySchema),
});

export const BASELINE_PATH = 'tests/architecture/duplicateImplementationsBaseline.json';

export function hashBody(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Collect every bound name in a binding pattern (parameters may destructure). */
function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
}

function parameterNames(parameters: readonly ts.ParameterDeclaration[]): Set<string> {
  const names = new Set<string>();
  for (const parameter of parameters) bindingNames(parameter.name, names);
  return names;
}

/** A member name we can print; computed and numeric-only names are skipped. */
function memberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * True when this Identifier is a NAME — a property key, declaration name or
 * label — rather than a value reference. Those names are NOT blanked, so
 * `{ name }` and `{ title }` stay different bodies.
 */
function isNamePosition(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent)) return node === parent.name;
  if (ts.isQualifiedName(parent)) return node === parent.right;
  if (ts.isPropertyAssignment(parent)) return node === parent.name;
  if (ts.isShorthandPropertyAssignment(parent)) return node === parent.name;
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return node === parent.name;
  if (ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) return node === parent.name;
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) return node === parent.name;
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return node === parent.name;
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return node === parent.name;
  if (ts.isBindingElement(parent)) return node === parent.name || node === parent.propertyName;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isEnumMember(parent)) return node === parent.name;
  if (ts.isTypeReferenceNode(parent)) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
    return node === parent.label;
  }
  return false;
}

/**
 * Normalize one function body: blank the function's own name and its parameter
 * names in value position, drop comments, and collapse all formatting
 * whitespace by re-emitting the body as its PARSER token stream joined with
 * single spaces.
 *
 * The token stream comes from `node.getChildren()` rather than a bare
 * `scanner.scan()` loop, and that is a correctness requirement, not a style
 * choice: a bare scan mis-tokenizes a template literal's `${…}` tail and a JSX
 * text run containing a stray quote (measured at base `7b390de`: 735 of 2651
 * bodies hit an unterminated token that way). `getChildren()` is the parser's
 * own tree, so nested braces, template substitutions and JSX children are
 * already resolved. Whitespace INSIDE string/template/regex literal text is
 * data and is kept verbatim; a JSX text run's indentation is formatting and is
 * collapsed to single spaces.
 */
export function normalizeBody(body: ts.Node, sourceFile: ts.SourceFile, blank: ReadonlySet<string>): string {
  const blankNodes = new Set<ts.Node>();
  const collect = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (ts.isIdentifier(node) && blank.has(node.text) && !isNamePosition(node, parent)) {
      blankNodes.add(node);
    }
    node.forEachChild((child) => {
      collect(child, node);
    });
  };
  collect(body, undefined);
  const tokens: string[] = [];
  const emit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (ts.isIdentifier(node) && blankNodes.has(node)) {
        tokens.push('$');
        return;
      }
      const raw = node.getText(sourceFile);
      const text = node.kind === ts.SyntaxKind.JsxText ? raw.replace(/\s+/g, ' ').trim() : raw;
      if (text.length > 0) tokens.push(text);
      return;
    }
    for (const child of children) emit(child);
  };
  emit(body);
  return tokens.join(' ');
}

/** Extract every NAMED function/method body from one source file. */
export function collectNamedFunctions(file: string, code: string): ScannedFunction[] {
  const sourceFile = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: ScannedFunction[] = [];
  const add = (
    name: string,
    parameters: readonly ts.ParameterDeclaration[],
    body: ts.Node,
    at: ts.Node,
  ): void => {
    const blank = parameterNames(parameters);
    blank.add(name);
    const normalized = normalizeBody(body, sourceFile, blank);
    const line = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile)).line + 1;
    found.push({ file, name, line, normalized, hash: hashBody(normalized) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      add(node.name.text, node.parameters, node.body, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer.parameters, node.initializer.body, node.initializer);
    } else if (ts.isMethodDeclaration(node) && node.body !== undefined) {
      const name = memberName(node.name);
      if (name !== null) add(name, node.parameters, node.body, node);
    } else if (
      (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
      node.body !== undefined
    ) {
      const name = memberName(node.name);
      if (name !== null) add(name, node.parameters, node.body, node);
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = memberName(node.name);
      if (name !== null) add(name, node.initializer.parameters, node.initializer.body, node.initializer);
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = memberName(node.name);
      if (name !== null) add(name, node.initializer.parameters, node.initializer.body, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

/** Group functions at or above the floor by normalized body; keep 2+ sites. */
export function groupFunctions(functions: readonly ScannedFunction[]): DuplicateGroup[] {
  const byHash = new Map<string, ScannedFunction[]>();
  for (const fn of functions) {
    if (fn.normalized.length < NORMALIZED_FLOOR) continue;
    const sites = byHash.get(fn.hash);
    if (sites === undefined) byHash.set(fn.hash, [fn]);
    else sites.push(fn);
  }
  const groups: DuplicateGroup[] = [];
  for (const [hash, sites] of byHash) {
    if (sites.length < 2) continue;
    const sorted = [...sites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const first = sorted[0];
    if (first === undefined) continue;
    groups.push({ hash, normalized: first.normalized, sites: sorted });
  }
  return groups.sort((a, b) => a.hash.localeCompare(b.hash));
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

/** Scan the real `src/` tree and return the duplicate groups at the floor. */
export function scanRepo(): DuplicateGroup[] {
  const cwd = process.cwd();
  const functions: ScannedFunction[] = [];
  for (const file of sourceFiles(path.join(cwd, 'src'))) {
    const code = readFileSync(file, 'utf8');
    functions.push(...collectNamedFunctions(path.relative(cwd, file), code));
  }
  return groupFunctions(functions);
}

function siteKey(fn: ScannedFunction): string {
  return `${fn.file}:${fn.name}`;
}

function siteWithLine(fn: ScannedFunction): string {
  return `${fn.file}:${fn.name}:${fn.line}`;
}

describe('the duplicate-body tripwire can see what it polices (non-vacuity)', () => {
  it('recognises a copy that renamed the function and its parameters as ONE implementation', () => {
    const code = [
      'function alpha(value) {',
      "  return typeof value === 'object' && value !== null && !Array.isArray(value);",
      '}',
      'function beta(thing) {',
      "  return typeof thing === 'object' && thing !== null && !Array.isArray(thing);",
      '}',
    ].join('\n');
    const groups = groupFunctions(collectNamedFunctions('synthetic.ts', code));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sites.map(siteKey)).toEqual(['synthetic.ts:alpha', 'synthetic.ts:beta']);
  });

  it('does NOT collapse bodies that reference a different property (artifact.name vs entry.title)', () => {
    const code = [
      'function alpha(artifact) {',
      '  return artifact.name.trim().toLowerCase() + artifact.name.length;',
      '}',
      'function beta(entry) {',
      '  return entry.title.trim().toLowerCase() + entry.title.length;',
      '}',
    ].join('\n');
    expect(groupFunctions(collectNamedFunctions('synthetic.ts', code))).toEqual([]);
  });

  it('does NOT compare bodies below the 75-character normalized floor', () => {
    const code = [
      'function alpha(value) { return value === null; }',
      'function beta(thing) { return thing === null; }',
    ].join('\n');
    expect(groupFunctions(collectNamedFunctions('synthetic.ts', code))).toEqual([]);
  });
});

describe('no duplicate implementations in src/ (the tripwire)', () => {
  it('matches the checked-in baseline exactly at the 75-character normalized floor', () => {
    const current = scanRepo();
    const baseline = baselineSchema.parse(
      JSON.parse(readFileSync(path.join(process.cwd(), BASELINE_PATH), 'utf8')) as unknown,
    );
    const currentByHash = new Map(current.map((group) => [group.hash, group]));
    const baselineByHash = new Map(baseline.groups.map((entry) => [entry.hash, entry]));
    const problems: string[] = [];

    for (const group of current) {
      const entry = baselineByHash.get(group.hash);
      const currentSites = group.sites.map(siteKey);
      if (entry === undefined) {
        problems.push(
          [
            `NEW DUPLICATE — shared normalized body ${group.hash} (${group.normalized.length} chars) is implemented at ${group.sites.length} sites:`,
            ...group.sites.map((site) => `    ${siteWithLine(site)}`),
            '  Ask the seam question first (AGENTS §Centralization obligation 4): can ONE seam carry this?',
            '  Do NOT add a baseline entry without a reason and a named fold slice.',
          ].join('\n'),
        );
      } else if (
        JSON.stringify([...currentSites].sort()) !== JSON.stringify([...entry.sites].sort())
      ) {
        problems.push(
          [
            `BASELINE SITE MISMATCH — shared normalized body ${group.hash}:`,
            `    baseline sites: ${entry.sites.join(', ')}`,
            `    current sites:  ${group.sites.map(siteWithLine).join(', ')}`,
            '  A copy was folded, renamed or moved: update or delete this baseline entry.',
          ].join('\n'),
        );
      }
    }

    for (const entry of baseline.groups) {
      if (!currentByHash.has(entry.hash)) {
        problems.push(
          [
            `STALE BASELINE ENTRY — ${entry.hash} [${entry.sites.join(', ')}] no longer matches any duplicate group:`,
            '  the copies were folded, renamed or moved out of the floor.',
            `  Delete this line from ${BASELINE_PATH} — the baseline is debt, not a licence.`,
          ].join('\n'),
        );
      }
    }

    expect(problems).toEqual([]);
  });
});
