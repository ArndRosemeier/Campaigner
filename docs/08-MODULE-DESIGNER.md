# 08 — Module Designer v2 (Milestone 4)

Replaces the quota-driven Module Forge. Core inversion: **a Module is a
markdown document with wiki-links; structured artifacts are annotations that
hang off it** — not the other way around. Generation is iterative deepening
(spine → parts), sized by the level range, with per-part retry.

Binding conventions from `00-OVERVIEW.md` and `AGENTS.md` apply (no silent
fallbacks; zod at every LLM boundary; failures pause loudly).

Implementation order: M4-A (entity + wiki-links + reader) → M4-B (generator)
→ M4-C (entity workflow) → M4-D (integration & forge retirement).

---

## M4-A — Module entity, wiki-links, reader

### Entity (new Dexie table, one new `db.version(N+1)`)

```ts
interface Module extends BaseEntity {
  campaignId: Id;
  title: string;
  concept: string;              // the user's concept text, kept for regeneration context
  levelMin: number;             // int >= 1
  levelMax: number;             // int >= levelMin
  tone: string;                 // free text, may be ''
  sizeDial: 'sketch' | 'standard' | 'detailed';
  spine: ModuleSpine | null;    // null until pass 0 has run
  parts: ModulePart[];          // embedded; ordered
  status: 'draft' | 'generating' | 'ready' | 'failed';
  errorMessage: string;
  includePriorModules: boolean; // opt-in: prior modules in the generator context
}
interface ModuleSpine {
  premise: string;              // markdown, a few paragraphs
  themes: string[];
  partPlan: PartPlan[];         // approved plan the parts are generated from
}
interface PartPlan {
  title: string;
  levelBand: string;            // e.g. '1', '2–3'
  synopsis: string;             // one paragraph
  levelUpTrigger: string;       // what ends this part / triggers level-up
}
interface ModulePart {
  planIndex: number;            // index into spine.partPlan
  markdown: string;             // the actual module text, with [[wiki-links]]
  status: 'pending' | 'generating' | 'ready' | 'failed';
  errorMessage: string;
}
// table: modules: 'id, campaignId, updatedAt'
```

Repo `moduleRepo.ts`: CRUD + `saveModule` (full-row validate + put; modules
are NOT revisioned — parts are individually regenerable, that is the undo).

### Artifact aliases

`ArtifactBase` gains `aliases: string[]` (upgrade default `[]`). Shown in the
editor header as a chip input next to tags ("also known as").

### Wiki-link syntax & resolution (`/src/lib/wikilinks.ts`, pure)

- Syntax in markdown: `[[Name]]` or `[[Name|display text]]`. LLMs and users
  write names only — **never IDs in the text**.
- `extractWikiLinks(md): { name: string; display: string }[]` (regex
  `/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g`, names trimmed, deduped
  case-insensitively).
- `resolveWikiLink(name, artifacts): Artifact | undefined` — case-insensitive
  match on `name` first, then on any alias. Ambiguity (2+ matches): return the
  first by `updatedAt` desc; the reader marks such chips with a ⚠ tooltip
  listing the candidates.
- Renaming an artifact must offer (dialog): "Add old name as alias" (default
  on) so existing module text keeps resolving. No text rewriting.
- **The Party is invisible to module creation** (owner-ratified, docs/17 row
  69, verbatim: "The creator is referring to players in the party. The party
  should not be visible to module creation."). Every artifact list a
  module-creation step receives — the shared cast block, the "Existing
  campaign entities/artifacts" prompt indexes, the name-classification
  candidate set and the name-resolution sets of the panel, the post-parts
  batches and the stub popover — is the **module-creation pool**: ONE domain
  constant (`MODULE_CREATION_EXCLUDED_KINDS` → `visibleToModuleCreation` /
  `moduleCreationPool`, `src/domain/artifact.ts`, mirroring
  `BULK_REMOVE_EXCLUDED_KINDS`), never a scattered `kind !== 'pc'`. Why: a PC
  is AUTHORED BY THE PLAYERS — feeding `pc` rows in made generated modules
  address the players by name and resolved generated names back onto their
  characters. `resolveWikiLink` itself is UNCHANGED: reading surfaces (the
  reader's chips, the wiki-graph, the module chat grounding) still resolve the
  owner's own prose against the full pool, so a premise that names a party
  member keeps its link. Do not "fix" that back — this rule is about artifact
  visibility to GENERATION, not about censoring the owner's text, and the
  party-derived LEVEL context (`partyLevelLine`) plus the npc-only fixed cast
  stay exactly as they are.

### Reader (`/c/:campaignId/m/:moduleId`, feature `/src/features/modules/`)

The module is **front and center**: a single scrollable document view at the
middle pane's full width (no prose max-width cap; comfortable padding, the
type scale unchanged), large type, parts as chapters (H1 = part title with
level band badge), spine premise as an intro section. The entity rail on the
right is width-bounded (`w-80 shrink-0 min-w-0`) so its batch toolbar wraps
inside instead of sizing the rail and invading the document. Sticky mini-ToC on the left
(part titles, click to scroll) with a **search box on top**: matches are
located in the rendered document; next/previous (and Enter/Shift+Enter)
cycle through them, scrolling the active match into view and flashing a
highlight on its containing block. Edit affordance per part: an ✎ toggle that
swaps that part to the part text editor (`PartTextEditor` in
`src/features/modules/part-text-editor.tsx`) — the shared `MarkdownBody`
textarea plus a find/replace toolbar operating on the draft string: match
count as `active / total`, Enter/Shift+Enter + prev/next navigation (which
moves the draft selection), a case-sensitive toggle (default off, mirroring
the sidebar search), replace-one + replace-all, a WikiMarkdown preview
toggle, and explicit **Save part** / **Cancel**. Blur still saves (a blur
whose focus lands inside the editor toolbar is ignored so finding/replacing
never commits mid-search); every commit flows through `savePartEdit` →
`patchModuleTextPart`, which writes the `parts` array on the MODULE ROW
(part bodies live on the module row — there is no artifact revision for part
markdown) with `status: 'ready'`, `edited: true`, the "Part saved" toast and
the post-save auto-promote scan. `edited: true` is what arms the rewrite
dialog's overwrite warning, so toolbar edits trip the confirm exactly like
blur-saves. Generation semantics (`runParts`/`rewritePart`/
`generateMissingParts`) and the normalization-verdict proposal flow are
untouched by the editor; the reader stays the default view (no routing
change).

**Wiki-link rendering** (extend the existing `markdown-body.tsx` pipeline with
a remark step or pre-tokenizer):
- resolved → solid chip (kind-colored, cover-image micro-thumb when present);
  click opens the **peek modal**;
- unresolved → dashed/muted chip; click opens the **stub popover** (M4-C);
- ambiguous → solid chip with ⚠.

**Peek modal**: a dialog rendering the read-only artifact card (REUSE the
Session-Mode card components — portrait, summary, kind data, stat block).
Esc / click-outside dismisses back to the exact
scroll position. Wiki-links inside the modal body push onto an in-modal
breadcrumb stack (Back button, Esc pops one level). The entity's image
(cover or first gallery image) is shown as a banner above the card — the
full picture, never cropped (`object-contain`); clicking it opens a viewer
that fills the entire screen on a black background (GM-at-the-table use:
biggest possible picture for the players; click anywhere or Esc closes).
Footer: "Open in workspace" (the "Focus in
Play" button was removed — module mode IS the play mode).

The same wiki-link rendering must also apply to artifact `body` markdown
everywhere it is rendered (workspace preview, Play mode) — one shared
component, one behavior.

**Post-save auto-promote (10 D12):** resolution stays pure — render never
changes scopes. After a module text write lands (reader part edit,
entity-panel rewrite-apply + focus change, spine/parts generation saves,
spine approval, stub-popover alias writes), `promoteSecondModuleUses`
scans the saved text and promotes second-module wikilink uses to campaign
level with a loud toast.

**Module cover (cover-generation arc):** the module row carries
`coverImageId` (cover-only; no gallery). The reader header mounts the cover
hero (`ModuleCoverHero`, `useImageUrl` — the same artifact-cover path as the
play cards) with **Generate / Regenerate cover** beside the header actions;
the modules list row mounts the cover thumb (`ModuleCoverThumb`) with a
compact icon-only generate affordance. Generation is the unattended cover
queue (`src/features/covers/cover-image-queue.ts`, n=1, dock progress, loud
per-slot failures): the prompt grounds on title + concept + the full
document text (`moduleDocumentText` — premise + parts), styled by the owning
campaign's system; empty grounding refuses loudly (describe the module
first). Skip-if-imaged for first generation, delete-after-replace for regen
(fresh cover commits first, ONLY the superseded blob is freed — the
preservation rule). The module cover doubles as the module-PDF cover fallback:
a module-seeded deliverable without its own cover borrows the source
module's art on the PDF cover page (session memory, never persisted).

---

## M4-B — Generator: spine → parts

New engine `/src/llm/moduleGen.ts`. Do NOT build this on personas/runEngine —
it is a distinct two-pass flow; reuse only `chat()` from `openrouter.ts`.
Progress/state live on the Module row itself (statuses above), observed via
`useLiveQuery`; streaming tokens via the existing in-memory emitter pattern.

> **Superseded 2026-09 (owner decision, docs/17 row 72):** the conflict-kind
> vocabulary, the encounter `wants` pair and the declared-mix gate described
> below are GONE — §M4-B-1 states what a scene is and what conflict is demanded
> now, and why the mechanism was removed. The encounter FLOOR in this section is
> unchanged, owner-ratified and still binding.

### M4-B-1 — What a scene IS, and what conflict is demanded (supersedes the declaration machinery)

**Retired (docs/17 row 72).** Every encounter record used to carry
`wants: [a, b]` (exactly two mutually exclusive wants) and a `conflictKind`
(combat | hazard | chase | social | puzzle | exploration), and generation gated
the module's DECLARED MIX on them: at least one outright combat, one
hazard-or-chase, one social conflict. The mechanism had no consumer — the only
readers of the two fields were the validators that demanded them and the prompts
that echoed them back. It counted the planner's own claims, so a spine that
declared the right three words passed while shipping any prose at all, and it
was never owner-ratified as a rule. Removed: `ENCOUNTER_CONFLICT_KINDS` /
`EncounterConflictKind`, both record fields, `encounterMixReport` /
`encounterMixMessage` / `assertEncounterMix` and the `>= 1` mix thresholds,
`requireEncounterDeclarations` and the planner's canonical carry-over of the
declarations, the "declares no conflict kind" / "declares N wants" failures, and
every prompt clause about declaring kinds or mix (spine prompt, spine repair,
parts prompt, floor repair, normalization). Stored rows that still carry the two
keys are read through the non-strict schemas, which strip them — no migration
ceremony, the owner's testing-phase stance (docs/17 row 72).

**What a scene is, now stated in the prompts (never gated):**
- An `encounter` is a FIGHT: initiative, a battle map with terrain, a monster
  roster with images. Anything that is not a fight — a negotiation, a hazard, a
  puzzle, an investigation, a ritual, a chase — is an `event`: an illustration,
  and no battle map, no monsters, no roster. The artifact pipeline already
  behaved this way (`post-generation.ts` generates maps and mob portraits only
  for `kind: 'encounter'` artifacts, and offers illustrations per configured
  kind, `event` included); the prompts now say it, and the normalization prompt
  classifies by what the party DOES in the scene, never by how dangerous it
  sounds.

**What conflict is demanded of the SITUATION (prompt discipline):**
- The situation is contested by someone — a faction, an NPC, a predator, a
  rival party, or the place itself — and who carries that conflict may shift as
  the module runs. Not every module has an antagonist; every module has a
  conflict.
- At least two VISIBLE approaches per situation, differing in cost or
  consequence: nothing resolves on a single route, and no part is a passive wait
  for the plot. Two rolls toward the same outcome are one approach.
- The premise states how the situation can resolve, and every part equals what
  the premise promises; a synopsis carries the situation, the actors, the
  stakes and at least one concrete scene (richer synopsis text — no schema
  change).
- Factions carry an order of battle (wants, needs, preferred tactics, fears,
  when it flees) and advance their own plan between parts whether or not the
  party engages; every returnable location carries a line of what has changed.
- An antagonist is visible from the first part — agents, aftereffects,
  evidence — never held back for the finale.
- Resolution shape, stated positively: every conflict ends with someone worse
  off, a cost paid, or a new problem opened — the losing side is bought, beaten
  or outmaneuvered, never talked out of its want; a compromise costs a party
  something it needed; the resolution is built from what the party found and
  did, never revealed as an unearned third option. Satisfaction is rationed to
  the finale, at full price.
- Persistence: what the party defeats, bypasses or changes stays changed and
  stays visible when they return; nobody locates, captures or sets the party
  back by fiat.
- Anti-generic: every encounter and every location carries one concrete
  particular that could not be swapped out unchanged (an opponent the party
  cannot tell apart from the last one is meaningless combat); no NPC ally is
  more intimately bound to the plot than the PCs are; opportunistic threats
  advance or reveal a faction's plan; exploring is never punished as such.
- The user's premise, tone, level range and size are FIXED INPUT: a structural
  requirement is met by changing the structure (the part plan, which faction
  carries the conflict, where it starts), never the premise.
- No ratio demands, ever: no combat/non-combat percentage, no scenes-per-part
  quota, no art-per-page — the same class of error as the retired mix gate.

**Boundary (binding).** Only the FLOOR is machine-checked. "The story is not
kumbaya", "the conflict is interesting", "the clue inference is fair" and "the
pacing works" cannot be validated without a classifier guessing at prose, which
this repo forbids (AGENTS rules 1 and 3). The demands above are prompt
discipline plus the owner's read of the spine checkpoint. A pure check in the
floor's family (for example counting links) may only be PROPOSED, never built
silently.

### M4-B-2 — The scene block is the CLASSIC STYLE's shape (owner decision, docs/17 row 73; styles, row 86)

**This is now ONE option among the module's writing styles, not the only shape
a module can take** (owner decision, docs/17 row 86 — see §Editable prompt
styles below). It remains the shape of the **Classic** built-in, which is the
default and whose bytes are pinned, and everything the rest of this section
says about the block describes what Classic asks for.

**Why.** Every generated scene must arrive as a GM-usable BLOCK. This is the
best-evidenced usability finding in the research behind this arc (multi-source
practitioner consensus: a scene the GM can run from the page, rather than prose
they must re-read and re-organize mid-session). The owner chose the full
per-scene field set over a prose-only instruction (docs/17 row 73).

**Where the text lives.** The labels and the anti-formula demands moved out of
`src/llm/moduleGen.ts` with the style layer: `PART_SCENE_FIELD_LABELS`,
`classicSceneFieldBullets()` and `PART_SCENE_VARIATION_DEMANDS` now live in
`src/llm/promptStyles.ts` and are rendered into the CLASSIC template. That is
also why the Story style has no field list at all: the block is what Classic
says, and a style is free to say something else (row 86) — the Freestyle style
goes further and prescribes no shape of any kind (§Freestyle).

**It is a DOCUMENT-FORMAT convention, not a schema.** The block lives in the
part's markdown, so there is no schema change, no Dexie version, no migration
and no second document format: the part text stays one ordinary markdown
string in the ONE `assembleModulePartsDocument` / `splitPartsDocument` format
(`domain/modulePartsDocument.ts`). Assembly, splitting, the canvas split-save,
the byte-exact durable version snapshots and the reader's `WikiMarkdown`
rendering all operate on the same text they always did, and the round-trip is
pinned by test (`tests/features/scene-block-document.test.ts`).

**The block, in this order** (the prompt carries exactly these labels —
`PART_SCENE_FIELD_LABELS` in `src/llm/moduleGen.ts` is the one source, and the
test asserts every label reaches the prompt):

- **Scene heading + tag** — the scene's name as a wiki-link to its own entity,
  plus its tag: `### [[Scene Name]] — ENCOUNTER` or `— EVENT`. ENCOUNTER = a
  fight with stakes (battle map, monster roster, images); EVENT = everything
  else (negotiation, chase, hazard, mystery, puzzle, investigation —
  illustration only, no map, no monsters). Classified by what the scene is
  FOR: combat being merely possible does not make a scene an ENCOUNTER. The
  heading carries the LINK on purpose — the floor counts canonical
  `[[encounter]]` links in the part text, so a scene named only in passing
  prose would be invisible to the gate that is supposed to see it.
- **Where** — a link to an existing location entity (`[[Place Name]]`); a
  location is never invented inline.
- **First impression** — EXACTLY one or two sentences, present tense, one
  concrete sense plus one thing out of place. No history, no faction names, no
  explanation of causes, and never the party's actions or feelings. Stated in
  the prompt as the ONLY text a GM reads aloud; everything else on the block is
  GM-facing.
- **Who is here and what they want right now** — one clause per NPC present,
  saying what that NPC wants in this scene. Each NPC speaks about what they
  want and otherwise deflects or refuses.
- **The situation** — the conflict already running when the party arrives, and
  what it does in the next few minutes if nobody intervenes.
- **What changed** — the one thing different from the previous scene's state,
  and the cost the party pays to engage with it. The prompt carries the test
  verbatim: *if you could honestly write "the situation is the same, now what
  do you do", this is not a scene — rewrite it or delete it.*
- **If the party acts** — 2–4 bullets of the form
  `<a plausible party action> -> <what the opposition does>`. Different bullets
  must lead to genuinely different outcomes; two routes reaching the same place
  are one bullet.
- **Secrets** — 0–2 per scene, each written ABSTRACT FROM WHERE IT IS FOUND so
  a GM can move it; nothing the party NEEDS may be available from only one
  place.
- **Leads** — each lead names the entity it points at and why it is worth
  following; a lead that points nowhere is deleted.
- **Outcome** — graded: success, partial success and failure written
  separately. Failure costs something specific AND moves the situation forward
  (fail forward — a failed attempt is a new situation, never a dead end).

**Part-level rules that ride with the block:** no scene may require one
specific party action to proceed — if the party does nothing, the relevant
faction simply advances its own plan; the text addresses the GM and never the
players (the GM controls the world and everyone in it; what a player character
does, says, thinks or feels is never authored — the "if the party acts" bullets
are a GM-facing menu of plausible actions, not a script for the players); at
most one new entity is introduced per scene and it is used in the scene that
introduces it; and the part ends with at least two threads pointing into other
parts.

**ANTI-FORMULA RULE (binding requirement of the format, not a nicety).** The
owner's explicit fear, verbatim: *"I dont want this to become formulaic. I fear
that if we prompt this creativity gets lost."* The field set is a GM-facing
SCAFFOLD, never a fill-in template, and the prompt says so in the SAME
instruction block, immediately next to the field list
(`PART_SCENE_VARIATION_DEMANDS` — test-pinned verbatim, so it cannot be quietly
softened):

- the block ORDERS information for the GM — it is not a form to fill in;
- scenes differ from each other in length, shape and voice; any field may be a
  single short line when the scene is small, and padding a field to look
  complete is named as the failure;
- no symmetric structure across scenes and no repeated beat pattern
  (arrive → talk → fight) across the part or the module;
- the fields never dictate what happens, and a scene with nothing at stake is
  rewritten or deleted — never filled with prose to satisfy its labels.

**What is NOT in this format, deliberately** (docs/17 row 73): no candidate
slate of directions to pick from (the story is already seeded by a human idea
and can be refined with the existing tools, and modules already have drafts with
approval), no alternates field, and no code-checked cardinality — no "at least
N routes per conclusion", no "at least two factions", no route-count or
ratio demand of any kind. A count over prose needs a classifier guessing at a
gate (§M4-B-1 boundary) and would make the output formulaic, which is the
failure the owner named. Nothing in this section adds a runtime gate: the
ENCOUNTER/EVENT tag is TEXT for now — maps, monsters and rosters are still
decided by the entity's recorded `kind === 'encounter'` in the artifact
pipeline (`post-generation` filters on it), and the encounter floor is
untouched (§Editable encounter floor).

### The assertion rule — what the writer must state, and what it must leave alone (owner-directed, docs/17 row 89)

**The writer now says what the fight IS.** Owner report, verbatim: *"The
encounter prose generator actually did a good job here, and the mob generator
was not too bad either. The problem is the disconnect. The prose actually holds
truth, but it might not always be sufficient. If the prose is vague then the mob
generator can improvise, if its specific like here, it must follow that lead."*
The module text had staged two risen lumberjacks, axes in hand, on a boggy
footbridge, and the encounter roster fielded a sea hag, ghoul soldiers and
skeletal guards — because the writer's own contract clause asked the rank and
file to *"stay anonymous and undescribed by name (no names, no counts), so the
encounter pipeline casts them."* That clause is rewritten; the pipeline's half
lives in `11-ENCOUNTER-GENERATOR.md §The scene is the truth — the assertion
rule`.

**What the writer MUST state, in an encounter scene** (the rewritten
`contract.encounterCasting` slot, `src/llm/promptStyles.ts` — one contract
clause, rendered once per part, identical in all three built-in styles):

- the **opposition**: what the creatures are, roughly how many, what they carry,
  what they are doing;
- the **place**: where it is, its terrain, and the conditions the party will
  fight in;
- and therefore any creature the scene identifies precisely enough to be a
  specific creature rather than "some undead".

**A stated count is BINDING.** The prohibition that produced the vague
opposition is deleted: a writer who writes "two risen lumberjacks" has fixed the
roster's composition, and the encounter generator must stage it — or declare
loudly why it could not (that collision path is the pipeline's, `docs/11`). The
count is FICTION, not a stat line: the mechanics slot still forbids stat blocks,
tactics rules and the map in prose, and the casting clause restates that
boundary in the same breath so the two never read as a contradiction.

**What the writer MUST leave alone.** Stat blocks, difficulty tuning, tactics,
treasure and the battle map belong to the encounter pipeline. The writer asserts
the fiction; the pipeline owns the CASTING around it and must not contradict
what the text states.

**Personal names stay the writer's choice, for PEOPLE.** A boss, a duelist or a
negotiator may be named (a named, drafted NPC is pinned as fixed cast,
`docs/11`); a rank-and-file fighter never gets a personal name — write "two
drowned lumberjacks", not "[[Josef]], a drowned lumberjack". Names are what the
module's links, artifacts and cast resolve against, so an invented name per mook
would fork entities the module has no use for.

**Silence is free, and that half is load-bearing.** Where the scene states
nothing the pipeline designs the roster, the map and everything else freely: the
contract clause says so in as many words, and that is a deliberate refusal to
make the pipeline timid. A vague scene is never a reason to invent an assertion
the text does not make — no mechanism anywhere counts, measures or judges how
"specific" a scene is (that threshold is what a model answers inconsistently,
and it is the failure mode this rule exists to avoid).

**This is prompt discipline, not a gate** (§M4-B-1 boundary, unchanged): no code
reads the prose to check it stated enough. The only new code-side inputs are the
encounter prompt's own section, the brief's framing label and the optional
`substitutions` declaration the model may file.

### Editable prompt styles (owner decision, docs/17 row 86)

**What the owner asked for, verbatim:** *"How about we make these prompts (with
placeholders) visible and changeable in settings? We could even have several
'styles' and the user could just select one... or author his own, based on
another."* — the answer to the row-73 complaint that the module had become *"a
list of things with the same structure"* with *"no room to spin a story"*.

**Two layers, and the split is the design.**

- The **style** is the user prompt: everything the author writes, with
  `{{placeholders}}` for the run's values. Styles are DATA
  (`src/domain/promptStyle.ts`), never code: `{ id, name, origin, basedOn?,
  version, templateText, createdAt, updatedAt }`.
- The **contract** is what the app parses, counts or depends on. It is injected
  on every composition from values the seam computes, and a style can say
  anything around those clauses but cannot remove them. The required tokens, per
  surface, are the spine's `contract.replyFormat`, `contract.floor`,
  `contract.entityKinds`, `contract.sceneKinds`, `contract.wikiLinks` and the
  parts' `contract.replyFormat`, `contract.gmAddress`, `contract.wikiLinks`,
  `contract.lengthTarget`, `contract.floor`, `contract.mechanics`,
  `contract.encounterCasting` (the floor clause itself still comes from the
  module's own recorded guardrail — §Editable encounter floor — and the gate,
  the counter, the messages and the goldens are untouched by this arc).

**The template is sectioned**: `--- SPINE ---` and `--- PARTS ---`. One flat
template cannot compose two structurally different prompts (the planner's JSON
call and the per-part markdown call), so the section markers are part of the
format, text outside them is refused by name, and the settings editor says so
next to the field.

**Placeholders are named, and every misuse is loud.** An unknown token is an
error that names it (never rendered literally, never silently emptied); a token
used in the wrong section names the section; an empty template is refused. A
placeholder ALONE on a paragraph disappears when the run has no value for it —
exactly how the pre-style builders dropped a null entry from the message array —
while a placeholder alone on a LINE inside a block leaves an empty line (that is
what the pre-style disabled-floor part prompt looks like). All three cases,
plus inline substitution, are pinned byte for byte.

**Built-ins are immutable and shipped in code.** `Classic` is today's text,
verbatim; `Story` writes the part as the story the GM plays — beats whose shape
the model chooses, no ordered field list — while keeping the contract, the
heading-with-`[[link]]` requirement (the encounter floor counts canonical
`[[encounter]]` links, so a beat named only in passing prose would be invisible
to the gate) and the floor clauses byte-identical to Classic's; `Freestyle`
(owner request, docs/17 row 87) prescribes no shape at all — see §Freestyle
below, and the owner's stated expectation for it, verbatim: *"i do think that
freestyle really is where front line models will shine and small models will
struggle. Front line models profit from being unconstrained."* **That
expectation was then revised by his own test, and the record shows the
sequence.** His words, verbatim: *"I have new information. I am using a very
cheap but new model and its doing fine. Thats why. I like this style better."*
So the expectation is **NOT confirmed**: he ran Freestyle on a cheap but NEW
model and it performed well, and the variable that showed up is how new the
model is, not what it costs. This is his own observation of his own run, not a
measurement by us. Nothing in this doc, the code or the tests may state or imply
that cheap/small models struggle with Freestyle, or that Freestyle needs a
front-line model. **Freestyle is what a FRESH app now defaults to** (docs/17 row
88): he preferred the output, so the product default moved — see §Default
writing style below. A built-in cannot be edited at all; `Duplicate` is the way in, and a
style derived from another keeps `basedOn` and a `Reset to source`.

### Default writing style (owner request, docs/17 row 88)

**Freestyle is the PRODUCT default.** The owner generated with it, on a cheap but
new model, it did fine, and he liked the output better — so a fresh app starts
there. Two layers carry it and they are the only two that moved:
`defaultSettings().defaultPromptStyleId` (what a brand-new app's settings row is
born with) and the zod default on that field (what a row, or a backup, that does
not STORE the field reads back as — the pre-styles-arc shape). The New Module
dialog's own fallback for the window before the catalog read lands is the same
constant. `PROMPT_STYLE_FREESTYLE_ID` (`src/domain/promptStyle.ts`) is the ONE
spelling of the id; the built-in's entry uses it too.

**An explicitly STORED `defaultPromptStyleId` is honored verbatim and never
rewritten** — a stored `'classic'` is data, so there is no migration, no Dexie
version bump and no upgrade normalization for it, and the Settings page's **Make
default** is the one explicit way to change it. A row written before the styles
arc simply has no stored value and therefore picks up the product default.

**The resolution order, and the invariant that makes this safe.** A module's
style is resolved in exactly one order: **the module's recorded style → and, when
nothing was recorded, Classic by PROVENANCE** (`promptStyleForModule`). The app
default is NOT a rung of that ladder: it is consulted only where no style has
been recorded for the module being CREATED (`resolveCreationPromptStyle`, the
creation path). Every module the owner already has was written under Classic, so
this is what keeps a resume, a repair and a per-part regeneration composing
exactly the prompt they composed before — pinned by
`tests/llm/promptStyles-default-style.test.ts`, which renders a legacy row (no
`promptStyle` key in Dexie) against the byte-identity fixture with the app
default sitting on Freestyle.

### Freestyle — the shape-free experiment (owner request, docs/17 row 87)

**What the owner asked for, verbatim:** *"i see classic and story as options. I
would like you to add a 'Freestyle' option where just the setting and the
technology is explained and the goal to make this a noteworthy and fun module to
play, no actual structure given on top of that. I want to experiment with that.
All artefact types and the encounter floor still need to be explained."*

**What its PARTS section carries — three things, and nothing else.**

1. **The setting**: every context placeholder the other built-ins use
   (`{{campaign}}`, `{{modulePremise}}`, `{{themes}}`, `{{allParts}}`,
   `{{partHeading}}`, `{{partSynopsis}}`, `{{partEndCondition}}`,
   `{{previousPart}}`, `{{ruleExcerpts}}`, `{{glossary}}`, `{{campaignIndex}}`,
   `{{priorModules}}`, `{{additionalInstruction}}`). A part prompt without them
   writes a different module than the planner approved.
2. **The technology** — what this app is and what it does with the text, which
   is not creative preference: the text is what a GM runs a table from; every
   proper noun written as a `[[wiki-link]]` becomes a real artifact the app
   builds out, with its own generated details and its own generated images; the
   six artifact kinds are each explained (`npc` a person or creature the party
   meets, `location` a place, `event` a non-combat scene, `faction` an
   organization, `note` anything else, `encounter` a FIGHT) together with what
   the app builds per kind — an **encounter** gets a battle map, a monster
   roster and mob-portrait images, an **event** gets an illustration and nothing
   else, and every artifact can carry generated images and details; player
   characters are not the module's to write and `plotarc` is not an entity kind
   the module declares; and the **encounter floor**, whose numbers and wording
   arrive through `{{contract.floor}}` — the template never restates, rounds or
   softens them, because a style that repeated the numbers could disagree with
   the gate that counts them. What an encounter IS versus an event (a
   negotiation, hazard, puzzle, investigation or chase is an event) is stated
   there too: that distinction is the technology the floor depends on.
3. **The goal**: make this a noteworthy and fun module to play.

**What it deliberately OMITS — the point of the style.** No field list, no
beat-heading template, no "write the part as …" instruction, and none of the
craft-discipline bullets Classic and Story carry (no "two visible approaches",
no "end the part with two threads", no "every conflict ends with a cost", no
one-new-entity-per-scene rule, no finale-aware closing demand). Those are the
other styles' creative prescriptions; the owner wants to see what the model does
without them.

**Where the form is stated, and what that does NOT change.** Classic and Story
carry the heading-with-`[[link]]` requirement as a FORMAT rule; Freestyle states
the same underlying app behaviour as TECHNOLOGY and lets the model choose the
form: the app builds an artifact from every linked name, and it counts a part's
encounters from the wiki-linked names whose recorded entity kind is `encounter`
(`encounterNamesIn` / `countModuleEncounters`) — so a fight becomes countable by
being named, linked and declared with that kind, which is why the spine declares
entity kinds and why the contract's own link rules ask for `[[Encounter Name]]`.
That boundary — a fight written only inside a sentence, never named or linked, is
invisible to the count — is PRE-EXISTING for every style, not something Freestyle
introduces (docs/05 §Screen: Module reader, docs/18 §4). **The encounter floor
itself is identical for all three styles**: the same `{{contract.floor}}` clauses,
verbatim, with the module's own numbers. Freestyle weakens nothing, and no claim
is made that a freestyle part complies with the floor differently.

**The SPINE section is Classic's, verbatim — a judgement call reported for the
owner's veto.** The planner's reply is a JSON contract (`partPlan`), its
instruction is already conflict-first rather than formulaic, and the part plan is
scaffolding the owner does not read, while the part text is what he is
experimenting with. Freestyling the planner too is a follow-up he can ask for.

**The contract layer is untouched for all three styles** — the reply format, the
GM address rule, the wiki-link and canonical-spelling rules, the mechanics
clause, encounter casting, the length target and the floor clauses are injected
exactly as before. Freestyle drops none of them, and no contract value changed:
Classic's byte identity (`tests/llm/promptStyles-classic-identity.test.ts`) still
guards every module the owner already has. **Freestyle is also what a fresh app
now defaults to** (docs/17 row 88) — §Default writing style above: that changes
what a NEW module is created in, never what an existing one is read as.

**A module RECORDS the style it was written in** — id, name, version and the
full `templateText` on its row (`domain/module.promptStyle`, additive and
optional). Every later generation of that module — a resume, a repair, a
per-part regeneration, the floor-repair rewrite — composes from THAT copy, so
editing a style can never rewrite a module that exists and deleting one can
never break it. A module written before styles existed has no recorded style and
resolves to the immutable Classic (`promptStyleForModule` →
`source: 'legacy-classic'`): it was written with that text and keeps composing
it. Moving an existing module onto a style's current text is an explicit,
confirmed act (the canvas's style bar, which renders NOTHING when there is no
difference).

**Byte identity is the acceptance criterion.** `tests/llm/promptStyles-classic-identity.test.ts`
compares the composed Classic prompt against eleven fixtures captured by
RENDERING the pre-refactor builders (the 89e5d71 method — never transcribed):
the default floor, a disabled floor, prior modules with the shared cast, an
extra retry instruction, tone bans with a campaign description, part 0,
continuity, the finale, the bare case, plus a LEGACY row (no `promptStyle` key
in Dexie) and a row that RECORDED Classic. Nothing about this arc is allowed to
change one byte of the default path.

**Storage decision.** Styles live on the SETTINGS row (`promptStyles`,
`defaultPromptStyleId`), not in a Dexie table: no version bump and no migration
golden to re-derive, the app default is a settings preference anyway (one read
seam instead of two) — and moving that preference's DEFAULT to Freestyle (docs/17
row 88, §Default writing style above) cost exactly two values for that reason —
the row already carries a comparable per-feature object
(`newModuleDraft`) with its own read carve-out, and backup/export already
carries the settings row. The hazard — a settings write clobbering a field it
does not own — is closed in `settingsRepo.updateSettings`, which carries such a
field forward VERBATIM and fails loudly if it cannot be read; an unreadable
styles blob is reported on both surfaces with one explicit way out ("Discard
unreadable styles") and is never shown as "no styles".

**Deliberately NOT in this arc:** per-module style AUTHORING (a module selects a
style and records its text; authoring happens in Settings), style versioning as
history (the version only marks the template generation a module recorded),
style-level model/temperature settings (those stay on the persona and the
Settings defaults), and any effect of a style on the encounter FLOOR (which
stays recorded per module and machine-checked).

### Pass 0 — Spine (one call, JSON)

Input: concept, levelMin/Max, tone, sizeDial, campaign (name, system,
description), and — when the campaign has artifacts — a compact index of
existing artifacts (name, kind, one-line summary; cap 60 entries) so the
module can reuse the campaign's world. The index (and the cast list below) is
the module-creation pool: **the Party (`kind: 'pc'`) is excluded** (docs/17
row 69) — a PC is authored, not campaign setting content to reuse. **Opt-in continuity:** when the module
row has `includePriorModules` (set at creation), the prompt additionally
carries the campaign's other modules — premise + written part texts, drafts
included, ordered oldest first, per-part/per-module/total char caps, oldest
dropped first on overflow — labeled as settled history to continue, never
retcon. The section is omitted when the flag is off (default) or no other
module has any text. Both passes also carry the shared campaign cast
list (`campaignCastContext`: campaign-scoped NON-`pc` rows — the Party is
excluded, docs/17 row 69 — names+kinds, 60-name
cap, ~2.4k chars inside the 24k total) so follow-ups reuse promoted
names exactly instead of inventing duplicates.

Prompt requirements (verbatim intent, exact wording up to implementer):
- Propose `partPlan` covering the level range: **default one part per level;
  the model MAY merge adjacent levels into one part when the story is better
  served** (so 1–10 → ~8–10 parts, 1–2 → 1–2 parts). Every level in the range
  must be covered by exactly one part, in order.
- Think like an experienced GM: prioritize meaningful choices, varied pacing,
  clear stakes, and challenges that are exciting without feeling arbitrary. Let
  the fiction and pacing decide the structure — never a quota.
- REQUIREMENT — encounter floor: name at least **`perLevel` distinct
  encounters per level** of the module's range (levels X–Y → at least N
  distinct encounters across the module), with each part naming at least as
  many encounters as the levels its band covers. `perLevel` is the module's
  own recorded floor (default 1), never a hard-coded one — see §Editable
  encounter floor below; the same number renders this clause, the spine repair
  retry, the per-part share and the gate. An encounter is a fight (battle map
  and monster roster), so a negotiation, hazard, puzzle, investigation or chase
  is an `event` instead and does not count. Place encounters deliberately in
  the parts where they make narrative and gameplay sense, and reserve climactic
  encounters for an earned escalation. The 4× ceiling stays advisory and never
  fails.
- The conflict contract (§M4-B-1): the situation is contested and who carries
  the conflict may shift; at least two VISIBLE approaches per situation
  differing in cost or consequence; the premise states how the situation can
  resolve and parts equal what the premise promises; factions carry an order of
  battle and advance between parts; an antagonist is visible from the first
  part; every conflict ends with someone worse off, a cost paid, or a new
  problem opened; what the party changes persists and stays visible; one
  concrete particular per encounter and location; no NPC ally more intimately
  bound to the plot than the PCs; the user's premise is FIXED INPUT.
- Structural conflict governs HOW scenes resolve, never what they feel like —
  no tone, register or subject matter is restricted here (murder clown and
  grieving revenge both clear every gate). A matching module tone adds its own
  2–3 outcome limits (see the tone dial below); the universal demand is stated
  positively, so an untoned module carries no ban list at all.
- The three non-negotiables are restated LAST in the prompt, immediately before
  the reply-format line (which stays last for structured output).
- Introduce as many locations, NPCs, factions, notes, events and encounters as
  the story needs — none of them must be detailed here. Give every scene a
  distinctive, stable name, declare it with its kind in `entities`, and
  wiki-link it in prose (`[[Scene Name]]`) so it can be resolved into its
  artifact later.
- An `encounter` is a FIGHT (initiative, battle map, monster roster); anything
  not a fight is an `event` (illustration, no map, no monsters, no roster).
- Reuse existing campaign entities by their exact name; never duplicate one to
  fill the encounter floor.

Output zod `ModuleSpineSchema` (premise, themes, partPlan with all four
fields; partPlan length 1..20) **plus `entities: [{ name, kind }]`** — the
model declares each entity's kind (npc/location/event/faction/note/encounter)
when it invents the name; the record is stored as `module.entityKinds` and
drives chip preselects and batch buckets (a missing/incomplete list fails the
spine loudly — no client-side heuristic ever decides a type). `absorbed` is
filled by normalization, not by the model.
`responseFormat:'json'`, same invalid-JSON-retry-once policy as personas;
second failure → module `status:'failed'` + errorMessage (loud, per AGENTS
rule 1).

**Spine encounter gate (floor-only):** after the spine saves, zero
`kind: "encounter"` records — only when the module's floor is ENABLED (a
disabled floor makes an encounter-free spine legitimate, and the gate carries a
loud invariant throw if it is ever reached with the floor off) — triggers ONE
repair retry on the escalated model asking for the named encounters; a second
encounter-free spine fails loudly, so a zero-encounter draft never parks on the
checkpoint. The declared mix is not checked: it does not exist any more
(§M4-B-1).

**Checkpoint (default): the spine is shown for approval** — editable premise
textarea and part-plan table (edit titles/synopses/bands, add/remove/reorder
parts). Buttons: "Generate parts" / "Retry spine…" (optional extra
instruction) / "Discard". This is the highest-leverage steering moment.

**Opt-in skip (`autoApproveSpine`, set at creation via "Generate parts
without review"):** the generated spine is approved as-is and pass 1 starts
immediately — the checkpoint never renders, and a retried spine continues
unattended too (`createModuleAndRun` / `retrySpine` run pass 1 and the
post-generation automation right after pass 0 lands). Off (default) = the
checkpoint behavior above, byte-for-byte.

### Pass 1 — Parts (one call per part, sequential, markdown out)

For part i, the user message contains:
1. spine premise + themes,
2. **full markdown of part i−1** (continuity; omit for i=0),
3. one-line synopses of ALL parts (so later parts can be foreshadowed),
4. this part's plan entry (title, band, synopsis, levelUpTrigger),
5. rule excerpts: `searchRules(partSynopsis, { limit: 4 })` for grounding,
6. the same opt-in prior-modules context as pass 0 (when
   `includePriorModules` is set) — cross-module continuity for the prose,
7. writing instructions:
   - free-form GM-facing markdown, `##`/`###` headings allowed (H1 is added
     by the reader),
   - each scene with anything at stake is written as ONE labeled scene block,
     with the fields in the order of §M4-B-2 (heading + ENCOUNTER/EVENT tag,
     Where, First impression, Who is here and what they want right now, The
     situation, What changed, If the party acts, Secrets, Leads, Outcome) —
     and the anti-formula rule rides the SAME instruction block, immediately
     after the field list (§M4-B-2, binding),
   - every situation offers at least two VISIBLE approaches differing in cost or
     consequence — nothing resolves on a single route,
   - every conflict ends with someone worse off, a cost paid, or a new problem
     opened (the positively stated resolution shape — the frictionless
     resolutions are named as its inverse, not as a ban list),
   - what the party defeats, bypasses or changes is written into the fiction so
     it stays visible; nothing they accomplished is undone off-screen and
     nobody locates or captures them by fiat,
   - **wiki-link every proper noun** (NPCs, locations, factions, artifacts,
     monsters) AND every scene (`[[Encounter Name]]` for a fight, `[[Event
     Name]]` for anything else) as `[[Name]]`, consistently reusing exact names
     from earlier parts and the campaign index (the index is the module-creation
     pool — no party member is ever listed, docs/17 row 69; a generated name
     that happens to match a PC's becomes the module's OWN entity),
   - target length by sizeDial: sketch ≈ 400–700 words, standard ≈ 800–1500,
     detailed ≈ 1500–2500 (soft targets, stated in the prompt),
   - REQUIREMENT — this part's encounter share (stated with the concrete
     number): name at least `perLevel × levels in the band` distinct
     encounters, as `[[Encounter Name]]` wiki-links, each a fight staged where
     a battle map and a monster roster make sense; encounters named in other
     parts do not count toward this part's share. The item is omitted entirely
     when the module's floor is disabled,
   - the finale is the one part where satisfaction is allowed, at full price
     (every want met is paid for visibly); every other part ends with a cost, a
     revelation, or a new pressure that carries into the next part,
   - an antagonist's agents, aftereffects or evidence stay on the page; one
     faction advances its own plan in the part whether or not the party engages
     it, and a return to a known place opens with what has changed since,
   - one concrete particular per encounter and location that could not be
     swapped out unchanged; the PCs stay the protagonists (no NPC ally more
     intimately bound to the plot than they are, no NPC solving what the party
     came to solve),
   - opportunistic threats (a predator, a patrol, a bandit group) advance or
     reveal a faction's plan; exploring is never punished as such,
   - the three non-negotiables are restated LAST in the writing instructions,
   - no stat blocks in the prose — mechanics belong to linked entities;
     reference DCs/checks inline where natural,
   - REFERENCE encounters, never author them: the prose sets up the FIGHT and
     links it as `[[Encounter Name]]` — no monster roster with counts, no
     tactics or terrain rules, no battle map or ASCII map (those belong to the
     linked encounter artifact, designed by the encounter pipeline from the
     prose mention),
   - a scene that is NOT a fight is an event: linked as `[[Event Name]]` and
     written as its whole block in the prose (§M4-B-2 — the block IS what an
     event gets) — an event receives an illustration and no battle map,
     monsters or roster, because none is generated for it,
   - in encounter scenes, name ONLY the fixed participants (the boss, the
     duelist, the negotiator — `[[Halvar]]`): rank-and-file fighters stay
     anonymous and undescribed by name (no names, no counts), so the
     encounter pipeline casts them (11-ENCOUNTER-GENERATOR §Fixed cast —
     every invented name becomes an artifact the pipeline must honor).

**Encounter-floor gate (hard):** after the parts loop AND the
name-normalization pass, but BEFORE the ready write, `runParts` counts the
floor on the normalized canonicals — against **the module's own recorded floor**
(`encounterFloorGuardrailFor`, §Editable encounter floor; a disabled floor
demands 0 and no band is ever deficient, so the gate and its repair are
inert) (`countModuleEncounters` — pure: the set
of lowercased `extractWikiLinks(moduleDocumentText)` targets whose recorded
kind is `"encounter"` against levelCount, allocated per band with
`levelsInLevelBand`; bands `1`, `2-3`, `2–3`, `2 - 3` parse, unparseable = 1;
reuse counts; the 4× ceiling stays advisory and never fails high;
sizeDial-independent). The pass checks NOTHING else: the declared mix and its
validator are gone (§M4-B-1). Each deficient part in the run's scope gets ONE
repair rewrite via the `rewritePart` engine (`generatePart`) on the
escalated model — the repair carries the resolution shape (finale-aware: the
closing part may satisfy at full price) — hand-edited parts are never touched
(they fail loud instead) — then the pass re-normalizes and recounts. A full run
owns the whole-module total; a subset run (single-part rewrite/retry) owns only
its parts' band shares. Still short →
module `status:'failed'` with an `errorMessage` naming the deficient part
titles/bands + `toastError`; good parts are preserved (no rollback — parts
are individually regenerable, and a failed repair restores the pre-repair
prose) and the post-generation automation is
SKIPPED on every tail (`approveSpineAndRun`, `generateMissingParts`, the
`autoApproveSpine` tails). Batch entity generation alone can never satisfy
the floor: the count reads prose wiki-links, not artifact records.

Output is **plain markdown — no JSON, no zod** for the prose itself. Empty or
<100-char output = failure (retry once, then part `status:'failed'`). Strip a
single leading H1 if the model emits one. Generated part prose is
already-decoded stored text, so a `?xx` tail or literal `\uXXXX` in it is
mangled output, never content: `generatePart` scans the normalized markdown
with `findEscapeDebris` (`src/lib/encodingHygiene.ts`, pure) before the
ready write, and on a hit marks the part `failed` with the debris named in
its `errorMessage` — the existing failed semantics (the chain continues,
the user retries); debris is never persisted as ready prose.

Sequential execution; module `status:'generating'` with the reader already
showing finished parts (progressive reveal — the user reads part 1 while part
3 generates). Part failure does NOT stop the chain: mark that part failed
(visible error card with Retry button in its slot) and continue with the next
part, using the last *successful* part as continuity context. Cancellation is
NOT a part failure: when the run's abort signal has fired (Stop all / the
reader Stop button) the chain STOPS — the in-flight part keeps its slot
(pending, 'Cancelled'), finished parts stay, the module returns to ready
(draft before the first part), and the dock job finishes quietly with no
failure toast. Abort recognition reads the controller's signal, never the
error's shape (the streaming pipeline can surface a stop as a cross-realm
AbortError, a wrapped transport error, or no error at all).

Per-part **"Rewrite…"** button (also for successful parts): optional user
instruction appended, regenerates just that part with the same context recipe
(prior part = current text of part i−1). Overwrites the part's markdown —
confirm dialog when the part was hand-edited since generation.

### Editable encounter floor (numeric, Advanced)

The floor is the one prompt requirement the owner can change without editing
prompt copy (owner decision, docs/17 row 70). It is deliberately a
**numerical** interface — two controls behind the New Module dialog's
**Advanced — encounter guardrails** disclosure:

- **Encounter floor** (on by default) — off means no minimum count of named
  encounters at all: the prompt clause, the spine gate, the floor gate and the
  floor repair all disappear together.
- **Per level** (default 1, integers 0..10) — how many distinct encounters each
  level of the range must yield.

ONE source of truth, `src/domain/module.ts`: `encounterFloorGuardrailSchema`
(`{ enabled, perLevel }`, integers, min 0, and `enabled ⇒ perLevel ≥ 1` — a
disabled floor may carry 0). Every consumer reads the resolved value
`encounterFloorGuardrailFor(module)` **from the module row** — the spine prompt
builder, the spine gate and its repair retry, the parts gate, the floor repair
and the per-part instruction — so a repair, a retry or a later pass months on
judges the module by the rules it was created with, never by whatever a dialog
shows today. `countModuleEncounters(module, floor?)` and
`assertEncounterFloor(module, floor?)` are pure and default to the module's own
recorded floor.

Rendered prose is derived from the numbers (`encounterCountWord`): `perLevel: 1`
renders "at least one distinct encounter per level"; 2 renders "at least two
distinct encounters per level" and "→ at least 4 distinct encounters across the
module" for a 2-level range; the failure message states the doubled requirement
("needs 4 distinct named encounters … needs 2, names 1"). The failure message is held
byte-identical by `floor-message-default.txt`; the prompt-clause fixtures
(`spine-`/`parts-guardrail-default.txt`) are captured from the live builders and
change deliberately when the prompt contract changes (docs/17 row 72).

**Storage:** the choice is recorded ON THE MODULE ROW in
`encounterFloorGuardrail` (additive optional, `null` = not recorded = today's
default floor), so the row is self-describing and no settings change can
retroactively alter a module's rules. No Dexie version bump is needed (a
nullable optional field parses old rows as `null`).

Not configurable, by design: nothing else about a scene. What a scene IS
(encounter = fight, everything else = event) and how conflicted the situation
must be are prompt discipline, not dials — a count can be gated, a story cannot
(§M4-B-1 boundary). The scene BLOCK's shape (§M4-B-2) is prompt discipline for
the same reason: it is not a dial, it carries no count, and the only number in
the format's family is the floor above. The narrow exception worth naming is
the heading LINK itself: because the floor counts canonical `[[encounter]]`
links in the part text, the format requires the scene's link in its heading —
that is a link-syntax requirement serving the existing counter, not a new gate,
and it changes neither the counter nor the floor.

### Tone dial (outcome limits)

`tone` stays free text (dialog input, may be `''`). When it names one of the
canonical values below (case-insensitive), the planner prompt renders that
value's outcome limits AFTER the universal demand. Every limit names an
OUTCOME — never register, mood, or subject matter. The prose palette stays
fully open: murder clown and grieving revenge both clear every gate.

The universal demand is stated positively (docs/17 row 72): every conflict ends
with someone worse off, a cost paid, or a new problem opened — the losing side
is bought, beaten or outmaneuvered, never talked out of its want; a compromise
costs a party something it needed; the resolution is built from what the party
found and did, never revealed as an unearned third option. That sentence is the
inverse of the four frictionless resolutions the old
`MODULE_TONE_GENERIC_BANS` list forbade, so the list is gone: a matching tone
carries its own 2–3 limits (the only hard bans the prompt carries, each with the
reason attached), and an untoned module carries no ban list at all.

- heroic: the confrontation is won by a bystander sacrifice the party never
  chose; the villain yields the moment the party demonstrates superior
  resolve.
- hopeful: every loss is undone before the part ends; a bleak outcome is
  reversed by a last-moment turn that costs no one.
- whimsical: the conflict dissolves because it was all a misunderstanding
  with no remaining consequences; a trickster rewinds events so the party's
  choices leave no trace.
- mystery: the culprit confesses the whole scheme unprompted; the final
  clue arrives from nowhere instead of from the investigation.
- intrigue: every faction honors its bargain with no betrayal priced in; a
  divided loyalty is settled by exposition rather than by what is
  sacrificed.
- horror: the threat is fully explained and dismantled with nothing unknown
  left standing; everyone escapes the scene without loss.
- tragedy: a doomed stand is rescued by an intervention nobody earned; the
  price of the outcome lands on someone uninvolved instead of on whoever
  chose it.

Single source: `MODULE_TONE_BANS` (`src/llm/moduleGen.ts`) — the prompt renders
from the constant, this section documents it.

### Creation UI

"New Module" (modules list page `/c/:campaignId/modules`, plus entry in the
top bar next to Play): dialog with concept textarea, level range (two numeric
steppers 1–20, max ≥ min), tone input, size dial (3-way toggle), and the
opt-in **"Continue from previous modules"** checkbox (disabled with a hint
until some other module of the campaign has text; the flag persists on the
module row, so later spine retries / part rewrites keep the continuity
context). Creates the Module row and navigates to the reader **immediately** —
pass 0 runs there, where the reader is its live progress surface: streaming
card, Stop button, and a progress dock that reports what the stream is doing
(char counts while the answer streams, "the model is thinking (Ns)" — with an
explicit "can take several minutes, this is normal" hint — while a reasoning
model works before its first delta, "no answer yet (Ns)" while the provider
is silent). When the model streams its reasoning, the card shows it live as a
dimmed "thinking" tail (illustration only — never persisted, cleared once the
prose starts). The spine's opening detail names the stage as one large design
call and sets the minutes-long expectation up front, so the quiet stretch is
not read as a hang. The dialog never blocks on the LLM. A failed first spine
shows its recorded error in the reader with an in-place **Retry spine draft**.

**Persisted draft** (owner request, docs/17 row 70): every value the dialog
holds — the concept included — is saved to the settings row's
`newModuleDraft`, TAGGED with the campaign it was written in, so deleting a
module and trying again (or resetting and starting over) does not cost a retype.
The write is debounced (500 ms) on change, flushed synchronously when the run
starts and when the dialog closes/mounts away, and never fired before the
stored draft has been seeded (a pre-seed empty state can never overwrite a
stored draft). A draft written in another campaign is neither prefilled nor
overwritten. **Reset to defaults** (footer) restores the dialog's own defaults
and overwrites the stored draft — a prefill with no way out would be a trap.
The two campaign wipes ("Remove all generated content", "Clear workspace") KEEP
the draft on purpose (it is authored input and retry is the feature);
`deleteCampaign` clears it, because the campaign it is tagged for is gone. A
stored draft that no longer validates fails the settings read LOUDLY (no silent
half-prefill).

**Advanced — encounter guardrails**: the two floor controls (§Editable
encounter floor above), recorded on the module row at creation.

---

## M4-C — Entity workflow (unresolved links are the work queue)

### Entity panel

Reader sidebar (right, collapsible): "Entities" — all wiki-links across the
module in TWO lists: **Focused** on top (the entities the table cares about
right now), then **Unfocused**, separated by a divider. Each row has a star
toggle to move between the lists (persisted on the module row as
`focusedEntities`, matched case-insensitively). A sort button switches the
order inside both groups between **first mention** (document order, persisted
as `entitySort: 'mention'`) and **alphabetical** (`'alphabetical'`), with a
"N mentioned · M detailed" progress line. Clicking a resolved row opens the
entity card (peek modal) — EXCEPT encounters, which navigate straight to
the workspace (`artifactPath(campaignId, artifact.id)`, the same target as
the peek modal's "Open in workspace" button) with no peek modal; the owner
always wants an encounter directly. Unresolved rows offer the same actions
as the stub popover. Wiki-link clicks in part bodies still peek for every
kind — only the entity-panel path has the encounter exception.

**Images mode** (module-mode-as-play): the "Images" button above the entities
swaps the row stars for a checkbox per entry —
- **checked** = the entity's artifact has an image (`coverImageId` or
  `imageIds`);
- **indeterminate** = the entity is queued in the background image queue;
- **unchecked** = no image. Unresolved entities have the checkbox disabled
  (there is no artifact to attach an image to).

Checking an entity enqueues a background generation (`entity-image-queue.ts`,
one sequential pump): deterministic prompt draft from the entity's own data
(`buildImagePrompt` — appearance shortcut or summary/body grounding,
mirroring `runEngine.runPromptDraft`; **owner amendment 2026-09-05, c3c021f**:
the LLM prompt-crafting call + repair retry are gone — "I dont want that
extra LLM call. Just use the appearance/body."), then `generateImages` →
`intakeImage` → `createImage` (source `generated`) → attached to the artifact
as the cover when it had none. The queue deliberately does NOT go through the
persona run pipeline: the Illustrator's pick step always pauses for a user
decision (07 §M3-A), which an unattended queue cannot do. Progress rides the shared
dock (`module-entity-images-<moduleId>`, done/total + per-entity detail);
the reader stays fully usable. Failures are loud toasts and never stop the
queue; entities that already gained an image meanwhile are skipped silently.
Unchecking a QUEUED entity just removes it from the queue (aborting if it is
the in-flight job) — no confirm; unchecking an entity WITH an image asks for
confirmation first (`removeImageFromArtifact`: detach + scrub the artifact's
revision snapshots + delete the blob when nothing else references it).

### Orphaned entities (unmentioned)

The panel's third list, below Unfocused: **"Orphaned (unmentioned)"** — every
MODULE-owned entity (kind ∈ `ENTITY_KINDS` + `plotarc`, owner-ratified:
module-owned produced content is orphanable even though the panel never lists
plotarc elsewhere) whose own module's prose never mentions it (zero resolving
wiki-link mentions in premise + parts). The term is disambiguated against the
campaign tree's module-less "Orphaned" group and phantoms (00-OVERVIEW §
Terminology). Amber family per row (the campaign-tree orphaned-badge
convention): kind badge, "no mentions", a trash button, and Adopt (the row is
still module-owned and adoptable). Rows carry the group even though they are
not wiki-link tokens of the module — the panel's token lists can never show
them; that is the point.

- **Derivation** (read time, pure): `entity-orphans.ts`
  (`deriveModuleOrphans` + the memoized `useModuleOrphans` hook over the
  panel's EXISTING props — no live query, no new props). Mentions are
  wiki-link TOKENS resolved via `buildWikiGraph` exactly the way the reader
  resolves them (exact name then aliases, case-insensitive, module-tier
  precedence) — never `countOccurrences` substrings. A module-tier
  same-named row in ANOTHER module means that module's prose does not count
  (the shadow rule); a name matching several artifacts is
  ambiguity-shadowed (only the reader's winner gets the node) — shadowed
  rows are excluded from the group and never offered for deletion.
- **Delete-all**: destructive toolbar button "Delete N orphans" (hidden at
  N=0) → an `AlertDialog` (count in the title, names in a scroll list,
  destructive confirm) → `sweepOrphanedArtifacts` (db/orphanSweep.ts): ONE
  `rw` transaction (array form: artifacts, revisions, images, battles,
  modules, campaigns, deliverables) that RE-DERIVES the orphans + every
  guard from re-listed rows INSIDE the tx (recount doctrine — the dialog's
  list never decides what goes). Hard guards per artifact: campaign-wide
  mentions (a row another module's prose mentions is KEPT — cross-module
  prose is never broken), the ambiguity shadow (render→confirm race belt),
  battle board `tokens[].artifactId` + `seedFighters[].id` on ANY campaign
  battle, encounter roster `npc-ref`/rulebook `mobArtifactId` on any
  SURVIVING encounter (SAME-module encounters count — the module survives),
  and deliverable outline nodes. Per-artifact outcomes ride the failed[]
  convention: deleted N / kept M with the kept names + reasons in ONE loud
  toast — never silent. Safe cascades are named in the confirm copy
  (relations pointing at deleted rows are scrubbed; images only they
  referenced are pruned) — the deletions themselves ride the FROZEN
  `deleteArtifact` (14 decision 5 untouched; the sweep is a NEW surface,
  never an ad-hoc per-artifact cascade).
- **Per-row single delete**: the same sweep surface with `onlyId` — the
  same guard set; a refusal names its reason ("mentioned in campaign
  prose — …", "same-named entity exists — resolve the duplicate first", a
  battle token / seed fighter / roster citation / outline node) as the
  toast instead of deleting.
- **Never candidates**: promoted rows (`moduleId: null`), pc rows, global
  library rows.

### Stub popover (click on an unresolved chip)

- **Create stub**: kind picker (npc/location/event/faction/note/encounter;
  preselected from
  `module.entityKinds` — the type the generator declared when it invented
  the name — or, for hand-typed names, a one-shot model classification;
  always user-confirmable), creates a minimal artifact (name = link
  name, summary = the sentence containing the first occurrence, tag
  `module:<title>`). Chip turns resolved immediately. A stub is not a
  dead end: the artifact editor fills it with AI later — every kind has a
  **content AI section** (`ContentAiSection` → the `useContentRefillRequest`
  channel → the persona panel's targeted generate run; encounters keep the
  roster-aware section, docs/11 §entry points). The refill is grounded in
  the owning module exactly like automatic generation: the run engine's
  `targetModuleGrounding` renders `surroundingParagraphs(
  moduleDocumentText(module), name)` + the spine premise into the draft
  prompt, feeds the same text to the campaign-grounding detection, and
  names every inapplicable state in the prompt/run (module row gone,
  campaign-scoped target, no mention of the name) — never a silent drop.
- **Generate**: runs the persona chain IN PLACE (one step, auto autonomy —
  the same machinery as the batch) with the shared progress bar
  (00-OVERVIEW §binding progress). Brief = link name + the paragraphs
  surrounding its occurrences (cap ~1200 chars) + module premise. On
  finalize the produced artifact is aligned to the exact link name (the
  model's invented name is kept as an alias) and tagged `module:<title>`;
  the chip resolves via the live query. A failed run stays loud: toast +
  the failed row in the Runs tab. (This used to navigate to the workspace
  with a prefilled persona panel — from the reader it was
  indistinguishable from the app closing the view and doing nothing; the
  navigation bridge is removed.)
- **Link existing…**: quick-find over campaign artifacts; picking one adds
  the link name to that artifact's `aliases` (this is how near-miss names get
  bound without editing text). Alias-linking another module's artifact is a
  second-module use — it auto-promotes to campaign level with a loud toast
  (10 D12).

### Batch generation

Entity panel button "Generate all unresolved of kind…" (kind picker +
confirm showing count): buckets use `module.entityKinds` (the model's
record; prose-invented names are classified by one batched model call after
the parts land — never a client heuristic). Enqueues persona runs
sequentially via the existing `chainRunner` in `auto` autonomy, brief-built
exactly like the single case. Failures follow chain semantics (visible
failed runs; continue).

The batch engine is headless (`src/features/modules/entity-batch.ts`,
`runEntityBatch`): the panel and the post-generation automation below share
one implementation (progress dock job `module-entities-<moduleId>-<kind>`,
name alignment, module-ownership stamping, loud failure summary).

Parallelism (optimization): entity generations are independent — each brief
is grounded in the module text alone — so the batch runs up to
`maxParallelRequests` (Settings) entity generations at once, each a real
PersonaRun in the Runs tab (the old sequential chain's "earlier entities as
extra retrieval context" coupling is dropped). A failed run does not stop
the batch: every entity without a produced artifact is reported in one
summary toast. The background image queue likewise generates up to
`maxParallelRequests` covers at once. Dependent chains (module parts,
writers' room personas, the encounter pipeline's stages) stay strictly
sequential.

### Names the text picks up later (the record gate is a TEXT gate)

Every batch bucket is keyed by a RECORD (`module.entityKinds`) — never a
client heuristic. The creation-time pass records the names of the text it
saw, so at creation every mentioned name has one and every kind has its
button. A LATER text change does not: a chat turn (editor or preview), a
hand edit through the one part-text save path, a board rewrite, a part
generation whose own pass never ran (a cancelled parts run), or a
durable-version restore can all introduce wiki-link names no pass has seen.
Such a name has no record, therefore no bucket and no button — the owner's
report: "after module creation there are buttons to detail all NPCs etc.
Please make those available again when coming back from a chat (chat can
introduce new ones)".

**The observation point (one, event-free).** The panel derives the module
text's UNCLASSIFIED names from the same fresh read its buckets use
(`useModuleEntities` → `domain/entityNormalization.unclassifiedEntityNames`):
wiki-link names that (a) do not resolve to an artifact yet, (b) have no
record, and (c) are not already answered for by a pending consent proposal.
"Resolve" is read against the **module-creation pool** — the Party is
excluded (docs/17 row 69), so a name equal to a player character's is work
the module still owes, never a name already covered.
The derivation is a pure function of the observed text, so EVERY
text-changing path is covered by one wiring — no per-event hooks exist — and
nothing is dispatched by a render: a re-render, a tab switch or a second
visit classifies nothing and duplicates nothing.

**The name collision with the Party.** The pool exclusion is what makes a
generated name that happens to equal a PC's safe: the classification cannot
pick the player's character (it is neither a listed name, a recorded name nor
an artifact), so the name maps to itself, gets a NEW module-owned record and
is batch-generated as the module's own artifact — inside the module's own
text the module-tier row then wins resolution. The player's row is never
touched (no alias, no revision, no scope change). A model that tries to fold
the name onto the PC anyway is rejected by the existing contract validator
(`validateNormalizationReply`'s "neither a listed name, a recorded entity
name, nor an existing artifact"), retried once with the violation stated, and
then recorded as a loud failure on the module row — the panel's Retry owns
recovery. Deliberately linking a PC remains available through the stub
popover's explicit "Use existing entity…" picker (a user act, never a silent
verdict).

**The action: "Classify N new names".** The toolbar shows the count and one
button (premise/parts, in first-mention order, no per-name work); the click
runs `llm/moduleGen.classifyNewModuleEntityNames` — the SAME machinery as
the post-parts pass (same prompt builder, with the module's recorded
canonicals as the legal canonical vocabulary; same JSON contract, validator
and one stated retry; same mechanical application), narrowed to the names
that have no record. Failure semantics are the pass's, deliberately: the
error is RECORDED on the row with `entityNamesNormalized: false` — which
closes the batch gate and shows the panel's Retry — plus a toast; nothing is
guessed, and no name is silently dropped. The run refuses to start while the
row says the text is not normalized (the full pass owns that state) and the
panel keeps the affordance disabled while the module is generating (its own
pass records the names when the parts land).

**Consent is unchanged (fix-01).** Generated (unedited) parts take the link
rewrites immediately; hand-edited parts and the premise become stored
proposals for the review dialog — and chat-applied parts ARE hand-edited
(the one part-text save path stamps `edited: true`), so a variant a chat turn
introduced is folded only after the user accepts it there. A review already
pending is preserved (unioned, deduped by document + from → to), never
replaced. A run that rewrites text also takes the durable pre-change
snapshot first, like every other normalization pass (docs/18 §2.3).

**Idempotency.** The record write is APPEND-ONLY: a canonical that already
has a record keeps it byte-identical (never re-keyed, never duplicated), so
repeating the run — or chatting again — changes nothing; a run with nothing
to classify makes no model call, writes nothing and adds no durable version
row; another module's records and text are never touched.

**Why the click and not an automatic pass on display** (considered, decided):
an auto-run would spend a model call on any fresh view of a module with an
unrecorded name without the user asking — the owner's own documented stance
against unrequested LLM calls (docs/17 row 9) — and would classify without a
visible consent step. The click is ONE action for all new names, and the
affordance sits exactly where the buttons it unlocks appear. Auto-dispatch is
a one-line change at the same observation point if the owner prefers it.

### Post-generation automation (module row flags)

The New Module dialog's "After the parts are written" grid persists four
flags on the module row (zod defaults keep old pass flags off):

- `autoGenerateKinds: EntityKind[]` — per artifact type (npc, location,
  event, faction, note, encounter): batch-detail its UNRESOLVED wiki-link entities
  after a full parts pass. Opt-in.
- `autoImageKinds: EntityKind[]` — per artifact type: enqueue a background
  image (cover) for every RESOLVED entity of that kind without an image.
  Runs after the batches so newly generated artifacts are covered. Opt-in.
- `autoGenerateBattlemaps: boolean` — the module's MASTER SWITCH for
  automatic battlemaps. **The dialog defaults it ON** (owner request:
  "when automating encounters, battlemap creation should run automatically
  with defaults"): it gates BOTH the post-run automation (every encounter
  the module CREATES — batch or otherwise — is auto-enqueued on the
  unattended encounter-map queue via post-run-extras) and the post-parts
  sweep below. Unticking keeps this module's battlemaps manual; the entity
  panel's "Generate encounter maps" button is unaffected either way. Batch
  artifacts are module-owned FROM BIRTH (the batch run carries
  `placementModuleId`), so the master switch applies to them too.
- `autoGenerateMobImages: boolean` — after the parts pass, every
  module-owned encounter's rulebook-cited roster mobs are enqueued on the
  mob-portrait queue via the encounter editor's batch entry
  (`enqueueMobPortraits`): one portrait per creature kind, canonically
  cached, skip-if-imaged; enqueue is async (the dock carries progress).
  Opt-in (off by default); needs image generation in Settings.

Trigger: the ENGINE fires `runModulePostGeneration`
(features/modules/post-generation.ts) — inside `approveSpineAndRun`
(spine checkpoint "Generate parts"), after every `generateMissingParts`
completion (missing-parts button, failed-module resume), and in the
unattended tails (`createModuleAndRun` / `retrySpine` when the module row
has `autoApproveSpine`). A single-part rewrite NEVER triggers it. Semantics:

- Idempotent by construction — batches target only unresolved names, the
  image queue skips artifacts that already have images, the map queue skips
  encounters that already carry a map. Re-running a full pass never
  double-generates.
- Entity batches stay gated on `entityNamesNormalized` (fix-01): a failed
  normalization pass skips the batch step (its own failure is already loud
  with a Retry in the entity panel).
- With image generation disabled in Settings, image/battlemap/mob-portrait
  automation is skipped with ONE loud toast each — never a wall of
  per-entity failures, never a silent drop.
- Failures are loud per job (toasts + failed runs in the Runs tab) and never
  stop the remaining automation; one `toastSuccess` summarizes what ran.

### M4-B-3 — The two derived repair controls (owner requests, docs/17 rows 71/74)

The canvas header carries two user-invoked controls that repair finished work:
**Fix module problems** and **Resume automatic module creation**. Both are
DERIVED — the page asks "is there something to do?" of the live row on every
render — and both are additive or snapshot-protected rather than destructive.

**The text/entity boundary (binding, owner's words).** *"Fix module problems"*
is about the module TEXT, not entities: *"Entities are automated in other
ways. So... when the text is fixed, entities can be regenerated just by the
second part of my request."* Concretely:

- the problem set the fix control acts on is the TEXT's own, derived from
  detectors that already exist — the module's encounter floor per level band
  (`assertEncounterFloor`'s own counter and guardrail) and the READER's
  unresolved-link test (`resolveWikiLink` → the dashed "not detailed yet"
  chip). No new runtime check is introduced, and no detector that judges prose
  quality, pacing, fairness or story shape exists here (§M4-B-1 boundary);
- only the FLOOR is repairable by rewriting text. An unresolved `[[Name]]` is
  the reader's own way of saying "this entity is not detailed yet", which is
  entity work: it is DETECTED and REPORTED (in the confirmation's own section,
  with its remedy) and never rewritten. Fuzzy or heuristic name matching for a
  phantom link is forbidden here — a variant of an existing name is the
  normalization pass's job, judged by the model;
- therefore the control APPEARS only when a rewrite can fix something. Being
  driven by missing entities would make it entity work under a text label, and
  it would open a dialog with nothing to rewrite. The entity half of any
  shortfall has its own control below, plus the entity panel;
- the rewrite itself rides the EXISTING repair seam — `generatePart` with the
  floor repair's instruction and the escalated repair model — and is scoped to
  the failing check: one attempt per part per invocation, no retry loop, no
  "improve the prose" behaviour, no candidate slate, no cardinality demand.
  A `snapshotModuleVersion` row is written BEFORE the attempt (the confirmation
  says so; the snapshot precedes the ATTEMPT, so a failed attempt leaves an
  identical-to-restore version rather than no version at all — no rewrite may
  ever run without a prior recorded version). A still-short floor fails
  LOUDLY with the floor's own message and leaves the module `failed`; a part
  whose call threw has its pre-repair text restored byte-identically and is
  reported, never silently patched. Because the floor counts LINKS whose
  RECORDED kind is `encounter`, the repair runs the existing name-normalization
  pass after a successful rewrite, or the number would not move.

**The derived-deviation rule (binding).** *"Resume automatic module
creation"* compares the module's RECORDED intent (`automationIntent`, written
at creation, docs/17 row 71) with what actually exists, at render time: what
the intent asked to generate (entities by kind, images by kind, battle maps,
mob portraits) and does not have. NOTHING about the deviation is stored — no
`deviates`, `hasProblems` or `needsWork` flag exists and none may be added,
because a cached verdict goes stale the moment the owner fixes the text,
deletes an artifact or images something by hand, which is exactly the state the
button exists for. The targets are the SWEEP's own (`batchTargets`,
`imageTargets`, `encountersNeedingMaps`, `encountersNeedingMobPortraits`) over
the SWEEP's pool (the module-creation pool: the Party is invisible to module
creation, docs/17 row 69), so the confirmation names exactly the work the
sweep would do and can neither promise work it would skip nor hide work it
would run. Names the text picked up with no recorded type are part of the
deviation, because no batch can see them until they are classified; a closed
`entityNamesNormalized` gate is part of it too, because it silently blocks
every entity batch. A module created before the intent was recorded
(`automationIntent: null`) stays INERT: intent is never inferred from a legacy
row's automation fields, which describe what the engine did. A row whose
automation fields have drifted from the recorded intent is refused LOUDLY
rather than guessed at.

**Resume is additive by construction.** The work is the existing
post-generation sweep, whose every step already targets only what is missing
(unresolved names, entities without images, encounters without maps, mobs
without portraits): the resume never re-generates, re-details or overwrites an
existing artifact or image, and it never touches the module's prose. Before the
sweep it may run two EXISTING passes, each for a concrete reason — the
incremental classification pass (names the text picked up later have no
recorded kind), and the name-normalization pass when the gate is closed (a
sweep called with the gate closed would generate nothing silently). If that
pass still fails, the resume refuses loudly and runs NOTHING rather than
half-running. It captures the stop epoch at entry and asks `stoppedSince`
before each unit, so **Stop all** during a resume ends it where it is — a
stopped orchestration must not start its next unit — and the sweep keeps its
own entry capture for a stop landing mid-sweep. A resume with nothing missing
is a no-op with no call, no write, no enqueue and no toast.

**Neither control is a gate.** No runtime check, prompt clause, run state or
validation path depends on either of them: they are repair surfaces over work
that already exists, they cannot block a module, and the generation gates
(the floor, the normalization gate) are exactly the ones that were there
before. Their visibility rules are the derivations above, not stored state.

---

## Module board (v1 — whole module on a board with LLM refinement)

The whole module — and the campaign's settled history — on one board (the
module's spatial overview), beside
the reader: `/c/:campaignId/m/:moduleId/board` (full-viewport module child
route, the battle-table precedent), entered from the reader header
(**Board**) and from the modules list row. Spec lives here; the screen text
is docs/05 §Module board; implementation in
`src/features/modules/board/`.

**TEXT-ONLY v1 scope (owner decision):** the current module renders a
premise card and one card per part; every PRIOR module renders as a
read-only text group (premise + parts). Everything is prose through the
shared `WikiMarkdown` — NO entity cards, NO phantom cards, NO artifact
detail cards, and wiki chips are INERT on the board (no peek modal, no stub
popover — entity actions are deferred to a later arc). Ambiguity ⚠ and
unresolved-dashed chip markers are the renderer's own; each prior group
resolves with its module's OWN tier-0 context over the campaign + global
pool, so a module-owned entity beats a same-named shared row only inside its
own group.

- **Cards are the reader's JOIN**: `spine.partPlan[planIndex] ×
  parts[planIndex]` — title/band from the plan, body/status/edited from the
  part. H1 is never stored; the card renders the plan title as the heading,
  exactly like the reader. Prior groups list only the parts that have text.
- **React Flow owns the viewport** (`@xyflow/react` 12.x; the attribution
  badge stays): pan/zoom/pinch/drag are React Flow gestures — cards mount
  plain buttons only, scrollable bodies carry `nowheel`, and nothing on the
  board arms a second pointer-gesture path (the battle gesture machine is
  battle-board-scoped; the module board never touches it).
- **Node keys are STABLE**: `'premise'`, `'part-<planIndex>'` — planIndex is
  IDENTITY (never renumbered; deliverable seeding and the encounter floor's
  band allocation depend on it) — and `'prior-<moduleId>'`. One parse site:
  `planIndexFromCanvasNodeKey` (`src/domain/module.ts`).
- **Layout persistence**: the module row's `canvas` field (`nodes/zoom/pan`,
  additive nullable — docs/01) holds dragged positions and the viewport;
  writes go through `patchModule` debounced at 600ms (one rw transaction;
  pending write flushes on unmount). The layout rides backup/export with the
  row; NO localStorage, NO Dexie version. Fresh layouts seed deterministic
  positions from the `lib/graphLayout` row discipline (prior modules in a
  left column, the current spine to its right).
- **LOD**: full markdown at zoom ≥ 0.6 (`BOARD_LOD_FULL_ABOVE`); below, a
  title/band/status skeleton. Node content lives in per-node store slices
  (`boardStore`, value-diffed on sync) so one part changing re-renders one
  card — React Flow re-renders all nodes if node objects churn.
- **Continuity edges**: a prior group connects to the current premise/part
  card when both texts mention the same canonical wiki-name — derived by
  `deriveContinuityEdges` from `buildWikiGraph`'s per-document mentions
  (reader-pool resolution, per-module tier-0 context), capped at 12 edges
  (most-mentioned first) with a visible "+N more … not drawn" note. Edges
  merge per (prior group, current card) pair with the shared names as the
  label; render if it clarifies, never if it buries the text.
- **Per-part Rewrite**: the card header's button (ready parts only, disabled
  while the module generates) opens a dialog with an optional steering
  instruction and a per-run **Continue from previous modules** toggle
  defaulting to the row's `includePriorModules` — the engine reads the
  per-run override (`PartsRunOptions.includePriorModules`), the row is
  untouched; the prior-modules context itself is the engine's verbatim
  `priorModulesContext` (4k/8k/24k caps are load-bearing).
- **The rewrite runs THE engine**: `runParts` with `planIndexes: [i]` — the
  same subset semantics as the reader's `rewritePart` (floor gates own their
  bands, name normalization included) — minus its swallow-all catch, so
  `ModuleBusyError` surfaces LOUDLY (one generation per module; the board
  header carries the same Stop affordance, `cancelModuleGen`). Failure
  surfaces via `part.status`/`errorMessage` rendering on the card.
- **Staged rewrites (owner decision — no diffs)**: the rewrite result is
  staged on the card, in memory only (`stagedRewrites` zustand store — NO
  persistence, dies on reload). While proposed, the card renders the NEW
  text as-is framed as a proposal — never a diff view (the owner expects
  huge diffs); a streaming ghost preview (rAF-throttled tokens into the
  store) shows partial text while the engine writes, and partial text never
  touches the module row. **Show previous** flips the card to the old text
  on demand. **Apply** lands the new text through THE one part-text save
  path (`saveModulePartText` → `patchModulePartText`: row re-read inside the
  transaction, `status: 'ready'`, `edited: true`, post-save
  `promoteSecondModuleUses`) — after apply, the old text is gone.
  **Discard** restores the old text through the same save path (the engine
  had already written its text to the row). A failed apply reverts the
  staging to proposed with a loud toast.
- **One part-text save path (seam)**: `features/modules/partText.ts` — the
  reader's hand edit, the board rewrite's Apply and Discard all funnel
  through `saveModulePartText`; the row re-read inside the write makes a
  concurrent parts write (another save, a finishing generation) loss-free.
  Never route a part-text write anywhere else.

---

## Module canvas (v3 — document co-authoring for the WHOLE module)

ChatGPT-canvas-style co-authoring for the whole module in ONE document at
`/c/:campaignId/m/:moduleId/canvas` (the route name the Board rename freed),
entered from the reader header (**Canvas**, beside **Board**) and the modules
list row. Screen text is docs/05 §Module canvas; implementation in
`src/features/modules/canvas/`.

- **The substrate is CodeMirror 6, text-first** (research-ratified): the
  editor mounts `@uiw/react-codemirror` + `@codemirror/lang-markdown` (both
  MIT) with GFM extensions and line wrapping. **The editor doc string IS the
  markdown** — byte-exact fidelity for `[[wiki-links]]`, code spans, fences
  and tables by construction; there is NO parse→serialize round-trip
  anywhere. WYSIWYG canvases were rejected on license AND fidelity grounds
  (decision ledger 48).
- **ONE document for the whole module — no part selector** (v3, ledger 53):
  the editor doc is assembled by the shared `assembleModulePartsDocument`
  (pure, `src/domain/modulePartsDocument.ts` — the SAME format the chat sees:
  every planned part in `spine.partPlan` order, the spine premise EXCLUDED,
  each section introduced by its `[Part <n> of <total> — <title>]` label line
  and separated by a blank line + exactly ten `=` + a blank line). A
  not-yet-written part opens as a labeled empty section. The doc is assembled
  ONCE per module mount — never re-assembled mid-session (that would clobber
  unsaved edits). The scaffold lines are ordinary editable text while
  editing; they are validated only at the boundaries that need the split
  (save, chat send, proposal ranges) by the shared INVERSE
  `splitPartsDocument`/`splitModulePartsDocument`, which FAIL LOUDLY (typed
  `ModulePartsDocumentError` naming the offending line/section) on a
  missing/malformed/duplicated separator or label, a section count that does
  not match the plan, or a lying label — never silent re-splitting. A bare
  `==========` line inside part CONTENT is harmless (the label line is what
  identifies a section start); content faking a full section header fails the
   split loudly. Deep links are SCROLL targets, not scope: `?part=<planIndex|
   premise>` written by `canvasPath`, the reader's `#part-<n>` hash honored on
   load — in preview (the DEFAULT view, ledger 58) the same targets scroll
   the preview articles, each carrying its `part-<n>` anchor id (the scroll
   re-runs once the content commits, so a module row arriving before the
   campaign rows cannot drop it); resolution in `canvas/canvasScope.ts`
   (still the one parse site). Preview round-trips are safe: returning from
   the preview remounts the editor from the LATEST snapshot (preview chat
   turns rewrite it) through the existing mountDoc path, never from the
   pristine assemble (which would silently discard unsaved edits).
- **Wiki chips are marks, not React**: a CM6 ViewPlugin over the visible
  ranges decorates each `[[token]]` with the `WikiMarkdown` palette resolved
  against the READER pool (campaign + global) with the module's tier-0
  context (unresolved dashed, ambiguous wavy-amber) and provides
  `EditorView.atomicRanges`, so a token edits as one unit
  (`canvas/wikiDecorations.ts`).
- **Suggestions are decorations, never mutations** (TipTap suggestion-spec
  pattern, `canvas/suggestions.ts`): a proposal is a CM6 StateField entry
  `{id, from, to, originalText, proposedText, instruction, status,
  streaming, wholePart}`. Ranges RE-MAP on user edits; typing INSIDE a
  proposed range invalidates it LOUDLY (page toast), while edge insertions
  re-map outside the span (marimo semantics — the pure rule is
  `suggestionSurvives`). Span proposals render the original struck + the
  proposed text as a green ghost + inline Accept/Reject widgets at the range
  end (disabled while streaming). **Whole-part proposals are the same
  machinery over the full document range, rendered NO-DIFF** (board
  precedent, ledger 47): a block replace widget shows the proposed markdown
  AS-IS, "Show previous" flips the widget to the original, and the header's
  Apply/Discard drive the same accept/reject commands.
- **Undo contract**: Accept = ONE dispatch (`{changes}` + the accept effect)
  annotated `isolateHistory: 'full'` — exactly one undo step from the
  accepted state back to the pre-accept doc; streaming chunk updates and
  bookkeeping effects ride `Transaction.addToHistory.of(false)` so tokens
  NEVER pollute undo. Mod-y / Mod-u accept/reject the proposal at the cursor
  (the marimo keymaps). Block decorations are computed from the state fields
  via a facet — CM6 forbids block widgets from view plugins.
- **AI actions — the cursor plays no role** (v3, ledger 53, owner-directed;
  the `canvasRefine` contract in `src/llm/canvasRefine.ts`):
  **Refine selection** works on an explicit text SELECTION over the whole
  doc and grounds the model with the SELECTED RANGE (+ enclosing block) and
  the instruction — the full part text is never ambient context — returning
  ONE span replacement; **Rewrite part** works on an explicitly PICKED part
  (a dialog picker listing the plan; the confirm stays disabled until a part
  is picked — the editor selection is not consulted) and grounds the model
  with that part's current text, returning the COMPLETE part markdown (no
  H1); the proposal is a block replace over THAT part's section range
  (the whole-part machinery below). Both prompt the `[[wiki-link]]` token semantics (canonical
  spellings, never inflect inside the token, `[[Name|display]]` for surface
  differences). The reply is ZOD-validated at the boundary and scanned for
  escape debris — a failure throws loud, never partial-apply. Settings
  model/gates are reused (`defaultChatModel`, strict structured outputs,
  escalation chain, language directive; temperature 0.4 — surgical).
  **Streaming**: the transport always streams; the strict-JSON reply is not
  markdown, so an incremental extractor (`ReplacementStreamExtractor`)
  peels the `replacement` string value out of the raw deltas and streams
  THAT into the overlay — best-effort preview only (ambiguity yields
  nothing); the settled, validated reply is the canonical proposal text.
- **One generation per module**: a module whose forge is running
  (row status) or that already holds a canvas refine (a registry claimed
  synchronously at entry) refuses with `ModuleBusyError` — surfaced loudly,
  never queued. Stop rides the caller's abort signal (a user stop is not an
  error: the overlay simply drops). While a whole-part proposal is pending
  or a refine is in flight, the other AI actions are disabled.
- **Acceptance IS persistence through the split-save** (v3, ledger 53): the
  accept dispatch already replaced the doc (one undo unit), so the page
  lands the result through `saveWholeModuleDocument`
  (`canvas/saveDoc.ts`) — the doc is split and ONLY the parts whose text
  changed vs the module row land through THE one part-text save path
  (`saveModulePartText` → `edited: true`, promote scan), each with its
  per-part session-ledger entry (`canvas/canvasStore.ts` — zustand,
  SESSION-ONLY, dies on reload; resets when the canvas's module changes).
  Manual **Save** is the same one action (origin-'user' entries per changed
  part; an unchanged empty section saves nothing). A failed part save toasts
  loudly NAMING the part while the remaining parts still land (the return
  value reports exactly what persisted); a doc whose scaffolding no longer
  parses fails the save loudly with the splitter's reason and the editor
  keeps its text. **Restore** re-proposes an older per-part version as a
  block replace over THAT part's current section range — it rides undo and
  the split-save like any proposal; there is no side-door write. Every
  origin-'ai' save ALSO takes the durable pre-change snapshot first (see
  §Simple undo below) — the session ledger is session review state, the
  durable stack is the undo.
- **Simple undo — DURABLE whole-document versions, taken BEFORE every AI
  change** (owner-directed: "There is no undo in chat right now. I would
  like to have a simple one. Before each AI change, simply save the whole
  content in a version. Make an option under versions to clear all previous
  versions."; ledger 63, docs/18 §2.3):
  - **What a version is**: ONE row per AI change holding the WHOLE module
    parts document BYTE-EXACT as it stood immediately before that change —
    the same text `assembleModulePartsDocument` builds and
    `splitPartsDocument` splits (`==========` separators, `[Part <n> of
    <total> — <title>]` labels, every planned part, spine premise excluded).
    Never a second document format: a restore re-splits the stored string
    against the CURRENT plan through the existing split/save seam.
  - **DURABLE by owner decision**: the rows live in Dexie (`moduleVersions`,
    schema v19 — additive table, no migration; a pre-v19 database simply has
    no undo history and the first AI change starts the stack) and survive
    reload. This is deliberate revision history, created for AI changes ONLY
    — the per-part session ledger keeps its own SESSION-ONLY semantics
    (`canvasStore.ts` header: do not "fix" that with persistence) and the two
    stacks are separate and parallel, each labelled honestly in the menu.
  - **When** — ONE shared seam, `snapshotModuleVersion(moduleId, source,
    label)` (`db/moduleVersionRepo.ts`), called immediately BEFORE the AI
    write, never after. Covered paths: canvas AI saves through
    `saveWholeModuleDocument` with `origin: 'ai'` — the editor chat batch, the
    preview-snapshot chat batch, an accepted **Refine**/**Rewrite** proposal,
    and a restore (session or durable); `runParts` at ENTRY (`llm/moduleGen.ts`)
    — full generation, "generate missing parts", a single-part
    rewrite/regenerate (the reader's Rewrite and the board's staged rewrite
    both ride it), and the floor-repair rewrites inside the pass; each
    `normalizeModuleEntityNames` pass (its own snapshot — it rewrites link
    targets inside generated part text); and the entity panel's consented
    apply of stored normalization rewrites (`entity-panel.tsx`). An
    `origin: 'ai'` save that names no source THROWS and writes nothing: an
    AI change whose pre-state could not be recorded must not land (AGENTS 1),
    and the throw surfaces through the caller's existing loud path.
  - **When NOT** — manual typing is never snapshotted: the reader's hand edit,
    the canvas's manual **Save** (origin `'user'`) and CM6's own history cover
    hand edits; a hand edit is not an AI change. The board's Apply/Discard of a
    staged rewrite is likewise not snapshotted: the engine's own write was
    already captured at the pass entry, and Discard restores exactly the text
    that snapshot holds.
  - **Labels are honest** — what the change is about to do: `Chat: <opening
    words of the instruction>`, `Refine: …`, `Rewrite: …`, `Rewrite part 2 —
    Under the Docks: make it flood`, `Generate parts`, `Generate 2 missing
    parts`, `Normalize entity names`, `Apply name-normalization rewrites`,
    `Restore from <time>`. The menu shows the label, the source and a
    timestamp, newest first; the group header states the semantics ("the whole
    document as it was BEFORE each AI change").
  - **Bounded, never silently** — `MODULE_VERSION_CAP` = 25 versions per
    module; the OLDEST is pruned in the same transaction as the insert, and
    the menu states the retention ("keeping the most recent 25"). No dedupe
    and no coalescing: an AI change that ended up writing nothing still
    leaves its pre-state snapshot (restoring it is a harmless no-op) rather
    than a silent hole in the history. `createdAt` is strictly increasing per
    module, so "newest" is never a coin flip between two snapshots taken in
    the same millisecond.
  - **Restore** — the durable entry is validated against the CURRENT part plan
    first: a version saved under a different plan (a re-drafted spine) would
    produce a document whose scaffold labels lie, so it is refused LOUDLY
    ("saved for a different part plan") instead of proposed. A valid one rides
    the SAME proposal machinery as every other AI change — a block replace
    over the whole document, accept = one undo unit → the split-save — never a
    side-door row write; the restored text is byte-identical to the snapshot
    (test-pinned). A restore is itself an AI save, so it snapshots the
    pre-restore document: a wrong restore is recoverable. Restore needs the
    mounted editor (the suggestion machinery is CM6 state): in preview the
    click says so LOUDLY instead of silently doing nothing.
  - **Clear all previous versions** — an item in the same Versions menu,
    destructive-confirmed (AlertDialog, the Clear-chat conventions): it clears
    ONLY that module's durable stack (module-keyed — another module's versions
    survive), takes NO snapshot first (that would immediately re-create what
    was just cleared), touches no document text, the thread or the session
    ledger, and toasts the number of rows that actually went. **Clear chat
    stays exactly as landed** and does NOT clear the durable stack: undo
    history is not chat state, and the two controls stay independent.
  - **Deletion**: EVERY path that deletes module rows removes their versions in
    the SAME transaction (they describe a document that no longer exists, and
    nothing could ever list, restore or prune them again) through the ONE
    `moduleVersionRepo.deleteModuleVersionsForModules(moduleIds)` seam
    (docs/18 §2.1): `deleteModule` with its own id, and the bulk deletes —
    `deleteCampaign`, **Clear workspace** and **remove all generated content** —
    with their campaign's module ids re-listed INSIDE their transaction right
    before the module rows go. The campaign wipes also collect rows whose
    module row is already gone (`pruneOrphanedModuleVersions` — residue a
    pre-seam build left; a version row carries no `campaignId`, so only that
    global door can reach them). Undo history is therefore never "kept
    content": the wipes' copy says so, and no version row outlives its module.
- **Leave guard, not scope guard** (v3): leaving the page with unsaved edits
  or a pending proposal demands the explicit discard confirm — session
  staging dies on reload AND on leave; the saved row is never touched by
  either. Same-page deep links and the preview toggle are not navigation
  away: they never guard (the doc is one document).

- **Preview is the DEFAULT view: chat + rendered preview side by side**
  (owner-directed, ledger 58): `previewOpen` defaults TRUE per module on
  first open (store `openByModule` undefined ⇒ true; `previewStore.ts`
  session-only, dies on reload, resets on module change); the toggle stays
  session-only and the Edit affordance stays prominent — one click back
  to the document. The preview fills its pane (padding kept, NO centered
  narrow measure) with the chat sidebar beside it unchanged (chat left,
  preview fills the rest). It renders the toggle-time snapshot — or, on
  first open, the assembled/mount doc — through the shared
  `WikiMarkdown` with the reader pool and clickable entity chips, scaffolding
  stripped, empty parts marked explicitly unwritten; a doc whose scaffolding
  no longer parses shows the splitter's loud reason. Header AI actions +
  Save stay disabled in preview (unchanged).
- **Last-replacement highlight, both surfaces** (owner-directed, ledger 58:
  "just the last replacement"): page state `lastReplacement: {doc, from,
  to} | null` — whole-doc offsets plus the post-apply doc string
  identity, SET ONLY by chat application (the LAST command's FIRST applied
  range; both apply paths report it in post-apply coordinates, so an
  empty-part fill highlights the filled text). Rendered WHILE AND ONLY WHILE
  the current doc text is byte-identical to the stored string — any
  hand edit, proposal accept or next apply clears/replaces, never a stale
  mark. Editor = a CM6 background mark via a small StateField/extension
  (`canvas/lastReplacement.ts` — own file, not a fork of the
  suggestions field; the field re-checks the identity itself, so a lagging
  page can never leave a stale mark); preview = the SHARED `WikiMarkdown`'s
  OPTIONAL highlight prop (part-relative range, forwarded by `CanvasPreview`
  after mapping the whole-doc range to its part; reader output byte-identical
  when absent). Chat only — refine keeps its ghost affordances.

### Module canvas chat (v2 — LLM co-authoring via XML edit commands)

Owner direction: "a real chat where the LLM can make targeted edits", XML for
commands (fewer problems in owner experience); amended 2026-09-09 (ledger
row 51): "No part selection. Whole module in context (without premise),
parts split by an easy to see delimiter … I want the model to see the whole
module and be able to make changes to the whole module" + an uncapped
read-only grounding block for continuity. Entry: the reader header's **Chat**
link (next to Canvas) routes to the canvas with the sidebar forced open
(`canvasChatPath`, `?chat=open`, ledger 57); the modules list row's own Chat
entry was DROPPED by owner decision 2026-09-10 (ledger row 91, AMENDS 57) —
it landed on this same canvas, so the row keeps one icon per destination and
the chat stays one click away from the row's Canvas icon through the
sidebar's own header toggle. A collapsible wide LEFT
sidebar (`w-96`, `canvas/ChatSidebar.tsx`) beside the editor — and
beside the PREVIEW, which is the DEFAULT view (ledger 58): the canvas opens
as chat + rendered preview side by side, and the chat is FULLY LIVE there
(sending re-enabled; the "persist for preview mode" end-state). Every chat
control is a 44px touch target (iPad-proportioned). Protocol + engine in
`src/llm/canvasChat.ts`; application in `canvas/chatApply.ts` (editor) and
`canvas/snapshotChat.ts` (preview); flow in `canvas/chatController.ts`
(editor) and `canvas/snapshotChat.ts` (preview); state in
`canvas/chatStore.ts`. Decision ledger rows 50, 51 and 58.

- **Protocol**: the assistant replies with short prose plus ZERO OR MORE XML
  command blocks — `<edit all="false"><search>…</search><replace>…</replace></edit>`
  (`all="true"` = replace-every-occurrence ACROSS ALL PARTS; default exactly
  one match across the WHOLE module). XML over JSON:
  nested multi-line prose bodies need no escape dance. This is the deliberate
  deviation from canvasRefine's strict-JSON-schema reply — prose+XML is not a
  JSON shape, so NO `responseFormat` rides the call; validation is the strict
  extractor + zod (`canvasEditCommandSchema`) at the boundary.
- **Strict extractor** (`parseCanvasChatReply`): a balanced left-to-right scan
  — no regex-guessing across boundaries. A stray `</edit>`, an unterminated
  block, missing/duplicated children, unexpected content inside a block, an
  unknown attribute, or more than 40 commands per reply throws
  `CanvasChatParseError`: the WHOLE reply is marked failed with an error card
  (loud, AGENTS 1/3) — nothing partial is ever applied. Search/replace bodies
  are taken VERBATIM (no entity decoding). `chatProseSoFar` is the
  best-effort DISPLAY splitter for streaming (hides forming blocks, never
  throws, never applies).
- **Per-part match ladder** (`resolveCanvasEdit` per part, pure; cross-part
  aggregation in `resolveCanvasEditAcrossParts`): the search resolves against
  EACH part's snapshot text — NEVER across the assembled string (a search
  spanning two parts therefore cannot match and fails loudly). Ladder per
  part: (1) exact bytes, (2) case-insensitive (index-safe fold), (3)
  whitespace-collapsed (runs of whitespace ≡ one space, normalized spans
  mapped back to exact original offsets). Lineage: aider's
  `replace_most_similar_chunk` ladder; aider's fuzzy AUTO-APPLY branch stays
  dead (as upstream) — a zero match FAILS with the closest candidate snippet
  (bigram-similarity line-window scan, aider's `find_similar_lines` reporting
  role) picked across ALL parts, instead of guessing. Curly/straight quote
  folding is NOT included (documented deviation, row 50). Exactly one match
  across the whole module → apply; multiple matches → apply ONLY with
  `all="true"` (in every part where it matched), else a failed card ("N
  matches — add surrounding context or set all"); zero matches → failed card
  with the candidate.
- **Whole-module parts document** (context contract, load-bearing): EVERY
  request carries the CURRENT document — v3: the LIVE whole-document canvas
  editor doc passed by the page at send time (the doc IS the whole module,
  so unsaved edits in EVERY part ride along; never a cached copy, never a
  row re-assembly). The per-part snapshot the model saw comes from the
  SHARED `splitModulePartsDocument` (domain) applied to that SAME doc, so
  application matches EXACTLY the text the model saw — a doc whose
  scaffolding no longer parses fails the send loudly with the splitter's
  reason. Every planned part in `spine.partPlan` order (missing/empty part
  = empty section); the spine premise is EXCLUDED (owner: "without
  premise"). **Delimiter + label spec**: sections are separated by a blank
  line + a line of exactly ten `=` characters (`==========`) + a blank
  line, and every section OPENS with the scaffold label line `[Part <n> of
  <total> — <title>]` (n = 1-based position in the plan; no usable title →
  `[Part <n> of <total>]`). That scaffolding is never content: the prompt
  forbids separators/label lines inside any search/replace and forbids
  editing across a separator (one command lives inside ONE part). **Empty-part label-anchor convention**:
  an empty (not-yet-written) part's label line is its only anchor — a
  command whose search EXACTLY equals an empty part's label line fills that
  part; the replace must START with the same label line and the part text
  becomes the remainder after the label (leading blank lines trimmed);
  anything else fails loudly. The prompt states this convention explicitly.
- **Read-only grounding (unconditional, UNCAPPED)**: every request carries a
  clearly-marked `<reference-only>` block, riding INSIDE the final user turn
  (outside the persisted conversation history — carried fresh every turn,
  never trimmed, never itself persisted): the
  campaign's `name` + `description` (`campaignRepo` read), the game system
  as `GAME_SYSTEM_LABELS[campaign.system]`, and ALL preceding modules' FULL
  text — the campaign's other modules in story order (createdAt ascending,
  the `priorModulesContext` convention), each as title + premise + every
  written part's markdown in plan order. Deliberately NOT
  `moduleGen.priorModulesContext`: its PRIOR_*_CHAR_CAP caps are the
  generation-time context frugality the owner removed for chat — the
  chat-specific renderer (`renderChatGrounding`) is uncapped. The block is
  labeled REFERENCE-ONLY: continuity context the model must never edit or
  emit commands against; commands apply to the current module's parts
  document only.
- **Apply semantics** (`chatApply.applyChatCommandsAcrossParts`): commands
  resolve per part against each part's CURRENT text at apply time
  (re-resolved per command against the live doc — earlier commands in one
  reply never shift later ranges). The editor holds the whole module, so
  EVERY command lands as ONE CM6 transaction with NORMAL history — chat
  applies are NOT `addToHistory: false`; the user can undo the AI's edits
  ONE command at a time (a replace-all's ranges ride that one transaction
  = one undo step). The batch persists afterwards through the split-save
  (only the parts whose text changed hit the row); a failed part save flips
  that part's outcomes to LOUD failed cards ("the edit did not land") plus
  `toastError` naming the part — never a silent drop. Each command renders
  as OUTCOME CARDS (one per part application, plus one per failure), each
  naming its target part (planIndex + title): applied (occurrence count +
  mini before→after: the ACTUAL replaced text vs the replace) or failed
  (reason + closest candidate + **Report to LLM**). The encoding-hygiene
  debris scan runs per command's replace text (loud failed card,
  canvasRefine parity). **In preview** (the editor is unmounted — v3
  contract, never remounted hidden) the SAME protocol runs against the
  preview SNAPSHOT STRING (`snapshotChat.applyChatCommandsToSnapshot`:
  pure string splices through the SAME per-part ladder — no second
  matcher — re-split per command, so earlier commands never shift
  later ranges and a faked section header throws `ModulePartsDocumentError`
  loud; flow `snapshotChat.runSnapshotChatTurn` + snapshot report
  variants): the batch persists through the SAME split-save
  (`saveWholeModuleDocument` is headless — row writes, no editor),
  then the snapshot + highlight advance and the preview re-renders;
  return-to-Edit remounts the latest snapshot through the existing mountDoc
  path; a scaffolding-broken snapshot fails the send loudly through the
  existing error path. NO CM6 history exists for preview-applied chat edits
  (the editor is unmounted, so nothing to undo with Mod-z) — their undo is
  the DURABLE pre-change snapshot taken before the turn (§Simple undo above),
  restored from the Versions menu. Outcome cards are unchanged (before→after
  still shown per command).
- **Report-to-LLM loop** (first-class): the button composes a user turn —
  the error, the failed command verbatim, and the current text around the
  failure point (`composeFailureReport`, ±300 chars) — where the excerpt
  comes from the TARGET part's CURRENT text in the live editor doc — in
  preview, from the CURRENT snapshot at click time — and sends it
  through the normal send path (aider's "N SEARCH/REPLACE blocks
  failed to match! … Did you mean…" retry loop). One-shot per failure
  (button flips to "Reported"). A restored outcome (thread reloaded from the
  row) reports the same way: the excerpt is cut from the CURRENT doc at
  click time, so it re-resolves against what the document says now.
- **Context history**: the FULL conversation rides every request — no cap,
  no omission note (owner-directed 2026-09-09, ledger 57 — the
  `MAX_CONTEXT_MESSAGES` 12-message tail policy is deleted). Older user
  turns keep instruction text only: a stale `<document>` block surviving in
  an older turn is stripped (full context must not ship dead copies of the
  module — the current document rides once, in the final turn). The
  grounding block rides outside the history, in that same final turn.
  Assistant history entries keep their raw replies so
  the model sees its own commands.
- **Model**: the Settings `ModelInput` component reused in the sidebar;
  default = the Settings `defaultChatModel`, the selection is session-only
  canvas state keyed per module (Board staging precedent), persisted nowhere;
  the Settings gates ride the transport unchanged (fallback escalation
  chain, language directive, reasoning effort; temperature 0.4).
- **Streaming**: prose streams into the bubble (rAF-coalesced, suggestion
  ghost precedent); commands parse + apply ONLY after the reply completes —
  no mid-stream XML application in v1. Aborting mid-stream marks the partial
  reply `aborted` LOUDLY (card: "Stopped — nothing was applied"); no
  commands apply, nothing saves.
- **State**: the thread lives ON THE MODULE ROW as the additive inert
  `chatThread` field (`{messages, outcomes}` persisted as history;
  `canvasChatKey(moduleId)` — no part component: ONE conversation per
  module; the model selection stays session-only). Written after each
  SETTLED turn (debounced `chatPersist.scheduleChatPersist`; a write failure
  toasts loudly but NEVER blocks chatting) and restored on canvas open —
  restored messages + outcomes render as history and never auto-apply. No
  Dexie version (the field rides backup and campaign export/import with the
  rest of the row — exported modules carry their chat history, which is the
  point) and never read by a generation prompt (module grounding reads
  premise + parts only). Part-text persistence still rides the canvas's
  split-save (`saveWholeModuleDocument` → `edited: true` + promote scan,
  ledger entry `Chat: …` per changed part); the chat never writes part text
  directly.
- **Clear chat** (owner-directed: "i do need a clear chat option to get back
  to a pristine state"): the panel header's **Clear chat** control returns ONE
  module's chat to a pristine state behind a destructive-styled confirm
  (`canvas/clearChat.ts`) — in one action it clears (1) the live conversation
  + outcome cards (`chatStore.clearModule`), (2) the persisted thread on the
  module row (`chatPersist.clearPersistedChatThread` → the SAME
  `patchModule({chatThread: []})` write the debounced writer uses; a pending
  debounce for that key is cancelled first), (3) that module's SESSION version
  ledger — every part of it (`canvasStore.clearModule`; keys are
  `moduleId#planIndex`, so another module's ledger is structurally untouched;
  seq numbering restarts) — and (4) the last-replacement highlight (the page
  drops its `lastReplacement` state, which is what removes the editor mark AND
  the preview wash). The ROW WRITE GOES FIRST and is awaited: its failure
  cancels the whole action (nothing half-cleared, nothing restored from the
  row on the next open). What it does NOT clear, and the dialog copy says so
  in as many words: the module's DOCUMENT text — chat edits already applied
  are saved content, this control is NOT an undo — and the DURABLE version
  stack (§Simple undo above), which is precisely where reverting text now
  lives: undo history is not chat state, so "Clear all previous versions"
  (a separate, separately confirmed control in the Versions menu) is the only
  thing that empties it. While a chat reply is in flight, or any canvas AI
  action is live for the module (generating / refining / a pending proposal),
  the control REFUSES LOUDLY with a toast instead of clearing under a running
  turn — there is no cancel-then-clear path (owner report: a running turn
  would land its own message + ledger entry moments later, so a clear under it
  could not promise the pristine state it advertises). Everything else about
  the module survives: the document, its durable versions, the open state and
  the session model selection (surface preferences, not conversation state) +
  other modules' threads, ledgers, versions and highlights.
  **Truthfulness note (the session-only ledger)**: the thread outlives the
  session but the SESSION ledger does not, by design — so a canvas reopened on
  a previous session's thread can legitimately show applied edits while the
  session group in the Versions dropdown reads "Nothing accepted yet" and Save
  stays disabled (the doc matches the row). That gap is the documented price
  of a session-scoped ledger (never persist it, docs/18 §4), not a bug to
  chase, and it is no longer a hole in the user's ability to go back: the
  DURABLE group above it lists that session's AI pre-change snapshots, which
  survive the reload (docs/18 §2.3). The two groups are labelled so they can
  never be mistaken for each other; Clear chat is still the way back to a
  pristine conversation.
- **Pre-flight**: a module with no planned parts (no spine/partPlan) fails
  LOUDLY before anything sends ("no parts to chat about — generate the
  module first" — controller pre-flight toast + the engine's send-time
  boundary check), never an empty-context send.
- **Serialization**: chat and refine share the `llm/canvasBusy` registry
  (extracted from canvasRefine) — ONE generation per module across every
  canvas surface; `ModuleBusyError` surfaces as a failed card AND the
  caller's toast, never queued. While a proposal is pending, a refine is in
  flight, or the module generates, the chat send is disabled. The send
  stays ENABLED while the preview is open (the live default view —
  preview turns need no editor).

---

## M4-D — Integration & retirement

- **Deliverable seeding**: "Seed from module" on the Deliverable builder maps
  spine premise → intro text node, each part → chapter with a text node of
  the part markdown (wiki-links rendered as plain bold names in PDF), plus
  artifact nodes for each resolved entity of that part (deduped, first
  occurrence wins). `mdToPdfmake` must handle the `[[...]]` tokens (render
  display text, bold).
- **Play mode**: quick-find gains modules/parts as a third result group;
  selecting scrolls the reader. (The peek-modal "Focus in Play" button was
  removed when module mode became the play mode — M4-C.)
- **Retire the old forge**: delete `moduleForge.ts`, its UI entry points and
  tests; keep `chainRunner` (used by writers' room and M4-C batch). Keep the
  writers' room feature untouched. Remove forge-only persona briefs; keep all
  personas.
- README + in-app help updated: module designer section replaces forge docs.

---

## Acceptance criteria

- Concept "smugglers' cove gone eldritch", levels 1–3, standard: spine
  proposes ~3 parts; after approval, parts generate sequentially and are
  readable while later parts stream; total module text noticeably shorter
  than the same concept at levels 1–10.
- Part 2 rewrite with instruction "make the villain a child" changes only
  part 2.
- Clicking `[[Harbormaster Ilse]]` (unresolved) → create stub → chip turns
  solid; "Generate" produces a full NPC in place (progress bar runs, no
  navigation) whose card opens in the peek modal from the reading position,
  dismissible with Esc.
- Killing the network mid-pass-1 yields a failed part with a Retry button and
  a completed rest-of-module; nothing silently placeholders (AGENTS rule 1).
- ~~No numeric entity quotas exist anywhere in the new UI.~~ Struck:
  the encounter floor is a hard numeric quota — a module whose document
  names fewer distinct encounters than its level count (allocated per band)
  fails loudly instead of shipping ready (see the floor gate above). The ONE
  exception is the floor itself, which the owner may retune per module in the
  New Module dialog's Advanced disclosure (a numeric control — the requirement
  is a quota, and a quota is a number, docs/17 row 70).

## Non-goals

Cross-module continuity checking, module-level revision history, collaborative
editing, automatic text rewriting on artifact rename, images in module prose
(covers come from linked artifacts), map generation.
