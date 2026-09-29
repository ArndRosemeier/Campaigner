import type { AnyArtifact, EntityKind, Id, Module } from '@/domain';
import {
  ARTIFACT_KIND_SINGULAR,
  comparableName,
  ENTITY_KINDS,
  MODULE_PREMISE_LEVEL,
  moduleCreationPool,
  moduleDocumentFromView,
  moduleLevelList,
  type ModuleLevelList,
} from '@/domain';
import {
  batchTargets,
  encountersNeedingMaps,
  encountersNeedingMobPortraits,
  imageTargets,
} from '@/features/modules/post-generation';
import { resolveWikiLink } from '@/lib/wikilinks';

/**
 * ============================================================================
 * THE LEVEL-SCOPED GENERATION SELECTION (docs/23 §7, docs/17 row 394).
 *
 * THE OWNER'S CONTROL, IN ONE SEAM. The owner asked for "a detail generation
 * dialog with checkboxes and level ranges (for example: generate everything but
 * encounters and images for levels 1-3, although 6 levels are already defined)".
 * The question that dialog asks the app is exactly ONE: *which named entities,
 * of which kinds, does this selection cover?* — and this file is the only place
 * that question is answered. `(kinds, levelRange) → targets`, computed from the
 * DERIVED LEVEL LIST (`domain/moduleDocument.moduleLevelList`), never from a
 * second derivation of the document: the level list already carries each level's
 * wiki-linked names by kind, level 0 (the premise) included.
 *
 * THE DEDUPE RULE IS THE OWNER'S (docs/23 §6, ratified): "an entity named in
 * several levels is generated at the FIRST level it is mentioned". A name
 * mentioned in levels 2, 4 and 5 is therefore ONE target, at level 2 — and the
 * `duplicates` list carries the later mentions so the dialog can SAY so rather
 * than choose silently. The name key is the repo's ONE name comparison
 * (`domain/artifactAlias.comparableName`), so two spellings of one entity are
 * one target here exactly as they are everywhere else.
 *
 * THE PREMISE HAS NO AUTOMATIC LEVEL, AND THAT IS AN EXPLICIT ANSWER, NOT A
 * GUESS. Level 0 (the premise) is a level of the document but NOT a level
 * SECTION, so a name mentioned ONLY in the premise has no first section to be
 * generated at. Those names are reported in `premiseOnly` and are selected ONLY
 * when the range's own low bound is the premise (`levelRange.min ===
 * MODULE_PREMISE_LEVEL`) — the dialog renders that bound as "Premise (no level
 * yet)" and the scope statement names the bucket with its count, so the answer
 * is visible before anything runs. The engine is then free to infer the level
 * (its `explicitLevel ?? recordedLevel ?? moduleLevel` chain, docs/17 row 247);
 * the selection never invents one.
 *
 * WHAT THIS FILE DOES NOT DO: it does not generate, enqueue or read the DB. The
 * detail verdict is the entity panel's own (`features/modules/detailed-entity`),
 * and the image/map/portrait target sets are the sweep's own detectors
 * (`features/modules/post-generation`) — this seam only restricts them to the
 * selected names, so the dialog and the entity workflow can never disagree about
 * what is missing. The one module-level entry derives the level list exactly
 * ONCE.
 * ============================================================================
 */

/** The generation dialog's kinds: the six entity kinds plus the image pass. */
export const GENERATION_IMAGE_KIND = 'image' as const;
export type GenerationKind = EntityKind | typeof GENERATION_IMAGE_KIND;

/** The dialog's selectable kinds in the domain's own order, images last. */
export const GENERATION_KINDS: readonly GenerationKind[] = [...ENTITY_KINDS, GENERATION_IMAGE_KIND];

/**
 * A level RANGE, read the way docs/23 §2.1 says: "levels 1–3" means the level
 * SECTIONS 1, 2 and 3, so it excludes the premise by construction; a low bound of
 * `MODULE_PREMISE_LEVEL` (0) is the named "no level yet" bucket, which is the
 * only way a premise-only entity can be selected.
 */
export interface GenerationLevelRange {
  min: number;
  max: number;
}

/** One thing the selection will generate, and the level that selected it. */
export interface GenerationTarget {
  /** The exact wiki-link name the produced artifact must carry. */
  name: string;
  kind: EntityKind;
  /**
   * The level whose mention selected this target — its FIRST level SECTION
   * mention. `null` is the premise-only bucket: the name has no level yet and
   * the engine infers one.
   */
  level: number | null;
}

/** An encounter target, carrying the row a map/portrait job attaches to. */
export interface GenerationEncounterTarget extends GenerationTarget {
  artifactId: Id;
}

/** A name several levels mention: generated ONCE, at its first mention. */
export interface GenerationDuplicate {
  name: string;
  kind: EntityKind;
  /** The level the entity is generated at (its first level-section mention). */
  level: number;
  /** Every LATER level that mentions the same name too. */
  laterLevels: number[];
}

/** One selected level and how many targets fall on it. */
export interface GenerationLevelCount {
  number: number;
  count: number;
}

/** The level-scoped name selection — the pure half of the seam. */
export interface LevelNameSelection {
  /**
   * The targets the range and kinds select, each name EXACTLY ONCE: ordered by
   * level (the premise bucket first when it is on), then the domain's kind
   * order, then name. A premise-only target carries `level: null`.
   */
  targets: GenerationTarget[];
  /**
   * Names mentioned ONLY in the premise (level 0) of a selected kind — the "no
   * level yet" bucket. Reported ALWAYS, whether or not it is selected, so the
   * scope statement can name what it is leaving out.
   */
  premiseOnly: GenerationTarget[];
  /** Names several levels mention (the dedupe rule, stated for the dialog). */
  duplicates: GenerationDuplicate[];
  /** Per selected level: the target count that falls on it. */
  levels: GenerationLevelCount[];
}

/** The name key every comparison in this file uses (the repo's ONE form). */
function nameKey(name: string): string {
  return comparableName(name);
}

/** Level first, then kind (the domain's order), then name. */
function compareTargets(left: GenerationTarget, right: GenerationTarget): number {
  const leftLevel = left.level ?? MODULE_PREMISE_LEVEL;
  const rightLevel = right.level ?? MODULE_PREMISE_LEVEL;
  return (
    leftLevel - rightLevel ||
    ENTITY_KINDS.indexOf(left.kind) - ENTITY_KINDS.indexOf(right.kind) ||
    left.name.localeCompare(right.name)
  );
}

/**
 * `(kinds, levelRange) → targets`, computed from the DERIVED LEVEL LIST. PURE:
 * no DB, no module row, no artifact — the caller hands in the list it already
 * has.
 */
export function selectLevelNames(
  list: ModuleLevelList,
  kinds: readonly EntityKind[],
  levelRange: GenerationLevelRange,
): LevelNameSelection {
  const wanted = new Set(kinds);
  // The first level-SECTION mention per name, the premise's own mentions, and
  // every level that mentions it (the duplicate report's raw material). One walk
  // of the derived list, ascending, so "first" is literally the first section the
  // document carries.
  const firstSection = new Map<string, GenerationTarget>();
  const premiseMentions = new Map<string, GenerationTarget>();
  const mentionedAt = new Map<string, number[]>();
  for (const level of list.levels) {
    for (const mention of level.names) {
      if (mention.kind === null || !wanted.has(mention.kind)) continue;
      const key = nameKey(mention.name);
      const levels = mentionedAt.get(key);
      if (levels === undefined) mentionedAt.set(key, [level.number]);
      else if (!levels.includes(level.number)) levels.push(level.number);
      if (level.number === MODULE_PREMISE_LEVEL) {
        if (!premiseMentions.has(key)) {
          premiseMentions.set(key, { name: mention.name, kind: mention.kind, level: null });
        }
        continue;
      }
      if (!firstSection.has(key)) {
        firstSection.set(key, { name: mention.name, kind: mention.kind, level: level.number });
      }
    }
  }

  // The bucket is exactly the names with NO level section of their own: a name
  // the premise AND level 2 mention is a level-2 entity, never a bucket entry
  // (docs/23 §6's "first level SECTION that mentions it").
  const premiseOnly = [...premiseMentions]
    .filter(([key]) => !firstSection.has(key))
    .map(([, target]) => target)
    .sort(compareTargets);

  const inRange = (level: number): boolean =>
    level >= levelRange.min && level <= levelRange.max;
  const sectionTargets = [...firstSection.values()].filter(
    (target) => target.level !== null && inRange(target.level),
  );
  // The "no level yet" bucket is selected by the range's OWN low bound: the
  // premise IS level 0, so `min === 0` means "include it" and nothing else does.
  const includePremise = levelRange.min <= MODULE_PREMISE_LEVEL;
  const targets = [...(includePremise ? premiseOnly : []), ...sectionTargets].sort(compareTargets);

  const duplicates: GenerationDuplicate[] = [];
  for (const target of sectionTargets) {
    const level = target.level ?? MODULE_PREMISE_LEVEL;
    const laterLevels = (mentionedAt.get(nameKey(target.name)) ?? []).filter(
      (number) => number > level,
    );
    if (laterLevels.length > 0) {
      duplicates.push({ name: target.name, kind: target.kind, level, laterLevels });
    }
  }
  duplicates.sort(
    (left, right) => left.level - right.level || left.name.localeCompare(right.name),
  );

  const counts = new Map<number, number>();
  for (const target of targets) {
    const level = target.level ?? MODULE_PREMISE_LEVEL;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const levels = [...counts]
    .map(([number, count]) => ({ number, count }))
    .sort((left, right) => left.number - right.number);

  return { targets, premiseOnly, duplicates, levels };
}

/** What the dialog asks the module-level seam for. */
export interface GenerationSelectionInput {
  module: Module;
  artifacts: readonly AnyArtifact[];
  kinds: readonly GenerationKind[];
  levelRange: GenerationLevelRange;
}

/**
 * The generation selection's full result: the level-scoped NAMES plus the four
 * work sets the dialog dispatches, each restricted to the selected names through
 * the EXISTING verdict seams (`batchTargets`, `imageTargets`,
 * `encountersNeedingMaps`, `encountersNeedingMobPortraits`) — this seam decides
 * the SCOPE, those seams decide what is missing inside it.
 */
export interface GenerationSelection extends LevelNameSelection {
  /** Names that need an authored detail (the entity batch's own verdict). */
  detail: GenerationTarget[];
  /** Resolved entities without a cover image (the image queue's own verdict). */
  images: GenerationTarget[];
  /** Selected encounters without a battlemap. */
  maps: GenerationEncounterTarget[];
  /** Selected encounters whose roster still holds portrait work. */
  mobPortraits: GenerationEncounterTarget[];
  /**
   * THE SCOPE STATEMENT'S NUMBER: every job the selection would start —
   * details + images + maps + mob portraits. The dialog prints THIS field, so
   * what it announces and what it runs cannot drift.
   */
  totalCount: number;
}

/**
 * The module-level entry: derives the level list ONCE (the ONE derivation) and
 * returns the level-scoped targets plus the work sets.
 */
export function selectGenerationTargets(input: GenerationSelectionInput): GenerationSelection {
  const { module, kinds, levelRange } = input;
  const entityKinds = kinds.filter((kind): kind is EntityKind => kind !== GENERATION_IMAGE_KIND);
  const list = moduleLevelList(moduleDocumentFromView(module), module.entityKinds);
  const names = selectLevelNames(list, entityKinds, levelRange);

  // The module-creation pool (docs/17 row 69): the entity name space is the
  // module's own, never the Party's — the SAME pool the batch and the image
  // queue work from.
  const artifacts = moduleCreationPool(input.artifacts);
  const selected = new Map<string, GenerationTarget>();
  for (const target of names.targets) selected.set(`${target.kind}:${nameKey(target.name)}`, target);

  const detail: GenerationTarget[] = [];
  const images: GenerationTarget[] = [];
  for (const kind of entityKinds) {
    for (const name of batchTargets(module, artifacts, kind)) {
      const target = selected.get(`${kind}:${nameKey(name)}`);
      if (target !== undefined) detail.push(target);
    }
    for (const name of imageTargets(module, artifacts, kind)) {
      const target = selected.get(`${kind}:${nameKey(name)}`);
      if (target !== undefined) images.push(target);
    }
  }
  detail.sort(compareTargets);
  images.sort(compareTargets);

  // Maps and mob portraits are encounter work: a selected encounter NAME is the
  // scope, and the sweep's own detectors say whether it still needs anything.
  const encounters = new Map(
    names.targets
      .filter((target): target is GenerationTarget & { kind: 'encounter' } =>
        target.kind === 'encounter',
      )
      .map((target) => [nameKey(target.name), target]),
  );
  const withId = (
    detector: readonly { id: Id; name: string }[],
  ): GenerationEncounterTarget[] =>
    detector.flatMap((encounter) => {
      const target = encounters.get(nameKey(encounter.name));
      return target === undefined ? [] : [{ ...target, artifactId: encounter.id }];
    });

  const maps = withId(encountersNeedingMaps(module, artifacts)).sort(compareTargets);
  const mobPortraits = withId(encountersNeedingMobPortraits(module, artifacts)).sort(compareTargets);

  return {
    ...names,
    detail,
    images,
    maps,
    mobPortraits,
    totalCount: detail.length + images.length + maps.length + mobPortraits.length,
  };
}

/** The dialog's human label for a kind (the domain's own singular labels). */
export function generationKindLabel(kind: GenerationKind): string {
  return kind === GENERATION_IMAGE_KIND ? 'Images' : ARTIFACT_KIND_SINGULAR[kind];
}

/** Does this name have an authored, detailed entity of its own? (The panel's verdict.) */
export function selectedNameResolves(
  name: string,
  artifacts: readonly AnyArtifact[],
  moduleId: Id,
): AnyArtifact | undefined {
  return resolveWikiLink(name, moduleCreationPool(artifacts), { moduleId }).artifact;
}
