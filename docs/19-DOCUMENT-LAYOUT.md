# docs/19 — The document (layout v2)

The READABLE, SELF-SUFFICIENT document a campaign hands to a person: the module's
own text with the material it refers to close enough to use, as a file that works
without this app.

**Status: design, ratified in conversation with the owner (2026-09-13). Sections
marked OPEN are not decided yet; everything else is binding intent for the slices
that build it. Nothing here is implemented beyond what each section says already
exists.**

## 0. The owner's intent, verbatim

> "The pdf export is very basic, i was imagining something a lot more involved and
> practical. What is bad: Texts are just pasted one after the other. Relations are
> not really usable. A GM will need to constantly move around the text. What i
> would love to have: 2 bars everywhere. Main bar, the text. Sidebar, related
> artifacts (encounters are too big for that, they need their own page each).
> Problem: Our artifacts are very extensive compared to the text. So there needs
> to be flexibility what to put where … A good layout is not trivial or formulaic,
> it needs judgement."

> "Screen will be the main thing, oversized artefacts should get extra pages, but
> not at the end… better close to where they are referred to."

> "In reality, i would not want to give the LLM any forced design. Good LLMs are
> much better at those things than i am, the LLM just needs the tools to do the
> job. No guessing, i agree, so the LLM just needs the module text and a way to
> grab the details (can reuse the functionality from chat)."

> "Using different fonts (smaller for details) is actually well established."

> "Not sure about summaries, lets leave that out for now. Summaries can get
> problematic fast when stat blocks get summarized for example."

Uses it must serve (owner, when asked who reads it): **someone who does not use
this app at all**, and **an easy reference while using it**. The first is the
stricter one — a file that a stranger can open and read, on screen or on paper.

## 1. What exists today, and the defect

- The DOCUMENT PLAN (docs/17 row 109, docs/07 §M3-D) — the model authors the plan,
  the renderer authors the pages. Roles (`explanation` / `read-aloud` / `gm-note` /
  `aside`), audience (`all` / `gm` / `player`), section titles, image anchoring.
- The renderer (`src/lib/modulePdf.ts`) prints each planned section in plan order,
  and every non-aside section **breaks the page** → the document reads as a
  sequence of full-page sections, one thing after another.
- Internal links already work for wiki-links in body text (`linkToDestination`),
  a chapter TOC exists, and stat blocks already print in two columns.
- The planner (`src/llm/modulePlan.ts`) makes ONE call with NO tools and sees each
  artifact as a single line: id, kind, name and a 160-character excerpt, capped
  after a count it is told about.

**The defect is therefore twofold and neither half is the model's fault:** the
plan cannot express "these belong together" (its vocabulary has no grouping and no
placement), and the planner cannot judge what it cannot see (one line per
artifact). A linear plan rendered one-section-per-page is exactly the "texts pasted
one after the other" the owner reported.

## 2. The split we keep

**The model decides what belongs with what. The renderer decides where it fits.**

- The model's work: relevance, grouping, order, section titles, role, audience,
  which images print where — judgement, which is what a good model is better at
  than a formula.
- The renderer's work: placement, column shape, type size, page breaks, overflow —
  arithmetic it can verify by measuring, which the model cannot.

This is deliberately NOT a design imposed on the model. The repertoire below is
conventional typography (the owner's own point: small type for detail is
established practice), and the model is never asked to guess a height it cannot
see. Structure remains the interface, not the design: a plan may only NAME things
that exist, and an invalid plan is a loud, named failure (AGENTS rules 1–3).

## 3. The page (screen-first)

- A4 portrait, one page at a time — screen viewers show a single page, so the
  document is built as **page-level main column + sidebar**, NOT as paired duplex
  spreads. (Duplex pairing is a print refinement, see §10.)
- Indicative geometry, to be tuned with real content: 20 mm margins; main column
  ≈ 104 mm; sidebar ≈ 60 mm; gutter 6 mm. The sidebar is the "second bar" the
  owner asked for, full height, and exists on every page that has companions.
- **Sections flow.** No page break per section; breaks happen where content or the
  plan demands one (an own-page item, a chapter start).
- Typographic tiers — the conventional repertoire, one treatment each, implemented
  once in the renderer: body 11 pt; **detail 9.5–10 pt** (stat blocks, tables,
  reference boxes); kicker 8 pt for labels; `read-aloud` box; `gm-note` box;
  indented muted `aside`. Smaller type for detail is the standard lever that
  absorbs most of the fit problem — it is why the model does not need to know
  heights.

## 4. Placement: two tiers, and locality is DERIVED (ratified)

- **`beside`** — a companion (a short artifact body, a stat block, a note) that
  fits the sidebar on a page where its referring text runs.
- **`adjacent`** — an oversized thing (an encounter, an event, a location with
  maps) gets its OWN page(s), inserted immediately AFTER the text that first
  refers to it. Never at the end of the book.

The owner's words make locality a rule, not a preference: "better close to where
they are referred to". Consequences the renderer enforces:

- The placement of an adjacent artifact is **computed from the first reference**
  (`extractWikiLinks` over the planned text), not requested by the plan. A plan
  cannot scatter artifacts to the back, and cannot orphan one.
- Later references become internal links to the artifact's page, and the artifact's
  own pages list where they are referenced from.
- An artifact referenced nowhere either prints where the plan puts it or is not
  printed at all (OPEN, §10) — but it never silently disappears.

## 5. Overflow: never clip, never shorten

Deterministic step-down, in this order, with every step VISIBLE in the document:

1. fits the sidebar → `beside`;
2. does not fit → continues on the NEXT page's sidebar, marked "(continued)";
3. still oversized → promoted to its own page(s) directly after its referring text
   (§4), marked in the sidebar where the space ran out.

The owner's decision, recorded: **no model-authored summaries or condensation.**
The content is verbatim by contract ("the app prints the module's own text and the
named row's own text, verbatim"), and the reason is the owner's: a summarized stat
block is silently wrong. Revisit only if we must, as a deliberate decision — not
as a renderer convenience.

## 6. The model's toolkit (owner's direction: tools, not constraints)

- **Today:** one call, no tools, one-line artifact excerpts (§1).
- **v2:** the planner reads what it needs — the module's own text (all of it, not a
  capped list), an artifact's full content, what a part links to (the wiki graph
  and the recorded relations), the encounter rows. Reuse the chat's retrieval
  capability rather than inventing a second mechanism (AGENTS rule 4).
- A measure capability (hand the planner content, get back its rendered height)
  would let a plan predict its own fit. It is NOT required: the renderer owns fit
  (§2, §5). Worth having only if real plans start fighting the page.
- The plan stays a validated, stored artifact.

## 7. Navigation (the main consumption is a screen)

- Every reference in the text is an internal link to the thing it names (exists for
  wiki-links; extend to every reference).
- A TOC with page numbers (the `chapters` TOC exists).
- Every artifact section states where it is referenced from.
- The audience split stays: one plan, and a full / GM / player document from it.

## 8. The export flow

- **One press.** Exporting plans and renders; there is no separate planning step
  (owner: "Bad design to put one functionality behind 2 buttons that need to be
  pressed sequentially. And i do want to have that automatic").
- **Every export plans** (owner: "I dont think we need a cache. Chances to do 2
  reports on the same module thats unchanged are VERY slim"). A stored plan is the
  RECORD of the last export and the escape hatch that can re-render that exact
  book — never a reason to skip planning.
- **Trade-off, accepted knowingly:** the same unchanged module exported twice
  yields two different documents (fresh model decision each time).
- A planning failure is loud and distinguishable from success (AGENTS rules 1–2).

## 9. What we will NOT do (recorded, so it is not "improved" later by accident)

- No model-authored summaries or condensation of content (§5).
- No appendix relegation of oversized artifacts — adjacency wins (§4).
- No free-form layout markup from the model; the plan is a structure we validate
  and can render identically from a stored value (§2).
- No silent fitting: any promotion, continuation or omission is visible in the
  document and diagnosable afterwards.
- No second canvas entry point in the reader header (row 138) and no second
  mechanism for one idea anywhere (AGENTS rule 4).

## 10. OPEN — decisions the owner still holds

1. **Does the sidebar repeat?** When a long section spans several pages, does a
   companion print once (at first reference, later references link back), or does
   the sidebar repeat it on each page? Proposal: once, with links.
2. **May the plan omit?** Must the document be complete, or may the plan leave
   something out entirely (relying on the audience split for GM/player)? Proposal:
   complete, so nothing is lost by a layout decision.
3. **An artifact referenced nowhere:** printed where the plan puts it, or dropped?
4. **Print refinement:** if the document is ever printed and bound, do we add
   duplex spread pairing (left page text, right page its detail) on top of the
   page model? Only after the screen version works.
5. Geometry (§3) and detail type sizes are starting points to be tuned against real
   modules, not fixed values.

## 11. Build order (each slice: pins, an injection proof, docs — as always)

1. **Automatic planning on export** (in flight): one press, always plans, stored as
   a record.
2. **The planner's toolkit:** real content through the chat's retrieval seam, so
   placement judgement has something to judge.
3. **The page model:** flowing sections, main column + sidebar, detail tiers.
4. **Adjacency and overflow:** own-page insertion after the first reference, the
   step-down ladder, continuation markers.
5. **Navigation:** back-references from artifact sections, links everywhere.
6. **Print refinement** (OPEN, §10).
