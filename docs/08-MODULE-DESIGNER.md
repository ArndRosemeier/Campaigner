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

### Pass 0 — Spine (one call, JSON)

Input: concept, levelMin/Max, tone, sizeDial, campaign (name, system,
description), and — when the campaign has artifacts — a compact index of
existing artifacts (name, kind, one-line summary; cap 60 entries) so the
module can reuse the campaign's world. **Opt-in continuity:** when the module
row has `includePriorModules` (set at creation), the prompt additionally
carries the campaign's other modules — premise + written part texts, drafts
included, ordered oldest first, per-part/per-module/total char caps, oldest
dropped first on overflow — labeled as settled history to continue, never
retcon. The section is omitted when the flag is off (default) or no other
module has any text. Both passes also carry the shared campaign cast
list (`campaignCastContext`: moduleId-null rows, names+kinds, 60-name
cap, ~2.4k chars inside the 24k total) so follow-ups reuse promoted
names exactly instead of inventing duplicates.

Prompt requirements (verbatim intent, exact wording up to implementer):
- Propose `partPlan` covering the level range: **default one part per level;
  the model MAY merge adjacent levels into one part when the story is better
  served** (so 1–10 → ~8–10 parts, 1–2 → 1–2 parts). Every level in the range
  must be covered by exactly one part, in order.
- Think like an experienced GM designing for real players: prioritize fun,
  meaningful choices, varied pacing, memorable moments, clear stakes, and
  challenges that are exciting without feeling arbitrary or hopeless. Balance
  combat, social, exploration, discovery, and recovery according to the story
  and the group's enjoyment. Let the fiction and pacing decide the exact
  structure rather than filling a quota mechanically.
- As a soft planning guideline, aim for roughly **1–4 encounters per level**
  across the module. This is advice, not a requirement: create fewer when
  tension, travel, investigation, or character moments need room; create more
  only when the adventure supports that pace. An encounter may be combat,
  social conflict, exploration, hazard, negotiation, chase, puzzle, or another
  scene with meaningful risk and player agency. Place encounters deliberately
  in the parts where they make narrative and gameplay sense, vary their type
  and intensity, and reserve climactic encounters for an earned escalation.
  Never pad the module with repetitive or disposable encounters.
- Introduce as many locations, NPCs, factions, notes, and encounters as the
  story needs — you are not required to detail any of them in the spine. Give
  every planned encounter a distinctive, stable name, declare it as
  `kind: "encounter"` in `entities`, and reference it in prose with a
  wiki-link (`[[Encounter Name]]`) so it can be resolved into an encounter
  artifact later.
- Reuse existing campaign entities by their exact names when they fit; do not
  invent duplicates to satisfy the soft encounter guideline.

Output zod `ModuleSpineSchema` (premise, themes, partPlan with all four
fields; partPlan length 1..20) **plus `entities: [{ name, kind }]`** — the
model declares each entity's kind (npc/location/event/faction/note) when it
invents the name; the record is stored as `module.entityKinds` and drives
chip preselects and batch buckets (a missing/incomplete list fails the
spine loudly — no client-side heuristic ever decides a type).
`responseFormat:'json'`, same invalid-JSON-retry-once policy as personas;
second failure → module `status:'failed'` + errorMessage (loud, per AGENTS
rule 1).

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
     by the reader), read-aloud text as blockquotes,
   - **wiki-link every proper noun** (NPCs, locations, factions, artifacts,
     monsters) as `[[Name]]`, consistently reusing exact names from earlier
     parts and the campaign index,
   - target length by sizeDial: sketch ≈ 400–700 words, standard ≈ 800–1500,
     detailed ≈ 1500–2500 (soft targets, stated in the prompt),
   - no stat blocks in the prose — mechanics belong to linked entities;
     reference DCs/checks inline where natural.

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

### Post-generation automation (module row flags)

The New Module dialog's "After the parts are written" grid persists three
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
- With image generation disabled in Settings, image/battlemap automation is
  skipped with ONE loud toast each — never a wall of per-entity failures,
  never a silent drop.
- Failures are loud per job (toasts + failed runs in the Runs tab) and never
  stop the remaining automation; one `toastSuccess` summarizes what ran.

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
- No numeric entity quotas exist anywhere in the new UI.

## Non-goals

Cross-module continuity checking, module-level revision history, collaborative
editing, automatic text rewriting on artifact rename, images in module prose
(covers come from linked artifacts), map generation.
