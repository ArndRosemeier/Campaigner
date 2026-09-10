import type { AnyArtifact, Id, MonsterEntry, MonsterSource, NpcArtifact, StatBlock } from '@/domain';
import { moduleTagFor } from '@/domain/module';
import {
  adoptIntoCampaign,
  createArtifact,
  getArtifact,
  getAnyArtifact,
  listArtifactsByCampaign,
  listArtifactsByModule,
  stampModuleOwnership,
  updateArtifact,
  type RevisionMeta,
} from '@/db/artifactRepo';
import { db } from '@/db/db';
import { getModule } from '@/db/moduleRepo';
import { cloneArtifactCover, fillCoverFromCache } from '@/db/mobPortraitCache';
import { toastSuccess } from '@/lib/toast';

/**
 * Mob artifacts (owner-ratified mob-artifact arc): a creature the encounter
 * pipeline cites from the bestiary — via the roster (`sourceName`) or a
 * pinned/ranked chunk citation — becomes ONE real, image-able `npc` artifact
 * per campaign per rulebook chunk.
 *
 * Binding decisions (docs/11 D5 amendment):
 * - Kind `'npc'` with the additive `data.monsterChunkId` marker — NOT a new
 *   kind, and NOT an entry in `links` (artifact links are artifact→artifact
 *   in every consumer; a chunkId there would render as a broken node).
 * - Keyed by `chunkId` (the creature kind's stat-block chunk), scan-based
 *   lookup mirroring `materializeMonsterNpc`'s one-entity-per-name scan —
 *   cross-book duplicate creatures get separate artifacts (acceptable v1;
 *   the roster disambiguates by book).
 * - NO stat duplication: the artifact carries name + marker only; the chunk
 *   stays the source of truth (`resolveMonsterEntry` keeps reading it), so
 *   seeding resolves stats through `resolveMonsterEntryWithRepos` and freezes
 *   ONE `seedFighters` row under the artifact id.
 *
 * Both writers — runEngine finalize (both remap sites) and `battleSeed`'s
 * lazy retro-fill — share THIS helper, so repeated runs/encounters/seeds
 * converge on the same row (idempotency is test-pinned).
 */

/** The campaign's mob artifact for one chunk, when one exists. */
export async function findMobArtifactByChunk(
  campaignId: Id,
  chunkId: Id,
): Promise<NpcArtifact | undefined> {
  const artifacts = await listArtifactsByCampaign(campaignId);
  return artifacts.find(
    (artifact): artifact is NpcArtifact =>
      artifact.kind === 'npc' && artifact.data.monsterChunkId === chunkId,
  );
}

/** True when the row is a mob artifact (an `npc` carrying the chunk marker). */
export function isMobArtifact(artifact: AnyArtifact): artifact is NpcArtifact {
  return artifact.kind === 'npc' && artifact.data.monsterChunkId !== undefined;
}

/**
 * The artifact ids a roster points at: `npc-ref` entries plus rulebook entries
 * carrying the mob-artifact stamp. ONE reader for every roster consumer (the
 * auto-promote ROSTER/BATTLE hook and the delete-dialog citation census) —
 * never a second interpretation of `MonsterEntry.source`.
 */
export function rosterArtifactIds(monsters: readonly MonsterEntry[]): Id[] {
  const ids: Id[] = [];
  for (const monster of monsters) {
    if (monster.source.type === 'npc-ref') ids.push(monster.source.artifactId);
    else if (monster.source.type === 'rulebook' && monster.source.mobArtifactId !== undefined) {
      ids.push(monster.source.mobArtifactId);
    }
  }
  return ids;
}

/** What one module's encounters CITE (never what the module owns). */
export interface ModuleMobCitations {
  /** The distinct cited rows, name-sorted. */
  artifacts: NpcArtifact[];
  /** The module's encounters whose rosters carry at least one citation. */
  citingEncounters: string[];
}

/**
 * The module-delete dialog's blast-radius census: the distinct MOB artifacts
 * (rulebook-cited creatures — ONE campaign-scoped `npc` row per campaign per
 * cited chunk, docs/11 D5) that the encounters OWNED BY `moduleId` cite.
 *
 * This is a REFERENCE count, deliberately NOT an ownership count: those rows
 * are campaign-level by design (they must outlive any single module, and
 * stamping `moduleId` on them would break the one-artifact-per-chunk identity),
 * so `deleteModule` neither deletes nor releases them — the module's encounters
 * go, their citations stop existing, and the rows simply stay. Naming the
 * number before the click is what makes the cascade's real reach visible.
 *
 * `listArtifactsByModule` answers the ownership question; this answers the
 * citation one, and the caller renders the two as separate sentences.
 */
export async function countMobArtifactsCitedByModule(moduleId: Id): Promise<ModuleMobCitations> {
  const module = await getModule(moduleId);
  if (module === undefined) {
    throw new Error(`mob citations: module ${moduleId} no longer exists`);
  }
  const owned = await listArtifactsByModule(moduleId);
  const citedIds = new Set<Id>();
  const citingEncounters: string[] = [];
  for (const artifact of owned) {
    if (artifact.kind !== 'encounter') continue;
    const ids = rosterArtifactIds(artifact.data.monsters);
    if (ids.length === 0) continue;
    citingEncounters.push(artifact.name);
    for (const id of ids) citedIds.add(id);
  }
  if (citedIds.size === 0) return { artifacts: [], citingEncounters: [] };
  // The parsed campaign pool (the repo's own read boundary) — the cited rows
  // are campaign-scoped mob artifacts, so nothing else can be the target.
  const pool = await listArtifactsByCampaign(module.campaignId);
  const artifacts = pool
    .filter(isMobArtifact)
    .filter((artifact) => citedIds.has(artifact.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { artifacts, citingEncounters };
}

/**
 * Get-or-create the mob artifact for `chunkId`. The name is the roster
 * creature name (the first citers win it; an existing artifact is reused
 * verbatim, mirroring `materializeMonsterNpc`). An empty name is a loud
 * error — never an unnamed artifact (AGENTS rule 1). `cache` deduplicates
 * repeated citations of the same chunk within one caller (one run/seed).
 *
 * Concurrency: scan + create run in ONE rw transaction (artifacts +
 * revisions — the nested createArtifact joins as a subset). Two concurrent
 * get-or-creates for the same chunk serialize: the loser's scan sees the
 * winner's committed row and reuses it. The previous check-then-act across
 * two unrelated transactions could materialize TWO mob artifacts for one
 * cited chunk, splitting token identity and portraits (the ratified
 * ONE-artifact-per-chunk rule, docs/11 D5 amendment).
 *
 * Global portrait read-through (docs/11 D5 amendment, slice A): pass
 * `options.fillCoverFromCache` to clone the cached canonical cover into a
 * still cover-less artifact AFTER the transaction commits (the clone is the
 * attach seam's own transaction — it cannot nest inside this one). Default
 * callers (runEngine finalize, battleSeed retro-fill, bestiary spawn) pass
 * nothing and behave byte-identically: the read-through is opt-in for the
 * portrait batch only, so generation stays manual-only everywhere else.
 */
export async function getOrCreateMobArtifact(
  campaignId: Id,
  chunkId: Id,
  name: string,
  meta: RevisionMeta = { source: 'user' },
  cache?: Map<Id, Id>,
  options?: { fillCoverFromCache?: boolean | undefined },
): Promise<Id> {
  const trimmedName = name.trim();
  if (trimmedName === '') {
    throw new Error('mob artifact: a monster to materialize has an empty name');
  }
  const cached = cache?.get(chunkId);
  if (cached !== undefined) return cached;

  const artifactId = await db.transaction('rw', [db.artifacts, db.revisions], async () => {
    const existing = await findMobArtifactByChunk(campaignId, chunkId);
    if (existing !== undefined) {
      cache?.set(chunkId, existing.id);
      return existing.id;
    }

    const created = await createArtifact(
      {
        campaignId,
        kind: 'npc',
        name: trimmedName,
        // Name + marker only — the chunk's stat block is the source of truth,
        // so nothing is copied (no stat duplication, no drift).
        data: { appearance: '', personality: '', statBlock: null, monsterChunkId: chunkId },
      },
      meta,
    );
    cache?.set(chunkId, created.id);
    return created.id;
  });

  if (options?.fillCoverFromCache === true) {
    const source: MonsterSource = { type: 'rulebook', chunkId };
    await fillCoverFromCache({
      artifactId,
      campaignId,
      source,
      citingName: trimmedName,
    });
  }
  return artifactId;
}

/**
 * Cover carry-forward (docs/11 D5 preservation rule): after an encounter
 * content regeneration re-cites its roster, a rulebook entry that converged
 * on a NEW cover-less mob-artifact row (re-chunked/re-imported chunk, or a
 * deleted-then-recreated row) inherits the OLD same-named row's cover —
 * cloned through `cloneArtifactCover` (the portrait worker's own clone
 * mechanism, no second mechanism), so tokens keep rendering art instead of
 * falling back to initials while the old blob stays intact. Old rows remain
 * as orphans (no deletion sweep in this slice — out of scope).
 *
 * Best-effort: entries whose new artifact is already imaged, whose old row
 * is gone or cover-less, or with no same-named old rulebook entry are left
 * untouched (`carried` counts only actual clones). Never throws for a
 * missing row — content regeneration must not fail over a cosmetic carry.
 */
export async function carryMobCoversForward(options: {
  campaignId: Id;
  /** The encounter's roster BEFORE the content write. */
  oldMonsters: readonly MonsterEntry[];
  /** The encounter's roster AFTER the content write. */
  newMonsters: readonly MonsterEntry[];
}): Promise<{ carried: number }> {
  const oldByName = new Map<string, Id[]>();
  for (const entry of options.oldMonsters) {
    if (entry.source.type !== 'rulebook') continue;
    // Unstamped old rows (pre-marker encounters) carry no artifact identity
    // — nothing to carry from.
    if (entry.source.mobArtifactId === undefined) continue;
    const key = entry.name.trim().toLowerCase();
    if (key === '') continue;
    const known = oldByName.get(key);
    if (known === undefined) oldByName.set(key, [entry.source.mobArtifactId]);
    else known.push(entry.source.mobArtifactId);
  }
  let carried = 0;
  for (const entry of options.newMonsters) {
    if (entry.source.type !== 'rulebook') continue;
    if (entry.source.mobArtifactId === undefined) continue;
    const candidates = oldByName.get(entry.name.trim().toLowerCase());
    if (candidates === undefined) continue;
    const next = await getAnyArtifact(entry.source.mobArtifactId);
    if (next === undefined) continue;
    if (next.coverImageId !== null || next.imageIds.length > 0) continue;
    for (const fromArtifactId of candidates) {
      if (fromArtifactId === entry.source.mobArtifactId) continue;
      const outcome = await cloneArtifactCover({
        fromArtifactId,
        toArtifactId: entry.source.mobArtifactId,
        campaignId: options.campaignId,
      });
      if (outcome === 'cloned') {
        carried += 1;
        break;
      }
    }
  }
  return { carried };
}

export interface SpawnResult {
  artifactId: Id;
  /** false = the artifact already lived in this module (no revision churn). */
  stamped: boolean;
}
/**
 * Bestiary-roster spawn (owner-ratified single placement + auto-promote):
 * get-or-create the campaign's mob artifact for `chunkId` and put it into
 * `moduleId` via `stampModuleOwnership` — the artifact is module-owned (one
 * placement at a time) and carries the `module:<title>` compatibility tag.
 * Spawning the same creature into the SAME module again is an idempotent
 * no-op (no revision bump). Spawning into a DIFFERENT module PROMOTES the
 * artifact to campaign level via `adoptIntoCampaign` (shared — the second
 * module's use keeps it for everyone) instead of moving it away from the
 * first module (auto-promote on second-module use).
 */
export async function spawnMobArtifactIntoModule(
  campaignId: Id,
  chunkId: Id,
  name: string,
  moduleId: Id,
  moduleTitle: string,
  meta: RevisionMeta = { source: 'user' },
  cache?: Map<Id, Id>,
): Promise<SpawnResult> {
  const artifactId = await getOrCreateMobArtifact(campaignId, chunkId, name, meta, cache);
  const artifact = await getArtifact(artifactId);
  if (artifact === undefined) throw new Error(`mob artifact ${artifactId} vanished after get-or-create`);
  if (artifact.campaignId !== campaignId) {
    throw new Error(`mob artifact ${artifactId} belongs to another campaign`);
  }
  if (artifact.moduleId === moduleId) {
    return { artifactId, stamped: false };
  }
  if (artifact.moduleId !== null) {
    // Second-module use: promote to shared campaign ownership (auto-promote
    // on second-module use) instead of moving it away from the first
    // module — with the same LOUD notice as every other promotion path.
    await adoptIntoCampaign(artifactId);
    toastSuccess(`«${artifact.name}» is now shared across the campaign (used by ${moduleTitle})`);
    return { artifactId, stamped: true };
  }
  await stampModuleOwnership(artifactId, moduleId, moduleTagFor(moduleTitle), meta);
  return { artifactId, stamped: true };
}

/**
 * The machine marker stamped into an on-demand invented creature's summary:
 * `materializeInventedCreatureArtifact` reuses (never duplicates) the
 * artifact carrying this encounter's marker under the roster name, so the
 * per-entry "Create creature + portrait" action stays idempotent across
 * clicks and the batch-all collapses duplicate roster names onto one row.
 */
export function inventedCreatureMarker(encounterId: Id): string {
  return `[encounter-creature:${encounterId}]`;
}

/**
 * The on-demand invented creature for one roster name on one encounter, when
 * it already exists: an npc of the exact name (case-insensitive, trimmed)
 * carrying this encounter's creation marker. THE one lookup rule —
 * `materializeInventedCreatureArtifact` reuses what this finds, and the
 * portrait batch's read-only count resolves through it too, so counting what
 * a roster row's portrait would be can never CREATE the creature it counts.
 */
export async function findInventedCreatureArtifact(
  campaignId: Id,
  encounterId: Id,
  name: string,
): Promise<NpcArtifact | undefined> {
  const trimmedName = name.trim();
  if (trimmedName === '') return undefined;
  const marker = inventedCreatureMarker(encounterId);
  const artifacts = await listArtifactsByCampaign(campaignId);
  return artifacts.find(
    (artifact): artifact is NpcArtifact =>
      artifact.kind === 'npc' &&
      artifact.name.trim().toLowerCase() === trimmedName.toLowerCase() &&
      artifact.summary.includes(marker),
  );
}

/** Appearance seeding for an invented creature: roster notes, then the
 * pocket-treasure checklist the token card would carry — the only
 * description an uncited roster entry has. Both empty ⇒ '' (no
 * placeholder prose; the portrait prompt still grounds on name+summary). */
export function inventedCreatureAppearance(notes: string, treasure: string): string {
  const parts: string[] = [];
  if (notes.trim() !== '') parts.push(notes.trim());
  if (treasure.trim() !== '') parts.push(`Carries:\n${treasure.trim()}`);
  return parts.join('\n\n');
}

export interface InventedCreatureMaterialize {
  campaignId: Id;
  encounterId: Id;
  encounterName: string;
  /**
   * The encounter's moduleId (null when campaign-level): the creature is
   * created in the SAME scope so `deleteModule`'s cascade/keep disposes them
   * together — a module-owned encounter's creature must not survive as a
   * campaign stray under cascade, nor strand under keep. A dangling moduleId
   * fails loudly (ownership-boundary existence check, docs/18 §3).
   */
  moduleId: Id | null;
  /** Roster name — the artifact's name, verbatim (trimmed). */
  name: string;
  /** Roster entry notes → appearance seed. */
  notes: string;
  /** Roster entry treasure → appearance seed. */
  treasure: string;
  /** The inline stat block when the entry has one, else null. */
  statBlock: StatBlock | null;
  meta?: RevisionMeta;
  /** Batch dedupe: roster-name (per encounter) → artifact, mirroring
   * `materializeMonsterNpc`'s one-entity-per-name collapse. */
  cache?: Map<string, Id>;
}

/**
 * On-demand creature for an uncited roster entry (inline / none sources —
 * model-invented mobs with no bestiary citation and no mob artifact):
 * a REAL campaign- (or module-) scoped `npc` artifact named for the roster
 * entry, appearance seeded from its notes/treasure text, the inline block
 * when present else null, summary noting the encounter it was created for.
 *
 * Deliberately NOT a mob artifact: no `monsterChunkId` marker (there is no
 * chunk), so the canonical portrait cache firewall holds structurally —
 * nothing about this row can ever produce a `cacheKeyForMonsterSource`.
 * The roster entry itself is NOT rewritten to npc-ref: battleSeed's spawn
 * paths stay byte-identical (inline still freezes per-instance rows,
 * name-only stays statless); this only adds an image-able artifact + cover.
 *
 * Reuse (never duplicate): an npc of the exact name (case-insensitive,
 * trimmed) already carrying this encounter's marker is linked instead — a
 * statless twin receives the inline block as a revisioned user save; an
 * existing stat block or user-edited appearance is never overwritten. An
 * empty name is a loud error — never an unnamed artifact (AGENTS rule 1).
 */
export async function materializeInventedCreatureArtifact(
  options: InventedCreatureMaterialize,
): Promise<Id> {
  const trimmedName = options.name.trim();
  if (trimmedName === '') {
    throw new Error('invented creature: a monster to materialize has an empty name');
  }
  if (options.moduleId !== null) {
    const module = await getModule(options.moduleId);
    if (module === undefined) {
      throw new Error(
        `invented creature: module ${options.moduleId} no longer exists — re-anchor the encounter before creating its creatures`,
      );
    }
  }
  const key = `${options.encounterId}:${trimmedName.toLowerCase()}`;
  const cached = options.cache?.get(key);
  if (cached !== undefined) return cached;

  const existing = await findInventedCreatureArtifact(
    options.campaignId,
    options.encounterId,
    trimmedName,
  );
  if (existing !== undefined) {
    if (existing.data.statBlock === null && options.statBlock !== null) {
      await updateArtifact(
        existing.id,
        { data: { ...existing.data, statBlock: options.statBlock } },
        options.meta ?? { source: 'user' },
      );
    }
    options.cache?.set(key, existing.id);
    return existing.id;
  }

  const created = await createArtifact(
    {
      campaignId: options.campaignId,
      ...(options.moduleId === null ? {} : { moduleId: options.moduleId }),
      kind: 'npc',
      name: trimmedName,
      summary: `On-demand creature created for encounter "${options.encounterName.trim() === '' ? 'Untitled encounter' : options.encounterName.trim()}" ${inventedCreatureMarker(options.encounterId)}`,
      data: {
        appearance: inventedCreatureAppearance(options.notes, options.treasure),
        personality: '',
        statBlock: options.statBlock,
      },
    },
    options.meta ?? { source: 'user' },
  );
  options.cache?.set(key, created.id);
  return created.id;
}
