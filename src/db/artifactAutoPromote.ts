import type { AnyArtifact, Id, MonsterEntry, Module } from '@/domain';
import {
  adoptIntoCampaign,
  getAnyArtifact,
  listArtifactsByCampaign,
  listArtifactsByModule,
} from '@/db/artifactRepo';
import { getModule, listModulesByCampaign } from '@/db/moduleRepo';
import { db } from '@/db/db';
import { buildWikiGraph } from '@/domain/wikiGraph';
import { extractWikiLinks, resolveWikiLink } from '@/lib/wikilinks';
import { toastError, toastSuccess } from '@/lib/toast';

/**
 * Auto-promote on second-module use (owner-ratified design).
 *
 * Rule: module-created artifacts stay module-owned. The moment a SECOND
 * module references one — a wikilink in its text, an encounter roster entry,
 * or a battle token — the artifact auto-promotes to campaign level
 * (`moduleId: null`) with a LOUD toast notice. There is no separate core
 * state: promotion IS `adoptIntoCampaign`, the only sanctioned scope changer
 * path (via `moveScope`), reused verbatim — never a parallel scope writer.
 *
 * Every helper here is idempotent: an already campaign-level row is a no-op,
 * so repeated saves/scans never churn revisions or re-toast.
 */

/** How many promoted names one toast lists before collapsing the rest. */
export const PROMOTION_TOAST_NAME_CAP = 3;

/**
 * Compares one artifact's owner against the using module and promotes on
 * mismatch. Returns the promoted row, or null when nothing moved (already
 * campaign-level, or owned by the using module itself). A null using module
 * is a campaign-level use — any module owner mismatches and promotes.
 * Throws loudly on a failed promote (AGENTS rule 1): the caller decides
 * whether the outer write still lands.
 */
export async function promoteArtifactForModuleUse(
  artifactId: Id,
  userModuleId: Id | null,
): Promise<AnyArtifact | null> {
  const artifact = await getAnyArtifact(artifactId);
  if (artifact === undefined) {
    throw new Error(`auto-promote: artifact ${artifactId} no longer exists`);
  }
  if (artifact.campaignId === null) return null;
  if (artifact.moduleId === null) return null;
  if (userModuleId !== null && artifact.moduleId === userModuleId) return null;
  return adoptIntoCampaign(artifactId);
}

/**
 * Single-artifact LOUD variant (stub-popover alias writes): promotes on
 * owner mismatch and toasts the same batched-style notice for the one row.
 * Failures propagate — the caller toasts them (AGENTS rule 2).
 */
export async function promoteArtifactForModuleUseLoud(
  artifactId: Id,
  userModuleId: Id,
): Promise<AnyArtifact | null> {
  const promoted = await promoteArtifactForModuleUse(artifactId, userModuleId);
  if (promoted === null) return null;
  const user = await getModule(userModuleId);
  toastPromotions([promoted], user?.title ?? 'another module');
  return promoted;
}

/** Batched LOUD notice for promoted rows — never the run-issue channel (that
 * channel is LLM-run escalation; this is a user-visible ownership change). */
function toastPromotions(promoted: readonly AnyArtifact[], usedByLabel: string): void {
  if (promoted.length === 0) return;
  const names = promoted.map((artifact) => `«${artifact.name}»`);
  const shown = names.slice(0, PROMOTION_TOAST_NAME_CAP);
  const rest = names.length - shown.length;
  const subject =
    shown.length === 1 && rest === 0
      ? `${shown[0]} is now shared across the campaign`
      : `${shown.join(', ')}${rest > 0 ? ` and ${String(rest)} more` : ''} are now shared across the campaign`;
  toastSuccess(`${subject} (used by ${usedByLabel})`);
}

/** Loud per-artifact failure surface: a failed promote never passes silently. */
function toastPromotionFailures(failures: readonly { name: string; error: unknown }[]): void {
  for (const failure of failures) {
    toastError(`Could not share “${failure.name}” across the campaign`, failure.error);
  }
}

/**
 * LINKS hook — post-save scan. Extracts every wikilink from the writer
 * module's freshly saved texts, resolves each against the campaign pool with
 * the writer as context, and promotes owner-mismatched hits to campaign
 * level. Pure resolution stays in `resolveWikiLink` (the render path is NOT
 * hooked); this runs AFTER the text write lands.
 */
export async function promoteSecondModuleUses(
  writerModuleId: Id,
  markdowns: readonly string[],
): Promise<AnyArtifact[]> {
  const writer = await getModule(writerModuleId);
  if (writer === undefined) {
    throw new Error(
      `auto-promote: writer module ${writerModuleId} no longer exists — refusing to scan text for a deleted module`,
    );
  }
  const pool = await listArtifactsByCampaign(writer.campaignId);
  const names = new Map<string, string>();
  for (const markdown of markdowns) {
    for (const link of extractWikiLinks(markdown)) {
      const lower = link.name.trim().toLowerCase();
      if (lower !== '' && !names.has(lower)) names.set(lower, link.name);
    }
  }
  const promoted: AnyArtifact[] = [];
  const failures: { name: string; error: unknown }[] = [];
  const seen = new Set<Id>();
  for (const name of names.values()) {
    const resolution = resolveWikiLink(name, pool, { moduleId: writerModuleId });
    const hit = resolution.artifact;
    if (hit === undefined) continue;
    if (hit.moduleId === null || hit.moduleId === writerModuleId) continue;
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    try {
      promoted.push(await adoptIntoCampaign(hit.id));
    } catch (error) {
      failures.push({ name: hit.name, error });
    }
  }
  toastPromotions(promoted, writer.title);
  toastPromotionFailures(failures);
  return promoted;
}

/** Artifact ids a roster entry points at (npc-ref / rulebook mob rows). */
function rosterArtifactIds(monsters: readonly MonsterEntry[]): Id[] {
  const ids: Id[] = [];
  for (const monster of monsters) {
    if (monster.source.type === 'npc-ref') ids.push(monster.source.artifactId);
    else if (monster.source.type === 'rulebook' && monster.source.mobArtifactId !== undefined) {
      ids.push(monster.source.mobArtifactId);
    }
  }
  return ids;
}

/**
 * ROSTER/BATTLE hook — every encounter `data.monsters` write and every
 * battle seed/spawn funnels its referenced artifact ids through here. The
 * encounter/battle module mismatching an artifact's owner promotes it.
 * `encounterModuleId: null` is a campaign-level use: any module owner
 * mismatches.
 */
export async function promoteRosterUses(
  encounterModuleId: Id | null,
  monsters: readonly MonsterEntry[],
  usedByLabel?: string,
): Promise<AnyArtifact[]> {
  const label =
    usedByLabel ??
    (encounterModuleId === null
      ? 'a campaign-level encounter'
      : ((await getModule(encounterModuleId))?.title ?? 'another module'));
  const promoted: AnyArtifact[] = [];
  const failures: { name: string; error: unknown }[] = [];
  const seen = new Set<Id>();
  for (const id of rosterArtifactIds(monsters)) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const row = await promoteArtifactForModuleUse(id, encounterModuleId);
      if (row !== null) promoted.push(row);
    } catch (error) {
      const artifact = await getAnyArtifact(id).catch(() => undefined);
      failures.push({ name: artifact?.name ?? id, error });
    }
  }
  toastPromotions(promoted, label);
  toastPromotionFailures(failures);
  return promoted;
}

export type ReferenceVia = 'link' | 'roster' | 'battle';

export interface ReferencedOwnedArtifact {
  artifact: AnyArtifact;
  via: ReferenceVia;
}

/**
 * DELETE support — every module-owned artifact of `moduleId` that is
 * referenced from OUTSIDE the module. No stored index exists: the reference
 * set unions the wiki-link graph edges, the encounter roster scan
 * (npc-ref + mobArtifactId), and the battle token/seed-fighter scan.
 * References from the module's OWN encounters/battles do not count — those
 * rows die with the module under cascade.
 */
export async function modulesReferencingOwnedArtifacts(
  moduleId: Id,
): Promise<ReferencedOwnedArtifact[]> {
  const owner = await getModule(moduleId);
  if (owner === undefined) throw new Error(`auto-promote: module ${moduleId} no longer exists`);
  const campaignId = owner.campaignId;
  const owned = await listArtifactsByModule(moduleId);
  if (owned.length === 0) return [];
  const ownedIds = new Set<Id>(owned.map((artifact) => artifact.id));
  const byId = new Map<Id, AnyArtifact>(owned.map((artifact) => [artifact.id, artifact]));
  const found = new Map<Id, ReferencedOwnedArtifact>();
  const mark = (id: Id, via: ReferenceVia): void => {
    const artifact = byId.get(id);
    if (artifact === undefined || found.has(id)) return;
    found.set(id, { artifact, via });
  };

  // Links: wiki-graph edges from OTHER modules into owned nodes. Uncapped —
  // the delete dialog must see every reference, not a ranked sample
  // (campaignGrounding.ts precedent for uncapped graph use).
  const pool: readonly AnyArtifact[] = await listArtifactsByCampaign(campaignId);
  const modules: readonly Module[] = await listModulesByCampaign(campaignId);
  const graph = buildWikiGraph(modules, pool, { cap: Number.POSITIVE_INFINITY });
  for (const edge of graph.edges) {
    if (edge.moduleId !== moduleId && ownedIds.has(edge.to)) mark(edge.to, 'link');
  }

  // Roster: npc-ref / mobArtifactId entries on encounters OUTSIDE the module
  // (campaign-level included — they survive the delete).
  for (const row of pool) {
    if (row.kind !== 'encounter' || row.moduleId === moduleId) continue;
    for (const id of rosterArtifactIds(row.data.monsters)) {
      if (ownedIds.has(id)) mark(id, 'roster');
    }
  }

  // Battles: live tokens + frozen seed-fighter rows on OTHER modules' boards.
  const battles = await db.battles.where('campaignId').equals(campaignId).toArray();
  for (const battle of battles) {
    if (battle.moduleId === moduleId) continue;
    for (const token of battle.board.tokens) {
      if (token.artifactId !== null && ownedIds.has(token.artifactId)) {
        mark(token.artifactId, 'battle');
      }
    }
    for (const seed of battle.seedFighters) {
      if (ownedIds.has(seed.id)) mark(seed.id, 'battle');
    }
  }

  return [...found.values()];
}
