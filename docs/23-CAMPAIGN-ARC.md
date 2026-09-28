# 23 — The campaign arc: ONE document, levels found by the separator

**Status: OWNER-RATIFIED 2026-09-28.** This spec is the contract the arc's slices are briefed from.
It replaces the "module = premise + parts" storage model and the many-modules-per-campaign rule.

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
- **Zero separators is LEGAL** — a premise and no levels yet. That is the "starts with nothing" state.
- **The title line is prose.** The app extracts NO title and stores NO title. Markdown renders a `##`
  line as a heading on its own; a level picker MAY display the section's first line as a CAPTION
  (display only — never a value, never a decision).
- **Level identity is the number in the separator.** Nothing else is load-bearing.

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

The **level list**: for each level, its number, its section's text range, and the wiki-linked names it
mentions by kind (a wiki-link is the app's own syntax — `[[Name|alias]]`). Plus `levelMin`/`levelMax`.
A stored copy of any of these would be a second truth and is deleted with the old model.

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
