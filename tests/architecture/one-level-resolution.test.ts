import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CODE, filesWith } from '../helpers/sourceCode';

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
 *
 * THE SEVENTH (row 289) is the OWNER'S INSTRUCTION and the end of the pattern
 * as an authority: his measured sentence *"…images are preserved, but level
 * needs to be bumped to 3."* resolved NOTHING through `instructionLevel` (a
 * level word, then whitespace, then digits), so the chain fell to the minted
 * block and the stat block was bound to the OLD level while the prose model
 * wrote the level he asked for. The reader is now a structured model call —
 * `llm/instructionLevel.readInstructionLevel`, defined ONCE and called ONLY by
 * the engine — and the regex wrapper is DELETED. `firstLevelInText` remains the
 * ONE reader of a level out of the app's own MODULE prose (the name-scoped
 * rung, row 285) and is deliberately OUT of the instruction path.
 */

const ENGINE = 'src/llm/runEngine.ts';
const ROOM_BUDGET = 'src/llm/roomBudget.ts';
const LANGUAGE = 'src/llm/language.ts';
const ROSTER = 'src/llm/encounterRoster.ts';
const WIKILINKS = 'src/lib/wikilinks.ts';
const ENTITY_PANEL = 'src/features/modules/entity-panel.tsx';
const STAT_BLOCK_CARD = 'src/features/campaign/components/stat-block.tsx';
const INSTRUCTION_LEVEL = 'src/llm/instructionLevel.ts';
const ARTIFACT_DOMAIN = 'src/domain/artifact.ts';
const KIND_FORMS = 'src/features/campaign/components/kind-forms.tsx';
const ENTITY_BATCH = 'src/features/modules/entity-batch.ts';

/**
 * The files that size an encounter's fight (docs/17 row 291): the engine that
 * asks the seam, the seam itself, the editor form that names the part, and the
 * module batch whose brief carries the party line.
 */
const ENCOUNTER_LEVEL_FILES: readonly string[] = [
  ENGINE,
  ROOM_BUDGET,
  KIND_FORMS,
  ENTITY_BATCH,
];

/** Comments are skipped (`CODE`): the seam's own docstring NAMES the regex it removes. */
function scanned(): [string, string][] {
  return Object.entries(CODE);
}

describe('ONE seam resolves the entity level (docs/17 rows 206/247/253/289)', () => {
  it('states the precedence chain at exactly one site, and only in the engine', () => {
    const files = Object.keys(CODE);
    // Non-vacuity: the walk must see the whole tree, or it proves nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(
      filesWith('const resolvedLevel = explicitLevel ?? recordedLevel;'),
    ).toEqual([ENGINE]);
    // The user's instruction is read at that same site — BY THE MODEL since
    // docs/17 row 289. The reader is defined ONCE in its own module and called
    // ONLY by the engine, and the pre-289 regex wrapper is GONE rather than
    // renamed: a pattern over the owner's free text may never be the authority
    // again (AGENTS rule 5), so `export function instructionLevel` is pinned
    // ABSENT exactly as the pre-253 English-only regex is above.
    expect(filesWith('export function instructionLevel')).toEqual([]);
    expect(filesWith('export async function readInstructionLevel')).toEqual([
      INSTRUCTION_LEVEL,
    ]);
    expect(
      filesWith('readInstructionLevel(')
        .filter((file) => file !== INSTRUCTION_LEVEL)
        .sort(),
    ).toEqual([ENGINE]);
    expect(filesWith('context.moduleGrounding?.statedLevel')).toEqual([]);
  });

  it('reads a level out of prose through ONE reader, fed by ONE language vocabulary', () => {
    // The reader itself…
    expect(filesWith('export function firstLevelInText')).toEqual([ROOM_BUDGET]);
    // …and the level-WORD vocabulary lives in exactly ONE place (docs/17 row
    // 253): the language seam, beside the directive that makes the app GENERATE
    // in eleven languages. A new language is added to ONE map, not to a regex.
    expect(filesWith('export const LEVEL_WORDS')).toEqual([LANGUAGE]);
    expect(filesWith('export function levelWordsPattern')).toEqual([LANGUAGE]);
    // The reader is the ONLY caller of that pattern — a second caller would be
    // a second answer to "what does this text say the level is".
    expect(filesWith('levelWordsPattern()').sort()).toEqual([ROOM_BUDGET, LANGUAGE].sort());
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

  it('an entity level is STRICTLY the stated one — no section, prose or band derivation exists (docs/17 row 401)', () => {
    // The owner: the level strictly comes from the story LLM. The three
    // context-derived sources are DELETED; a reappearance reds here.
    expect(filesWith('function moduleStatedLevel')).toEqual([]);
    expect(filesWith('function entityProseLevel')).toEqual([]);
    expect(filesWith('moduleStatedLevel(')).toEqual([]);
    expect(filesWith('withCombatEntityLevelHints')).toEqual([]);
    // The engine's chain has exactly the three sources and no band.
    const engine = readFileSync(join(process.cwd(), ENGINE), 'utf8');
    expect(engine).toContain('const resolvedLevel = explicitLevel ?? recordedLevel;');
    expect(engine).not.toContain('levelMin: module.levelMin');
    // The section number survives ONLY as the PARTY level (where in the story).
    expect(filesWith('export function partLevelForMention')).toEqual([ROOM_BUDGET]);
    const roomBudget = readFileSync(join(process.cwd(), ROOM_BUDGET), 'utf8');
    expect(roomBudget).toContain('NEVER answers "HOW STRONG');
    expect(roomBudget).toContain('TOOK\n * PLACE IN THE PAST');
  });

  it('reads a figure’s prose through ONE name-scoped seam (the brief fallback only, docs/17 rows 285/401)', () => {
    expect(filesWith('export function nameScopedLevel')).toEqual([ROOM_BUDGET]);
    expect(
      filesWith('nameScopedLevel(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
    expect(filesWith('export function sentenceAround')).toEqual([WIKILINKS]);
    expect(filesWith('export function firstLevelInText')).toEqual([ROOM_BUDGET]);
  });

  it('routes the brief-text fallback through the ONE party-line exclusion, and leaves no raw-brief reader', () => {
    // Defined once, beside `partyLevelLine` whose shape it excludes…
    expect(filesWith('export function withoutPartyLevelLines')).toEqual([ROOM_BUDGET]);
    // …and consumed only by the stat-block step: the fallback read AND the
    // prompt the step finally sends (docs/17 row 247 removed the party line from
    // BOTH, so what the reader ignores and what the model sees cannot drift).
    const callers = filesWith('withoutPartyLevelLines(').filter(
      (file) => file !== ROOM_BUDGET,
    );
    expect(callers).toEqual([ENGINE]);
    // The pre-row-206 raw regex over the brief is GONE: a second reader that
    // bypasses the party-line exclusion reds here.
    expect(filesWith('.exec(input.brief)')).toEqual([]);
  });

  it('reads a mob’s MINTED level through ONE reader, and keeps the chain at one site (docs/17 row 282)', () => {
    // THE READER, defined once beside the ONE level grammar and reached by every
    // surface that answers "what level is this mob": the entity panel's chip, the
    // stat-block card, and the engine's precedence chain.
    expect(filesWith('export function mobLevelText')).toEqual([ROSTER]);
    expect(filesWith('export function mobLevelFor')).toEqual([ROSTER]);
    expect(
      filesWith('mobLevelFor(')
        .filter((file) => file !== ROSTER)
        .sort(),
    ).toEqual([ENGINE, ENTITY_PANEL].sort());
    // The card renders a `StatBlock`, not an artifact (the bestiary, battle and
    // editor surfaces all mount it), so it reaches the SAME grammar read through
    // `mobLevelText` rather than re-printing the raw string.
    expect(
      filesWith('mobLevelText(')
        .filter((file) => file !== ROSTER)
        .sort(),
    ).toEqual([STAT_BLOCK_CARD]);
    // THE BLOCK IS THE HEAD OF THE RECORDED TERM: a stored hint that contradicts
    // an existing minted block cannot steer a regeneration back to it, while the
    // precedence EXPRESSION itself is unchanged and still one site (so the
    // user's instruction and the module's structured level keep their order).
    expect(filesWith('const recordedLevel = mintedBlockLevel ?? storedHint')).toEqual([ENGINE]);
    expect(filesWith('const resolvedLevel = explicitLevel ?? recordedLevel;')).toEqual([
      ENGINE,
    ]);
    // The generated entity-hint paragraph gets the SAME one-site exclusion the
    // party line has, applied only where the block outranks the hint.
    expect(filesWith('export function withoutEntityLevelHintLines')).toEqual([ROOM_BUDGET]);
    expect(
      filesWith('withoutEntityLevelHintLines(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
  });

  it('makes the PART the only encounter level, and holds the pattern and the midpoint ABSENT (docs/17 row 291)', () => {
    // THE FREE-TEXT READER IS DELETED, not renamed. `parseRosterTargetLevel`
    // was `/(\d+)/.exec(levelHint)` over a string the MODEL wrote: "CR 12 for 4
    // players" sized the window at 12 and "3/4 of the party" at 3. The name
    // must not exist in any spelling (AGENTS rule 5).
    expect(filesWith('parseRosterTargetLevel')).toEqual([]);
    // THE BAND MIDPOINT is not a level either: the ONE fallback that turned a
    // module's `levelMin`..`levelMax` RANGE into an encounter's level is gone,
    // so the two sizing paths (the roster window and the brief) cannot disagree
    // about whether a range is a level — neither reads one. The pin is scoped to
    // the encounter path's files: `llm/moduleGen` keeps a midpoint of its own
    // for the module creator's BESTIARY WINDOW ordering (which library creature
    // to OFFER) — a different question with no encounter involved, recorded as
    // deliberately unmoved in docs/18 §5.
    expect(
      scanned()
        .filter(
          ([file, text]) =>
            ENCOUNTER_LEVEL_FILES.includes(file) &&
            text.includes('(module.levelMin + module.levelMax) / 2'),
        )
        .map(([file]) => file),
    ).toEqual([]);
    // THE STORED `levelHint` IS DECLARED EXACTLY ONCE — the deprecated domain
    // key old rows carry (kept so an old row parses with no error state) — and
    // it is NEVER REACHED as `data.levelHint` anywhere in `src/` (the model no
    // longer writes it either: `levelHint: z.string()` is that one domain
    // declaration, not a reply contract).
    expect(filesWith('levelHint: z.string()')).toEqual([ARTIFACT_DOMAIN]);
    expect(
      scanned()
        .filter(([, text]) => /(?:\.|^)data\.levelHint\b/.test(text))
        .map(([file]) => file),
    ).toEqual([]);
    // THE ONE SEAM: every encounter party level comes from
    // `encounterPartyLevel`, defined once in `roomBudget` and called ONLY by
    // the engine — the roster window, the brief guidance and every room-stamping
    // site ask it, so a fourth caller cannot invent a fourth answer.
    expect(filesWith('export function encounterPartyLevel')).toEqual([ROOM_BUDGET]);
    expect(
      filesWith('encounterPartyLevel(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
    // …and the part read underneath it is ONE function carrying BOTH facts the
    // form needs (the part's TITLE and its exact level); `partLevelForMention`
    // is its level half, so the band read exists once. The form is the only
    // caller of the title half.
    expect(filesWith('export function partLevelMentionFor')).toEqual([ROOM_BUDGET]);
    expect(
      filesWith('partLevelMentionFor(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([KIND_FORMS]);
    // The level half keeps its one non-engine caller: the module entity batch's
    // brief carries the party line at the same mention position.
    expect(
      filesWith('partLevelForMention(')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENTITY_BATCH]);
  });

  it('judges an out-of-band target for participants only (docs/17 row 283)', () => {
    // THE AIMING CLAUSE for the stored entity level hint lived in the pass-0
    // spine prompt and is DELETED with pass 0 (docs/17 row 392), together with
    // the pre-283 constant it replaced.
    // THE OUT-OF-BAND CHECK survives: ONE context type, ONE advisory sentence,
    // both in the ONE advisory home (`roomBudget`), with the engine as its only
    // production caller. The target reaches it through `entityLevelHintFor`, the
    // ONE reader of the module record's hint, rather than a second name-keyed
    // copy.
    expect(filesWith('export interface EncounterTargetContext')).toEqual([ROOM_BUDGET]);
    expect(filesWith('The module targets level')).toEqual([ROOM_BUDGET]);
    expect(
      filesWith('targetLevelFor:')
        .filter((file) => file !== ROOM_BUDGET)
        .sort(),
    ).toEqual([ENGINE]);
    expect(
      filesWith('targetLevelFor: (name) => entityLevelHintFor(owner.entityKinds, name)'),
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
