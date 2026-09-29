import { comparableName } from '@/domain/artifactAlias';
import {
  bestiarySlotForEntity,
  encounterFloorGuardrailFor,
  entityLevelHintFor,
  type EncounterFloorGuardrail,
  type ModuleEntityKind,
} from '@/domain/module';
import { MODULE_PREMISE_LEVEL, moduleLevelList } from '@/domain/moduleDocument';

/**
 * ============================================================================
 * THE LEVEL PROBLEM LIST (docs/17 row 401) — ONE pure function over the WHOLE
 * document that says what the story author still owes the app:
 *
 * - `missing-level`: an NPC or encounter the document mentions whose RECORD
 *   states no level. The level is STATED by the chat (`<state_level>`), never
 *   inferred from context, so a name without one is a question, not a guess.
 * - `needs-placement`: an encounter mentioned ONLY in the premise. Its party
 *   level is the number of the first level SECTION that mentions it (later
 *   mentions are recaps of something already done); the premise is no section, so
 *   it has none until the encounter is placed in a level.
 * - `encounter-shortfall`: a level SECTION naming fewer distinct encounters than
 *   the per-level minimum (`encounterFloorGuardrail`, the owner's setting).
 *
 * `unclassifiedLinks` are wiki-links with no recorded kind. They are COUNTED
 * separately — never silently as encounters, never as zero — and are NOT part of
 * the ask (most are locations); a chat statement with `entity="encounter"` makes
 * one an encounter.
 *
 * Both surfaces — the chat's problem card and the Generate dialog — call THIS
 * function and format with `levelAskMessage`, so the list they show and the ONE
 * message the button sends cannot differ. An empty list means nothing is owed.
 * ============================================================================
 */

export type LevelProblem =
  | { kind: 'missing-level'; name: string; entityKind: 'npc' | 'encounter'; level: number }
  | { kind: 'needs-placement'; name: string }
  | { kind: 'encounter-shortfall'; level: number; found: number; required: number; short: number };

export interface LevelProblemReport {
  /** Everything owed, in document order (premise first, then each level). */
  problems: LevelProblem[];
  /** Wiki-links of unknown kind — reported, never counted as encounters. */
  unclassifiedLinks: string[];
  /** Per level section: the distinct encounters it names (the dialog's counts). */
  encounterCounts: { level: number; found: number; required: number }[];
}

export function deriveLevelProblems(input: {
  document: string;
  entityKinds: readonly ModuleEntityKind[];
  floor?: EncounterFloorGuardrail | null | undefined;
}): LevelProblemReport {
  const floor = encounterFloorGuardrailFor({ encounterFloorGuardrail: input.floor });
  const list = moduleLevelList(input.document, input.entityKinds);
  const problems: { order: number; problem: LevelProblem }[] = [];
  const seen = new Set<string>();
  const firstSection = new Map<string, number>();
  const unclassified = new Map<string, string>();
  const counts: LevelProblemReport['encounterCounts'] = [];
  let order = 0;
  for (const level of list.levels) {
    const encountersHere = new Set<string>();
    for (const mention of level.names) {
      const key = comparableName(mention.name);
      if (mention.kind === null) {
        if (!unclassified.has(key)) unclassified.set(key, mention.name);
        continue;
      }
      if (mention.kind === 'encounter') {
        encountersHere.add(key);
        if (level.number !== MODULE_PREMISE_LEVEL && !firstSection.has(key)) {
          firstSection.set(key, level.number);
        }
      }
      if ((mention.kind !== 'npc' && mention.kind !== 'encounter') || seen.has(key)) continue;
      seen.add(key);
      // A CAST npc (bestiary slot) takes its stats from a library creature.
      if (
        entityLevelHintFor(input.entityKinds, mention.name) === null &&
        bestiarySlotForEntity(input.entityKinds, mention.name) === null
      ) {
        problems.push({
          order: (order += 1),
          problem: { kind: 'missing-level', name: mention.name, entityKind: mention.kind, level: level.number },
        });
      }
    }
    if (level.number !== MODULE_PREMISE_LEVEL) {
      const required = floor.enabled ? floor.perLevel : 0;
      counts.push({ level: level.number, found: encountersHere.size, required });
      if (encountersHere.size < required) {
        problems.push({
          order: (order += 1),
          problem: {
            kind: 'encounter-shortfall',
            level: level.number,
            found: encountersHere.size,
            required,
            short: required - encountersHere.size,
          },
        });
      }
    }
  }
  // An encounter only the premise mentions: no section, so no party level.
  const premise = list.levels.find((level) => level.number === MODULE_PREMISE_LEVEL);
  for (const mention of premise?.names ?? []) {
    const key = comparableName(mention.name);
    if (mention.kind !== 'encounter' || firstSection.has(key)) continue;
    if (problems.some((entry) => entry.problem.kind === 'needs-placement' && comparableName(entry.problem.name) === key)) {
      continue;
    }
    problems.push({ order: 0.5, problem: { kind: 'needs-placement', name: mention.name } });
  }
  problems.sort((left, right) => left.order - right.order);
  return {
    problems: problems.map((entry) => entry.problem),
    unclassifiedLinks: [...unclassified.values()],
    encounterCounts: counts,
  };
}

/** One line per problem — the SAME words on the card, in the dialog and in the ask. */
export function levelProblemLine(problem: LevelProblem): string {
  switch (problem.kind) {
    case 'missing-level':
      return `- «${problem.name}» (${problem.entityKind}, first mentioned in ${problem.level === MODULE_PREMISE_LEVEL ? 'the premise' : `level ${String(problem.level)}`}) has no level.`;
    case 'needs-placement':
      return `- «${problem.name}» (encounter) is only mentioned in the premise — place it in a level.`;
    case 'encounter-shortfall':
      return `- Level ${String(problem.level)} names ${String(problem.found)} of the ${String(problem.required)} encounters it needs (${String(problem.short)} short).`;
  }
}

/**
 * THE ONE ASK: every problem in ONE message (never one per problem). Sent only
 * by an explicit click, through the chat's existing send.
 */
export function levelAskMessage(problems: readonly LevelProblem[]): string {
  return [
    'Please fix everything on this list in ONE reply. For every NPC and encounter without a level, state it with <state_level level="N" entity="npc|encounter"> (an easy or a hard figure is your call); write the missing encounters into the levels that are short; place premise-only encounters in a level.',
    ...problems.map(levelProblemLine),
  ].join('\n');
}
