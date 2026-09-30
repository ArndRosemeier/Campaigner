import {
  BOARD_PREMISE_NODE_KEY,
  boardLevelNodeKey,
  canvasPriorModuleNodeKey,
  levelForPlanIndex,
  type AnyArtifact,
  type Id,
  type Module,
} from '@/domain';
import { buildWikiGraph, type WikiGraphMention } from '@/domain/wikiGraph';

/**
 * Board continuity edges (08-MODULE-DESIGNER §Module board): a prior
 * module's text group connects to the CURRENT module's premise/level card
 * when both texts mention the same canonical wiki-name — derived from
 * `buildWikiGraph`'s per-document mentions, so resolution follows exactly
 * the reader's pool + per-module tier-0 conventions (13-WIKI-GRAPH). Pure.
 *
 * The edges' TARGETS are the board's level node keys (docs/17 row 388); the
 * mentions they are derived from are the tree-wide mention convention
 * (`'premise'` / `part-<planIndex>`, `domain/wikiGraph`), so the LEVEL comes
 * from the ONE `levelForPlanIndex` — never a second arithmetic.
 *
 * The derivation is CAPPED and the cap is surfaced (never silent): a long
 * campaign can share dozens of names, and a board buried under edges is
 * noise, not information — the page renders a "+N more" honesty note.
 */

export interface BoardContinuityEdge {
  /** Stable edge id: `<source>|<target>`. */
  id: string;
  /** Prior module's text-group node key. */
  source: string;
  /** Current module's premise/part node key. */
  target: string;
  /** The shared canonical names (first-seen spelling), `×N` mention weight. */
  label: string;
  /** Total mention weight across the shared names. */
  weight: number;
}

export interface ContinuityDerivation {
  edges: BoardContinuityEdge[];
  /** How many ranked edges were dropped behind the cap. */
  truncated: number;
}

/** Maximum drawn continuity edges (most-mentioned first, deterministic). */
export const BOARD_CONTINUITY_EDGE_CAP = 12;

/** Builds the derived wiki graph with NO node cap (edges own the honesty cap). */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

export function deriveContinuityEdges(input: {
  module: Module;
  priorModules: readonly Module[];
  /** The reader's resolution pool: campaign artifacts + global library. */
  pool: readonly AnyArtifact[];
}): ContinuityDerivation {
  if (input.priorModules.length === 0) return { edges: [], truncated: 0 };
  const graph = buildWikiGraph([input.module, ...input.priorModules], input.pool, {
    cap: UNCAPPED,
  });

  /** (source, target) → accumulating edge. */
  const merged = new Map<
    string,
    { source: string; target: string; names: string[]; weight: number }
  >();

  for (const node of graph.nodes) {
    const currentDocs = node.mentionsByDocument.filter(
      (mention) => mention.moduleId === input.module.id,
    );
    const priorDocs = node.mentionsByDocument.filter(
      (mention): mention is WikiGraphMention & { moduleId: Id } =>
        mention.moduleId !== input.module.id,
    );
    if (currentDocs.length === 0 || priorDocs.length === 0) continue;
    for (const prior of priorDocs) {
      for (const current of currentDocs) {
        const source = canvasPriorModuleNodeKey(prior.moduleId);
        const target =
          current.where === 'premise'
            ? BOARD_PREMISE_NODE_KEY
            : boardLevelNodeKey(levelOfMentionDocument(current.where));
        const id = `${source}|${target}`;
        const entry = merged.get(id);
        if (entry === undefined) {
          merged.set(id, { source, target, names: [node.names[0] ?? node.key], weight: node.mentions });
        } else {
          const name = node.names[0] ?? node.key;
          if (!entry.names.includes(name)) entry.names.push(name);
          entry.weight += node.mentions;
        }
      }
    }
  }

  const ranked = [...merged.entries()].sort(
    ([idA, a], [idB, b]) =>
      b.weight - a.weight ||
      a.names.join(',').localeCompare(b.names.join(',')) ||
      idA.localeCompare(idB),
  );
  const kept = ranked.slice(0, BOARD_CONTINUITY_EDGE_CAP);
  return {
    edges: kept.map(([id, entry]) => ({
      id,
      source: entry.source,
      target: entry.target,
      label: `${entry.names.join(', ')} ×${String(entry.weight)}`,
      weight: entry.weight,
    })),
    truncated: ranked.length - kept.length,
  };
}

/**
 * The LEVEL a mention's own document names: the tree-wide mention convention
 * (`'premise'` / `part-<planIndex>`, `domain/wikiGraph`) carries a `planIndex`,
 * and the board addresses by LEVEL — so this calls the ONE
 * `levelForPlanIndex`. The premise never reaches here (the caller maps it to
 * the premise card), and an unknown document is LOUD rather than silently
 * dropped (AGENTS rule 1).
 */
function levelOfMentionDocument(where: string): number {
  const planIndex = Number(where.slice('part-'.length));
  if (!Number.isInteger(planIndex) || planIndex < 0) {
    throw new Error(`deriveContinuityEdges: unknown document "${where}"`);
  }
  return levelForPlanIndex(planIndex);
}
