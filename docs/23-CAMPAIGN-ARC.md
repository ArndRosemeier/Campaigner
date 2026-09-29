**BUILD STATE (2026-09-29, docs/17 row 398).** New campaign has an inline name field beside it (placeholder 'New campaign'; empty = placeholder); Enter submits; rename via EditCampaignDialog.

**BUILD STATE (2026-09-29, docs/17 row 397).** The generation dialog's images are PER KIND: `Settings.generationImageKinds` (remembered preference, default none) feeds `selectGenerationTargets({..., imageKinds})`; the `image` pseudo-kind is gone.

# 23 — The campaign arc: ONE document, levels found by the separator

**Status: OWNER-RATIFIED 2026-09-28.** This spec is the contract the arc's slices are briefed from.
It replaces the "module = premise + parts" storage model and the many-modules-per-campaign rule.

**BUILD STATE (docs/17 row 396). ADVISORS LANDED** — adversarial critique inside the canvas chat: lenses are data (`domain/advisors.ADVISOR_LENSES`), each advisor is a separate model call that sees the document (or a level range) and the chat prose but never the command syntax, its answer is a persisted ADVISOR CARD (`moduleChatMessage.advisor`, additive, no DB bump) with Approve (sends the attributed critique through the existing send) / Dismiss. Explicit trigger only.

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

**BUILD STATE (2026-09-28, docs/17 row 385). PHASE 1c IS COMPLETE — SOURCE AND PINS.** The 59 red pins row 384 left are migrated as claims about the document (fixtures compose `assembleModuleDocument`/`moduleDocumentFromView`, assertions parse `moduleDocumentSections` with the level-0 index shift, targets are named `Level N`, an empty level fills by its own separator line), and the whole suite is GREEN in-turn (`tests/llm` 1422; `tests/features` 790 + 813; the rest of the tree 2064). The migration also surfaced and fixed THREE defects the source-only slice could not see: a document whose last level is empty ended on a bare separator (so text written there glued onto it — the formatter now terminates that line), the per-part save's artifact-promotion hook was lost (the document write promotes the changed level texts now), and the chat applier's plan titles were shifted by one level (level 0 is the premise). Two SEMANTIC claims were rewritten to the model's truth and one REVERSED, each stated in its pin: a version whose saved document no longer parses, or is a LEGACY `'parts-document'` row, is refused by name; and a version predating the `premise` field now restores the premise anyway, because the document carries it. **THE FRONTIER IS NOT ENTERED:** `lib/modulePdf` still calls the legacy `==========` seam (phase 1d/1e), and the version row's premise-twice debt stands (docs/18 §5). Original landing record, kept for the design: **PHASE 1c — THE CANVAS, THE CHAT AND THE SAVE PATH SPEAK THE DOCUMENT.** The canvas editor's doc IS the module document (level 0 = the premise, then `=====Level N=====` sections): `moduleDocumentFromView` is the ONE view→text composition (shared with the row write), the canvas page and the preview parse through `moduleDocumentSections`, `moduleRepo.saveModuleDocument` is THE one document write (atomic — the per-part save and its `failedParts` report are gone), and a durable version now stores the STORED document bytes tagged `documentFormat: 'module-document'` (a legacy `'parts-document'` entry is REFUSED on restore, because it would otherwise be misread as one giant premise). The chat's context is the WHOLE document, premise included — the premise is a level like any other, so the ordinary `<edit>` path edits it, and the empty-level fill anchors on the level's own separator line now that the label line is gone. A module with a premise and no level sections IS chattable (`NO_DOCUMENT_MESSAGE` replaces `NO_PARTS_MESSAGE`; the condition is the document's — **SUPERSEDED BY docs/17 row 390: that refusal and its constant are DELETED, because an EMPTY document is now the chat's starting state**). **THE LEGACY `==========` FORMAT IS NOT RETIRED:** `lib/modulePdf` still assembles/splits it (the phase 1d/1e frontier), so `domain/modulePartsDocument.ts` stays with its pins. **WHAT IS NOT DONE:** the generation dialog (phase 4) and the level-addressed chat commands (row 381) are untouched, pass 0 still authors a plan, and the reader/PDF/board (1d/1e) do not speak the document yet.

**BUILD STATE (2026-09-28, docs/17 row 381). PHASE 3 IS ENTERED — THE CHAT'S COMMAND VOCABULARY SPEAKS LEVELS, AND
THE PREMISE NEEDS NO COMMAND OF ITS OWN.** The owner's two level-addressed commands are LANDED in the ONE chat
vocabulary (`src/llm/canvasChat.ts` + `src/features/modules/canvas/chatApply.ts`):
`<replace_level level="N"><replace>…</replace></replace_level>` replaces level N's whole text, and
`<append_level level="N"><replace>…</replace></append_level>` appends to it — **CREATING level N through the app's own
formatter when N is exactly `max + 1`** (on a document with no level sections, `max` is 0, so the first
`append_level level="1"` creates level 1). **The TARGET IS THE LEVEL NUMBER (§2.1), so level 0 IS the premise and the
SAME commands edit it: there is deliberately no `replace_premise`, and `replace_level level="0"` is the premise's own
edit path.** **The APP writes the canonical separator and the level number**, so the model never emits the scaffold —
the refinement the owner approved, and what makes a broken format structurally impossible on this path. The applier
CALLS the §4 level-addressed seam (`replaceLevelText`/`appendLevelText`) rather than re-implementing the edit, the
`max + 1` rule or the separator-lookalike refusal; a refused target (out of range, or a numbering jump) is a LOUD
failed outcome card carrying the seam's own named reason with the document byte-identical, and the other commands in
the same reply still apply (per-command loudness, the semantics a non-matching `<edit>` already has). `levelMin`/
`levelMax` are unchanged (still stored, still the module's DECLARED range), the plan/state metadata is untouched, and
phase 3's larger half (the chat authoring from NOTHING with no parts precondition, and pass 0's retirement) is NOT
started; the generation dialog (phase 4) is untouched too.
**BUILD STATE (2026-09-28, docs/17 row 386). PHASE 1d LANDED — THE LEGACY FORMAT IS DELETED; ONE FORMAT REMAINS.** The last two callers of the `==========` parts document are gone: the PDF lanes read each level through `domain/moduleDocument.moduleDocumentSectionsFromView(view)` (the view's own document parsed by the ONE parser, so the reader, the canvas and the PDF name a level identically), the reader renders that same derived level list instead of mapping `spine.partPlan`, and `domain/modulePartsDocument.ts` + its re-export + its pins are DELETED. `CampaignExport.modules` now carries the STORED `ModuleRow` (the ONE `document` + the generator's metadata) and `EXPORT_FORMAT_VERSION` moved 3 → 4, so an export→import round trip preserves the document BYTE-IDENTICALLY; the backup already carried the row verbatim and is pinned to keep doing so. **THE PROOF IS A SOURCE SCAN:** `tests/architecture/one-module-document-format.test.ts` requires `modulePartsDocument`, `CANVAS_PARTS_DELIMITER`, `canvasPartLabel`, `splitPartsDocument` and `assembleModulePartsDocument` to appear NOWHERE under `src/` or `tests/` (the pin file is the one named carrier, so the detector is proven non-vacuous). **NO GOLDEN MOVED** — the PDF's rendered bytes are identical, so `pdfLayoutBaseline.json` was NOT regenerated and its "loses not one text run" assertion still binds; the only deliberate format move is the export version literal. **THE DERIVED `spine`/`parts` VIEW ITSELF STAYS** (the generator and the module board still read it — phases 1f/1e), and the premise-twice debt in the version row stands (docs/18 §5). The owed links-hook pin is row 387: `tests/features/canvas-document-promotion.test.ts` drives the REAL save seam (no mock of `promoteSecondModuleUses`) and proves a changed level's new link promotes the other module's artifact, an unchanged level's does not, and nothing moves when nothing changed.

**BUILD STATE (2026-09-28, docs/17 row 388). PHASE 1e LANDED — THE MODULE BOARD IS KEYED BY LEVEL, AND THE
ROW'S STORED SPELLING IS FROZEN BEHIND ONE BOUNDARY.** The board was the last surface still ADDRESSING its cards
by `planIndex`; it now addresses LEVELS — level N as `level-<N>`, the premise as `level-0` — through ONE grammar
(`domain/moduleDocument.boardLevelNodeKey`/`levelFromBoardNodeKey`) beside the ONE level↔planIndex conversion.
**THE SLICE'S FIRST DELIVERABLE WAS THE MEASUREMENT, and it is what made the decision decidable:** every
per-`planIndex` key was inventoried, and the board's ONLY STORED one is the module row's `canvas` field
(`domain/module.ts:1154`), whose node keys an existing board spells `'premise'` / `part-<planIndex>`. Those bytes
are **FROZEN** — `storedCanvasNodeKeyForLevel`/`levelForStoredCanvasNodeKey` are their exact INVERSE, applied at
the board's read boundary (`boardLayout.resolveBoardNodePositions`) and its write boundary
(`BoardPage.persistLayout`), so an existing arranged layout reads exactly as it was left and round-trips
byte-identically: **no converter, no `version` bump, no format change** (migrating those bytes to `level-<N>`
would be a clean-cut format change for the owner to ratify, not an agent call — it was NOT taken). **LEVEL 0 IS
DECIDED AND PINNED:** the premise IS a board card at level 0 and is DELIBERATELY NOT A PART — the `parts` record,
the per-part rewrite flow and the staged rewrites hold levels 1..N only, the same boundary the old model
expressed as `planIndex −1`. The still-`planIndex` seams the board reaches (the derived `spine`/`parts` view, the
engine's `planIndexes` + `part-token` events, the ONE part-text save) are converted at the call through the ONE
pair — a third mapping exists nowhere. The OTHER per-`planIndex` keys the tree still carries
(`entityRewriteProposals[].planIndex`, the chat outcomes' `targetParts[].planIndex`, the stored
`documentPlan`'s `source.planIndex`, the `levelPlans`/`levelStates` array positions, the tree-wide mention
convention and the canvas `?part=` scroll address) are INVENTORIED and NAMED as their own slices
(docs/18 §5), never re-keyed here.

**BUILD STATE (2026-09-28, docs/17 row 389). PHASE 2 IS LANDED — THE MODULE LIST DIES; THE CAMPAIGN LEADS TO ITS ONE
DOCUMENT, AND THE ROW SURVIVES.** The plural concept is gone from the SURFACES without a schema change (the phase-2 column
says "none", and none was taken): `ModulesListPage` and `ROUTES.modules` are DELETED, replaced by `CampaignDocumentPage`
at `/c/:campaignId/document`, which resolves the campaign's single module row (arc-first, `hooks.useModules`) and lands on
its READER — whose table of contents IS the derived level list — or shows the create state when the campaign has no row.
The module ROW survives untouched: artifact ownership by `moduleId`, the chat thread, the versions, and every
module-scoped route (`/m/:moduleId`, `/canvas`, `/board`, `/battle`) are unchanged. **THE SECOND MODULE IS REFUSED
LOUDLY, NOT SILENTLY:** `moduleRepo.createCampaignDocument` is the ONE creation seam (`db/moduleRepo.ts`) — it checks
inside the write transaction and throws `CampaignDocumentExistsError` NAMING the existing document, writing NO row; the
app's single creation path (`llm/moduleGen.createModuleAndRun`) goes through it, the landing is the ONLY mount of
`NewModuleDialog`, and the top-bar "New Module" door became a "Document" LINK. `saveModule`/`createModule` stay the
general upsert on purpose — updates use them, and a test or an IMPORT reproducing a LEGACY multi-module campaign seeds
rows through them. **THE LEGACY MULTI-MODULE CAMPAIGN IS SURFACED, NEVER HIDDEN:** `LegacyModulesNotice` is mounted ONCE
in the campaign bar (every campaign route), names every extra row and LINKS to it (its reader, where the ordinary delete
control now lives — `ModuleDeleteButton`/`ModuleDeleteDialog`, moved from the list row to the reader header). The spec's
route (a) was taken; the `version(33)` clean cut was NOT, because the phase-2 column takes no schema change and the
existing rows are the owner's data. `compareModulesByStartLevel`/`useModules` survive as the display order that picks
the ONE document and orders the extras (and the artifact-scope pickers), and the campaign EXPORT still carries
`ModuleRow[]` (format v4 unchanged — with one row in practice, N for a legacy/imported campaign).

**BUILD STATE (2026-09-28, docs/17 row 390). PHASE 3a IS LANDED — THE CHAT AUTHORS FROM NOTHING, AND PASS 0 IS NO LONGER THE PREMISE'S AUTHOR.** The entry that was missing is real: `llm/moduleGen.startCampaignDocument` is the APP's creation seam (the create dialog calls it and lands on `canvasChatPath` with the chat open) and it writes an **EMPTY** document through the ONE refusing `createCampaignDocument` seam, running NO pass 0 — the generator's entry (`createModuleAndRun`) shares the SAME private row-creation body and keeps pass 0 as the generation path the phase-4 generation dialog will drive. The chat's empty-document pre-flight is **DELETED** (`NO_DOCUMENT_MESSAGE` and its two guards), the `hasDocument` option is gone from `chatTurn`/`chatController`/`snapshotChat`/`ChatSidebar`, and `CanvasPage` opens on an empty document instead of the "no document yet" panel. **A chat-created level's plan metadata is DECIDED AND PINNED: it is NONE** — `moduleRowFromDocument` stores empty `levelPlans` entries, the derived display title is the `Level N` label (never the prose caption line, §2), and a missing title is **not a failure**; `tests/features/canvas-chat-from-nothing.test.ts` pins both directions and the whole flow (the premise lands as level 0, `append_level` makes the app write `=====Level 1=====`, and the document round-trips through save/reload). **The pass-0 spine checkpoint is NARROWED to a row that HAS a pass-0 plan** (`showSpineCheckpoint` now requires `spine.partPlan.length > 0`): a chat-authored premise-only document is the reader, because the checkpoint's "Discard" would otherwise delete the premise the chat just wrote (pinned in `tests/features/module-reader.test.tsx`). The system prompt gained the authoring rule, so `tests/fixtures/gmAssistFraming/module-chat-golden.json` was recaptured through the project's own render path (**32659 → 34543 bytes, +1884**; `system` 9346 → 9955, `payload` 10335 → 10951, `followUp` 12395 → 13011; cause: ONE added prompt line, and the file's three JSON lines are the only changes). **THE FRONTIER IS NAMED, NOT ENTERED:** the generation engine is NOT re-keyed (it still addresses parts by `planIndex` through the derived view) and the dialog's generation-only controls still exist (recorded on the row, used by the generation step); moving them into the phase-4 generation dialog and re-keying the engine to levels are those slices'.

**BUILD STATE (2026-09-28, docs/17 row 391). PHASE 1f IS LANDED — THE GENERATION ENGINE'S UNIT IS THE LEVEL, AND
THE PLANINDEX-KEYED PART SAVE IS DELETED.** The last surface still keyed by `planIndex` on the INSIDE now
addresses a level by its NUMBER through the ONE `levelForPlanIndex`/`planIndexForLevel` pair (never a third
mapping, never arithmetic beside it): `PartsRunOptions.levels`, the `part-token`/`part-thinking` events,
`generatePart`/`rewritePart`/`generateMissingParts`/`repairModuleEncounterFloor` and `FloorRepairOutcome` all
speak levels, and `generateMissingParts` derives its scope from the DOCUMENT. **ITS PROMPTS READ THE LEVEL'S OWN
TEXT**: `levelCall` parses the document once (`moduleLevelSectionsFromView`) and takes the material, the
continuity and the level list from it — the stored `levelPlans` `title`/`synopsis`/`levelUpTrigger` are NO LONGER
READ, because a chat-authored level has none (row 390) and the level's prose is what a generation step is about;
the rules retrieval now searches with the level's own text, and `{{partEndCondition}}` is passed `null` (decision 4
deleted `levelUpTrigger`). **ITS WRITES GO THROUGH THE DOCUMENT SEAM**: `db/moduleRepo.saveModuleLevels` +
`domain/moduleDocument.moduleRowFromLevelWrites` is THE level-addressed write (re-read in the tx, spliced over the
row's own bytes by `replaceLevelText`, run state merged), `db/moduleRepo.patchModulePartText` and
`features/modules/partText.ts` are DELETED, and the reader's hand edit and the board's Apply/Discard write through
`features/modules/levelText.saveModuleLevelText`. **PASS 0 IS NARROWED, NOT DELETED, AND THE CALLER IS NAMED**:
`runSpine`'s only STARTER is `createModuleAndRun`, which no app surface calls (the app's door is
`startCampaignDocument`), while the checkpoint and the reader's retry are RECOVERY for a row that already carries a
pass-0 plan (the checkpoint stays narrowed to `partPlan.length > 0`, row 390) — pinned by
`tests/architecture/pass0-is-narrowed.test.ts`, with the deletion's full pin list named in row 391 as the
remainder. **THE DERIVED `spine`/`parts` VIEW STAYS**: it still has readers everywhere (the reader, the PDF, the
board's card join, the entity panel and batch), so its deletion was 1g's — and row 392 MEASURED it as a second
1b-sized cut (~40 reader sites in ~25 `src/` files) and NAMED it as the remainder instead (the row-392 BUILD STATE
below; the per-file verdicts are in docs/18 §5). **NO FORMAT MOVED** — no `version`
bump, no storage change; the planIndex keys that remain (the stored `entityRewriteProposals`/`targetParts`/
`documentPlan` fields, the mention convention, the canvas `?part=` address, the adversarial pass's target) are
inventoried in `docs/18` §5 and left to their own slices. **THE GOLDENS MOVED, THROUGH THE PROJECT'S OWN RENDER
PATH** (a `CAPTURE_PROMPT_GOLDENS=1` run of the real `runSpine`/`generatePart` against the mocked chat): the seven
`tests/fixtures/promptStyles/*.txt` prompt goldens and
`tests/fixtures/adversarialGeneration/flag-off-transcript.json` — each byte delta and its cause in row 391. Phase
4 (the level-scoped generation dialog and automation off) is untouched and NOT started.
 (1) **A part
does not cover a level RANGE:** `levelBand` is the section's own number, so a module's sections ascend from
1 and "this part covers levels 2–3" is expressed as TWO sections — the 16 behaviour pins that asserted the
deleted range are migrated to the new model, and no live code offers or parses a range any more. (2) **The
document format TRIMS a level body**, so a part's trailing whitespace is not content the row can carry — the
goldens that differed by one trailing space are recaptured. `levelMin`/`levelMax` stay STORED and are NOT
derived: they are the module's DECLARED range and pass 0's own spine prompt reads them BEFORE any section
exists.

**BUILD STATE (2026-09-28, docs/17 row 392). PHASE 1g LANDED — PASS 0 IS DELETED.** The temporary
compatibility layer the storage cut built in 1b is gone from the CODE: the pass-0 entry points
(`runSpine`/`retrySpine`/`approveSpineAndRun`/`discardSpine`/`createModuleAndRun`), the spine prompt
builder and its JSON reply boundary (`spineMessages`, `parseSpine`, `parseSpineEntities`,
`spineReplySchema`), the pass-0-only adversarial premise review, the whole-spine and plan-only row
writes (`saveSpine`/`savePartPlan`), the checkpoint component and the reader's spine
stream/Retry card, and the level-scoped stream store's `null` (spine) key. **THE STORED PLAN
METADATA IS KEPT** (`levelPlans`/`levelStates`), because the inventory shows live readers: display
titles, the PDF's plan appendix, the module plan and the per-level run state/provenance — so there
is NO `version(33)`, and §5's deletion of `synopsis`/`levelUpTrigger`/`themes` stays deferred by
sequencing. **THE DERIVED `spine`/`parts` VIEW STAYS TOO**, and that is a measured verdict: ~40
reader sites in ~25 `src/` files still speak it (the PDF, the wiki graph, the module plan, the
engine, the room budget, the groundings, the entity panel/batch, the reader, the canvas/chat, the
board, quickfind and the module-plan dialog), so its deletion is a second 1b-sized cut, NAMED as the
remainder with the per-file verdicts in docs/18 §5. The surviving app model is the row-390/391 one:
the CHAT authors the document, the engine writes LEVELS, and a legacy row that carries a pass-0 plan
is read (and its missing levels written) rather than approved at a checkpoint.


**BUILD STATE (2026-09-28, docs/17 row 394). PHASE 4 IS LANDED — THE LEVEL-SCOPED GENERATION DIALOG EXISTS, AND EVERY AUTOMATIC GENERATION TRIGGER IS GONE.** The owner's control is built: `features/modules/generation-selection.selectGenerationTargets({ module, artifacts, kinds, levelRange })` is the ONE `(kinds, levelRange) → targets` seam, computed on the DERIVED LEVEL LIST (`domain/moduleDocument.moduleLevelList` — no second derivation, and none of the dialog, the seam or the dispatcher ever calls the parser `splitModuleDocument`; a source pin requires that), and `features/modules/generation-dialog` is the ONE dialog: per-kind checkboxes (npc / location / event / faction / note / encounter / images) plus a level range whose LOW BOUND may be **Premise (no level yet)**, with an **encounter-extras** pair (battlemaps, mob portraits) that is OFF unless ticked. **IT STATES ITS SCOPE BEFORE IT RUNS** — the levels, the kinds and the TARGET COUNT (`selection.totalCount`, the seam's own number: details + images + maps + mob portraits) — and a selection of `WIDE_SELECTION_JOBS` (12) or more asks a second, explicit confirmation carrying the same count. **THE DEDUPE RULE IS VISIBLE:** `duplicates` names every entity several levels mention with its first level and the later ones (*"Kael (Level 1; also Level 2)"*), and a **premise-only entity has NO automatic level** — it is reported in `premiseOnly`, NAMED in the scope statement whether or not it is selected, and selected ONLY by putting the low bound on "Premise (no level yet)", where the engine infers its level. The RUN half (`features/modules/generation-run.runGenerationSelection`) drives the EXISTING engine in the domain's stable kind order (encounters LAST, the fixed-cast pin) through `runEntityBatch`, `useEntityImageQueue`, `useEncounterMapQueue` and `enqueueEncounterPortraitFill`, behind the ONE entity gate (`features/modules/entity-gate`). **AUTOMATISM OFF, inventorial:** the `void runModulePostGeneration` in `llm/moduleGen.generateMissingParts` is DELETED (that seam now writes missing level TEXT and stops); the post-run automatic battlemap and the automatic roster-portrait triggers are DELETED from `features/campaign/post-run-extras` (only a run's OWN ticked `runExtras` survive); the New Module dialog's generation-only controls (the per-kind auto-generate/auto-image grid, "Generate encounter battlemaps", "Generate encounter mob images", "Generate parts without review") are DELETED and the creation payload no longer carries any automation flag — so a module created from now on records an EMPTY `automationIntent` and the old canvas resume control can never appear for it; **the queue pumps and the sweep itself STAY** (they are the engine the dialog drives). The **NAMED REMAINDER** is the old mechanism's USER-INVOKED surfaces (the canvas resume + the entity panel's "Generate everything" + `resume-automation`/`automation-deviation`), a second 1b-sized cut recorded with its reasoning in docs/18 §5. **NO GOLDEN MOVED** (no prompt changed). Pins: `tests/features/generation-selection.test.ts` (11 — the seam, both dedupe directions, the premise arm, the true count), `tests/features/generation-dialog.test.tsx` (5 — the printed count against the seam, the named bucket both ways, the extras off by default, the wide confirmation), `tests/architecture/one-generation-selection.test.ts` (7 — the automatisms absent, ONE seam, ONE derivation, the existing verdicts reused).

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

**AS LANDED (docs/17 row 394), the removal is of the TRIGGERS, not of the engine.** Every AUTOMATIC pass is
gone: the `void` sweep call inside `generateMissingParts`, the post-run automatic battlemap and automatic
roster portraits, the New Module dialog's generation-only controls (so a new module records an EMPTY
`automationIntent`), and `autoApproveSpine`'s control. The sweep itself (`post-generation.runModulePostGeneration`),
its detectors, the three queue PUMPS and the app's USER-INVOKED old surfaces (the canvas "Resume automatic
module creation" and the entity panel's "Generate everything", with `resume-automation`/`automation-deviation`)
SURVIVE, because the dialog's dispatcher drives those same units and the detectors are what its selection seam
reuses. Deleting the user-invoked surfaces and the stored automation fields is a NAMED second cut (docs/18 §5),
not part of this phase.

## 9. Migration — the clean cut (owner-ratified, decision 8)

A new `version(32)` in the established clean-cut style: campaign rows are PURGED, never converted.
The library and settings survive. No converter, no upgrade bodies.

## 10. Phases

| phase | content | schema |
| --- | --- | --- |
| **0** | this spec + the ledger rows that retire the old model | none |
| **1** | THE DOCUMENT IS THE TRUTH: the format + the loud extraction, the derived level list, the canvas editor / chat / reader / PDF speaking one document, the deletes | `version(32)` |
| **2** | ONE MODULE PER CAMPAIGN: the module LIST dies (the row survives as artifact ownership, chat thread and versions); the tree/navigation/list collapse | none |
| **3** | THE CHAT FROM NOTHING: no parts precondition, it authors the premise and the level sections, persists as it goes; moduleGen's pass 0 retires — **3a LANDED (docs/17 row 390)**: the chat authors from an empty document and the app entry runs no pass 0; pass 0 survives as the generator's own entry for phase 4 | none |
| **4** | LEVEL-SCOPED GENERATION + automation off — **LANDED, docs/17 row 394** (the dialog + the selection seam; the automatic triggers are gone, the engine and the user-invoked old surfaces are the named remainder) | none |

Order is the owner's: the chat is the central piece and the dialog is useless without it.

## 11. What does NOT change

The generation engine and the artifact writers; artifact ownership by `moduleId` (deleting the module
entity would touch ownership everywhere for no user gain, so the ROW survives and only the plural
concept dies); the library; the party; the PDF lanes (they re-render from the leveled document); the
chat's threading and persistence.

**BUILD STATE (2026-09-29, docs/17 row 395). THE CAMPAIGN ENTRY IS THE CHAT.** New campaign creates the campaign and its empty document in one click and lands on the canvas chat (no form, no settings, no model call); a campaign without a document is redirected there too; `NewModuleDialog` and its draft are deleted. Generation is only ever the explicit Generate… dialog (row 394) or the new small “Create <name>?” confirm on a not-yet-generated artifact chip. Levels, premise and tone are authored in the chat. Named remainder: no model-proposed campaign name.
