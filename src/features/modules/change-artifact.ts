import type { ArtifactKind, AnyArtifact, Campaign, DungeonMapPath, Id } from '@/domain';
import { ENTITY_KINDS, castCreatureWriteRefusal, isCastCreatureNpc } from '@/domain';
import { getAnyArtifact } from '@/db/artifactRepo';
import { getCampaign } from '@/db/campaignRepo';
import { getModule } from '@/db/moduleRepo';
import {
  regenerateEncounterEverything,
  repopulateEncounter,
} from '@/features/campaign/encounterRegen';
import { runEntityBatch } from '@/features/modules/entity-batch';
import type { StubKind } from '@/features/modules/persona-request';
import { claimModuleGeneration, releaseModuleGeneration } from '@/llm/canvasBusy';

/**
 * THE one way to change an artifact from an instruction (docs/17 row 101,
 * docs/18 §2) — the owner's request, verbatim: *"I suggest a centralized
 * changeArtefact function that can change any artefact based on instructions
 * and then forwards that to the specialists. I am a fan of centralized
 * functions."*
 *
 * WHY IT EXISTS, and why routing beats a chat-side writer. The canvas chat is
 * the owner's refinement engine, but it holds no per-kind knowledge: it cannot
 * know that an encounter has exactly two regeneration operations, that a
 * location is detailed by the Worldbuilder while a note is detailed by the
 * Plot Architect, or that a rulebook-cited creature row must never be authored
 * at all. A chat that wrote artifacts directly would be a SECOND writer with a
 * second provenance story (no `writerModel`, no revision source), a second
 * validation story and a second failure story — and it would drift from the
 * engines the moment a prompt or a contract moves. So the chat (a later arc)
 * asks HERE, and this module makes exactly the request the specialist already
 * understands, in the specialist's own vocabulary.
 *
 * THE ROUTE IS CHOSEN FROM THE RESOLVED ROW, never from the caller's claim: the
 * seam reads the artifact and dispatches on `artifact.kind`, so a caller cannot
 * pick an engine by lying about the kind. Per kind:
 *
 * | artifact kind                       | specialist                       | what it does                                      |
 * |-------------------------------------|----------------------------------|---------------------------------------------------|
 * | `encounter`                         | `features/campaign/encounterRegen` | the requested one of the two EXISTING operations |
 * | `npc` / `location` / `event` /      | `features/modules/entity-batch`  | re-designs the row IN PLACE through               |
 * | `faction` / `note`                  | (with `buildEntityBrief`)        | `runEngine`'s refill (identity preserved)         |
 * | `npc` carrying a `creatureRef`      | REFUSED — `isCastCreatureNpc`    | a RATIFIED boundary: nothing is written at all    |
 * | (a CAST CREATURE npc, docs/11 D4)   |                                  |                                                   |
 * | `pc`                                | UNSUPPORTED — the Party is authored | no persona produces a player character         |
 * | `plotarc`                           | UNSUPPORTED — outside the entity lane | the arc engine is not a module entity kind    |
 *
 * WHAT IS UNIFORM, because a seam that re-invents semantics is worse than none:
 *
 * - **The busy gate is the EXISTING one.** A module-owned target claims the
 *   shared canvas registry (`llm/canvasBusy.claimModuleGeneration`) for the
 *   duration and releases it in `finally`, so ONE generation per module holds
 *   across the chat, the refine lane and every change — a second claimant gets
 *   the existing loud `ModuleBusyError`, never a queue and never a silent
 *   no-op.
 * - **Failures propagate LOUDLY.** Nothing is caught here (AGENTS rules 1/2):
 *   a specialist that throws, a run that did not complete, a vanished campaign
 *   or module — all throw. The only non-throwing outcomes are the seam's OWN
 *   decisions, and those are returned as values a caller can branch on without
 *   reading a string: `refused` (a rule says no) and `unsupported` (no engine
 *   serves this kind).
 * - **Provenance and persistence are the specialist's.** The seam writes
 *   nothing itself: an encounter change lands through the same pipeline the
 *   editor's buttons drive (revisions, fill grade, advisory and all), an entity
 *   change lands through `runEngine`'s refill (which stamps `writerModel` and
 *   the `persona` revision source — docs/17 row 93).
 * - **NO VERSION/UNDO STORY IS INVENTED.** Artifact rows have none: the module
 *   DOCUMENT has durable versions (`moduleVersionRepo`), an artifact row has
 *   only its revisions (which `updateArtifact` writes before a content write)
 *   and, for encounters, the documented regeneration semantics — a regenerated
 *   artifact legitimately loses what regeneration replaces. The seam adds no
 *   undo and no partial-apply protection beyond what each specialist already
 *   gives (the prose leg still refuses a roster rewrite loud rather than
 *   half-applying it).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no chat wiring, no new chat protocol, no
 * UI, no instruction box, no read-on-request of artifact details, no second
 * prompt or brief form (`llm/additionalInstruction` is the ONE
 * `Additional instruction: …` paragraph, and an empty instruction leaves every
 * prompt byte-identical), no second busy registry, no queue, no retry, no
 * catch-and-continue, no scope change (a change never re-scopes a row), and no
 * new generation surface: the entity panel's per-kind batches stay on
 * `runEntityBatch` because they CREATE artifacts for names that have none and
 * carry no instruction — creation is not a change, and a single-artifact seam
 * would serialize a batch that runs on a bounded pool with one dock job.
 */

/** The route that ran — structured, so a caller never parses a sentence. */
export type ChangeArtifactOperation =
  | 'encounter-repopulate'
  | 'encounter-regenerate-everything'
  | 'entity-redesign';

/** The two change operations an encounter has today (docs/11, the artifact
 * editor's two buttons). There is NO default: they are genuinely different
 * (one replaces the roster and keeps the rooms, layout and map; the other
 * replaces the roster, the layout AND the map), and the destructive one must
 * never be what a caller gets by forgetting to choose. */
export type EncounterChangeOperation = 'repopulate' | 'everything';

export interface EncounterChangeOptions {
  operation: EncounterChangeOperation;
  /** The "Also redesign name and prose" checkbox (default OFF) — the
   * existing option, forwarded unchanged. */
  redesignProse?: boolean;
  /** The D18 per-run dungeon-map path for `'everything'` on a complex —
   * the existing option, forwarded unchanged (null = no override). */
  dungeonMapPath?: DungeonMapPath | null;
}

export interface ChangeArtifactRequest {
  /** The artifact to change. Callers resolve a NAME through the existing
   * resolver first — the seam never guesses which wiki-link a name meant. */
  artifactId: Id;
  /**
   * The change asked for, as free text. Empty/omitted is the honest "no
   * additional instruction": the specialist runs its existing operation and
   * every prompt stays byte-identical (that is how the artifact editor's two
   * long-standing buttons route through this seam without changing a byte of
   * what the engines send). A caller that HAS an instruction — the chat arc —
   * passes it, and it reaches the prompt in the one
   * `Additional instruction: …` form.
   */
  instruction?: string;
  /**
   * Encounter targets ONLY, and REQUIRED for them. Passing it for any other
   * kind, or omitting it for an encounter, is a programming error and throws
   * (never a silently ignored option, never a guessed operation).
   */
  encounter?: EncounterChangeOptions;
  /**
   * The caller's abort signal — OPTIONAL and ADDITIVE (docs/17 row 104): the
   * canvas chat passes its turn's own controller, so a stop that landed before
   * this change STARTED abandons it here — nothing is claimed, nothing is
   * called and nothing is written. That is the boundary this seam can honestly
   * own, and it is checked after the row and campaign reads (so a stop during
   * those is honored) and BEFORE the module slot is claimed.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: it does not cancel a generation that is
   * already running. In-flight runs are stopped by the EXISTING Stop-all path
   * (`features/progress/stop-all-generations` → `runEngine.cancelAllActive`),
   * which lands the run in the resumable `cancelled` state the engine already
   * defines — one cancel mechanism, never a second one invented at this seam
   * (a per-run signal would be exactly that).
   */
  signal?: AbortSignal;
}

export interface ChangeArtifactChanged {
  status: 'changed';
  artifactId: Id;
  kind: ArtifactKind;
  operation: ChangeArtifactOperation;
}

/** A rule says no: nothing was written, nothing was called. */
export interface ChangeArtifactRefused {
  status: 'refused';
  artifactId: Id;
  kind: ArtifactKind;
  /** The honest reason, ready to show the owner (the seam's own copy or the
   * shared creature-row refusal — never a generic sentence). */
  reason: string;
}

/** No engine serves this kind — the caller must not read this as success. */
export interface ChangeArtifactUnsupported {
  status: 'unsupported';
  artifactId: Id;
  kind: ArtifactKind;
  /** Why this kind has no engine, and where that work does happen. */
  reason: string;
}

export type ChangeArtifactResult =
  | ChangeArtifactChanged
  | ChangeArtifactRefused
  | ChangeArtifactUnsupported;

/**
 * The kinds the entity lane serves — DERIVED from `ENTITY_KINDS` (minus the
 * encounter, which has its own two operations above), never a hand-kept list
 * that could drift from the module entity vocabulary the panel, the
 * automation and the floor all read.
 */
const ENTITY_CHANGE_KINDS: readonly EntityChangeKind[] = ENTITY_KINDS.filter(
  (kind): kind is EntityChangeKind => kind !== 'encounter',
);
type EntityChangeKind = Exclude<StubKind, 'encounter'>;

/** The Party is AUTHORED, not generated (docs/17 row 69: the module-creation
 * pool excludes it, and no persona produces one) — said as the reason rather
 * than as a silent skip. */
function partyReason(artifact: AnyArtifact): string {
  return `«${artifact.name}» is a player character, and the Party is authored, not generated: no design engine produces a PC, so there is no instruction-driven change path for it. Edit it in the artifact editor's own fields — that is where a player character is written.`;
}

/** A plot arc is a real artifact kind with a real engine (the Arc Weaver), but
 * it is not part of the MODULE ENTITY lane (`ENTITY_KINDS` has no plotarc), so
 * the module-scoped entity engine cannot serve it and the seam says so instead
 * of routing it somewhere it does not belong. */
function plotArcReason(artifact: AnyArtifact): string {
  return `«${artifact.name}» is a plot arc, which is not one of the module entity kinds the entity engine serves (${ENTITY_CHANGE_KINDS.join(', ')}), so no module-scoped change engine exists for it. Run the Arc Weaver persona on it from the artifact editor's AI section, or edit it by hand.`;
}

/** No module: the entity engines ground every brief in the OWNING MODULE's
 * text, so the honest answer is a refusal naming the way out, not a
 * module-less brief that would invent a stranger (the class of bug the refill
 * guard already closes). */
function noModuleReason(artifact: AnyArtifact): string {
  return `«${artifact.name}» belongs to no module, and the entity engines ground every brief in the owning module's text — there is nothing for a change to be grounded in. Move it into a module (adopt it into the campaign, then into the module whose text names it) or generate the module's own entity, and change that row.`;
}

/** Where a change goes: the route, or one of the seam's two non-changing
 * answers. */
type ChangeRoute =
  | { route: 'encounter'; options: EncounterChangeOptions }
  | { route: 'entity'; kind: StubKind; moduleId: Id }
  | ChangeArtifactRefused
  | ChangeArtifactUnsupported;

/**
 * The WHOLE policy in one PURE function: the route for this artifact, or the
 * honest reason it cannot be changed. Nothing is claimed, called or written
 * before this returns, so a refusal costs nothing and can never half-happen.
 *
 * The kind-specific option mismatch throws: passing encounter options for an
 * npc (or none for an encounter) is a programming error, and a program error
 * is not a user-facing refusal.
 */
function resolveChangeRoute(artifact: AnyArtifact, request: ChangeArtifactRequest): ChangeRoute {
  // RATIFIED BOUNDARY (owner decision, docs/17 row 101, re-based on the
  // cast seam by the core-mob arc): a CAST CREATURE npc is this module's own
  // row for a LIBRARY creature, and its name IS the citation — an instruction
  // that renamed or rewrote it would stop every encounter and battle citing
  // that creature from finding it. This is a deliberate exception to "change
  // any artifact", not debt and not a TODO: the refusal names the reason and
  // the remedy, writes nothing at all, and can never be reported as success.
  // `isCastCreatureNpc` is the ONLY classification of such a row (never a
  // second reading of `creatureRef` at a call site).
  if (isCastCreatureNpc(artifact)) {
    return {
      status: 'refused',
      artifactId: artifact.id,
      kind: artifact.kind,
      reason: castCreatureWriteRefusal(artifact.name, artifact.name),
    };
  }
  if (artifact.kind === 'pc') {
    return {
      status: 'unsupported',
      artifactId: artifact.id,
      kind: artifact.kind,
      reason: partyReason(artifact),
    };
  }
  if (artifact.kind === 'plotarc') {
    return {
      status: 'unsupported',
      artifactId: artifact.id,
      kind: artifact.kind,
      reason: plotArcReason(artifact),
    };
  }
  if (artifact.kind === 'encounter') {
    if (request.encounter === undefined) {
      throw new Error(
        `An encounter change must name its operation: "repopulate" (a new roster for every room; rooms, layout and map kept) or "everything" (a new roster, layout and map). There is no default — the second replaces the map.`,
      );
    }
    return { route: 'encounter', options: request.encounter };
  }
  if (request.encounter !== undefined) {
    throw new Error(
      `Encounter change options were passed for «${artifact.name}», which is a ${artifact.kind} — the two encounter operations apply to encounters only.`,
    );
  }
  if (artifact.moduleId === null) {
    return {
      status: 'refused',
      artifactId: artifact.id,
      kind: artifact.kind,
      reason: noModuleReason(artifact),
    };
  }
  return { route: 'entity', kind: artifact.kind, moduleId: artifact.moduleId };
}

/** The campaign a change runs in, resolved FROM the row — never from the
 * caller, so a change can only ever happen in the context the artifact
 * actually belongs to. */
async function campaignForChange(artifact: AnyArtifact): Promise<Campaign> {
  if (artifact.campaignId === null) {
    throw new Error(
      `«${artifact.name}» is library-scoped (it belongs to no campaign), so there is no campaign context for a change to run in. Adopt it into a campaign first.`,
    );
  }
  const campaign = await getCampaign(artifact.campaignId);
  if (campaign === undefined) {
    throw new Error(`The campaign for «${artifact.name}» no longer exists`);
  }
  return campaign;
}

/** The encounter lane: the requested EXISTING operation, with the caller's
 * options and instruction forwarded unchanged (an empty instruction leaves the
 * briefs byte-identical — see `encounterRegen.legBrief`). */
async function changeEncounterArtifact(
  artifact: AnyArtifact,
  requested: EncounterChangeOptions,
  instruction: string,
): Promise<ChangeArtifactResult> {
  const options = {
    redesignProse: requested.redesignProse ?? false,
    ...(requested.dungeonMapPath === undefined
      ? {}
      : { dungeonMapPath: requested.dungeonMapPath }),
    ...(instruction === '' ? {} : { instruction }),
  };
  if (requested.operation === 'repopulate') {
    await repopulateEncounter(artifact.id, options);
    return {
      status: 'changed',
      artifactId: artifact.id,
      kind: artifact.kind,
      operation: 'encounter-repopulate',
    };
  }
  await regenerateEncounterEverything(artifact.id, options);
  return {
    status: 'changed',
    artifactId: artifact.id,
    kind: artifact.kind,
    operation: 'encounter-regenerate-everything',
  };
}

/** The entity lane: ONE target aimed at the row that already exists, so the
 * run fills it IN PLACE (identity, links and images preserved, provenance
 * recorded) instead of creating a second artifact of the same name. The module
 * was resolved FROM that row, so the brief is grounded in the module this
 * artifact belongs to. */
async function changeEntityArtifact(
  artifact: AnyArtifact,
  campaign: Campaign,
  kind: StubKind,
  moduleId: Id,
  instruction: string,
): Promise<ChangeArtifactResult> {
  const module = await getModule(moduleId);
  if (module === undefined) {
    throw new Error(`The module that owns «${artifact.name}» no longer exists`);
  }
  const result = await runEntityBatch({
    module,
    campaign,
    kind,
    targets: [{ name: artifact.name, artifactId: artifact.id }],
    ...(instruction === '' ? {} : { instruction }),
  });
  const produced = result.produced[0];
  if (produced === undefined) {
    // The specialist's own per-entity reason (the run's errorMessage, the
    // contract failure, the refused destination) — thrown, never returned as a
    // quiet status a caller could ignore.
    const reason = result.failed[0]?.message ?? 'the run produced no artifact';
    throw new Error(`The change to «${artifact.name}» did not complete: ${reason}`);
  }
  return {
    status: 'changed',
    artifactId: produced.artifactId,
    kind: artifact.kind,
    operation: 'entity-redesign',
  };
}

/**
 * Changes ONE artifact from an instruction, through the specialist for its
 * kind. The full contract is the module header above; the short version is
 * that the row decides the route, the instruction only ever ADDS a prompt
 * paragraph, refusals come back as values, failures throw, and the module's
 * generation slot is held for the duration through the existing busy gate.
 */
export async function changeArtifact(
  request: ChangeArtifactRequest,
): Promise<ChangeArtifactResult> {
  // ONE normalization point, at the boundary (mirrors `moduleGen`'s
  // `options.extraInstruction.trim()`): everything downstream sees the exact
  // bytes that reach the prompt.
  const instruction = (request.instruction ?? '').trim();
  const artifact = await getAnyArtifact(request.artifactId);
  if (artifact === undefined) {
    throw new Error(`The artifact to change (${request.artifactId}) no longer exists`);
  }
  // The route (and every refusal) is decided BEFORE anything is claimed, read
  // from or called, so a declined change costs nothing at all.
  const resolved = resolveChangeRoute(artifact, request);
  if ('status' in resolved) return resolved;
  const campaign = await campaignForChange(artifact);
  // The abort boundary (docs/17 row 104): a stop that landed while the row and
  // campaign were read abandons the change HERE — before the slot is claimed
  // and before any specialist runs, so a stopped change can never start work.
  if (request.signal?.aborted === true) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // The module slot: claimed for the whole change and released in `finally` —
  // the EXISTING one-generation-per-module gate (the chat and the refine lane
  // hold the same slot), so a second claimant throws `ModuleBusyError` loudly
  // instead of two generations racing on one module. A campaign-level artifact
  // holds no module slot (there is nothing to serialize with).
  const moduleId = resolved.route === 'entity' ? resolved.moduleId : artifact.moduleId;
  if (moduleId !== null) claimModuleGeneration(moduleId);
  try {
    return resolved.route === 'entity'
      ? await changeEntityArtifact(artifact, campaign, resolved.kind, resolved.moduleId, instruction)
      : await changeEncounterArtifact(artifact, resolved.options, instruction);
  } finally {
    if (moduleId !== null) releaseModuleGeneration(moduleId);
  }
}
