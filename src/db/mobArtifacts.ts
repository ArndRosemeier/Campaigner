import type { Id, MonsterSource, NpcArtifact, StatBlock } from '@/domain';
import { moduleTagFor } from '@/domain/module';
import {
  createArtifact,
  getArtifact,
  listArtifactsByCampaign,
  stampModuleOwnership,
  updateArtifact,
  type RevisionMeta,
} from '@/db/artifactRepo';
import { db } from '@/db/db';
import { getModule } from '@/db/moduleRepo';
import { fillCoverFromCache } from '@/db/mobPortraitCache';

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

export interface SpawnResult {
  artifactId: Id;
  /** false = the artifact already lived in this module (no revision churn). */
  stamped: boolean;
}
/**
 * Bestiary-roster spawn (owner-ratified single placement): get-or-create the
 * campaign's mob artifact for `chunkId` and put it into `moduleId` via
 * `stampModuleOwnership` — the artifact is module-owned (one placement at a
 * time) and carries the `module:<title>` compatibility tag. Spawning the
 * same creature into the SAME module again is an idempotent no-op (no
 * revision bump); into a DIFFERENT module it MOVES the artifact (the tag
 * list keeps the previous module tag as history, per stampModuleOwnership).
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
  const marker = inventedCreatureMarker(options.encounterId);

  const existing = (await listArtifactsByCampaign(options.campaignId)).find(
    (artifact): artifact is NpcArtifact =>
      artifact.kind === 'npc' &&
      artifact.name.trim().toLowerCase() === trimmedName.toLowerCase() &&
      artifact.summary.includes(marker),
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
      summary: `On-demand creature created for encounter "${options.encounterName.trim() === '' ? 'Untitled encounter' : options.encounterName.trim()}" ${marker}`,
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
