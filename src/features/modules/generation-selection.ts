import type { AnyArtifact, EntityKind, Id, Module } from '@/domain';
import {
  ARTIFACT_KIND_SINGULAR,
  castCreatureWritePermitted,
  comparableName,
  ENTITY_KINDS,
  bestiarySlotForEntity,
  entityLevelHintFor,
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

/**
 * The generation dialog's kinds: the six entity kinds. Images are PER KIND
 * (docs/17 row 397): `imageKinds` names which of the selected kinds also get an
 * image. Every entity kind is an artifact with a cover-image path
 * (`imageTargets` answers for all six), so every kind offers the toggle.
 */
export type GenerationKind = EntityKind;

/** The dialog's selectable kinds in the domain's own order. */
export const GENERATION_KINDS: readonly GenerationKind[] = ENTITY_KINDS;

/**
 * The explicit encounter extras a run was asked for — OFF unless the dialog's
 * checkboxes say so. Declared HERE, beside the selection, rather than in the
 * dispatcher: `totalCount` is the run's PLAN, and a plan that ignored the
 * ticked extras would announce a battlemap for an existing encounter the run
 * never starts (and, with the pending projection below, the same for created
 * ones).
 */
export interface GenerationEncounterExtras {
  battlemaps: boolean;
  mobPortraits: boolean;
}

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
  /** Selected kinds that ALSO get an image (a kind not in `kinds` has no names to illustrate). */
  imageKinds: readonly EntityKind[];
  levelRange: GenerationLevelRange;
  /** The encounter extras the run was asked for (see `GenerationEncounterExtras`). */
  encounterExtras: GenerationEncounterExtras;
  /**
   * THE OVERWRITE CHECKBOX (docs/17 row 422) — the owner's model-evaluation
   * control: *"when checked, all selected details that were already there get
   * removed and generated freshly"*. On, the selection ALSO covers the selected
   * names whose detail / cover / battlemap / mob portraits already exist, and
   * reports them in `overwrites` so the dialog can say exactly what will be
   * replaced. Absent or false is the additive run, and every field this seam
   * returned before is byte-identical (`overwrites` is then all empty).
   */
  overwrite?: boolean;
}

/** An existing artifact the overwrite run regenerates, and the row it is. */
export interface GenerationOverwriteTarget extends GenerationTarget {
  artifactId: Id;
}

/** A selected, already-detailed name the overwrite deliberately leaves alone. */
export interface GenerationOverwriteKept {
  name: string;
  kind: EntityKind;
  /** Why, ready to print (the dialog's confirmation names it). */
  reason: string;
}

/**
 * What an overwrite run REPLACES (docs/17 row 422), per kind of work. Every
 * list is existing work the additive sets exclude, so no job is counted twice.
 *
 * - `details`: this module's own detailed rows, regenerated IN PLACE (same id,
 *   fresh text, the previous text kept as a revision — owner decision 1).
 * - `images`: rows of a ticked image kind that carry a COVER; the fresh image
 *   becomes the cover and the old one is removed once it has landed (owner
 *   decision 2).
 * - `maps`: this module's encounters that already carry a battlemap (only when
 *   Battlemaps is ticked); the redraw replaces the map in one transaction.
 * - `mobPortraits`: this module's encounters with a roster (only when Mob
 *   portraits is ticked); every creature portrait is regenerated, existing ones
 *   replaced delete-after-replace and missing ones filled.
 * - `kept`: detailed names the overwrite does NOT regenerate, with the reason —
 *   never a silent skip.
 */
export interface GenerationOverwrites {
  details: GenerationOverwriteTarget[];
  images: GenerationOverwriteTarget[];
  maps: GenerationEncounterTarget[];
  mobPortraits: GenerationEncounterTarget[];
  kept: GenerationOverwriteKept[];
}

/** The number of overwrite jobs — the dialog's "is anything replaced?". */
export function overwriteJobCount(overwrites: GenerationOverwrites): number {
  return (
    overwrites.details.length +
    overwrites.images.length +
    overwrites.maps.length +
    overwrites.mobPortraits.length
  );
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
  /**
   * Selected NPCs/encounters with NO stated level (docs/17 row 401). They are
   * NOT in `detail`: a level is stated by the chat and never invented here, so
   * generating them is held back and the dialog lists them as 'needs a level'.
   */
  needsLevel: GenerationTarget[];
  /** Resolved entities without a cover image (the image queue's own verdict). */
  images: GenerationTarget[];
  /**
   * THE PENDING HALF OF `images` (docs/17 row 406): selected names of a ticked
   * image kind that have NO artifact yet, so THIS run's detail pass will create
   * them and they then need a cover. Counted in `totalCount` (the dialog
   * announces the work the run will start) but never enqueued FROM HERE — the
   * dispatcher re-reads the pool after the pass and enqueues only what EXISTS,
   * so a name whose detail FAILED is reported by the batch and never
   * re-reported by the image queue's loud missing-artifact failure.
   */
  pendingImages: GenerationTarget[];
  /** Selected encounters without a battlemap. */
  maps: GenerationEncounterTarget[];
  /** Selected encounters whose roster still holds portrait work. */
  mobPortraits: GenerationEncounterTarget[];
  /**
   * Selected encounters this run will CREATE (no artifact yet). Each one needs
   * a battlemap once it exists, and its portrait work is decided by the roster
   * the pass writes — so this list is the plan's pending encounter work for
   * BOTH extras, counted once per ticked extra. Like `pendingImages`, it is
   * never enqueued from the plan: the dispatcher re-reads after the pass.
   */
  pendingEncounters: GenerationTarget[];
  /** What an overwrite run replaces (all empty unless `overwrite` is on). */
  overwrites: GenerationOverwrites;
  /**
   * THE SCOPE STATEMENT'S NUMBER: every job the selection would start —
   * details + the images (existing + pending) + the ticked encounters' maps and
   * mob portraits (existing + pending) + every overwrite job. The dialog prints
   * THIS field, so what it announces and what it runs cannot drift; an extra
   * the dialog did not tick contributes nothing.
   */
  totalCount: number;
}

/**
 * The module-level entry: derives the level list ONCE (the ONE derivation) and
 * returns the level-scoped targets plus the work sets.
 */
export function selectGenerationTargets(input: GenerationSelectionInput): GenerationSelection {
  const { module, kinds, levelRange } = input;
  const entityKinds = kinds;
  const list = moduleLevelList(moduleDocumentFromView(module), module.entityKinds);
  const names = selectLevelNames(list, entityKinds, levelRange);

  // The module-creation pool (docs/17 row 69): the entity name space is the
  // module's own, never the Party's — the SAME pool the batch and the image
  // queue work from.
  const artifacts = moduleCreationPool(input.artifacts);
  const selected = new Map<string, GenerationTarget>();
  for (const target of names.targets) selected.set(`${target.kind}:${nameKey(target.name)}`, target);

  const detail: GenerationTarget[] = [];
  for (const kind of entityKinds) {
    for (const name of batchTargets(module, artifacts, kind)) {
      const target = selected.get(`${kind}:${nameKey(name)}`);
      if (target !== undefined) detail.push(target);
    }
  }
  detail.sort(compareTargets);
  // STRICT LEVELS (docs/17 row 401): an NPC or encounter whose record states no
  // level is held out of the detail work and named, never generated with a guess.
  const levelless = (target: GenerationTarget): boolean =>
    (target.kind === 'npc' || target.kind === 'encounter') &&
    entityLevelHintFor(module.entityKinds, target.name) === null &&
    // A CAST npc takes its stats from a library creature, not from a level.
    bestiarySlotForEntity(module.entityKinds, target.name) === null;
  const needsLevel = detail.filter(levelless);
  const detailReady = detail.filter((target) => !levelless(target));

  const images: GenerationTarget[] = [];
  for (const kind of entityKinds) {
    if (!input.imageKinds.includes(kind)) continue;
    for (const name of imageTargets(module, artifacts, kind)) {
      const target = selected.get(`${kind}:${nameKey(name)}`);
      if (target !== undefined) images.push(target);
    }
  }
  images.sort(compareTargets);

  // THE PENDING HALF (docs/17 row 406): the detail pass runs BEFORE the
  // image/map/portrait steps, so a name this run will CREATE becomes work for
  // those steps even though nothing resolves yet. Without this the announced
  // count on a first run said "0 images" while the run would (from row 406 on)
  // queue one per created entity — the owner-visible lie this fixes.
  //
  // The exclusion is what keeps the plan exactly the run's set with no double
  // count: a detail target whose name ALREADY resolves is counted in the
  // existing-work list above (the run's post-pass re-read resolves the same
  // name once, whether the batch created a fresh row or updated one).
  const imageKeys = new Set(images.map((target) => `${target.kind}:${nameKey(target.name)}`));
  const pendingImages = detailReady
    .filter(
      (target) =>
        input.imageKinds.includes(target.kind) &&
        !imageKeys.has(`${target.kind}:${nameKey(target.name)}`),
    )
    .sort(compareTargets);

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
  const fillPortraits = withId(encountersNeedingMobPortraits(module, artifacts)).sort(compareTargets);

  const overwrite =
    input.overwrite === true
      ? selectOverwrites({ input, artifacts, selectedTargets: names.targets, levelless, maps, withId })
      : { overwrites: EMPTY_OVERWRITES, needsLevel: [] };
  const { overwrites } = overwrite;
  // An encounter whose portraits the overwrite regenerates (both lanes, missing
  // ones filled too) is not ALSO a fill job: one encounter, one portrait job.
  const regenPortraitIds = new Set(overwrites.mobPortraits.map((target) => target.artifactId));
  const mobPortraits = fillPortraits.filter((target) => !regenPortraitIds.has(target.artifactId));

  // A detail encounter with no artifact yet (one the run will create). Its
  // battlemap is certain once the row exists; its portrait work is decided by
  // the roster the pass writes, so the plan counts the encounter once. Excluded
  // when it is already counted in `maps`/`mobPortraits` above.
  const encounterKeys = new Set(
    [...maps, ...mobPortraits].map((target) => nameKey(target.name)),
  );
  const pendingEncounters = detailReady
    .filter((target) => target.kind === 'encounter' && !encounterKeys.has(nameKey(target.name)))
    .sort(compareTargets);

  const extras = input.encounterExtras;
  const totalCount =
    detailReady.length +
    images.length +
    pendingImages.length +
    (extras.battlemaps ? maps.length + pendingEncounters.length : 0) +
    (extras.mobPortraits ? mobPortraits.length + pendingEncounters.length : 0) +
    overwriteJobCount(overwrites);

  return {
    ...names,
    detail: detailReady,
    // With overwrite off this is exactly the additive list (nothing appended).
    needsLevel:
      overwrite.needsLevel.length === 0
        ? needsLevel
        : [...needsLevel, ...overwrite.needsLevel].sort(compareTargets),
    images,
    pendingImages,
    maps,
    mobPortraits,
    pendingEncounters,
    overwrites,
    totalCount,
  };
}

const EMPTY_OVERWRITES: GenerationOverwrites = {
  details: [],
  images: [],
  maps: [],
  mobPortraits: [],
  kept: [],
};

/**
 * The selected names of `kinds` that EXIST, resolved to their rows: the exact
 * complement of a missing-work detector (`batchTargets` for details,
 * `imageTargets` for images), so "exists" and "missing" can never disagree.
 */
function existingOf(
  input: GenerationSelectionInput,
  artifacts: readonly AnyArtifact[],
  selectedTargets: readonly GenerationTarget[],
  kinds: readonly EntityKind[],
  missingOf: (module: Module, artifacts: readonly AnyArtifact[], kind: EntityKind) => string[],
): { target: GenerationTarget; artifact: AnyArtifact }[] {
  const { module } = input;
  const existing: { target: GenerationTarget; artifact: AnyArtifact }[] = [];
  for (const kind of kinds) {
    const missing = new Set(missingOf(module, artifacts, kind).map(nameKey));
    for (const target of selectedTargets) {
      if (target.kind !== kind || missing.has(nameKey(target.name))) continue;
      const artifact = resolveWikiLink(target.name, artifacts, { moduleId: module.id }).artifact;
      if (artifact !== undefined) existing.push({ target, artifact });
    }
  }
  return existing;
}

/**
 * The overwrite half of the selection (docs/17 row 422): what already exists
 * inside the selected scope. Returns the overwrite sets plus the detailed
 * NPCs/encounters held back for a missing level (they join `needsLevel`).
 */
function selectOverwrites(options: {
  input: GenerationSelectionInput;
  artifacts: readonly AnyArtifact[];
  selectedTargets: readonly GenerationTarget[];
  levelless: (target: GenerationTarget) => boolean;
  maps: readonly GenerationEncounterTarget[];
  withId: (detector: readonly { id: Id; name: string }[]) => GenerationEncounterTarget[];
}): { overwrites: GenerationOverwrites; needsLevel: GenerationTarget[] } {
  const { input, artifacts, selectedTargets, levelless } = options;
  const { module } = input;

  const details: GenerationOverwriteTarget[] = [];
  const kept: GenerationOverwriteKept[] = [];
  const needsLevel: GenerationTarget[] = [];
  for (const { target, artifact } of existingOf(input, artifacts, selectedTargets, input.kinds, batchTargets)) {
    // STRICT LEVELS (docs/17 row 401) hold for a regeneration exactly as for a
    // creation: a level is stated, never guessed.
    if (levelless(target)) {
      needsLevel.push(target);
      continue;
    }
    if (artifact.moduleId !== module.id) {
      // The in-place refill grounds its brief in the module that OWNS the row;
      // a row this module only links to is changed where it lives.
      kept.push({
        name: target.name,
        kind: target.kind,
        reason: 'not this module’s own entity — change it where it lives',
      });
      continue;
    }
    // THE ONE cast rule (docs/17 row 284): with no instruction, a cast library
    // creature's row is never rewritten (the batch would refuse it after the run).
    if (!castCreatureWritePermitted(artifact, undefined)) {
      kept.push({
        name: target.name,
        kind: target.kind,
        reason: 'a cast library creature — its name and stats are the library’s',
      });
      continue;
    }
    details.push({ ...target, artifactId: artifact.id });
  }
  details.sort(compareTargets);

  const imageKinds = input.kinds.filter((kind) => input.imageKinds.includes(kind));
  const images: GenerationOverwriteTarget[] = existingOf(
    input,
    artifacts,
    selectedTargets,
    imageKinds,
    imageTargets,
  )
    // What an image overwrite replaces is the COVER: a gallery-only row (an
    // encounter whose one image is its battlemap) has no cover to replace.
    .filter(({ artifact }) => artifact.coverImageId !== null)
    .map(({ target, artifact }) => ({ ...target, artifactId: artifact.id }))
    .sort(compareTargets);

  const ownEncounters = artifacts.filter(
    (artifact): artifact is AnyArtifact & { kind: 'encounter' } =>
      artifact.kind === 'encounter' && artifact.moduleId === module.id,
  );
  const needMap = new Set(options.maps.map((target) => target.artifactId));
  const maps = input.encounterExtras.battlemaps
    ? options
        .withId(ownEncounters)
        .filter((target) => !needMap.has(target.artifactId))
        .sort(compareTargets)
    : [];
  const mobPortraits = input.encounterExtras.mobPortraits
    ? options
        .withId(ownEncounters.filter((encounter) => encounter.data.monsters.length > 0))
        .sort(compareTargets)
    : [];

  return { overwrites: { details, images, maps, mobPortraits, kept }, needsLevel };
}

/** The dialog's human label for a kind (the domain's own singular labels). */
export function generationKindLabel(kind: GenerationKind): string {
  return ARTIFACT_KIND_SINGULAR[kind];
}

/** Does this name have an authored, detailed entity of its own? (The panel's verdict.) */
export function selectedNameResolves(
  name: string,
  artifacts: readonly AnyArtifact[],
  moduleId: Id,
): AnyArtifact | undefined {
  return resolveWikiLink(name, moduleCreationPool(artifacts), { moduleId }).artifact;
}
