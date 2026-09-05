import type { Id, NpcArtifact } from '@/domain';
import {
  createArtifact,
  listArtifactsByCampaign,
  type RevisionMeta,
} from '@/db/artifactRepo';

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
 */
export async function getOrCreateMobArtifact(
  campaignId: Id,
  chunkId: Id,
  name: string,
  meta: RevisionMeta = { source: 'user' },
  cache?: Map<Id, Id>,
): Promise<Id> {
  const trimmedName = name.trim();
  if (trimmedName === '') {
    throw new Error('mob artifact: a monster to materialize has an empty name');
  }
  const cached = cache?.get(chunkId);
  if (cached !== undefined) return cached;

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
}
