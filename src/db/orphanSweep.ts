import type { AnyArtifact, Battle, EncounterArtifact, Id, Module } from '@/domain';
import { battleSchema, ENTITY_KINDS, moduleSchema } from '@/domain';
import { buildWikiGraph, type WikiGraphNode } from '@/domain/wikiGraph';
import { resolveWikiLink } from '@/lib/wikilinks';

import { db } from '@/db/db';
import {
  deleteArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  listArtifactsByModule,
  listGlobalArtifacts,
} from '@/db/artifactRepo';
import { getModule, listModulesByCampaign } from '@/db/moduleRepo';
import { NotFoundError } from '@/lib/errors';

/**
 * Orphan sweep (08-MODULE-DESIGNER §M4-C "Orphaned entities", 14 cross-link):
 * the GUARDED delete surface for module-owned unmentioned entities. This
 * module OWNS the orphan definition — `entity-orphans.ts` (features, read
 * time) consumes `ORPHAN_KINDS`/`orphanCandidatesOf` AND
 * `evaluateOrphanGuards` from here (features → db, never the reverse) and
 * mirrors the panel-side module-scope tag: the read-time deriver and the
 * transaction deleter decide "deletable" with ONE predicate (docs/18 §2.2).
 *
 * DEFINITION (owner-ratified): an orphan is a module-owned artifact
 * (`moduleId === module.id`, kind ∈ `ORPHAN_KINDS`) with ZERO resolving
 * wiki-link mentions. Two scopes:
 * - the MODULE-scope tag — zero resolving mentions in THIS module's prose
 *   (premise + parts), the entity panel's "Orphaned (unmentioned)" group;
 * - the CAMPAIGN-WIDE gate — zero mentions across ALL campaign modules'
 *   prose, derived via UNCAPPED `buildWikiGraph` exactly like
 *   link-health-report: a row another module's prose mentions is KEPT.
 * Mentions are wiki-link TOKENS resolved the way the reader resolves them
 * (exact name then aliases, case-insensitive, module-tier precedence) —
 * never `countOccurrences` substrings.
 *
 * EXCLUSIONS: promoted rows (`moduleId: null`), pc rows and global library
 * rows are never candidates; ambiguity-shadowed candidates (their name
 * matches several artifacts — only the reader's winner gets the node) are
 * excluded from the offered set; a directly-attempted one is refused loud
 * with "same-named entity exists — resolve the duplicate first". `plotarc`
 * is orphanable on purpose (owner-ratified): module-owned produced content
 * surfaces as orphanable even though the panel never lists it elsewhere.
 *
 * SWEEP semantics (recount doctrine, deleteModule's standard): ONE `rw`
 * transaction (array form) re-lists the module row, the owned rows, the
 * campaign's modules/artifacts and every guard carrier INSIDE the tx, and
 * re-derives orphans + guards from those fresh rows — the panel's count
 * never decides what goes. Per-artifact outcomes ride the failed[]
 * convention: `deleted` N + `kept` M with reasons, rendered as ONE loud
 * toast by the caller — never silent. HARD GUARDS per artifact (ONE
 * evaluation, `evaluateOrphanGuards` below — the same function the panel's
 * read-time derivation calls with the subset its props can see, so the offer
 * and the deleter can never drift; docs/17 row 92):
 * - campaign-wide mentions (also covers a mention in the module's own
 *   prose — the campaign graph contains it; the reason names the site);
 * - ambiguity shadow (belt for a race between render and confirm);
 * - battle board `tokens[].artifactId` + `seedFighters[].id` on ANY
 *   campaign battle;
 * - encounter roster `npc-ref source.artifactId` on any SURVIVING encounter
 *   (a `rulebook` entry cites the read-only library, so it names no owned row).
 * The deliverable-outline carrier family is GONE with the deliverables concept
 * (docs/17 row 108): there is no outline left to cite a row.
 * Unlike deleteModule's scan, SAME-module encounters/battles count: the
 * module SURVIVES this sweep, so `modulesReferencingOwnedArtifacts`' cascade
 * exclusion does not apply.
 *
 * Decision 5 of 14-BACKLINKS-ORPHANS is untouched: `deleteArtifact`'s
 * semantics are frozen; this sweep is a NEW surface that CALLS
 * `deleteArtifact` per artifact (nested — its tables are a subset of the
 * sweep scope), so links scrub and image refcounts prune exactly as
 * everywhere else.
 */

/**
 * The artifact kinds the orphan derivation + sweep may tag/delete:
 * every module entity kind PLUS `plotarc` (owner-ratified) — never `pc`.
 */
export const ORPHAN_KINDS = [...ENTITY_KINDS, 'plotarc'] as const;

export type OrphanKind = (typeof ORPHAN_KINDS)[number];

/** True when the artifact kind is an orphanable kind (kinds only — scope is the caller's check). */
export function isOrphanKind(kind: AnyArtifact['kind']): boolean {
  return (ORPHAN_KINDS as readonly AnyArtifact['kind'][]).includes(kind);
}

/**
 * The orphan candidates of one module: module-owned rows of an orphanable
 * kind. Pure over the given rows — the sweep re-lists them inside its
 * transaction, the panel derives from its props.
 */
export function orphanCandidatesOf(
  moduleId: Id,
  artifacts: readonly AnyArtifact[],
): AnyArtifact[] {
  return artifacts.filter(
    (artifact) => artifact.moduleId === moduleId && isOrphanKind(artifact.kind),
  );
}

/** One kept orphan of a sweep: who, and the guard that refused it. */
export interface OrphanSweepKept {
  id: Id;
  name: string;
  reason: string;
}

/** Per-artifact outcomes of a sweep (the failed[] convention's shape). */
export interface OrphanSweepOutcome {
  deleted: { id: Id; name: string }[];
  kept: OrphanSweepKept[];
}

export interface OrphanSweepOptions {
  /**
   * Restrict the sweep to ONE artifact (the panel row's trash). The row is
   * re-checked against the full guard set; a refusal comes back as `kept`
   * with the reason instead of a delete.
   */
  onlyId?: Id | undefined;
}

/** The reason an ambiguity-shadowed candidate is refused (verbatim, 08 §M4-C). */
export const AMBIGUITY_KEEP_REASON = 'same-named entity exists — resolve the duplicate first';

/** 'premise' / 'part-<planIndex>' → the reader's label (Premise / Part N, 1-based). */
function whereLabel(where: string): string {
  if (where === 'premise') return 'premise';
  const partIndex = Number(where.slice('part-'.length));
  return Number.isNaN(partIndex) ? where : `part ${String(partIndex + 1)}`;
}

/** The loud mention reason: names the site(s) that resolved to the row. */
function mentionReason(node: WikiGraphNode, modulesById: Map<Id, Module>): string {
  const sites = node.mentionsByDocument.map((mention) => {
    const title = modulesById.get(mention.moduleId)?.title ?? mention.moduleId;
    return `"${title}" ${whereLabel(mention.where)} ×${String(mention.count)}`;
  });
  const shown = sites.slice(0, 2).join(', ');
  const more = sites.length > 2 ? ` (+${String(sites.length - 2)} more)` : '';
  return `mentioned in campaign prose — ${shown}${more}`;
}

function battleReason(battle: Battle, modulesById: Map<Id, Module>, what: string): string {
  const title = modulesById.get(battle.moduleId)?.title ?? battle.moduleId;
  return `${what} on the battle of "${title}"`;
}

/**
 * Everything the orphan guards read. The sweep assembles the FULL bundle from
 * rows re-listed inside its transaction (recount); the panel passes the subset
 * its EXISTING props can see (`panelOrphanGuardInput` in
 * features/modules/entity-orphans.ts — no live query, no added props,
 * 08 §M4-C binding). ONE evaluation, two surfaces: a read-time copy of these
 * guards is what made the panel offer rows the deleter always refuses
 * (docs/17 row 92).
 */
export interface OrphanGuardInput {
  /** The module whose orphans are being decided. */
  module: Module;
  /** The modules whose prose counts as a mention (guard 1, campaign-wide). */
  campaignModules: readonly Module[];
  /** The reader's resolution pool: campaign rows + globals. */
  pool: readonly AnyArtifact[];
  /** Parsed battles of the campaign (portrait tokens + frozen seed fighters). */
  battles: readonly Battle[];
}

/** Which guard refused a candidate — the discriminator the panel reads. */
export type OrphanGuardKind =
  | 'campaign-mention'
  | 'ambiguity'
  | 'battle-token'
  | 'seed-fighter'
  | 'encounter-roster';

/** One refusal: the guard and the LOUD reason text both surfaces show verbatim. */
export interface OrphanGuardRefusal {
  guard: OrphanGuardKind;
  reason: string;
}

/** One candidate's verdict: `refusal: null` = every guard passed, it is deletable. */
export interface OrphanGuardVerdict {
  artifact: AnyArtifact;
  refusal: OrphanGuardRefusal | null;
}

/** The evaluation of one candidate set: verdicts + the sets the report filter reads. */
export interface OrphanGuardEvaluation {
  /** Per-candidate verdicts, in the candidates' own order. */
  verdicts: OrphanGuardVerdict[];
  /** The module-scope tag: candidate ids THIS module's prose resolves. */
  moduleMentionedIds: ReadonlySet<Id>;
  /** The ambiguity shadow: candidate ids a same-named entity wins the node for. */
  shadowedIds: ReadonlySet<Id>;
}

/**
 * THE orphan guard evaluation — the one way to decide whether a candidate is
 * deletable. Pure: every input is a value the caller already holds.
 *
 * Guard order is load-bearing (it decides WHICH reason a doubly-guarded row
 * reports) and must never be reordered: (1) campaign-wide mentions — the
 * campaign graph CONTAINS this module's prose, so it covers both scopes;
 * (2) the ambiguity shadow; (3) a portrait token on any campaign battle
 * board; (4) a frozen seed-fighter row on any campaign battle; (5) an
 * encounter roster citation
 * (`npc-ref` `artifactId`) — applied to the SURVIVING encounters only, because
 * an encounter this evaluation finds deletable takes its citations with it.
 */
export function evaluateOrphanGuards(
  candidates: readonly AnyArtifact[],
  input: OrphanGuardInput,
): OrphanGuardEvaluation {
  const { module, campaignModules, pool, battles } = input;
  const modulesById = new Map<Id, Module>(campaignModules.map((row) => [row.id, row]));

  // Campaign-wide resolving mentions (uncapped — the link-health-report
  // pattern): a row with a node anywhere is mentioned and stays.
  const campaignGraph = buildWikiGraph(campaignModules, pool, {
    cap: Number.POSITIVE_INFINITY,
  });
  const mentionedNodes = new Map<Id, WikiGraphNode>();
  for (const node of campaignGraph.nodes) {
    if (node.artifact !== undefined) mentionedNodes.set(node.artifact.id, node);
  }
  // The module-scope tag (the panel's predicate): zero resolving mentions in
  // THIS module's prose.
  const moduleGraph = buildWikiGraph([module], pool, { cap: Number.POSITIVE_INFINITY });
  const moduleMentionedIds = new Set<Id>(
    moduleGraph.nodes.filter((node) => node.artifact !== undefined).map((node) => node.key),
  );
  // Encounters (roster guard): every encounter of the pool — a module-owned
  // one being cited does not exempt it, `deleteModule`'s cascade exclusion
  // does not apply here (the module SURVIVES this sweep).
  const encounters = pool.filter(
    (artifact): artifact is EncounterArtifact => artifact.kind === 'encounter',
  );

  const verdicts: OrphanGuardVerdict[] = [];
  const shadowedIds = new Set<Id>();

  for (const candidate of candidates) {
    // Guard 1 — campaign-wide mentions (covers the module's own prose).
    const mentionNode = mentionedNodes.get(candidate.id);
    if (mentionNode !== undefined) {
      verdicts.push({
        artifact: candidate,
        refusal: {
          guard: 'campaign-mention',
          reason: mentionReason(mentionNode, modulesById),
        },
      });
      continue;
    }
    // Guard 2 — ambiguity shadow (belt for the render→confirm window).
    const resolution = resolveWikiLink(candidate.name, pool, { moduleId: module.id });
    if (
      resolution.status === 'ambiguous' ||
      (resolution.artifact !== undefined && resolution.artifact.id !== candidate.id)
    ) {
      shadowedIds.add(candidate.id);
      verdicts.push({
        artifact: candidate,
        refusal: { guard: 'ambiguity', reason: AMBIGUITY_KEEP_REASON },
      });
      continue;
    }
    // Guard 3 — a portrait token on any campaign battle board.
    const tokenBattle = battles.find((battle) =>
      battle.board.tokens.some((token) => token.artifactId === candidate.id),
    );
    if (tokenBattle !== undefined) {
      verdicts.push({
        artifact: candidate,
        refusal: {
          guard: 'battle-token',
          reason: battleReason(tokenBattle, modulesById, 'a portrait token'),
        },
      });
      continue;
    }
    // Guard 4 — a frozen seed-fighter row on any campaign battle.
    const seedBattle = battles.find((battle) =>
      battle.seedFighters.some((fighter) => fighter.id === candidate.id),
    );
    if (seedBattle !== undefined) {
      verdicts.push({
        artifact: candidate,
        refusal: {
          guard: 'seed-fighter',
          reason: battleReason(seedBattle, modulesById, 'a frozen seed fighter'),
        },
      });
      continue;
    }
    // Every structural guard passed; the roster pass below decides guard 5.
    verdicts.push({ artifact: candidate, refusal: null });
  }

  // Guard 5 — encounter rosters, applied to the SURVIVING encounters: an
  // encounter this evaluation finds deletable takes its citations with it.
  // Encounters outside the candidate set survive by construction (they are
  // mentioned or shadowed, never deletable).
  const survivorsPassedStructural = new Set<Id>(
    verdicts.filter((verdict) => verdict.refusal === null).map((verdict) => verdict.artifact.id),
  );
  const survivingEncounters = encounters.filter(
    (encounter) => !survivorsPassedStructural.has(encounter.id),
  );
  for (const verdict of verdicts) {
    if (verdict.refusal !== null) continue;
    for (const encounter of survivingEncounters) {
      const reason = rosterReasonFor(encounter, verdict.artifact.id);
      if (reason !== undefined) {
        verdict.refusal = { guard: 'encounter-roster', reason };
        break;
      }
    }
  }

  return { verdicts, moduleMentionedIds, shadowedIds };
}

/** The roster guard: a surviving encounter's entry citing `artifactId`. */
function rosterReasonFor(encounter: EncounterArtifact, artifactId: Id): string | undefined {
  for (const entry of encounter.data.monsters) {
    if (entry.source.type === 'npc-ref' && entry.source.artifactId === artifactId) {
      return `roster entry "${entry.name}" of the encounter "${encounter.name}"`;
    }
  }
  return undefined;
}

/**
 * Sweeps the orphaned entities of one module (docs above). Reads/writes ONE
 * `rw` transaction over every touched table; a failure rolls the WHOLE
 * sweep back (count honesty, deleteModule's standard).
 */
export async function sweepOrphanedArtifacts(
  moduleId: Id,
  options: OrphanSweepOptions = {},
): Promise<OrphanSweepOutcome> {
  return db.transaction(
    'rw',
    // Array form (docs/18 gotcha — past the variadic cap). `creatureImages`
    // rides the scope because the per-row delete path below reaches the
    // campaign image prune (the reference walk reads it) — a scope that omits
    // it throws "object store not found" mid-sweep, which is exactly the
    // half-applied delete this transaction exists to prevent.
    [db.artifacts, db.revisions, db.images, db.battles, db.modules, db.campaigns, db.creatureImages],
    async () => {
      // Re-read INSIDE the tx (recount): the module row must still exist —
      // a module deleted between the panel render and the confirm fails
      // loudly instead of sweeping a ghost's rows.
      const moduleRow = await getModule(moduleId);
      if (moduleRow === undefined) throw new NotFoundError('Module', moduleId);
      const module = moduleSchema.parse(moduleRow);

      // The single-artifact boundary: loud existence + ownership checks
      // (AGENTS 1) — an id from another module (or a pc/library row) is a
      // caller bug, never a silent no-op.
      if (options.onlyId !== undefined) {
        const row = await getAnyArtifact(options.onlyId);
        if (row === undefined) throw new NotFoundError('Artifact', options.onlyId);
        if (row.moduleId !== moduleId || !isOrphanKind(row.kind)) {
          throw new Error(
            `"${row.name}" is not a module-owned orphan-kind entity of this module — ` +
              'the orphan sweep does not delete it.',
          );
        }
      }

      // Candidates re-listed INSIDE the tx (recount): rows that landed or
      // changed since the panel rendered are decided from their current
      // state, never from the snapshot the dialog counted.
      const candidates = orphanCandidatesOf(moduleId, await listArtifactsByModule(moduleId)).filter(
        (candidate) => options.onlyId === undefined || candidate.id === options.onlyId,
      );
      if (candidates.length === 0) return { deleted: [], kept: [] };

      const campaignModules = await listModulesByCampaign(module.campaignId);
      // The reader's resolution pool (5b28bc2): campaign rows + globals.
      const pool: AnyArtifact[] = [
        ...(await listArtifactsByCampaign(module.campaignId)),
        ...(await listGlobalArtifacts()),
      ];
      // Battle guard carriers (parse-on-read): any battle of the campaign —
      // the module survives this sweep, so its own battles count too.
      const battles = (await db.battles.where('campaignId').equals(module.campaignId).toArray()).map(
        (row) => battleSchema.parse(row),
      );
      // THE guard evaluation (one function, shared with the panel's read-time
      // derivation): every guard, in its documented order, decided from the
      // rows re-listed above — the panel's count never decides what goes.
      const evaluation = evaluateOrphanGuards(candidates, {
        module,
        campaignModules,
        pool,
        battles,
      });

      // Deletes: the candidates that passed every guard, via the frozen
      // `deleteArtifact` (nested — its six tables are a subset of this
      // scope; links scrub + image refcount prune ride it). Candidate order.
      for (const verdict of evaluation.verdicts) {
        if (verdict.refusal === null) await deleteArtifact(verdict.artifact.id);
      }

      // The offered set (the panel's predicate, re-derived): module-zero AND
      // not ambiguity-shadowed. A delete-all reports exactly what it was
      // offered — a guarded row the panel showed comes back as `kept` with
      // its reason, never a silent drop. A directly-attempted row (onlyId)
      // is always reported: when it fails the offered predicate, the guard
      // that failed (mention, shadow) is the refusal.
      const offered = (artifact: AnyArtifact): boolean =>
        !evaluation.moduleMentionedIds.has(artifact.id) &&
        !evaluation.shadowedIds.has(artifact.id);
      const deleted: { id: Id; name: string }[] = [];
      const keptOut: OrphanSweepKept[] = [];
      for (const verdict of evaluation.verdicts) {
        const { artifact } = verdict;
        if (verdict.refusal === null) {
          deleted.push({ id: artifact.id, name: artifact.name });
          continue;
        }
        if (options.onlyId !== undefined || offered(artifact)) {
          keptOut.push({ id: artifact.id, name: artifact.name, reason: verdict.refusal.reason });
        }
      }
      return { deleted, kept: keptOut };
    },
  );
}
