# 14 — Mentions panel & link-health report (backlinks + orphans)

A link-graph audit found that **nothing computes "what points at this
entity"**: renamed, adopted or deleted entities have invisible inbound
wiki-links until each module is opened one by one, and there is no
cross-module surface listing unresolved mentions or never-mentioned
artifacts. This spec adds the two missing surfaces. Both **consume**
`src/domain/wikiGraph.ts` (13-WIKI-GRAPH) — the pure derivation the Graph
page already uses — rather than forking a second extractor.

Terminology follows the glossary in `00-OVERVIEW.md §Global conventions`
and is used precisely: **wiki-link** (the `[[Name]]` token), **mention**
(one occurrence), **relation** (the hand-curated `artifacts.links` edge),
**alias** (an alternate name wiki-links resolve against), **phantom** (an
unresolved wiki-link name — never an artifact). User-facing copy says
**Mentions** / **Mentioned in**, never "backlinks" — that word lives in
this spec's file name only.

## 1. Binding decisions (product owner, verbatim)

1. **Mentions panel** on the entity detail surface: lists every mention of
   this entity across all modules — per document (module title,
   premise/part location, mention count), alias-only matches included,
   deep-linking each entry to the reader location. Wiki-link mentions
   ONLY — the curated hand-made relations stay in the entity's Relations
   section; do not mix the two graphs in one list.
2. **Link-health report on the Graph page**: a collapsible list section fed
   by the same derivation, honoring the page's current module/kind
   filters, with two sub-lists: (a) **Unresolved mentions** — phantom
   names grouped by name with per-document counts, each linking to the
   first reader location (the adopt/stub flow lives there); (b)
   **Never-mentioned artifacts** — resolved entities with zero inbound
   mentions in the filtered scope, linking to entity detail (candidates
   for deletion or for wiring into prose). Both capped with visible
   truncation notes (propose caps, spec documents them).
3. **Consume, don't fork**: use `buildWikiGraph` as-is where possible;
   extend the module ONLY via additive, tested output fields if genuinely
   needed (it stays pure, deterministic, and all 13 existing derivation
   tests keep passing).
4. **No persistence, no Dexie changes**; derived at read time, memoized.
5. **No deletion-behavior changes**: `deleteArtifact`'s scrub of
   materialized `links` stays as is — this report surfaces the wiki-link
   aftermath instead of changing cleanup semantics.

## 2. Data flow (consume, don't fork)

- Both consumers call `buildWikiGraph(modules, pool)` — the pure
  derivation of 13 §3 — with the reader's resolution pool: campaign
  artifacts + global library (`5b28bc2`). **No output field was needed**:
  the existing `nodes` / `mentionsByDocument` / `status` shape covers both
  surfaces, so the module is untouched (decision 3).
- One gap versus the Graph page: the derivation's default
  `WIKI_GRAPH_NODE_CAP` (120) could silently hide exactly the node a
  consumer needs — a sparsely-mentioned entity's node behind 120 hotter
  names. Both consumers therefore pass **`cap: Number.POSITIVE_INFINITY`**
  ("uncapped") and apply their own **visible** caps (the report's row
  caps below; the panel needs none). The Infinity behavior is pinned by
  an additive derivation test; nothing else about the derivation changes.
- **Mentions panel**: `graph.nodes.find(node => node.key ===
  artifact.id)` — `mentionsByDocument` is the raw per-document list.
  Module titles come from the same module list the derivation saw, so a
  mention's `moduleId` always resolves there (an impossible miss throws
  loudly instead of rendering a placeholder). The panel takes the pool
  from the editor's `campaignArtifacts` prop (the reader's pool the
  editor already holds — stable while typing, no artifacts-table live
  query re-firing through every autosave) and subscribes only to the
  module list.
- **Report**: unresolved sub-list = `graph.nodes` with `status
  === 'unresolved'` — phantoms are already grouped by name (keyed
  `name:<lowercase>`) with per-document counts; never-mentioned sub-list
  = pool artifacts (kind-filtered) whose id is **not** among the
  derivation's resolved node keys.
- Reader semantics are inherited for free: alias mentions merge into the
  target artifact's node; the same written name resolves per module, so a
  module-tier shadow means another module's prose does **not** count as a
  mention of the same-named campaign row; ambiguous names count for the
  reader's winner only. The graph never claims a resolution the reader
  would not make — neither do these surfaces.
- Derived at read time, memoized (`useMemo` over the live-query inputs);
  nothing persists, no Dexie changes (decision 4).
- Shared display helpers live in `src/features/campaign/mentionView.ts`
  (pure, feature-level — route building stays out of `domain`):
  `whereLabel(where)` renders the `where` convention as "Premise" /
  "Part N" (`planIndex + 1`, the reader's numbering), `mentionRoute`
  builds the reader deep link (`modulePath` + `#part-N` hash for parts),
  and `nodeFirstMentionRoute` deep-links a graph node to its first
  mention — throwing loudly on a mention-less node, which the derivation
  cannot produce.

## 3. Mentions panel (entity detail surface)

**Placement**: the workspace center pane (`ArtifactEditor`) — a read-only
**"Mentioned in"** section directly below the editable **Relations**
section (`LinksSection`). The adjacency makes decision 1's separation
visible: above, the hand-curated relations; below, the derived wiki-link
mentions. Two lists, never mixed. The reader's peek modal (entity card)
stays as-is — the workspace editor is the full detail surface (deep-linked
from the graph, quick-find and the tree); documented in `05-UI.md`.

- Header "Mentioned in" with the total mention count; a muted caption
  states the terms: wiki-link mentions in module prose, derived at read
  time — curated relations stay in the Relations section.
- One row per (module, document) with mentions: module title · Premise /
  Part N · ×count. Each row deep-links to the reader location:
  `modulePath(campaignId, moduleId)` for a premise mention,
  `modulePath(campaignId, moduleId, planIndex)` for a part (the
  `#part-N` hash scrolls the reader).
- A "Mentioned as" line lists every written spelling (`node.names`) when
  more than one — alias-only matches are visible as such.
- An ambiguous winner (node `status === 'ambiguous'`) shows a ⚠ line —
  the chip's tooltip semantics: several artifacts match a resolving
  name; the reader's winner is this one.
- **No cap**: rows are per (module, document) pair — bounded by the
  documents that mention the entity — and decision 1 says *every*
  mention, so the panel truncates nothing.
- Empty state: "No mentions yet — write `[[Name]]` (or one of its
  aliases) in a module's premise or parts."
- Loading: a muted "Loading…" line until the module list resolves.
- Scope: a Library (global) row shows its mentions across the open
  campaign's modules — the panel lives in the campaign workspace.
- Rendered rows are `<Link>`s; navigation targets are the reader and
  nothing else.

## 4. Link-health report (Graph page)

**Placement**: below the graph area, above the legend, as a collapsible
section (shadcn collapsible) — **default collapsed**; the trigger always
shows the live counts ("Link health — 2 unresolved · 3 never mentioned"),
so the report is discoverable while the graph stays the page's primary
content (13 decision 6). The section renders whenever the campaign has at
least one prose mention anywhere (`allGraph.nodes.length > 0`); a
campaign without wiki-links keeps the existing write-`[[wiki-links]]`
empty state.

**Derivation**: the page computes a third memoized `buildWikiGraph` call
with the page's current module/kind filters and `cap:
Number.POSITIVE_INFINITY` — the same derivation, filter-aware, uncapped
so the report's own visible caps are the whole truth (never silently
clipped by the graph's drawing cap).

### Sub-list (a) — Unresolved mentions

- Visible when the kind filter is "All kinds" or "Unresolved (phantoms)".
  Under a resolved kind, phantom names have no kind — the sub-list shows
  a muted note instead ("phantom names have no kind — switch the kind
  filter to All kinds or Unresolved").
- One row per phantom name (already grouped by name by the derivation),
  ranked by mentions desc, then name — the hottest to-do first.
- Row: the name as first written, total ×N, and a muted per-document
  line grouped per module ("Ashen Vault — Premise ×2, Part 1 ×1 · Bell
  Harbor — Part 3 ×1").
- Each row deep-links to the phantom's **first reader location**
  (`nodeFirstMentionRoute`) — the dashed chip and its stub/adopt flow
  live there (13's documented phantom click-through choice).

### Sub-list (b) — Never-mentioned artifacts

- Visible when the kind filter is not "Unresolved (phantoms)". Under that
  filter the sub-list shows a muted note instead (the filter selects
  phantom names, not entities).
- Pool artifacts of the selected kind (all kinds when "All kinds") with
  **zero resolving mentions** in the filtered scope, ranked
  alphabetically. "Zero resolving mentions" is the reader's semantics: a
  name written in prose that resolves elsewhere (module-tier shadow,
  ambiguity loser) is not a mention of this artifact.
- Row: artifact name + kind label, linking to the entity detail route
  (`artifactPath`).
- Module filter semantics: with one module selected, the sub-list lists
  the artifacts that module's prose never mentions (its own included);
  with all modules, the artifacts no module prose mentions.

### Caps and truncation notes (proposed, binding)

Each sub-list renders at most **`LINK_HEALTH_ROW_CAP = 20`** rows. A
truncated sub-list shows a roster-style note, e.g. "Showing 20 of 27
unresolved names (truncated; 7 more)" or "Showing 20 of 34 never-mentioned
entities (truncated; 14 more)". The rankings above make the cut
deterministic.

**Empty states**: "No unresolved mentions — every wiki-link in scope
resolves." / "Every entity in scope is mentioned in module prose."

## 5. Acceptance criteria

- An entity mentioned in several modules (premise and parts) lists one
  row per document with module title, Premise/Part N and ×count; each
  row opens the reader at that location (`#part-N` for parts).
- Alias-only mentions appear on the entity's panel (merged by the
  derivation) and the "Mentioned as" line names the spellings.
- A module-tier same-named artifact in another module does not inflate
  the panel — only mentions that resolve to the entity count.
- The panel sits below Relations, is wiki-link-only, and shows the empty
  state for an unmentioned entity; a Library row shows the open
  campaign's mentions.
- The Graph page shows the collapsible link-health section with live
  trigger counts; expanding shows both sub-lists honoring the current
  module/kind filters (including the two muted kind notes).
- Unresolved rows group phantom names with per-document counts and deep-
  link to the first reader location; never-mentioned rows link to the
  entity detail route.
- Both sub-lists cap at 20 rows with visible truncation notes; rankings
  are deterministic.
- No prose mentions anywhere → the section does not render (the write-
  `[[wiki-links]]` empty state covers the page).
- `buildWikiGraph` is unchanged: all 13 existing derivation tests pass;
  the uncapped `cap: Number.POSITIVE_INFINITY` behavior is pinned by an
  additional test.
- Gates green: lint (no new warnings), typecheck, full test suite.

## 6. Non-goals

- **No persistence, no Dexie changes** (decision 4) — derived at read
  time, memoized; no schema, export or import changes.
- **No retrieval changes** — the derivation never feeds retrieval;
  graph-aware retrieval is separately queued (spec-first).
- **No cross-module continuity checking** — the docs 08 non-goal stands.
- **No deletion-behavior changes** (decision 5): `deleteArtifact`'s scrub
  of materialized `links` stays as is; the report surfaces the wiki-link
  aftermath (phantoms, never-mentioned rows) instead of changing cleanup
  semantics.
- **No quickfind alias support, no materialized-relations backlinks** —
  the Relations section and quick-find behave exactly as before.
- **No changes to `buildWikiGraph`** — no output-field extension was
  needed (decision 3); the module keeps its 13 pinned tests.
