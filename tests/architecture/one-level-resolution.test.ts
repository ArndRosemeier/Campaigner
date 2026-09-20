import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ONE seam resolves an entity's level, and ONE reader reads a level out of
 * prose (docs/17 rows 206 and 247, AGENTS rule 4).
 *
 * THE FIRST REGRESSION (row 206) was a MISSING COPY, not a wrong one: the
 * artifact editor's "Regenerate with AI" rebuilt `StartRunInput` without
 * `entityLevelHint`, so `runStatblock` silently fell back to a regex over a
 * brief whose only `level N` was the PARTY's.
 *
 * THE SECOND (row 247, the owner's level-5 smith) was the same idea again: a
 * level stated in the module's PREMISE reached nothing, a party-level line
 * biased the model, and the reply's own level was persisted verbatim — with a
 * notice beside it. The cure is still ONE site: `runStatblock` resolves the
 * sources in ONE precedence chain (the user's instruction, the entity's OWN
 * MINTED BLOCK since row 282, the entity record's hint, the module's own
 * STRUCTURED level, the brief's party-line-free fallback), and the resolved
 * value BINDS the parsed block. `moduleStatedLevel` is ONE derivation (its two
 * consumers — the spine recording the hint and the engine resolving it — are
 * named here), and `firstLevelInText` is the ONE reader of `level N` out of any
 * prose.
 *
 * THE FOURTH (row 282, the owner's levels-1–2 module showing `level 7` on every
 * npc) was a SOURCE that should never have existed: the MODULE-WIDE PREMISE
 * read. Its half is pinned here too — the block outranks a stored hint that
 * contradicts it, and the block is read through ONE reader by the chip, the
 * stat-block card and the engine.
 *
 * THE SIXTH (row 285, the owner's *"That level 3 mob had in its prose that its
 * level 5 … It was ignored on multiple occasions."*) was a MISSING RUNG plus an
 * unscoped fallback: there was NO entity-prose source at all, so a part's
 * STRUCTURED band outranked the figure's OWN sentence (specificity inverted,
 * entity > part > module), an instruction facing a stored hint with no block
 * left TWO levels in one prompt, and the last-rung brief read was not
 * name-scoped. The cure is ONE name-scoped prose seam
 * (`roomBudget.nameScopedLevel`, called by `entityProseLevel` for the module
 * prose and by the engine for its brief fallback) reading the sentence around
 * the figure's NAME through the EXISTING `wikilinks.sentenceAround` and the
 * EXISTING `firstLevelInText` — never a second sentence reader, never a second
 * level regex. The pins below hold the seam to ONE definition and hold
 * `moduleStatedLevel`'s PROSE-BEFORE-BAND order; the behavioural arms live in
 * `tests/llm/level-language.test.ts` (I1/I2 and the non-vacuity half) and
 * `tests/llm/runEngine.test.ts` (D and E).
 *
 * The pins are SOURCE SCANS because the drift they catch is invisible: a second
 * call site that rebuilds `StartRunInput` reads correctly today and silently
 * loses the level the day a caller is added, and a second `level N` regex
 * anywhere is a second answer to the same question.
 *
 * THE FIFTH (row 283) is a MISSING RULE rather than a duplicated one: the hint
 * is a GENERATION TARGET, and the model was never told how to AIM it — so a
 * figure the party NEVER fights was aimed at the module's band like a combatant.
 * The spine clause is now a function of the module's own band and states the two
 * cases (fight ⇒ balance, inside the band; never fight ⇒ realism, the band
 * neither caps nor pulls down), and the out-of-band signal exists ONLY for an
 * encounter participant, judged inside the SAME `fielded` guard the fixed-cast
 * party-level advisory already uses (docs/17 row 283).
 *
 * THE THIRD (row 253) was an ASYMMETRY, not a copy count: the app GENERATES in
 * eleven languages (`llm/language.ts` carries the directive) while the ONE
 * reader asked only for the English word `level`, so a German module's own
 * `Stufe 5` reached NOTHING and the entity fell through to the module's band.
 * The vocabulary now lives in ONE map in the language seam (`LEVEL_WORDS`, one
 * entry per `GENERATION_LANGUAGES` code, machine-enforced complete) and the
 * reader is its ONE caller, so the pre-253 English-only regex is pinned ABSENT
 * rather than renamed: a level word list is a language fact, and a second one
 * is how the reader goes monolingual again (docs/17 row 162 is the same class).
 */

const SRC_DIR = join(process.cwd(), 'src');
const ENGINE = 'src/llm/runEngine.ts';
const ROOM_BUDGET = 'src/llm/roomBudget.ts';
const MODULE_GEN = 'src/llm/moduleGen.ts';
const LANGUAGE = 'src/llm/language.ts';
const ROSTER = 'src/llm/encounterRoster.ts';
const WIKILINKS = 'src/lib/wikilinks.ts';
const ENTITY_PANEL = 'src/features/modules/entity-panel.tsx';
const STAT_BLOCK_CARD = 'src/features/campaign/components/stat-block.tsx';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

function rel(full: string): string {
  return relative(process.cwd(), full).split(sep).join('/');
}

/** Comments are skipped: the seam's own docstring NAMES the regex it removes. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function scanned(): (readonly [string, string])[] {
  return sourceFiles(SRC_DIR).map(
    (file) => [rel(file), stripComments(readFileSync(file, 'utf8'))] as const,
  );
}

function filesContaining(needle: string): string[] {
  return scanned()
    .filter(([, text]) => text.includes(needle))
    .map(([file]) => file);
}

describe('ONE seam resolves the entity level (docs/17 rows 206/247/253)', () => {
  it('states the precedence chain at exactly one site, and only in the engine', () => {
    const files = sourceFiles(SRC_DIR);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(
      filesContaining('const resolvedLevel = explicitLevel ?? recordedLevel ?? moduleLevel'),
    ).toEqual([ENGINE]);
    // The user's instruction is read at that same site, and the module's own
    // level is consulted there too.
    expect(filesContaining('instructionLevel(statedInstruction)')).toEqual([ENGINE]);
    expect(filesContaining('context.moduleGrounding?.statedLevel')).toEqual([ENGINE]);
  });

  it('reads a level out of prose through ONE reader, fed by ONE language vocabulary', () => {
    // The reader itself…
    expect(filesContaining('export function firstLevelInText')).toEqual([ROOM_BUDGET]);
    // …and the level-WORD vocabulary lives in exactly ONE place (docs/17 row
    // 253): the language seam, beside the directive that makes the app GENERATE
    // in eleven languages. A new language is added to ONE map, not to a regex.
    expect(filesContaining('export const LEVEL_WORDS')).toEqual([LANGUAGE]);
    expect(filesContaining('export function levelWordsPattern')).toEqual([LANGUAGE]);
    // The reader is the ONLY caller of that pattern — a second caller would be
    // a second answer to "what does this text say the level is".
    expect(filesContaining('levelWordsPattern()').sort()).toEqual([ROOM_BUDGET, LANGUAGE].sort());
    // The PRE-253 English-only regex is GONE from `src/`, in BOTH spellings a
    // reader could be re-born as: a regex LITERAL (`/\blevel\s*(\d{1,2})\b/i`)
    // and the escaped SOURCE-string spelling, whose backslashes DOUBLE in the
    // source text (`'\\blevel\\s*(\\d{1,2})\\b'`). Whitespace is stripped
    // from each file first, so a literal wrapped across lines or re-spaced
    // (`` / \blevel \s* ( \d{1,2} ) \b / ``) is caught too. Non-vacuity: the
    // detector must fire on both source spellings, which is why each is
    // asserted against a synthetic text below. NOTE THE SCOPE: like every scan
    // in this file it walks `src/` ONLY, so an injection into the TEST tree is
    // invisible to it by construction — measured the hard way while proving
    // this pin: the first attempt injected in `tests/` and read the green as a
    // dead pin; the real injection went into `src/llm/language.ts` and red.
    const stripWhitespace = (text: string): string => text.replace(/\s+/g, '');
    const englishOnlyNeedle = String.raw`\blevel\s*(\d{1,2})\b`;
    const escapedNeedle = String.raw`\\blevel\\s*(\\d{1,2})\\b`;
    expect(
      stripWhitespace(String.raw`const a = /\blevel\s*(\d{1,2})\b/i;`),
      'the detector fires on a regex LITERAL',
    ).toContain(englishOnlyNeedle);
    expect(
      stripWhitespace(String.raw`const a = '\\blevel\\s*(\\d{1,2})\\b';`),
      'and on the escaped SOURCE-string spelling',
    ).toContain(escapedNeedle);
    const englishOnly = scanned()
      .filter(([, text]) => {
        const code = stripWhitespace(text);
        return code.includes(englishOnlyNeedle) || code.includes(escapedNeedle);
      })
      .map(([file]) => file);
    expect(englishOnly).toEqual([]);
  });

  it('derives the module’s own stated level once, for the spine recording and the engine resolution', () => {
    expect(filesContaining('export function moduleStatedLevel')).toEqual([ROOM_BUDGET]);
    // TWO consumers, both named: the spine records the level onto the entity
    // records it saves, the engine resolves it for a module-created run.
    expect(
      filesContaining('moduleStatedLevel(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([MODULE_GEN, ENGINE]);
  });

  it('reads a NAMED figure’s prose through ONE name-scoped seam, ABOVE either band (docs/17 row 285)', () => {
    // THE SEAM, defined once: "the level this text states ABOUT this name".
    // `entityProseLevel` composes it for the module (part sentence, then
    // premise sentence); the engine's brief fallback calls it directly. Both
    // ride THIS one function, so a rename or a second copy reds here.
    expect(filesContaining('export function nameScopedLevel')).toEqual([ROOM_BUDGET]);
    expect(filesContaining('export function entityProseLevel')).toEqual([ROOM_BUDGET]);
    expect(
      filesContaining('nameScopedLevel(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
    // It reads the EXISTING sentence reader and the EXISTING level grammar —
    // a second one of either is the drift this whole file exists to catch.
    expect(filesContaining('export function sentenceAround')).toEqual([WIKILINKS]);
    expect(filesContaining('export function firstLevelInText')).toEqual([ROOM_BUDGET]);
    // THE ORDER IS THE CURE (docs/17 row 285): inside `moduleStatedLevel` the
    // PROSE rung is consulted BEFORE the mentioning part's structured band, so
    // a figure's own sentence is more specific than the part it sits in. A swap
    // back to the pre-285 order reds HERE.
    const roomBudget = readFileSync(join(process.cwd(), ROOM_BUDGET), 'utf8');
    const proseRung = roomBudget.indexOf('const fromProse = entityProseLevel(module, name)');
    const partRung = roomBudget.indexOf('const fromPart = partLevelForMention(module, name)');
    expect(proseRung, 'the prose rung exists').toBeGreaterThan(-1);
    expect(partRung, 'the part-band rung exists').toBeGreaterThan(-1);
    expect(partRung, 'the prose rung sits ABOVE the structured band').toBeGreaterThan(proseRung);
    // And the prose rung itself is name-scoped with the `'nothing'` arm: a
    // sentence that names nobody is not evidence about anyone.
    expect(roomBudget).toContain("nameScopedLevel(part.markdown, name, 'nothing')");
    expect(roomBudget).toContain("nameScopedLevel(module.spine?.premise ?? '', name, 'nothing')");
  });

  it('routes the brief-text fallback through the ONE party-line exclusion, and leaves no raw-brief reader', () => {
    // Defined once, beside `partyLevelLine` whose shape it excludes…
    expect(filesContaining('export function withoutPartyLevelLines')).toEqual([ROOM_BUDGET]);
    // …and consumed only by the stat-block step: the fallback read AND the
    // prompt the step finally sends (docs/17 row 247 removed the party line from
    // BOTH, so what the reader ignores and what the model sees cannot drift).
    const callers = filesContaining('withoutPartyLevelLines(').filter(
      (file) => file !== ROOM_BUDGET,
    );
    expect(callers).toEqual([ENGINE]);
    // The pre-row-206 raw regex over the brief is GONE: a second reader that
    // bypasses the party-line exclusion reds here.
    expect(filesContaining('.exec(input.brief)')).toEqual([]);
  });

  it('reads a mob’s MINTED level through ONE reader, and keeps the chain at one site (docs/17 row 282)', () => {
    // THE READER, defined once beside the ONE level grammar and reached by every
    // surface that answers "what level is this mob": the entity panel's chip, the
    // stat-block card, and the engine's precedence chain.
    expect(filesContaining('export function mobLevelText')).toEqual([ROSTER]);
    expect(filesContaining('export function mobLevelFor')).toEqual([ROSTER]);
    expect(
      filesContaining('mobLevelFor(')
        .filter((file) => file !== ROSTER)
        .sort(),
    ).toEqual([ENGINE, ENTITY_PANEL].sort());
    // The card renders a `StatBlock`, not an artifact (the bestiary, battle and
    // editor surfaces all mount it), so it reaches the SAME grammar read through
    // `mobLevelText` rather than re-printing the raw string.
    expect(
      filesContaining('mobLevelText(')
        .filter((file) => file !== ROSTER)
        .sort(),
    ).toEqual([STAT_BLOCK_CARD]);
    // THE BLOCK IS THE HEAD OF THE RECORDED TERM: a stored hint that contradicts
    // an existing minted block cannot steer a regeneration back to it, while the
    // precedence EXPRESSION itself is unchanged and still one site (so the
    // user's instruction and the module's structured level keep their order).
    expect(filesContaining('const recordedLevel = mintedBlockLevel ?? storedHint')).toEqual([ENGINE]);
    expect(filesContaining('const resolvedLevel = explicitLevel ?? recordedLevel ?? moduleLevel')).toEqual([
      ENGINE,
    ]);
    // The generated entity-hint paragraph gets the SAME one-site exclusion the
    // party line has, applied only where the block outranks the hint.
    expect(filesContaining('export function withoutEntityLevelHintLines')).toEqual([ROOM_BUDGET]);
    expect(
      filesContaining('withoutEntityLevelHintLines(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
  });

  it('aims the hint by TWO cases and judges an out-of-band target for participants only (docs/17 row 283)', () => {
    // THE AIMING CLAUSE IS A FUNCTION OF THE MODULE'S OWN BAND. Case (1) tells
    // the model to aim a figure the party might fight INSIDE this module's range,
    // which is only truthful when the numbers come from the module row; a
    // constant here would aim every module at one band.
    expect(filesContaining('function spineEntityLevelHint(')).toEqual([MODULE_GEN]);
    expect(filesContaining('spineEntityLevelHint(module.levelMin, module.levelMax)')).toEqual([
      MODULE_GEN,
    ]);
    // The pre-283 constant is GONE rather than renamed-and-left: a second aiming
    // clause reachable from anywhere else would be a second answer to "how do I
    // aim this figure's level", which is the defect class this whole file guards.
    expect(filesContaining('SPINE_ENTITY_LEVEL_HINT')).toEqual([]);
    // THE OUT-OF-BAND CHECK: ONE context type, ONE advisory sentence, both in the
    // ONE advisory home (`roomBudget`), with the engine as its only production
    // caller. The target reaches it through `entityLevelHintFor`, the ONE reader
    // of the module record's hint, rather than a second name-keyed copy.
    expect(filesContaining('export interface EncounterTargetContext')).toEqual([ROOM_BUDGET]);
    expect(filesContaining('The module targets level')).toEqual([ROOM_BUDGET]);
    expect(
      filesContaining('targetLevelFor:')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
    expect(
      filesContaining('targetLevelFor: (name) => entityLevelHintFor(owner.entityKinds, name)'),
    ).toEqual([ENGINE]);
    // The check lives UNDER the SAME `fielded` guard the party-level check uses,
    // so "takes part in an encounter" has ONE meaning here (the behavioral
    // non-vacuity arm lives in `tests/llm/fixedCast.test.ts`, docs/17 row 283).
    const roomBudget = readFileSync(join(process.cwd(), ROOM_BUDGET), 'utf8');
    const fieldedGuard = roomBudget.indexOf('if (!fielded) {');
    const outOfBandCheck = roomBudget.indexOf('target < targets.levelMin - ROOM_BUDGET_OVER_MARGIN');
    expect(fieldedGuard, 'the fielded guard exists').toBeGreaterThan(-1);
    expect(outOfBandCheck, 'the out-of-band target check exists').toBeGreaterThan(-1);
    expect(outOfBandCheck, 'the target check sits inside the fielded path').toBeGreaterThan(
      fieldedGuard,
    );
  });
});
