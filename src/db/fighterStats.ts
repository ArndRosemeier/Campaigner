import type { AnyArtifact, Battle, FighterStats, FighterStatsLookup } from '@/domain';
import type { FighterStatsLike } from '@/domain/battle/board';
import { abilityModifier } from '@/domain/statblock';

/**
 * Fighter-stats resolution for battles (09-MILESTONE-5 M5-B): the engine
 * receives plain numbers, never Dexie — this module is the ONE place that
 * turns artifacts (+ the battle's frozen seed roster) into `FighterStats`.
 *
 * A statless NPC is absent from the lookup: a loud "no stats" badge in the UI,
 * excluded from initiative, never a placeholder number. A STATLESS PC is NOT
 * absent (docs/17 row 308, the owner's "all campaign players need to be in all
 * battles, always" rule): it reports its own HP, a null `maxHp` (unknown, never
 * invented) and an initiative bonus of exactly `initiativeOverride ?? 0` — no
 * dex or ability score is invented for a fighter the app is not tracking.
 */

/** An npc's resolved fighter numbers: current HP is the token's, never this. */
function npcStats(name: string, maxHp: number, dexScore: number, extraBonus: number): FighterStats {
  return {
    kind: 'npc',
    name,
    maxHp,
    initiativeBonus: abilityModifier(dexScore) + extraBonus,
    currentHp: null,
  };
}

/**
 * Resolves a pc artifact. currentHp is the ARTIFACT-owned value (the HP
 * ownership split — PCs keep their HP between battles), for a statful AND a
 * statless PC alike.
 *
 * A statful PC is unchanged: max HP from the block, bonus = dex modifier + the
 * PC's own override. A STATLESS PC resolves instead of vanishing (docs/17 row
 * 308): `maxHp` is null because no block states one (never an invented 0 or
 * 20) and the bonus is exactly `initiativeOverride ?? 0`. That is what lets
 * every campaign player stand on the board, roll initiative and take damage
 * with no stat block at all — the owner's point of convenience, since players
 * run themselves from their own character sheet.
 */
export function fighterStatsFromPc(artifact: AnyArtifact): FighterStats | undefined {
  if (artifact.kind !== 'pc') {
    return undefined;
  }
  const block = artifact.data.statBlock;
  const override = artifact.data.initiativeOverride ?? 0;
  return {
    kind: 'pc',
    name: artifact.name,
    maxHp: block === null ? null : block.hp,
    initiativeBonus: override + (block === null ? 0 : abilityModifier(block.abilities.dex)),
    currentHp: artifact.data.currentHp,
  };
}

/**
 * Resolves an npc artifact: max HP from the statblock, bonus = dex modifier
 * (+ an npc initiative override when its data carries one). Current HP is
 * ALWAYS null here — the token instance owns it; the artifact must never
 * store current HP. A statless npc stays ABSENT (the loud badge contract).
 */
export function fighterStatsFromNpc(artifact: AnyArtifact): FighterStats | undefined {
  if (artifact.kind !== 'npc' || artifact.data.statBlock === null) {
    return undefined;
  }
  const data: Record<string, unknown> = artifact.data;
  const override = typeof data.initiativeOverride === 'number' ? data.initiativeOverride : 0;
  return npcStats(
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
 * seed roster (rulebook/inline monsters, M5-C). Missing entries (statless npc
 * seeds and statless npc artifacts) stay absent: excluded from initiative,
 * loud badge, no placeholder. A statless PC is NOT missing — see
 * `fighterStatsFromPc`.
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

/**
 * Every campaign pc artifact — statful OR statless — for `ensurePcTokens`, the
 * ONE PC-token seam (docs/17 row 308). The arm is NAME-ONLY: a PC token never
 * reads maxHp (`instanceCurrentHpFor` returns null for `kind: 'pc'`), so
 * requiring a stat block here was the single line that silently dropped every
 * statless player from every battle.
 */
export function pcFightersOf(
  artifacts: readonly AnyArtifact[],
): { artifactId: string; stats: FighterStatsLike }[] {
  const out: { artifactId: string; stats: FighterStatsLike }[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'pc') continue;
    out.push({ artifactId: artifact.id, stats: { kind: 'pc', name: artifact.name } });
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
