# 13 — The Wiki-Link Graph (Graph page rework)

A link-graph audit found that the Graph page draws only the hand-curated,
materialized `artifacts.links` edges — a near-vestigial data source with one
manual editor (the artifact card's Relations section) and one automatic
writer — while the graph that actually drives entity creation and generation
(**wiki-links** in module prose, resolved at read time) has no visualization
at all. The page even says so in its honest copy: "[[Wiki-links]] in documents
are a separate graph." Decision (product owner): **draw the real graph.**

Terminology follows the glossary in `00-OVERVIEW.md §Global conventions` and
is used precisely throughout: a **wiki-link** is the `[[Name]]` token in
prose; a **mention** is one occurrence of such a token; a **relation** is a
stored typed edge (`artifacts.links`) edited on the artifact card; an
**alias** is an alternate name on an artifact that wiki-links also resolve
against.

## 1. Binding decisions (product owner, verbatim)

1. **Primary content = the derived wiki-link graph**: nodes/edges extracted
   from all module prose (`spine.premise` + `parts[].markdown`) via
   `extractWikiLinks`, resolved with the same pool + module-context
   resolution the reader uses (conventions of `5b28bc2`). Nothing is
   persisted — derived at read time, memoized.
2. **Unresolved names are visible as phantom/dashed nodes** — they are the
   campaign's to-do list, matching the reader's dashed-chip semantics. They
   are not artifacts.
3. **Filters: module (all vs one) and entity kind.** Additional affordances
   (search/highlight) optional if cheap.
4. **Edge weight = mention count** across the filtered scope, visualized
   (thickness or label).
5. **Click-through**: resolved node → the entity's existing detail route;
   phantom node → the stub/adopt affordance (or the module reader location,
   if cheaper — document the choice).
6. **The materialized-relations drawing is replaced as primary content** —
   relations stay fully visible in each entity's Relations section. A mode
   toggle is permitted ONLY if trivially cheap; not required.
7. **Node cap with a visible truncation note** (like the roster's
   "(roster truncated; N more)") — propose the cap, the spec documents it.
8. **Derivation lives in a pure, reusable, testable module**
   (`src/domain/wikiGraph.ts`), separate from the component — a follow-up
   task (backlinks + orphan report) will consume the same module. Design its
   output shape with that consumer in mind (per-node mention lists, per-edge
   module provenance if cheap).
9. The Graph page's honest-copy caption from the terminology pass must be
   updated to describe the new content truthfully.
10. Loud-failure rules apply; no new persistence, no Dexie changes.

## 2. Graph shape (what an edge IS)

Module prose has no single "owning entity", so entity→entity edges would have
to be invented (co-mention heuristics). The graph does not invent anything:
the real, extracted structure is **bipartite — a module's prose mentions
names**:

- **Module hub nodes** — one per module whose prose (in scope) mentions at
  least one name. Label = module title; drawn as a rounded square (muted).
- **Entity nodes** — one per distinct resolution target:
  - *Resolved / ambiguous*: keyed by the winning artifact's `id`. Names that
    resolve to the same artifact (exact name or **alias**, fix-01 variants)
    merge into one node; the label is the artifact's `name`. An ambiguous
    resolution (multiple candidates in the best scope tier) keeps the
    reader's winner and shows the ⚠ in its tooltip, exactly like a chip.
  - *Phantom*: keyed `name:<lowercase name>`, label = the name as first
    written. Dashed circle, muted — the reader's dashed-chip semantics.
- **Edges** — `module hub → entity node`, one per (module, target) pair with
  `weight` = the number of wiki-link tokens mentioning the target in that
  module's prose (`spine.premise` = document `premise`, each part = document
  `part-<planIndex>`; same `where` convention as the entity panel). No
  wiki-link tokens → no edges → no hub (a spineless module contributes
  nothing).

The same written name may resolve differently per module (module-tier tier-0
entities): each resolution target gets its own node, preserving exactly what
the reader shows — the graph never claims a resolution the reader would not
make.

## 3. Derivation module (`src/domain/wikiGraph.ts`, pure)

Pure TypeScript, no IO, no Dexie — importable by the Graph page, the follow-up
backlinks panel and the orphan report. Inputs are the campaign's `Module[]`
and the reader's resolution pool `AnyArtifact[]` = **campaign artifacts +
global library** (the `5b28bc2` reader pool; module text resolves against
globals). Resolution goes through the existing `resolveWikiLink(name, pool,
{ moduleId })` — tier-0 module entities win, then the campaign pool, then
globals; aliases match; within-tier ties break on `updatedAt` desc.

```ts
export interface WikiGraphMention {
  moduleId: Id;
  /** 'premise' or 'part-<planIndex>' — the entity panel's convention. */
  where: string;
  count: number;
}

export interface WikiGraphNode {
  /** Artifact id (resolved/ambiguous) or 'name:<lowercase>' (phantom). */
  key: string;
  /** The wiki-link names that resolve here, first-seen spelling first. */
  names: string[];
  /** The winning artifact; undefined for phantoms. */
  artifact: AnyArtifact | undefined;
  /** Mirrors resolveWikiLink: 'resolved' | 'unresolved' | 'ambiguous'. */
  status: 'resolved' | 'unresolved' | 'ambiguous';
  /** Total wiki-link mentions across the filtered scope. */
  mentions: number;
  /** Per-document mention lists — the backlinks consumer's raw material. */
  mentionsByDocument: WikiGraphMention[];
}

export interface WikiGraphEdge {
  /** Source module hub. */
  moduleId: Id;
  /** Target node key. */
  to: string;
  /** Wiki-link mentions of the target in that module's prose. */
  weight: number;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  /** Modules that actually contribute prose in scope (hub nodes). */
  modules: Module[];
  /** Entity nodes hidden by the cap (visible truncation note). */
  truncated: number;
}

export const WIKI_GRAPH_NODE_CAP = 120;

export type WikiGraphKindFilter = ArtifactKind | 'unresolved';

export interface WikiGraphFilters {
  /** Prose scope: one module, or all (undefined). */
  moduleId?: Id | undefined;
  /** Node scope: one resolved kind, phantoms only, or everything. */
  kind?: WikiGraphKindFilter | undefined;
  /** Entity-node cap; default WIKI_GRAPH_NODE_CAP. */
  cap?: number | undefined;
}

export function buildWikiGraph(
  modules: readonly Module[],
  pool: readonly AnyArtifact[],
  filters: WikiGraphFilters = {},
): WikiGraph;
```

Rules pinned by tests:

- Extraction counts **wiki-link tokens** (`WIKI_LINK_PATTERN`) — every
  `[[Name]]`/`[[Name|display]]` occurrence is one mention; duplicate tokens
  in one document each count (unlike the deduped `extractWikiLinks`, which
  is still used for the name set).
- Resolution happens per module context (`{moduleId: module.id}`), pool =
  campaign + globals; tier-0 module entities beat same-named campaign/global
  rows; globals resolve (the `5b28bc2` regression is pinned here too).
- Filters recompute the scope: a module filter narrows the prose (and drops
  nodes not mentioned there); a kind filter keeps resolved nodes of that
  kind, or phantoms for `'unresolved'`; edges to filtered-out nodes drop, and
  hubs left without edges drop with them.
- Cap: entity nodes (resolved + phantom) ranked by `mentions` desc, then
  name; the rest are dropped and counted in `truncated`. Module hubs are not
  capped (bounded by the campaign's module count); hubs left without edges
  drop. Cap applies after filters — the displayed graph is always ≤ cap
  entity nodes.
- Deterministic: same inputs → same output (node order = first appearance in
  document order; modules sorted by title).

## 4. UI (`GraphPage` rework)

- Layout reuses the `graphLayout` conventions (same row constants and kind
  ordering) via a new pure `layoutWikiGraph` in `src/lib/graphLayout.ts`:
  module hubs in the first row, resolved nodes in kind rows
  (`ARTIFACT_KINDS` order, `pc` first), phantoms in the last row; nodes
  alphabetical within a row; deterministic.
- Header count line: `N entities · M phantoms · K mentions`.
- Filters (top bar): module select ("All modules" + every module that
  contributes prose) and kind select ("All kinds", the seven artifact kinds,
  "Unresolved (phantoms)").
- Edge weight visualized as thickness (`1 + min(weight − 1, 4)`) plus a
  `×N` label when `weight > 1`.
- Click-through:
  - resolved/ambiguous node → `artifactPath(campaignId, artifact.id)` (the
    entity's existing detail route);
  - module hub → `modulePath(campaignId, moduleId)` (the reader);
  - **phantom → the module reader location of its first mention**
    (`modulePath` with the `#part-<planIndex>` deep link; plain reader for a
    premise mention). Documented choice per decision 5: the reader hosts the
    full stub/adopt flow (stub popover with kind classification, verdicts,
    "use existing entity") — reimplementing that on the graph would duplicate
    it, so a phantom click drops the GM exactly where the dashed chip
    already lives.
- Truncation note, roster-style: `Showing X of Y entities (graph truncated;
  Z more)` — rendered whenever `truncated > 0`.
- Honest-copy caption (decision 9): describes the derived wiki-link graph,
  the phantom semantics, and where relations went.
- Legend keeps the kind colors and adds the module hub (square) and phantom
  (dashed) entries.
- Empty state: no module prose mentions any name → prompt to write
  `[[wiki-links]]` in a premise or part. Loading state unchanged.
- No mode toggle (decision 6): the two graphs differ in shape and data
  source, so a toggle is not trivially cheap — relations remain on each
  artifact's Relations section.
- Errors: derivation is pure and total (bad names cannot throw); the page's
  live queries keep their existing loading behavior. No new persistence, no
  Dexie changes (decision 10).

Help topic `graph` (`src/help/helpContent.ts`) is rewritten for the new
content.

## 5. Acceptance criteria

- A campaign whose module prose mentions resolved entities, aliases, global
  library rows and unresolved names renders: kind-colored nodes for resolved
  entities, dashed nodes for phantoms, module hubs with weighted edges.
- Tier-0 resolution: a name that exists both as a module-owned artifact and a
  same-named campaign/global row resolves to the module-owned node (reader
  conventions); a global-library-only name resolves instead of phantomizing.
- Alias mentions merge into the target artifact's node and count toward its
  mentions.
- Module filter shows exactly one hub and its mentions; kind filter narrows
  to one kind (hubs without matching mentions disappear); "Unresolved"
  shows only phantoms.
- Edge thickness/label reflect per-module mention counts; a name mentioned
  twice in a module shows `×2`.
- Clicking a resolved node navigates to the artifact route; clicking a hub
  navigates to the reader; clicking a phantom navigates to the reader part
  of its first mention.
- >120 entity nodes render 120 with the truncation note.
- The old relations-drawing tests are replaced by wiki-graph page tests;
  relations data itself is untouched (Relations section still works).
- Gates green: lint (no new warnings), typecheck, full test suite.

## 6. Non-goals

- **No persistence** — the graph is derived at read time and memoized; no
  new Dexie tables, no schema changes, no export changes.
- **No retrieval changes** — the graph never feeds the retrieval pipeline.
- **No backlinks panel / orphan report** — the next queued task consumes
  `buildWikiGraph` as-is (`mentionsByDocument` is its raw material).
- **No relations-graph mode toggle** — decision 6; the hand-curated
  relations stay on the artifact card's Relations section.
- **No artifact-body wiki-links** — decision 1 scopes the prose to
  `spine.premise` + `parts[].markdown`; bodies are a possible follow-up.
- **No search/highlight affordance** — optional per decision 3, skipped to
  keep the derivation surface minimal.
- **No graph-aware retrieval, no quickfind alias support** — queued
  elsewhere.
