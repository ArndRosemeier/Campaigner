# 23 — The campaign arc: ONE document, levels found by the separator

**Status: OWNER-RATIFIED 2026-09-28.** This spec is the contract the arc's slices are briefed from.
It replaces the "module = premise + parts" storage model and the many-modules-per-campaign rule.

**BUILD STATE (2026-09-28, docs/17 row 380).** **PHASE 1 IS SPLIT.** **Phase 1a — the FORMAT
CONTRACT — is LANDED**: §2's level-0 model, §3's loud extraction, §4's derived level list and the
level-addressed edits §4 names are implemented and pinned in `src/domain/moduleDocument.ts`
(`tests/domain/moduleDocument.test.ts`, 33 pins). **The `version(32)` STORAGE CUT is NOT in phase 1a**
and is re-briefed as its OWN slices: deleting `spine.premise` / `spine.partPlan[]` / `parts[]` /
`themes` / the per-part `synopsis` + `levelUpTrigger` / the stored `levelMin`+`levelMax`, together with
every compile-forced surface, follows 1a. The measured compile-forced surface is 67 files under `src/`
and 147 under `tests/`, and `tsconfig.app.json` typechecks `tests/`, which is why it does not fit one
landing; `docs/18` §5 carries the census and the reasoning. Phases 2–4 are untouched.

**BUILD STATE (2026-09-28, docs/17 row 382). PHASE 1b — the `version(32)` STORAGE CUT — IS LANDED**
(owner decision after the row-382 measurement; `docs/17` row 382 has the full record). **The row stores the
TEXT truth plus the GENERATOR'S STATE, and they are different things.** STORED: the ONE `document`, plus
what the text cannot carry — `themes`, the per-level plan `levelPlans[]` (`title`/`synopsis`/
`levelUpTrigger`), the per-level run state `levelStates[]` (`status`/`errorMessage`/`edited`/
`writerModel`/`origin`) and the premise's own provenance (`premiseWriterModel`/`premiseOrigin`). DERIVED at
read time: `spine.premise` ← level 0, `parts[].markdown` ← the level sections' text, `levelBand` ← the
level's own NUMBER, and `spine` is `null` iff the document is empty. **No character of the TEXT is stored
twice**; the metadata is the generator's working state and **DIES with 1f/phase 3**, when the chat authors
the document and the plan stops existing — the spec's deletions of `themes` / `partPlan[]` /
`synopsis` / `levelUpTrigger` / `parts[]` are therefore **DEFERRED BY SEQUENCING, NOT REVERSED**. The
document's caption line under a separator is PROSE: it is never read, never compared, never a value
(§2 — the title is flavor; reading prose for a value is AGENTS rule 5's forbidden pattern), so the plan
title has exactly ONE path and the legacy `==========` labels still match it.

**BUILD STATE (2026-09-28, docs/17 row 383). PHASE 1b IS GREEN — every red it left is closed, and the
deleted capability is gone from the CODE, not only from the tests.** The 22 gate-red pins in 8 files (the
integrated gate's own list, which named two files the 1b writer had missed) were migrated to the ratified
model — the level is the SECTION'S own number, and an entity's level is the FIRST section that mentions it —
with **no assertion deleted or weakened**. `roomBudget.partLevelMentionFor` now returns the mentioning
section's number (`moduleDocument.levelForPlanIndex(planIndex)`) instead of parsing the derived `levelBand`,
and pass 0's prompt no longer OFFERS a merge between adjacent levels (a merge cannot be represented: the
plan's length IS the section count). The nine prompt goldens — three trailing-space and six carrying the
removed offer, the recorded spine message inside the adversarial transcript among them — were recaptured
through the project's own render path, with the byte delta and cause named in row 383, and the `pdfLayout`
content-preservation baseline moved by two band labels per large document (a 1:1 replacement, so its counts
are unchanged and the "loses not one text run" loss assertion was not weakened).

**BUILD STATE (2026-09-28, docs/17 row 385). PHASE 1c IS COMPLETE — SOURCE AND PINS.** The 59 red pins row 384 left are migrated as claims about the document (fixtures compose `assembleModuleDocument`/`moduleDocumentFromView`, assertions parse `moduleDocumentSections` with the level-0 index shift, targets are named `Level N`, an empty level fills by its own separator line), and the whole suite is GREEN in-turn (`tests/llm` 1422; `tests/features` 790 + 813; the rest of the tree 2064). The migration also surfaced and fixed THREE defects the source-only slice could not see: a document whose last level is empty ended on a bare separator (so text written there glued onto it — the formatter now terminates that line), the per-part save's artifact-promotion hook was lost (the document write promotes the changed level texts now), and the chat applier's plan titles were shifted by one level (level 0 is the premise). Two SEMANTIC claims were rewritten to the model's truth and one REVERSED, each stated in its pin: a version whose saved document no longer parses, or is a LEGACY `'parts-document'` row, is refused by name; and a version predating the `premise` field now restores the premise anyway, because the document carries it. **THE FRONTIER IS NOT ENTERED:** `lib/modulePdf` still calls the legacy `==========` seam (phase 1d/1e), and the version row's premise-twice debt stands (docs/18 §5). Original landing record, kept for the design: **PHASE 1c — THE CANVAS, THE CHAT AND THE SAVE PATH SPEAK THE DOCUMENT.** The canvas editor's doc IS the module document (level 0 = the premise, then `=====Level N=====` sections): `moduleDocumentFromView` is the ONE view→text composition (shared with the row write), the canvas page and the preview parse through `moduleDocumentSections`, `moduleRepo.saveModuleDocument` is THE one document write (atomic — the per-part save and its `failedParts` report are gone), and a durable version now stores the STORED document bytes tagged `documentFormat: 'module-document'` (a legacy `'parts-document'` entry is REFUSED on restore, because it would otherwise be misread as one giant premise). The chat's context is the WHOLE document, premise included — the premise is a level like any other, so the ordinary `<edit>` path edits it, and the empty-level fill anchors on the level's own separator line now that the label line is gone. A module with a premise and no level sections IS chattable (`NO_DOCUMENT_MESSAGE` replaces `NO_PARTS_MESSAGE`; the condition is the document's). **THE LEGACY `==========` FORMAT IS NOT RETIRED:** `lib/modulePdf` still assembles/splits it (the phase 1d/1e frontier), so `domain/modulePartsDocument.ts` stays with its pins. **WHAT IS NOT DONE:** the generation dialog (phase 4) and the level-addressed chat commands (row 381) are untouched, pass 0 still authors a plan, and the reader/PDF/board (1d/1e) do not speak the document yet.

**THE TWO COSTS OF THIS MODEL, AFTER ROW 383 (`docs/18` §5, `.gate-logs/row382-blocked.md`).** (1) **A part
does not cover a level RANGE:** `levelBand` is the section's own number, so a module's sections ascend from
1 and "this part covers levels 2–3" is expressed as TWO sections — the 16 behaviour pins that asserted the
deleted range are migrated to the new model, and no live code offers or parses a range any more. (2) **The
document format TRIMS a level body**, so a part's trailing whitespace is not content the row can carry — the
goldens that differed by one trailing space are recaptured. `levelMin`/`levelMax` stay STORED and are NOT
derived: they are the module's DECLARED range and pass 0's own spine prompt reads them BEFORE any section
exists.

## 1. The owner's decisions (verbatim substance)

> "One canvas chat that starts with nothing and ends with the campaign premise and produces module
> levels inside the canvas, as one big document. … The chat needs to have the WHOLE campaign inside
> and modules can be extracted using the separators."

1. **Text is the truth.** One big text; the premise is everything before the first level separator.
2. **The separator is `=====Level 1=====`** (a shape that worked in an earlier app of his).
3. **No auto-repair. Fail loudly.**
4. **Themes, per-part synopsis and `levelUpTrigger` are DELETED** — generation helps, replaced by the
   chat.
5. **The level title is flavor, nothing enforced** — it "can be an optional hint".
6. **"The important thing is to find the levels."**
7. **The chat is the central piece; the generation dialog cannot do anything without it — CHAT FIRST.**
8. **Losing the stored campaigns is no big deal** → the clean cut is ratified.
9. **An entity named in several levels is generated at the FIRST level it is mentioned**, and
   **needs a level HINT if it is meant to be higher — or it is self-evident** (his example: "head of
   the watch").

## 2. The document format (the APP's format)

```
<the premise: everything before the first separator line>

=====Level 1=====
## The cursed ship
<prose for level 1>

=====Level 2=====
<prose for level 2>
```

- **The format belongs to the app**, exactly as `domain/modulePartsDocument.ts` owns today's
  `==========` and its label. The app's formatter can WRITE the separators; the model writes prose
  and is told to preserve the scaffold; **every read VALIDATES and fails loudly**. This is AGENTS
  rule 5's "paired formatter/parser" carve-out: the app reads back its own format, and never guesses
  at prose.
- **Zero separators is LEGAL** — a premise and no levels yet. That is the "starts with nothing" state,
  and under §2.1 below it is simply "level 0 only".
- **The title line is prose.** The app extracts NO title and stores NO title. Markdown renders a `##`
  line as a heading on its own; a level picker MAY display the section's first line as a CAPTION
  (display only — never a value, never a decision).
- **Level identity is the number in the separator.** Nothing else is load-bearing.

### 2.1 The premise IS level 0 (owner decision, 2026-09-28)

The document is a list of LEVELS, and the premise is the FIRST of them: **level 0**. It is the one level
with **no separator of its own** — it is everything before the first `=====Level 1=====`. Levels 1..N
each begin with their canonical separator line.

Three consequences, and they are why this is the model rather than a naming choice:

- **ONE level-addressed family serves both.** Because the premise HAS a number, every section of the
  document can be addressed the same way — replace a level's content, extend a level's content, append
  the next level — and the premise is simply level 0. Nothing needs a premise-shaped command (there is
  deliberately no `replace_premise`), and nothing needs a second document representation or a second
  parser.
- **"Zero separators" is a legal state, not an error:** it is exactly "level 0 only" — the premise and no
  levels yet, which is the state a campaign starts in.
- **A level RANGE is read from where the owner says it starts.** "Levels 1–3" means the sections 1, 2 and
  3, so it excludes the premise by construction; a range whose low bound is 0 includes the premise.

The ENGINE never writes a `=====Level 0=====` line: level 0 has no separator, so a document that carries
one is a near miss and fails the read loudly (§3). The derived level list (§4) includes level 0 like any
other level.

## 3. The extraction contract — LOUD, and never repaired

A read of the document either yields a level list or FAILS with a typed error naming the offending
line. The app never repairs, renumbers, or reinterprets. All of these are ERRORS:

- a separator whose shape is not exactly canonical (see the tolerance below);
- a duplicated level number;
- a gap or a level number out of ascending order;
- **a NEAR-MISS** — a line that looks like a level header but is not canonical. This one matters most:
  it is an error naming that line, **never a silent merge into the previous level**, because a silent
  merge loses a level with no signal.

**The canonical line** is `=====Level ` + N + `=====` where N is a positive integer written without
leading zeros. Tolerance to settle in the slice and pin: trailing whitespace and the line's own
`\r`; nothing else (case is NOT tolerated — the app writes the canonical form, so anything else is a
near-miss and therefore loud).

## 4. What is DERIVED (never stored twice)

The **level list**: for each level — **level 0 (the premise) included**, so a caller can address any
section of the document by number (§2.1) — its number, its section's text range, and the wiki-linked
names it mentions by kind (a wiki-link is the app's own syntax — `[[Name|alias]]`). Plus
`levelMin`/`levelMax`: level 0 always exists, so `levelMin` is 0 for every document, and `levelMax` is
the number of the last level SECTION — 0 when the document is level 0 only. A stored copy of any of
these would be a second truth and is deleted with the old model.

**Level scope falls out of this**: an entity named inside `=====Level 3=====` IS a level-3 entity, and
"levels 1–3" means the wiki-links in sections 1, 2 and 3.

## 5. Deleted by this arc

`spine.themes`, `spine.partPlan[]` (title / `levelBand` / synopsis / `levelUpTrigger`), the per-part
`parts[]` rows, the per-part command mapping by `planIndex`, and the stored `levelMin`/`levelMax`.
`levelUpTrigger` was the "what ends this level / triggers the level-up" note: it fed one prompt line
(`Part ends when: …`) and printed in the PDF; the chat writes that in prose now.

## 6. The entity level rule (owner-ratified)

- **Default:** an entity's level is the **first** level section that mentions it.
- **Override:** an explicit **structured level HINT** on the entity/artifact. The engine already has
  the chain for this (`explicitLevel ?? recordedLevel ?? moduleLevel`, docs/17 row 247) and the
  artifact level plumbing (`partyLevel`, the entity level hint) — the hint rides that, it does not
  invent a parallel one.
- **Self-evident cases** ("head of the watch"): a **MODEL READ** may propose a hint — rule 5's
  sanctioned free-text reader (structured, zod-validated, answering `null` honestly) — and **what it
  read is NAMED on the user-visible surface** so a wrong read is correctable in one step. Never a
  silent guess.

## 7. The generation dialog (built AFTER the chat — decision 7)

ONE seam: `(kinds, levelRange) → targets`, where targets are the wiki-linked names in the selected
levels, filtered by the ticked kinds. Checkboxes per kind (npc / location / event / faction / note /
encounter / images) plus a level range — the owner's own example: *"generate everything but encounters
and images for levels 1-3, although 6 levels are already defined"*. It **states its own scope before it
runs** (levels, kinds, target count) so an empty or surprising selection is visible before any work
starts, and an entity named in several levels is generated ONCE, at its first mention (or at its hint).

## 8. Automation GOES (owner: "No automatism", "I do not need the old generation mechanism")

Removed: the post-generation sweep fired `void` at three sites (`moduleGen.ts:2905,2948,2993` →
`post-generation.ts:243`), post-run extras (`post-run-extras.ts:96`), the three queue pumps
(image/map/portrait), `autoApproveSpine`, and the New Module dialog's per-kind auto-generation
checkboxes. **The engine STAYS** — `runEngine` runs, the artifact writers and the in-place refill are
what produce detail; the dialog drives them.

## 9. Migration — the clean cut (owner-ratified, decision 8)

A new `version(32)` in the established clean-cut style: campaign rows are PURGED, never converted.
The library and settings survive. No converter, no upgrade bodies.

## 10. Phases

| phase | content | schema |
| --- | --- | --- |
| **0** | this spec + the ledger rows that retire the old model | none |
| **1** | THE DOCUMENT IS THE TRUTH: the format + the loud extraction, the derived level list, the canvas editor / chat / reader / PDF speaking one document, the deletes | `version(32)` |
| **2** | ONE MODULE PER CAMPAIGN: the module LIST dies (the row survives as artifact ownership, chat thread and versions); the tree/navigation/list collapse | none |
| **3** | THE CHAT FROM NOTHING: no parts precondition, it authors the premise and the level sections, persists as it goes; moduleGen's pass 0 retires | none |
| **4** | LEVEL-SCOPED GENERATION + automation off | none |

Order is the owner's: the chat is the central piece and the dialog is useless without it.

## 11. What does NOT change

The generation engine and the artifact writers; artifact ownership by `moduleId` (deleting the module
entity would touch ownership everywhere for no user gain, so the ROW survives and only the plural
concept dies); the library; the party; the PDF lanes (they re-render from the leveled document); the
chat's threading and persistence.
