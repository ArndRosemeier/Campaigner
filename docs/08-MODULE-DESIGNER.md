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

The module is **front and center**: a single scrollable document view, prose
width (~70ch), large type, parts as chapters (H1 = part title with level
band badge), spine premise as an intro section. Sticky mini-ToC on the left
(part titles, click to scroll) with a **search box on top**: matches are
located in the rendered document; next/previous (and Enter/Shift+Enter)
cycle through them, scrolling the active match into view and flashing a
highlight on its containing block. Edit affordance per part: an ✎ toggle that
swaps that part to the markdown textarea (same component as artifact bodies),
save on blur → `saveModule`.

**Wiki-link rendering** (extend the existing `markdown-body.tsx` pipeline with
a remark step or pre-tokenizer):
- resolved → solid chip (kind-colored, cover-image micro-thumb when present);
  click opens the **peek modal**;
- unresolved → dashed/muted chip; click opens the **stub popover** (M4-C);
- ambiguous → solid chip with ⚠.

**Peek modal**: a dialog rendering the read-only artifact card (REUSE the
Session-Mode card components — portrait, summary, kind data, stat block,
click-to-reveal secrets). Esc / click-outside dismisses back to the exact
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
module has any text.

Prompt requirements (verbatim intent, exact wording up to implementer):
- Propose `partPlan` covering the level range: **default one part per level;
  the model MAY merge adjacent levels into one part when the story is better
  served** (so 1–10 → ~8–10 parts, 1–2 → 1–2 parts). Every level in the range
  must be covered by exactly one part, in order.
- "Introduce as many locations, NPCs and factions as the story needs — you
  are not required to detail any of them." **No entity quotas anywhere.**
- Reuse existing campaign entities by their exact names when they fit.

Output zod `ModuleSpineSchema` (premise, themes, partPlan with all four
fields; partPlan length 1..20) **plus `entities: [{ name, kind }]`** — the
model declares each entity's kind (npc/location/faction/note) when it
invents the name; the record is stored as `module.entityKinds` and drives
chip preselects and batch buckets (a missing/incomplete list fails the
spine loudly — no client-side heuristic ever decides a type).
`responseFormat:'json'`, same invalid-JSON-retry-once policy as personas;
second failure → module `status:'failed'` + errorMessage (loud, per AGENTS
rule 1).

**Checkpoint (always, regardless of any autonomy setting): the spine is shown
for approval** — editable premise textarea and part-plan table (edit titles/
synopses/bands, add/remove/reorder parts). Buttons: "Generate parts" /
"Retry spine…" (optional extra instruction) / "Discard". This is the
highest-leverage steering moment; do not make it skippable.

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
single leading H1 if the model emits one.

Sequential execution; module `status:'generating'` with the reader already
showing finished parts (progressive reveal — the user reads part 1 while part
3 generates). Part failure does NOT stop the chain: mark that part failed
(visible error card with Retry button in its slot) and continue with the next
part, using the last *successful* part as continuity context.

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
(char counts while the answer streams, "the model is thinking (Ns)" while a
reasoning model works before its first delta, "no answer yet (Ns)" while the
provider is silent). The dialog never blocks on the LLM. A failed first spine
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
entity card (peek modal); unresolved rows offer the same actions as the stub
popover.

**Images mode** (module-mode-as-play): the "Images" button above the entities
swaps the row stars for a checkbox per entry —
- **checked** = the entity's artifact has an image (`coverImageId` or
  `imageIds`);
- **indeterminate** = the entity is queued in the background image queue;
- **unchecked** = no image. Unresolved entities have the checkbox disabled
  (there is no artifact to attach an image to).

Checking an entity enqueues a background generation (`entity-image-queue.ts`,
one sequential pump): prompt draft via the Illustrator persona's contract
(`imagePromptDraftSchema`, one JSON-repair retry — mirroring
`runEngine.runPromptDraft`), then `generateImages` → `intakeImage` →
`createImage` (source `generated`) → attached to the artifact as the cover
when it had none. The queue deliberately does NOT go through the persona run
pipeline: the Illustrator's pick step always pauses for a user decision
(07 §M3-A), which an unattended queue cannot do. Progress rides the shared
dock (`module-entity-images-<moduleId>`, done/total + per-entity detail);
the reader stays fully usable. Failures are loud toasts and never stop the
queue; entities that already gained an image meanwhile are skipped silently.
Unchecking a QUEUED entity just removes it from the queue (aborting if it is
the in-flight job) — no confirm; unchecking an entity WITH an image asks for
confirmation first (`removeImageFromArtifact`: detach + scrub the artifact's
revision snapshots + delete the blob when nothing else references it).

### Stub popover (click on an unresolved chip)

- **Create stub**: kind picker (npc/location/faction/note; preselected from
  `module.entityKinds` — the type the generator declared when it invented
  the name — or, for hand-typed names, a one-shot model classification;
  always user-confirmable), creates a minimal artifact (name = link
  name, summary = the sentence containing the first occurrence, tag
  `module:<title>`). Chip turns resolved immediately.
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
  bound without editing text).

### Batch generation

Entity panel button "Generate all unresolved of kind…" (kind picker +
confirm showing count): buckets use `module.entityKinds` (the model's
record; prose-invented names are classified by one batched model call after
the parts land — never a client heuristic). Enqueues persona runs
sequentially via the existing `chainRunner` in `auto` autonomy, brief-built
exactly like the single case. Failures follow chain semantics (visible
failed runs; continue).

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
