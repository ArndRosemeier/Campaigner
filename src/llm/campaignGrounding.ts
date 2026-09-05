import type { AnyArtifact, Id, Module } from '@/domain';
import {
  buildWikiGraph,
  wikiGraphNodeLabel,
  type WikiGraph,
  type WikiGraphMention,
  type WikiGraphNode,
} from '@/domain/wikiGraph';
import {
  extractWikiLinks,
  resolveWikiLink,
  surroundingParagraphs,
  WIKI_LINK_PATTERN,
} from '@/lib/wikilinks';
import { z } from 'zod';

/**
 * Campaign grounding (15-GRAPH-RETRIEVAL): graph-aware grounding for LLM
 * runs. In the retrieve step only, the run brief is scanned for entities of
 * the reader's resolution pool (campaign artifacts + global library); each
 * detected entity is expanded through the DERIVED wiki-link graph
 * (`buildWikiGraph` — consumed uncapped, never forked) by its top-1
 * co-mention, and the resulting excerpts are persisted with the retrieve
 * step's stored output so the draft renders them byte-identically — no new
 * searches, no query embeddings, no LLM calls (the cost invariant).
 *
 * The ratified decision points (15 §6) are binding here:
 * 1. expansion signal = co-mention only (no curated relations, no transitives);
 * 2. the encounter flow participates via general grounding only — the citable
 *    stat-block search and the pack roster stay byte-identical (fix-02);
 * 3. moderate budget: ≤ 3 detected entities, self + top-1 co-mention each
 *    (≤ 6 blocks), 4000-char global section budget, deterministic truncation;
 * 4. rollout = the global `wikiGroundingEnabled` settings toggle (default ON),
 *    gated by the caller — an empty module set, zero detections or an OFF
 *    toggle yield NO section (never an empty block).
 *
 * Detection is mechanical (never LLM) and module-context free: briefs are
 * campaign-level prose, so module-tier shadowing must not redirect it —
 * `resolveWikiLink` runs WITHOUT a `moduleId` (15 §2.4/§3.1).
 */

/** Ratified budget (15 §6 D3, moderate): ≤ 3 detected entities. */
export const GROUNDING_MAX_DETECTED_ENTITIES = 3;
/** Ratified budget: self + top-1 co-mention each ⇒ ≤ 6 blocks. */
export const GROUNDING_MAX_BLOCKS = 6;
/** Per-block excerpt cap (tighter than `surroundingParagraphs`' 1200 default). */
export const GROUNDING_EXCERPT_CAP = 600;
/** Global budget of the whole rendered section, header included. */
export const GROUNDING_SECTION_BUDGET = 4000;

/** The rendered section header — the 15 §3.4 label, glossary terminology. */
export const GROUNDING_SECTION_HEADER = 'Campaign grounding (derived from wiki-links):';

/** Provenance for a self block whose entity is mentioned nowhere in module
 * prose: its own artifact summary is the only campaign-side source (§2.4). */
export const GROUNDING_SUMMARY_SOURCE = 'artifact summary';

/** One persisted grounding block: who, from where, and the excerpt text.
 * `moduleId`/`where` are the source reference of a module-backed block —
 * validated on read (impossible-miss rule) and absent for summary-backed
 * blocks. The three string fields render verbatim, so pause/resume can never
 * drift the prompt. */
export interface ExpansionExcerpt {
  /** The entity's display name (canonical artifact name, or the first-seen
   * spelling for a phantom co-mention). */
  entityName: string;
  /** The provenance line: `<Module Title> — Part N`/`— Premise`, or the
   * artifact-summary marker. */
  source: string;
  /** The excerpt text (≤ 600 chars, already truncated). */
  text: string;
  /** The module the excerpt was taken from (module-backed blocks only). */
  moduleId?: Id | undefined;
  /** The document of that module ('premise' or 'part-<planIndex>'). */
  where?: string | undefined;
}

/** Zod shape of one stored block — the data-at-rest boundary (AGENTS rule 3). */
export const expansionExcerptSchema = z.object({
  entityName: z.string(),
  source: z.string(),
  text: z.string(),
  moduleId: z.string().optional(),
  where: z.string().optional(),
});

export interface CampaignGroundingInput {
  /** The run brief — detection runs on this text only (chain-context
   * artifacts are injected verbatim elsewhere and never re-detected). */
  brief: string;
  /** The campaign's modules (any order; the derivation sorts by title). */
  modules: readonly Module[];
  /** The reader's resolution pool: campaign artifacts + global library. */
  pool: readonly AnyArtifact[];
}

/**
 * Computes the whole campaign-grounding section (detection → expansion →
 * excerpt building → budget). Pure and deterministic: same inputs → same
 * blocks. An empty module set or zero detections yield an empty section —
 * legitimate outcomes, never errors (15 §3.2). Repo failures throw loudly at
 * the caller; the impossible cases (a recorded mention with no matching
 * paragraph) throw named errors here.
 */
export function computeCampaignGrounding(input: CampaignGroundingInput): ExpansionExcerpt[] {
  if (input.modules.length === 0) return [];
  const detected = detectCampaignEntities(input.brief, input.pool);
  if (detected.length === 0) return [];
  const graph = buildWikiGraph(input.modules, input.pool, { cap: Number.POSITIVE_INFINITY });
  const nodesByKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const moduleById = new Map(input.modules.map((module) => [module.id, module]));
  const byModule = coMentionIndex(graph);

  const blocks: ExpansionExcerpt[] = [];
  for (const artifact of detected) {
    // Resolved/ambiguous nodes are keyed by the winning artifact's id — the
    // detection's winner is exactly the node the reader would draw.
    const node = nodesByKey.get(artifact.id);
    const self = selfBlock(artifact, node, moduleById);
    if (self !== null) blocks.push(self);
    if (node === undefined) continue; // no node → no co-mentions exist
    const coMention = topCoMentionNode(byModule, nodesByKey, node.key);
    if (coMention === undefined) continue;
    blocks.push(moduleExcerptBlock(coMention, moduleById));
  }
  return applyBudget(blocks.slice(0, GROUNDING_MAX_BLOCKS));
}

/**
 * Detection (15 §3.1): literal `[[wiki-link]]` tokens first, resolved in
 * brief order; then case-insensitive word-boundary matches of pool artifact
 * names/aliases, longest spelling first. Each artifact is detected at most
 * once; phantoms (unresolved tokens) are skipped — they are to-dos, never
 * artifacts. Resolution uses NO moduleId: briefs are campaign-level prose and
 * module-tier shadowing must not redirect detection. Capped at
 * `GROUNDING_MAX_DETECTED_ENTITIES` — token-resolved entities rank first,
 * then word matches.
 *
 * Matches CONSUME their span (15 §3.1): every occurrence a matched spelling
 * covers — a literal token or a longer name/alias match — is claimed, and a
 * later (shorter) spelling can no longer match inside a claimed span. One
 * occurrence therefore detects exactly ONE artifact, the longest match:
 * "the Ember Council convenes" grounds the Council, never a second 'Ember'
 * artifact hiding inside it. Rank order stays longest-first; the cap counts
 * artifacts, not spans.
 */
export function detectCampaignEntities(
  brief: string,
  pool: readonly AnyArtifact[],
): AnyArtifact[] {
  const detected: AnyArtifact[] = [];
  const seen = new Set<string>();
  // The brief with every CLAIMED span blanked (same length, so match indices
  // stay the brief's): phase 1 claims each literal token's whole span; the
  // word phase below claims the span of every occurrence a matched spelling
  // covers.
  let remaining = blankSpans(brief, WIKI_LINK_PATTERN);

  // 1. Literal wiki-link tokens, in brief order.
  for (const link of extractWikiLinks(brief)) {
    const artifact = resolveWikiLink(link.name, pool).artifact;
    if (artifact === undefined) continue; // phantom — skipped by definition
    if (seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    detected.push(artifact);
    if (detected.length >= GROUNDING_MAX_DETECTED_ENTITIES) return detected;
  }

  // 2. Word-boundary name/alias matches, longest spelling first, over the
  // brief's unconsumed prose: spans claimed by the literal tokens above (a
  // token grounds its ONE resolution, never a second same-named artifact
  // behind it) and spans claimed by longer matches below are blanked, so a
  // shorter spelling can never detect inside them — the longest match
  // consumes the span. One spelling per lowercase form per artifact (the
  // longest wins) so "The Alchemist" beats its own partial overlap
  // "Alchemist".
  const spellings: { artifact: AnyArtifact; name: string }[] = [];
  for (const artifact of pool) {
    const forms = new Map<string, string>();
    for (const candidate of [artifact.name, ...artifact.aliases]) {
      const name = candidate.trim();
      const key = name.toLowerCase();
      if (key === '') continue;
      const existing = forms.get(key);
      if (existing === undefined || name.length > existing.length) forms.set(key, name);
    }
    for (const name of forms.values()) spellings.push({ artifact, name });
  }
  spellings.sort(
    (a, b) =>
      b.name.length - a.name.length ||
      a.name.localeCompare(b.name) ||
      a.artifact.id.localeCompare(b.artifact.id),
  );
  for (const { artifact, name } of spellings) {
    if (seen.has(artifact.id)) continue;
    const pattern = wordBoundaryPattern(name);
    // Free occurrences first: one match claims the spelling, and every
    // occurrence found is blanked in the same pass — claiming IS the match,
    // so shorter spellings can never overlap a consumed span.
    const occurrences = [...remaining.matchAll(pattern)];
    if (occurrences.length === 0) continue;
    remaining = blankSpans(remaining, pattern);
    seen.add(artifact.id);
    detected.push(artifact);
    if (detected.length >= GROUNDING_MAX_DETECTED_ENTITIES) return detected;
  }
  return detected;
}

/** A case-insensitive, word-boundary-anchored global matcher for `name`.
 * Boundaries are Unicode-aware letters/numbers (names are prose, not ASCII):
 * "Grix" matches in "Grix's" but not inside "Grixstone". */
function wordBoundaryPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Blanks every match of `pattern` with same-length spaces: claimed text can
 * no longer match, but string indices stay the original's. */
function blankSpans(text: string, pattern: RegExp): string {
  return text.replace(pattern, (whole) => ' '.repeat(whole.length));
}

/** Per-module adjacency of the derived graph: moduleId → (node key → weight).
 * `buildWikiGraph` emits one edge per (module, node) pair; the map makes
 * co-mention lookups single-pass. */
function coMentionIndex(graph: WikiGraph): Map<Id, Map<string, number>> {
  const byModule = new Map<Id, Map<string, number>>();
  for (const edge of graph.edges) {
    let targets = byModule.get(edge.moduleId);
    if (targets === undefined) {
      targets = new Map<string, number>();
      byModule.set(edge.moduleId, targets);
    }
    targets.set(edge.to, (targets.get(edge.to) ?? 0) + edge.weight);
  }
  return byModule;
}

/**
 * The detected entity's top-1 co-mention (15 §3.2, decision 1): the other
 * graph node sharing a module hub with it, ranked by summed shared-edge
 * weight desc, then node label, then key — the derivation's own tie-break
 * convention (wikiGraph.ts:202-209). Self is excluded; curated relations and
 * transitive expansion are not part of the ratified signal.
 */
function topCoMentionNode(
  byModule: ReadonlyMap<Id, ReadonlyMap<string, number>>,
  nodesByKey: ReadonlyMap<string, WikiGraphNode>,
  nodeKey: string,
): WikiGraphNode | undefined {
  const shared = new Map<string, number>();
  for (const targets of byModule.values()) {
    if (!targets.has(nodeKey)) continue;
    for (const [other, weight] of targets) {
      if (other === nodeKey) continue;
      shared.set(other, (shared.get(other) ?? 0) + weight);
    }
  }
  const candidates = [...shared.entries()].flatMap(([key, weight]) => {
    const node = nodesByKey.get(key);
    return node === undefined ? [] : [{ node, weight }];
  });
  candidates.sort(
    (a, b) =>
      b.weight - a.weight ||
      wikiGraphNodeLabel(a.node).localeCompare(wikiGraphNodeLabel(b.node)) ||
      a.node.key.localeCompare(b.node.key),
  );
  return candidates[0]?.node;
}

/** The self block of one detected entity (decision 3: self + top-1 each).
 * Module-mentioned entity → its top-mention document's excerpt; never
 * mentioned in prose → its own artifact summary (§2.4), which is real
 * campaign data, not a placeholder — an entity with neither mention nor
 * summary yields NO block (nothing to ground, not an error). */
function selfBlock(
  artifact: AnyArtifact,
  node: WikiGraphNode | undefined,
  moduleById: ReadonlyMap<Id, Module>,
): ExpansionExcerpt | null {
  if (node !== undefined) return moduleExcerptBlock(node, moduleById);
  const summary = artifact.summary.trim();
  if (summary === '') return null;
  return {
    entityName: artifact.name,
    source: GROUNDING_SUMMARY_SOURCE,
    text: capExcerpt(summary),
  };
}

/** One module-backed block: the node's top-mention document, excerpted via
 * `surroundingParagraphs` (≤ 600 chars) with the provenance line
 * `<Module Title> — <Premise|Part N>`. A mention exists by construction
 * (`mentionsByDocument`); every impossible miss throws loudly (the
 * mentionView convention, 14 §2) — never a placeholder. */
function moduleExcerptBlock(
  node: WikiGraphNode,
  moduleById: ReadonlyMap<Id, Module>,
): ExpansionExcerpt {
  const mention = topMention(node);
  const module = moduleById.get(mention.moduleId);
  if (module === undefined) {
    throw new Error(
      `campaign grounding: the mention of "${wikiGraphNodeLabel(node)}" references module ${mention.moduleId}, which is not among the campaign's modules`,
    );
  }
  const markdown = documentMarkdown(module, mention.where);
  if (markdown === null) {
    throw new Error(
      `campaign grounding: the mention of "${wikiGraphNodeLabel(node)}" references ${mention.where} of module "${module.title}", which does not exist`,
    );
  }
  return {
    entityName: wikiGraphNodeLabel(node),
    source: `${module.title} — ${whereLabel(mention.where)}`,
    text: excerptForNames(markdown, node.names, wikiGraphNodeLabel(node)),
    moduleId: module.id,
    where: mention.where,
  };
}

/** The node's hottest document: highest mention count, ties resolved by
 * document order (the derivation's insertion order — premise before parts,
 * modules by title). Deterministic. */
function topMention(node: WikiGraphNode): WikiGraphMention {
  const first = node.mentionsByDocument[0];
  if (first === undefined) {
    throw new Error(`campaign grounding: graph node "${node.key}" has no mentions`);
  }
  let top = first;
  for (const mention of node.mentionsByDocument) {
    if (mention.count > top.count) top = mention;
  }
  return top;
}

/** The module document a `where` convention points at, or null when it does
 * not exist (the loud-error branch separates "missing" from "empty text"). */
function documentMarkdown(module: Module, where: string): string | null {
  if (where === 'premise') return module.spine === null ? null : module.spine.premise;
  const match = /^part-(\d+)$/.exec(where);
  if (match === null) return null;
  const part = module.parts.find((candidate) => candidate.planIndex === Number(match[1]));
  return part === undefined ? null : part.markdown;
}

/** The mentionView convention (14 §2): 'premise' → "Premise",
 * 'part-<planIndex>' → "Part N" (planIndex + 1 — the reader's numbering). */
function whereLabel(where: string): string {
  if (where === 'premise') return 'Premise';
  const match = /^part-(\d+)$/.exec(where);
  return match !== null ? `Part ${String(Number(match[1]) + 1)}` : where;
}

/** The excerpt text for a node's document: the first spelling that matches a
 * paragraph (alias-written mentions), else the remaining names. All-empty is
 * impossible by construction — a mention exists — and throws loudly. */
function excerptForNames(markdown: string, names: readonly string[], entityName: string): string {
  for (const name of names) {
    const excerpt = surroundingParagraphs(markdown, name, GROUNDING_EXCERPT_CAP);
    if (excerpt !== '') return excerpt;
  }
  throw new Error(
    `campaign grounding: no paragraph of the mentioned document names "${entityName}", although the wiki-graph recorded a mention — refusing to ground from nothing`,
  );
}

/** The uniform per-block text cap (§3.4: 600 chars each). */
function capExcerpt(text: string): string {
  return text.length > GROUNDING_EXCERPT_CAP
    ? `${text.slice(0, GROUNDING_EXCERPT_CAP)}…`
    : text;
}

/** One block's rendered form — shared by the budget measure and the prompt
 * renderer so stored blocks and rendered prompts can never diverge. */
export function renderExpansionBlock(excerpt: ExpansionExcerpt): string {
  return `- ${excerpt.entityName} (${excerpt.source}):\n${excerpt.text}`;
}

/** Renders the whole section from stored blocks — byte-identical across
 * pause/resume because the blocks are the persisted ones. */
export function renderCampaignGroundingSection(excerpts: readonly ExpansionExcerpt[]): string {
  return [GROUNDING_SECTION_HEADER, ...excerpts.map(renderExpansionBlock)].join('\n\n');
}

/**
 * The ratified global budget (§3.4, D3): blocks render in the documented
 * order (per detected entity: self, then its top co-mention; entities in
 * detection order) until the 4000-char section budget would overflow; the
 * overflowing block is truncated into the remaining room (with an ellipsis)
 * and rendering stops. Deterministic: same inputs → same section.
 */
function applyBudget(blocks: readonly ExpansionExcerpt[]): ExpansionExcerpt[] {
  const kept: ExpansionExcerpt[] = [];
  let used = GROUNDING_SECTION_HEADER.length;
  for (const block of blocks) {
    const rendered = renderExpansionBlock(block);
    const room = GROUNDING_SECTION_BUDGET - used - 2; // the '\n\n' separator
    if (room <= 0) break;
    if (rendered.length <= room) {
      kept.push(block);
      used += rendered.length + 2;
      continue;
    }
    // Overflow: truncate this block into the remaining room, then stop.
    const prefixLength = `- ${block.entityName} (${block.source}):\n`.length;
    const maxText = room - prefixLength;
    if (maxText <= 0) break;
    kept.push({
      ...block,
      text:
        block.text.length <= maxText ? block.text : `${block.text.slice(0, maxText - 1)}…`,
    });
    break;
  }
  return kept;
}

/**
 * Read-time source validation (§3.7, impossible-miss rule): every stored
 * module-backed excerpt must still reference an existing module document.
 * The excerpt TEXT is rendered from storage verbatim (no re-derivation, no
 * prompt drift), but a source that vanished mid-run is a loud error — never
 * a silent skip or placeholder. Summary-backed blocks carry no reference.
 */
export function validateExpansionSources(
  excerpts: readonly ExpansionExcerpt[],
  modules: readonly Module[],
): void {
  if (excerpts.length === 0) return;
  const byId = new Map(modules.map((module) => [module.id, module]));
  for (const excerpt of excerpts) {
    if (excerpt.moduleId === undefined) continue;
    const module = byId.get(excerpt.moduleId);
    if (module === undefined) {
      throw new Error(
        `campaign grounding: the stored excerpt for "${excerpt.entityName}" references module ${excerpt.moduleId}, which no longer exists — regenerate the retrieve step`,
      );
    }
    if (documentMarkdown(module, excerpt.where ?? '') === null) {
      throw new Error(
        `campaign grounding: the stored excerpt for "${excerpt.entityName}" references ${excerpt.where} of module "${module.title}", which no longer exists — regenerate the retrieve step`,
      );
    }
  }
}
