import type { AnyArtifact, Battle, FighterStats, FighterStatsLookup } from '@/domain';
import { abilityModifier } from '@/domain/statblock';

/**
 * Fighter-stats resolution for battles (09-MILESTONE-5 M5-B): the engine
 * receives plain numbers, never Dexie — this module is the ONE place that
 * turns artifacts (+ the battle's frozen seed roster) into `FighterStats`.
 *
 * A fighter WITHOUT stats is absent from the lookup: a loud "no stats" badge
 * in the UI, excluded from initiative, never a placeholder number.
 */

/** Max HP for a fighter: the stat block's `hp` (max HP). */
function baseStats(
  kind: 'pc' | 'npc',
  name: string,
  maxHp: number,
  dexScore: number,
  extraBonus: number,
): FighterStats {
  return {
    kind,
    name,
    maxHp,
    initiativeBonus: abilityModifier(dexScore) + extraBonus,
    // The caller decides who owns current HP (see the two functions below).
    currentHp: null,
  };
}

/**
 * Resolves a pc artifact: max HP from the statblock, bonus = dex modifier +
 * the PC's own override, currentHp = the ARTIFACT-owned value (the HP
 * ownership split — PCs keep their HP between battles). Undefined when the
 * statblock is missing (loud warning upstream).
 */
export function fighterStatsFromPc(artifact: AnyArtifact): FighterStats | undefined {
  if (artifact.kind !== 'pc' || artifact.data.statBlock === null) {
    return undefined;
  }
  return {
    ...baseStats(
      'pc',
      artifact.name,
      artifact.data.statBlock.hp,
      artifact.data.statBlock.abilities.dex,
      artifact.data.initiativeOverride ?? 0,
    ),
    currentHp: artifact.data.currentHp,
  };
}

/**
 * Resolves an npc artifact: max HP from the statblock, bonus = dex modifier
 * (+ an npc initiative override when its data carries one). Current HP is
 * ALWAYS null here — the token instance owns it; the artifact must never
 * store current HP.
 */
export function fighterStatsFromNpc(artifact: AnyArtifact): FighterStats | undefined {
  if (artifact.kind !== 'npc' || artifact.data.statBlock === null) {
    return undefined;
  }
  const data: Record<string, unknown> = artifact.data;
  const override = typeof data.initiativeOverride === 'number' ? data.initiativeOverride : 0;
  return baseStats(
    'npc',
    artifact.name,
    artifact.data.statBlock.hp,
    artifact.data.statBlock.abilities.dex,
    override,
  );
}

/** Resolves any artifact; non-fighter kinds are absent. */
export function fighterStatsFromArtifact(artifact: AnyArtifact): FighterStats | undefined {
  if (artifact.kind === 'pc') return fighterStatsFromPc(artifact);
  if (artifact.kind === 'npc') return fighterStatsFromNpc(artifact);
  return undefined;
}

/**
 * The battle's stats lookup: real pc/npc artifacts first, then the frozen
 * seed roster (rulebook/inline monsters, M5-C). Missing entries (statless
 * seeds) stay absent: excluded from initiative, loud badge, no placeholder.
 */
export function buildFighterStatsLookup(
  battle: Pick<Battle, 'seedFighters'>,
  artifacts: readonly AnyArtifact[],
): FighterStatsLookup {
  const byArtifactId = new Map<string, FighterStats>();
  for (const artifact of artifacts) {
    const stats = fighterStatsFromArtifact(artifact);
    if (stats !== undefined) byArtifactId.set(artifact.id, stats);
  }
  const bySeedId = new Map<string, FighterStats>();
  for (const seed of battle.seedFighters) {
    bySeedId.set(seed.id, {
      kind: 'npc',
      name: seed.name,
      maxHp: seed.maxHp,
      initiativeBonus: seed.initiativeBonus,
      currentHp: null,
    });
  }
  return (id: string) => byArtifactId.get(id) ?? bySeedId.get(id);
}

/** Every statful pc artifact of the campaign (for ensurePcTokens). */
export function pcFightersOf(
  artifacts: readonly AnyArtifact[],
): { artifactId: string; stats: { kind: 'pc' | 'npc'; name: string; maxHp: number } }[] {
  const out: { artifactId: string; stats: { kind: 'pc' | 'npc'; name: string; maxHp: number } }[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'pc' || artifact.data.statBlock === null) continue;
    out.push({
      artifactId: artifact.id,
      stats: { kind: 'pc', name: artifact.name, maxHp: artifact.data.statBlock.hp },
    });
  }
  return out;
}

/** True when the battle row has nothing left worth keeping (source rule). */
export function isBattleEmpty(battle: Battle): boolean {
  return (
    battle.board.tokens.filter((token) => token.artifactId !== null).length === 0 &&
    battle.board.mapImageId === null &&
    battle.encounterArtifactId === null
  );
}
