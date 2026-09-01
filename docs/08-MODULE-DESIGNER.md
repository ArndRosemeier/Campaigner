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
(part titles, click to scroll). Edit affordance per part: an ✎ toggle that
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
breadcrumb stack (Back button, Esc pops one level). Footer: "Open in
workspace" + "Focus in Play".

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
module can reuse the campaign's world.

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
6. writing instructions:
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
steppers 1–20, max ≥ min), tone input, size dial (3-way toggle). No other
knobs. Creates the Module row and immediately runs pass 0 → spine approval →
pass 1.

---

## M4-C — Entity workflow (unresolved links are the work queue)

### Entity panel

Reader sidebar (right, collapsible): "Entities" — all wiki-links across the
module, grouped Resolved / Unresolved, with occurrence counts and a progress
line ("14 mentioned · 5 detailed"). Clicking scrolls to first occurrence;
unresolved rows offer the same actions as the stub popover.

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
  selecting scrolls the reader. Module reader's peek-modal "Focus in Play"
  sets play focus.
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
