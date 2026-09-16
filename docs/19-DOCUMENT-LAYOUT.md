# docs/19 — The document (layout v2)

The READABLE, SELF-SUFFICIENT document a campaign hands to a person: the module's
own text with the material it refers to close enough to use, as a file that works
without this app.

**Status: design, ratified in conversation with the owner (2026-09-13). Sections
marked OPEN are not decided yet; everything else is binding intent for the slices
that build it. Nothing here is implemented beyond what each section says already
exists.**

**BUILD STATE (kept honest landing by landing — `BUILT` means the definitions and
the pins exist at HEAD, `spec only` means nothing implements it yet):**

| § | state |
|---|---|
| §3 The page (main column + sidebar, flowing sections, typographic tiers) | **BUILT** — docs/17 row 148; a ONE-sided page uses the whole sheet since row 186 |
| §4 Two tiers, locality DERIVED from the first reference | **BUILT** — docs/17 row 148 (the `adjacent` pointer is a sentence in the TEXT column, §5 step 3, since row 186) |
| §5 The overflow ladder (beside → continued → own page), never clip, never shorten | **BUILT** — docs/17 row 148 |
| §9 "no silent fitting" (a promotion, continuation or omission is visible and diagnosable) | **BUILT** — docs/17 row 148 |
| §6 The planner's toolkit (real content through the chat's retrieval seam) | **BUILT** — docs/17 row 169 |
| §7 Navigation (links everywhere, a TOC with page numbers, back-references from every artifact section) | **BUILT** — docs/17 row 151 (bullets 1, 3 and 4) and row 156 (bullet 2: the Contents prints pdfmake's own page numbers, proved by reading the rendered pages back with pdfjs) |
| §8 One press, every export plans | **BUILT** — docs/17 row 139 |
| §10.4 Print refinement / duplex spread pairing | OPEN, deferred (§11 step 6) |
| §10.5 Geometry and detail type sizes are starting points | the BUILT values are listed in docs/17 row 148; they are tuned, not frozen |

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
- The planner (`src/llm/modulePlan.ts`) makes ONE call and — until docs/17 row
  169 — saw each artifact as a single line: id, kind, name and a 160-character
  excerpt, capped after a count it is told about. **Since row 169 that same ONE
  call carries real CONTENT (see §6): the module's own text, the wiki-graph
  links and every row's stored details, under a loud cap.**

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
- **A page is ONE full-width column unless BOTH columns carry real content**
  (docs/17 row 186, the owner: *"Some pages have just a sidebar, nothing else.
  Makes no sense. If there is nothing else, of course the sidebar can use all
  room."* / *"Similar problem with main area. If there IS no sidebar, use all
  room"*). The two-column frame exists only where a reader would see two bars:
  a marker sentence (§5's pointer, a "(continued)" head, the §10.1 link back) is
  NOT companion content — it rides the text column, and a page whose only
  companion content is a marker prints its text at the full content width. A
  page whose main column is empty because a companion continues onto it keeps
  that companion and prints it full width; nothing is dropped to make a page
  nicer (§9).
- **Sections flow.** No page break per section; breaks happen where content or the
  plan demands one (an own-page item, a chapter start).
- Typographic tiers — the conventional repertoire, one treatment each, implemented
  once in the renderer: body 11 pt; **detail 9.5–10 pt** (stat blocks, tables,
  reference boxes); kicker 8 pt for labels; `read-aloud` box; `gm-note` box;
  indented muted `aside`. Smaller type for detail is the standard lever that
  absorbs most of the fit problem — it is why the model does not need to know
  heights.

**BUILT (docs/17 row 148).** The geometry above is what the definitions carry —
`pdfPageModel` converts the millimetres ONCE (56.7 / 294.8 / 170.1 / 17 pt) and
`lib/modulePdf` imports them instead of holding a width of its own, so the
margins a page sets and the column widths it draws cannot drift apart. The detail
tier reaches the sidebar as a pdfmake `fontSize` on the COLUMN, not field by
field, so a stat box prints at 9.5 pt without knowing it. Sections flow: the
`pageBreak` moved off every heading and onto the page node, which is why a
section can now share a page with the one after it.
**One deviation, recorded rather than hidden:** §2 says the renderer places by
*measuring*; the builder is synchronous and definition-only (a two-pass render
would put a clock and a layout pass into a deliberately deterministic export), so
`estimateHeight` is arithmetic over the definition's own text — tuned
deliberately WIDE, so the arithmetic errs toward promotion rather than toward
overflow, and an unknown node contributes ZERO (it can never drop content).

**A markdown TABLE is FLOW content, not a detail tier (docs/17 row 157).** §3's
parenthetical above lists "tables" among the 9.5–10 pt detail treatments, and
that means the renderer's REFERENCE boxes (stat boxes, roster tables, the
read-aloud box) — boxes the renderer PLACES in a column. A table the author
wrote in the module's own prose is not one of those: it is the prose, so it
prints at the AMBIENT tier, where the text carries it — body 11 pt in the main
column, and 9.5 pt when the block it belongs to sits in a sidebar, because the
detail size is applied to the COLUMN and reached through pdfmake's own style
stack. It is measured by the same `estimateHeight` — a `table` node's layout
paddings are READ, which is why a markdown table's layout is written as an
object of functions rather than one of pdfmake's layout names — so the fit rule
sees it and may MOVE the block that carries it, never clip it. Whether a wide
table still READS well in a 104 mm column is §10.5's tuning question, and the
owner's to judge in a real PDF.

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

**BUILT (docs/17 row 148), and the OPEN question above is now ANSWERED BY THE
OWNER: such an artifact is DROPPED.** Recorded exactly, because it is a real
choice and not a spec default: it is dropped from the printed document, it is NOT
scattered to the back (§4 forbids that), and §9 binds the other direction — the
document states the omission on its own page and the export's `problems` names
the same site. Two limits belong with the answer: it applies to the PLANNED
document only (the procedural outline has no plan record to attribute an omission
to, so it still prints every row it scopes), and the plan's own validator already
refuses a section naming a row the module neither owns nor mentions — so the case
that can reach the renderer is an OWNED row the prose never names.

## 5. Overflow: never clip, never shorten

Deterministic step-down, in this order, with every step VISIBLE in the document:

1. fits the sidebar → `beside`;
2. does not fit → continues on the NEXT page's sidebar, marked "(continued)";
3. still oversized → promoted to its own page(s) directly after its referring text
   (§4), marked in the TEXT column where the space ran out (docs/17 row 186 — a
   marker sentence never owns a sidebar and never forms a page: the pointer is
   dropped rather than printed alone on an otherwise empty sheet).

**BUILT (docs/17 row 148), all three steps.** Step 2 arms the continuation
BEFORE the page closes, because closing the page is what opens the next one — a
companion that outgrows one sidebar opens the next page's sidebar with the
"(continued)" head. Step 3 leaves the pointer sentence where the space ran out
and prints the artifact full width on the page that follows. The ladder is a
PURE function of `(kind, hasImage, height)`, so the same input always places the
same way, and it is pinned both as that function and as the definition a real
module produces.

**AMENDED by docs/17 row 186 (the owner's own reading of an exported PDF).** The
pointer sentence and the two other marker sentences are not companion content:
they ride the TEXT column, a page whose sidebar would hold nothing but a marker
renders as ONE full-width column, and a page whose whole content would be marker
sentences is dropped rather than printed — the artifact's own page follows
immediately, so the announcement would be pure waste. The marker/real question
is answered in ONE place (`lib/pdfPageModel.isMarkerContent`, the brand its
`marker()` constructor stamps), so neither the paginator nor
`lib/modulePdf.pageNodes` ever matches a sentence's prose.

The owner's decision, recorded: **no model-authored summaries or condensation.**
The content is verbatim by contract ("the app prints the module's own text and the
named row's own text, verbatim"), and the reason is the owner's: a summarized stat
block is silently wrong. Revisit only if we must, as a deliberate decision — not
as a renderer convenience.

## 6. The model's toolkit (owner's direction: tools, not constraints)

**BUILT (docs/17 row 169) — the planner's blindness named in §1 is CLOSED.**
The planner still makes ONE strict JSON-contract call (no agentic loop, no
second call, no height-measuring capability — the "not required" verdict below
stands), but that call now carries real CONTENT instead of one line per row:

- **The module's own text, all of it** — through the shared reader
  (`domain/moduleDocumentText`: premise + every part).
- **Each row's real stored details** — through the CANVAS CHAT's own renderer
  (`canvasChat.renderStoredArtifactSection` → `artifactDetailLines` /
  `renderArtifactDetails`, the same rendering its `<request>` answer uses), so a
  planner row sees the same bytes the chat would answer with. An encounter's
  roster and treasure ride that same renderer.
- **What the module links to** — through the ONE graph derivation
  (`domain/wikiGraph.buildWikiGraph`), per document (premise and each part),
  never a second resolver.
- **A hard content cap with a LOUD marker** (`MODULE_PLAN_CONTENT_BUDGET_CHARS`,
  the chat's own `[TRUNCATED — …]` / `[BLOCK FULL — …]` shape): nothing is
  trimmed silently, and a row that stores nothing is named as such rather than
  dropped.

- **Today:** one call, no tools, one-line artifact excerpts (§1). **Superseded by
  row 169** — the call still has no tools, but it is no longer blind.
- **A measure capability** (hand the planner content, get back its rendered
  height) would let a plan predict its own fit. It is NOT required: the renderer
  owns fit (§2, §5). Worth having only if real plans start fighting the page.
  **Still not built, deliberately.**

The plan stays a validated, stored artifact; the contract, its validation, its
one write and its renderer are untouched. **Honest limit, recorded rather than
hidden:** the cap applies to the COMBINED content (module text → links → row
details, in that priority order), so a module whose own text exceeds the cap is
included CUT — loudly — and the row details past the cap are left out — also
loudly. The planner judges the document's head and whatever details fit, never a
silently shortened set. The measured prompt cost is recorded in docs/17 row 169.

## 7. Navigation (the main consumption is a screen)

- Every reference in the text is an internal link to the thing it names (exists for
  wiki-links; extend to every reference).
- A TOC with page numbers (the `chapters` TOC exists, and since docs/17 row 156 it
  prints them — see the notes below).
- Every artifact section states where it is referenced from.
- The audience split stays: one plan, and a full / GM / player document from it.

**BUILT (docs/17 row 151), except the second bullet.** Every `[[wiki-link]]` of
the module's own text — the premise, every part, every artifact body — is an
internal link to where that row prints, through ONE hook
(`mdToPdfmake.MdRenderOptions.destinationFor`) fed by the reader's own resolver,
so the PDF and the app's chips cannot name different rows. Every artifact
section states where it is referred to from: one line, `Referenced from: <place>
· <place>`, appended to the section's own main column, each place an internal
link to where it prints — and a row the document's own text never names states
nothing, because there is nothing to state. The audience split is unchanged, and
every link is checked to name a destination the same document actually carries
(pdfmake throws on a dangling one). **The second bullet is built too (docs/17
row 156), and this paragraph's earlier claim that "the `chapters` TOC prints
without them" was WRONG** — it was never checked against a page, and it was
never true: pdfmake resolves the numbers itself while it lays the document out
(`{ toc: { id: 'chapters', … } }` plus `tocItem: 'chapters'` on every heading),
so the builder never needs to know a page. Row 156 rendered the document,
read every page back with pdfjs, and pinned the number the Contents prints
against the page each section's heading actually prints on — 21 + 7 + 7
sections, all equal. Two structural notes come with it: the Contents page is a
page the paginator measures and emits like every other page (it used to be two
loose nodes with a `pageBreak`, i.e. a page outside §3's page model), and every
ToC entry links through the section heading's own `id` — the SAME identity the
paragraph above describes — so §7 has one link rule, not two.

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
- **No unlabelled or merged treasure.** The back matter's treasure ledger names
  the carrier of every line it prints: the encounter itself for its own
  `treasure` field, and `<encounter> · <mob> ×count` for what one of its roster
  entries carries (docs/17 row 159). A mob that carries nothing contributes no
  line and no row at all — never a label over a blank value — and the ledger is
  GM-only back matter, like every secret the player document strips.
- No second canvas entry point in the reader header (row 138) and no second
  mechanism for one idea anywhere (AGENTS rule 4).

## 10. OPEN — decisions the owner still holds

**The owner answered 1–4 while the page model landed (docs/17 row 148); the
answers are HIS, and where an answer differs from the proposal below it is his
call, not a spec default.** No question in this section is still open.

1. **Does the sidebar repeat?** — **ONCE, with a link back.** (His answer matches
   the proposal. The link back is the §5 pointer sentence.) **BUILT, docs/17 row
   151 — with one recorded deviation:** §5's pointer sentence says the detail
   *follows on the next page*, which is false for a back-reference, so the link
   back is a new sentence through the SAME marker seam ("The details of “X” print
   earlier in this document.") rather than a sentence that lies about where the
   content is. The rule fires at the one place a repeated companion is emitted (a
   plan may name one row twice), and it is per DOCUMENT: nothing about it is
   stored.
2. **May the plan omit?** — **NO: the document is COMPLETE.** Nothing the plan
   places is dropped for space; the audience split remains the only thing that
   removes material from a document. Proposal: complete.
3. **An artifact referenced nowhere:** — **DROPPED, not printed where the plan
   puts it** — a DEPARTURE from the proposal ("prints where the plan puts it or
   is not printed at all"), and the reason the §4 BUILT note above spells out its
   two limits. §9's rule is what keeps the answer safe: an omission is visible on
   the page and diagnosable in the export's `problems`, never silent.
4. **Print refinement (duplex spread pairing):** — **DEFERRED.** Not implemented,
   not attempted here (§11 step 6). The page model is page-level by design so
   that pairing can be added on top later without rebuilding the paginator.
5. Geometry (§3) and detail type sizes are starting points to be tuned against real
   modules, not fixed values. — **Still true, and the values in use are recorded
   in docs/17 row 148** so a tuning pass has one place to change them.

## 11. Build order (each slice: pins, an injection proof, docs — as always)

1. **Automatic planning on export** (in flight): one press, always plans, stored as
   a record.
2. ~~**The planner's toolkit:** real content through the chat's retrieval seam, so
   placement judgement has something to judge.~~ **DONE** (docs/17 row 169).
3. ~~**The page model:** flowing sections, main column + sidebar, detail tiers.~~
   **DONE** (docs/17 row 148).
4. ~~**Adjacency and overflow:** own-page insertion after the first reference, the
   step-down ladder, continuation markers.~~ **DONE** (docs/17 row 148 — it
   landed with 3, because a placement rule with no paginator has nowhere to put
   its answer).
5. ~~**Navigation:** back-references from artifact sections, links everywhere.~~
   **DONE** (docs/17 row 151) — **and §7 is COMPLETE**: its second bullet, the
   TOC's page numbers, landed as its own slice (docs/17 row 156), proved on the
   rendered page. Everything §7 asks for now exists.
6. **Print refinement** (OPEN, §10). **Untouched by docs/17 row 186** — that slice
   changed a page's own SHAPE (one full-width column unless both columns carry
   real content) and not the page-level model this deferral rests on, so §10.4's
   statement that pairing can be added on top later is still true.
