# 15 — Graph-aware retrieval (wiki-graph expansion of run grounding)

Retrieval for LLM runs is **text-similarity only**: `retrieveContext` embeds the
brief, `searchRules` ranks rulebook chunks, and the model never learns what the
campaign's own entity graph knows — that the Ashen Vault and the Ashen Cult are
written into the same module prose, that "Grix" is the Alchemist's alias, that
an encounter brief naming one Bestiary-adjacent NPC implies the other entities
that module also mentions. The link-graph audit that produced 13-WIKI-GRAPH
found exactly this gap; 13 §6 explicitly non-goaled it ("No graph-aware
retrieval … queued elsewhere") and 14 §6 re-queued it ("spec-first"). This
document is that spec.

**Status**: ratified. The product owner has ratified the four decision
points of §6 — they are binding, with zero deviation authority; the
mechanism in §3 as shaped by those decisions is the binding design.
Terminology follows `00-OVERVIEW.md §Global conventions` precisely:
**wiki-link**, **mention**, **relation** (`artifacts.links`), **alias**,
**phantom**.

## 1. Motivation

- The grounding query is `"<brief> (<system label>)"` (runEngine.ts:1191) —
  free prose ranked against RuleChunks by MiniSearch + cosine similarity. Two
  briefs naming the same entity can retrieve disjoint excerpts; nothing ties
  the campaign's entities to each other or to their source prose.
- The graph already exists and is cheap: `buildWikiGraph`
  (src/domain/wikiGraph.ts:99) derives the bipartite module→entity mention
  structure (13 §2) deterministically from `modules × pool`, with
  `mentionsByDocument` per node — "the raw material" that 14 already reused.
  Co-mention (two entities mentioned by the same module document) is one map
  lookup away from the stored `edges`.
- The campaigns' lore never reaches general persona runs: the draft prompt
  carries the brief, chain-context artifacts, and **rulebook** excerpts only
  (runEngine.ts:1409-1438). A brief naming `[[Grix]]` grounds in generic
  alchemy rules, never in the module prose that defines who Grix is.
- Encounters are the sharpest case: the encounter brief names rooms, NPCs and
  themes, yet the `brief` step grounds in the same rulebook query plus the
  roster (runEngine.ts:1863-1894).

## 2. Current flow (evidence, as of `2141d69`)

### 2.1 `searchRules` (src/search/search.ts:59-103)

- Options (search.ts:21-45): `bookIds`, `chunkTypes`, `hasStatBlock` (:25-30,
  fix-02 decision 3 — applied to keyword hits :67 AND the semantic candidate
  set :84), `system` (:31-37 — resolves the default book set via
  `readyBookIds` :64/:166-171), `limit` (default 12 :38-39/:60).
- Keyword path: MiniSearch over `text` + `headingJoined`, prefix/fuzzy, 100
  prefilter hits (:54, :67-68). Semantic path (only when
  `settings.embeddingsEnabled && apiKey`): embeds the **candidate set** (whole
  library < 2000 chunks, else the keyword top-100; :78-92), RRF fusion
  `Σ 1/(60 + rank)` (:57, :129-159). Embedding failure → once-per-session
  toast + keyword-only fallback; `searchRules` never rejects for embedding
  reasons (embeddings.ts:51-58; docs/03 §Failure behavior).
- **Query embeddings are uncached** — one request per `searchRules` call
  (docs/03 §Embeddings, "query embedding is requested per search"). Any
  mechanism that adds searches adds latency on the run's critical path.

### 2.2 The retrieve step and its stored output (src/llm/runEngine.ts)

- `retrieveContext` (:1176-1271): general search `limit: 8, system`
  (:1195-1199); pinned chunks merged first (:1200-1201); for
  `producesKind === 'encounter'` a **second search** restricted to citable
  stat blocks — `limit: 6, chunkTypes: ['statblock'], hasStatBlock: true,
  system` (:1212-1218) — plus the pack-roster index (:1229-1232); general hits
  fill the merge to **12 chunks max** (:1234-1237). Excerpt rendering:
  `` `[${title} p.${page}] ${headings}\n${text}` `` joined by blank lines
  (:1244-1250).
- `runRetrieve` persists the selection into the step output (:1273-1293):
  `chunkIds, titles, statblockChunkIds, rosterChunkByName, rosterLines,
  rosterTruncated` — zod-validated on read by `storedRetrieveOutputSchema`
  (:113-119, additive `.default([])` fields), loud error when absent
  (:1295-1310).
- `contextFromRetrieveStep` (:1312-1357) rebuilds the grounding **byte-
  identically** from the stored ids ("same ids, same order, same rendering —
  the valid-mobs pack-roster and citation sections included"), explicitly so
  draft/statblock never re-search. `runDraft` consumes it (:1393-1417);
  `runStatblock` consumes it (:1584-1597); `runEncounterBrief` calls
  `retrieveContext` directly (:1842-1894).
- **This architecture is test-pinned** (tests/llm/runEngine-grounding.test.ts):
  "searches once per run" (:113-141) and pinned-chunks-stay-first (:143-170).
  Any graph-aware mechanism MUST compute inside the retrieve step and persist
  with the stored output — never re-derive at draft time.

### 2.3 `searchRules` consumers today (blast radius)

| Consumer | Call | Graph-aware? |
|---|---|---|
| Persona run grounding | runEngine.ts:1195 (`limit: 8, system`) | **opt-in target** |
| Encounter citable stat blocks | runEngine.ts:1212 (`limit: 6`, statblock+hasStatBlock+system) | frozen (fix-02 contract) |
| Encounter brief step | runEngine.ts:1863 via `retrieveContext` | follows the general path |
| Module-generation post-pass | moduleGen.ts:1060 (`limit: 4`, no system filter) | out of scope v1 |
| Rules browser | search-browser.tsx:54 | never |
| Quickfind | quickfind-dialog.tsx:155 (`limit: 8`) | never (13 §6 keeps quickfind alias support queued separately) |
| Monster-source dialog | monster-source.tsx:248 (`limit: 20`, statblock+hasStatBlock+system) | never |
| Relations editor ("Link dialog") | links-section.tsx:31-47 — no search at all | must NOT change |

### 2.4 What the graph can legitimately offer

- **Detection in the brief** (the query is free prose, runEngine.ts:274):
  (a) literal wiki-link tokens — module-entity briefs already embed module
  prose, wiki tokens intact (wikilinks.ts:229-231; entity-batch.ts:149,
  moduleGen.ts:264/:928), so `[[Name]]` in a brief is realistic and exact;
  (b) name/alias word-boundary matches against a pool. Resolution reuses
  `resolveWikiLink(name, pool)` (wikilinks.ts:120-161). **Pool**: campaign
  artifacts + global library — the reader pool `5b28bc2` conventions that
  `buildWikiGraph` documents as its contract (wikiGraph.ts:92-97; assembled at
  ModuleReaderPage.tsx:192). **moduleId: none** — the brief is campaign-level
  prose, not module text; module-tier tier-0 shadowing (wikilinks.ts:107-111)
  must not redirect detection. Phantoms are skipped (glossary: a phantom is a
  to-do, never an artifact); ambiguous names use the reader's winner
  (wikiGraph.ts:63).
- **Co-mention expansion** (high value, derived): entities mentioned by the
  same module document as a detected entity — directly derivable from
  `buildWikiGraph`'s per-module `edges` (wikiGraph.ts:53-61) +
  `mentionsByDocument` (wikiGraph.ts:45-51). The derivation is deterministic
  (13 §3) and pure.
- **Curated relations**: `artifacts.links` typed edges (artifact.ts:69-70,
  edited in links-section.tsx). High precision — but the 13 audit found the
  materialized relations graph "near-vestigial" (13 intro): low recall, one
  manual editor.
- **Alias expansion**: "Grix" in the brief → entity "The Alchemist" — part of
  detection, not a separate signal (aliases resolve in `resolveWikiLink`,
  wikilinks.ts:129-131).
- **Expansion target** = excerpts ABOUT the expanded entity from campaign
  sources: its top-mention module document (`mentionsByDocument` →
  `surroundingParagraphs`, wikilinks.ts:232-248) and its `summary`. This costs
  **zero network calls** — the alternative (extra `searchRules` per expanded
  entity) buys rulebook chunks at the price of uncached query embeddings
  (§2.1) and a second critical-path search.

## 3. Proposed mechanism (recommendation)

**One sentence**: in the retrieve step only, detect entities in the brief
against the reader pool, expand each through the derived wiki graph
(co-mention), and persist a bounded, deterministic **campaign-grounding
section** with the stored retrieve output so the draft renders it
byte-identically — no new searches, embeddings, or LLM calls.

### 3.1 Detection (deterministic, mechanical — never LLM)

1. Extract wiki-link tokens from the brief (`WIKI_LINK_PATTERN`,
   wikilinks.ts:12) and resolve each via `resolveWikiLink(name, pool)` — pool
   = campaign + globals, **no moduleId** (§2.4). Resolved entities only.
2. Then match pool artifact `name`s and `alias`es case-insensitively at word
   boundaries in the brief; longest name first so "The Alchemist" beats a
   partial overlap; each artifact detected at most once; phantoms skipped.
   A match consumes its span: a word-phase match inside the span of an
   already-matched spelling — a literal wiki-link token or a longer
   name/alias match — detects nothing, so one occurrence grounds exactly one
   (longest) artifact.
3. Rank: token-resolved first (brief order), then word matches (longest
   first); cap at **≤ 3 detected entities**.
4. Chain-context artifacts (`contextArtifactIds`, runEngine.ts:291-301) are
   already injected verbatim — detection runs on the brief text only.

### 3.2 Expansion (recommendation: co-mention only)

- Build the graph once: `buildWikiGraph(modules, pool, { cap: Infinity })`
  with `modules = listModulesByCampaign(campaign.id)` (moduleRepo.ts:30) —
  consume, don't fork (the 14 §2 precedent). Empty module set or zero
  detections → empty section (not an error).
- For each detected entity: its co-mentioned entities are the other node keys
  sharing a module hub (`edges` of wikiGraph.ts:53-61), ranked by shared-edge
  `weight` desc, then label, then key — the derivation's own tie-break
  convention (wikiGraph.ts:202-209). Take the **top 1** per detected entity.
- Self is excluded; curated `artifacts.links` expansion is decision point D1
  (recommended out for v1); transitive expansion is rejected (noise).

### 3.3 Excerpt shape and hook point (determinism strategy)

- Per expanded entity ONE block: a provenance line
  (`Module Title — Part N` / artifact summary) + `surroundingParagraphs`
  of its top-mention document capped at **600 chars** (tighter than the
  helper's 1200 default), trying the node's first-seen spelling then remaining
  names (alias-written mentions). A mention exists by construction
  (`mentionsByDocument`); the impossible empty case throws loudly — the
  mentionView convention (14 §2), per AGENTS rule 1.
- Computed **entirely inside `retrieveContext`** and persisted on the retrieve
  step output as additive zod fields with defaults (the
  storedRetrieveOutputSchema pattern, runEngine.ts:113-119):
  `expansionExcerpts: z.array(z.object({ entityName, source, text })).default([])`.
- `contextFromRetrieveStep` returns them on `RetrieveContext`; `runDraft`
  renders the stored blocks verbatim — nothing re-derives at draft time, so
  pause/resume and mid-run edits cannot drift the prompt (runEngine.ts:1312-
  1322 rationale). `runStatblock` does **not** render the section: statblock
  filling grounds in rules, not campaign lore (its prompt is rules-only today,
  runEngine.ts:1587-1597).

### 3.4 Prompt placement and budgets

- Rendered in `runDraft` (and, if D2 opts encounters in, `runEncounterBrief`)
  after the Task line and before `Rule excerpts`, labeled with its derived
  provenance — e.g. `Campaign grounding (derived from wiki-links):` — so the
  brief itself is never modified or drowned: the section is additive, capped,
  and comes after the task.
- Proposed caps (ratify in D3): ≤ 3 detected entities × (self + 1 co-mention)
  = **≤ 6 blocks**, 600 chars each, **global section budget 4000 chars**
  (≈ 1k tokens — today's 12 rulebook chunks dominate the prompt; this is a
  ~5-10% increase, bounded and deterministic: overflow truncates the last
  block and stops).

### 3.5 System-filter interaction

Expansion adds **campaign-side** excerpts only. It never calls `searchRules`,
so the `system` scoping of the citable pool (search.ts:31-37, runEngine.ts:
1192-1198) and the hasStatBlock candidate filter (search.ts:84) are untouched
by construction. If a future decision ever adds rulebook searches for
expanded entities, those calls MUST pass `system: input.campaign.system` —
recorded here as a binding constraint on any such extension.

### 3.6 Opt-in per consumer (recommendation)

| Consumer | v1 behavior |
|---|---|
| General persona runs (incl. writers'-room chain steps, chainRunner.ts:280) | render the section |
| Encounter runs — `brief` step | render (D2); citable stat-block search + roster byte-identical |
| `statblock` step | never renders the section |
| Module-generation post-pass (moduleGen.ts:1060) | out of scope v1 |
| Rules browser, quickfind, monster-source, relations editor | untouched (no persona run) |
| Review mode `gather`/`check` (runEngine.ts:1655-1696) | untouched (no retrieval) |

### 3.7 Failure behavior

No silent fallbacks (AGENTS rule 1): repo reads failing inside the retrieve
step fail the run loudly; a stored excerpt referencing a since-deleted
module/part throws on read (impossible-miss rule) — and that read-time source
validation runs UNCONDITIONALLY: stored reference fields are data-at-rest
integrity, validated even when the toggle is OFF, so a vanished module fails
the run loudly regardless of `wikiGroundingEnabled`; an empty graph, no
detections, or a budget truncation are legitimate deterministic outcomes, not
errors. The section is derived — no persistence beyond the run-step output
that already exists (no Dexie change).

## 4. Acceptance criteria

- A brief containing `[[Grix]]` (or the bare alias "Grix") where Grix is
  mentioned in module prose produces a campaign-grounding section in the draft
  prompt containing Grix's own excerpt **and** the top co-mentioned entity's
  excerpt from the same module document.
- A campaign with no modules or no wiki-links produces **no** section and
  prompts byte-identical to today — `runEngine-grounding.test.ts` passes
  unchanged (searchRules still called exactly once per run, :125; pinned
  chunks first, :161-168).
- The expansion is computed in the retrieve step and persisted: the retrieve
  step output carries `expansionExcerpts` (zod-validated, default `[]` for
  pre-existing runs), and the draft renders the stored blocks byte-identically
  after pause/resume — no re-derivation, no second build of the graph.
- Budget: with many detected entities and hot co-mentions, the rendered
  section never exceeds the entity cap, per-block cap or global char budget;
  ranking and truncation are deterministic (same inputs → same section).
- Encounter runs: the citable stat-block search, hasStatBlock filtering and
  pack-roster sections are byte-identical (fix-02 tests green); no rulebook
  chunk is ever added by expansion; the statblock step's prompt contains no
  expansion text.
- Untouched surfaces verified: Rules browser, quickfind, monster-source
  dialog, relations editor (LinksSection), Mentions panel, link-health
  report, and `buildWikiGraph` itself (all 14 derivation tests in
  tests/domain/wikiGraph.test.ts pass unchanged).
- A stored excerpt whose source module/part vanished mid-run fails loudly on
  read (no placeholder text, no silent skip).
- Gates green: lint (no new warnings), typecheck, full test suite.

## 5. Non-goals

- **No changes to `searchRules`, the keyword index or embeddings** — 03 stays
  as-is; expansion adds no search, no query embedding, no LLM call.
- **No retrieval-side changes** for the rules browser, quickfind (alias
  support stays queued separately, 13 §6), monster-source dialog, module
  generation, or the relations editor.
- **No persistence / no Dexie changes** — expansion rides the existing
  run-step output; no schema, export or import changes.
- **No artifact-body wiki-links** — the derivation's prose scope stays
  `spine.premise` + `parts[].markdown` (13 §6); bodies remain a possible
  follow-up there, not here.
- **No LLM-based entity detection** — detection is mechanical matching;
  entity normalization (fix-01) remains the only LLM naming path.
- **No transitive expansion, no graph writes, no phantom resolution** —
  phantoms stay the campaign's to-do list.
- **No cross-module continuity checking** — the 08 non-goal stands.

## 6. Decision points — ratified by the product owner

**Ratified (product owner) — the following four decisions are BINDING, with
zero deviation authority:**

1. **Expansion signal: co-mention only** — no curated `artifacts.links`, no
   transitive expansion (D1 = a).
2. **Encounter flow: general grounding only** — the encounter brief step
   renders the campaign-grounding section; the fix-02 citable stat-block
   search and pack roster stay byte-identical (frozen contract) (D2 = a).
3. **Budget: moderate** — ≤ 3 detected entities, self + top-1 co-mention
   each (≤ 6 blocks), 4000-char global budget, deterministic truncation
   (D3 = b).
4. **Rollout: global settings toggle, default ON** — mirroring the
   `embeddingsEnabled` precedent, zero schema change (D4 = b).

The original decision analysis is retained below for the record.

Each is genuinely consequential; the mechanism above is neutral to the choice
in every row. The ratification above turned §3 into the binding design.

**D1 — Which expansion signal(s)?**
- (a) **Co-mention only** (recommended): the derived graph's real signal;
  `mentionsByDocument`/`edges` already exist and are deterministic.
- (b) Co-mention + curated `artifacts.links`: adds high-precision edges, but
  the audit found materialized relations near-vestigial — near-zero recall
  gain for a second expansion path to test. **Recommendation: (a).**

**D2 — Does the encounter flow participate?**
- (a) **General grounding only** (recommended): the encounter `brief` step
  renders the section; the citable stat-block search (`limit: 6`,
  hasStatBlock) and roster stay byte-identical — the fix-02 contract is
  frozen.
- (b) Encounter excluded entirely in v1: smallest blast radius, but the
  encounter brief is the marquee "brief names entities" case.
- (c) Also expand the citable pool: touches the citation-budget math and the
  fix-02 pool the day after its stabilization — reject.
  **Recommendation: (a).**

**D3 — The extra-excerpt budget?**
- (a) Tight: ≤ 2 detected, ≤ 2 blocks, 2000 chars.
- (b) **Moderate: ≤ 3 detected, self + top-1 co-mention each (≤ 6 blocks),
  4000 chars** (recommended — ≈ 1k tokens, ~5-10% over today's grounding).
- (c) Loose: ≤ 6 detected, ≤ 2 co-mentions each, 8000 chars — risks drowning
  the brief in module prose.
  **Recommendation: (b).**

**D4 — Rollout switch?**
- (a) Always on, no setting.
- (b) **Global settings toggle, default ON** (recommended): mirrors the
  `embeddingsEnabled` gate (docs/03 §Embeddings), zero schema change; an
  off-toggle is the escape hatch for wiki-link-sparse or noisy campaigns.
- (c) Per-campaign setting, default OFF: safest rollout but needs a campaign
  field + migration and keeps the feature dark by default.
  **Recommendation: (b).**
