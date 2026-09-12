# 07 — Milestone 3: Images, Rich Encounters, Session Mode, Module PDF

Four features, in this order (each builds on the previous). Same binding
conventions as `00-OVERVIEW.md`. Every task ends with
`pnpm lint && pnpm typecheck && pnpm test` green and a commit.

Dexie: all schema changes below go into **one new `db.version(N+1)`** with an
`upgrade()` migration where noted. Never mutate an existing version block.

---

## M3-A — Image support

### Storage

New Dexie table (Blobs live outside artifact JSON — revisions must stay small):

```ts
interface StoredImage extends BaseEntity {
  campaignId: Id;
  blob: Blob;                  // WebP, re-encoded, max 1600px long edge
  mimeType: string;            // 'image/webp'
  width: number; height: number;
  prompt: string;              // generation prompt, '' for uploads
  model: string;               // image model id, '' for uploads
  source: 'generated' | 'uploaded';
}
// table: images: 'id, campaignId'
```

**The `model` field now has a DISPLAY surface** (provenance arc, docs/17 row
93): the same small muted caption the text half uses renders the image model
under the image in the lightbox, the entity card's image banner, the module
cover hero and the campaign cover art (`features/images/use-image-model.ts` +
`components/writer-model-id.WriterModelId`; the details are in docs/05
§Provenance captions). The field itself is unchanged — no schema edit, no
migration — and `''` (uploads, and any row written before) shows NOTHING. The
caption is app-only: it is never part of an exported PDF.

- `ArtifactBase` gains `imageIds: Id[]` and `coverImageId: Id | null`.
  Migration: default `[]` / `null` on all existing artifacts (upgrade fn).
- **Revision snapshots copy the id references only** — never image data.
  Deleting an artifact deletes images not referenced anywhere else in the
  campaign — the reference check must cover **artifacts and revisions**
  (revision snapshots keep `imageIds` so restored history still renders)
  before deleting a blob.
  Battle-board sweep gap (closed 2026-09-08 by docs/11 D16, single-map-slot):
  *the M3-A check above never covered battle boards or encounter live maps —
  the seed froze a COPY of `mapImageId` onto `board`, and the refcount was
  blind to both, so deleting a replaced gallery row destroyed the blob under
  a live board (viewport "no map"). `referencedImageIds` (+ the global
  variant) now also pins encounter `data.mapImageId`,
  `snapshot.data.mapImageId`, and campaign `battles.board.mapImageId`.*
- Re-encode on intake in `/src/lib/imageIntake.ts`:
  `createImageBitmap(blob, { imageOrientation: 'from-image' })` (EXIF-safe),
  draw onto canvas, scale to ≤ 1600px long edge, `canvas.toBlob('image/webp',
  0.85)`. **Detect the actual encoded format** from the resulting blob and
  store that in `mimeType` — `toBlob` silently falls back (Safari has no WebP
  encoder), so `'image/webp'` is a target, not a guarantee.
- Smoke-test early: a fake-indexeddb round-trip of a `StoredImage` (Blob
  storage + structured clone) before building anything on top of it.
- Object URLs: one hook `useImageUrl(imageId)` that creates/revokes
  `URL.createObjectURL` properly; components never touch blobs directly.
- Cover slots (cover-generation arc — Modules and Campaigns, NOT artifacts):
  `moduleSchema` and `campaignSchema` gain additive
  `coverImageId: z.uuid().nullable().default(null)` — cover-only, no gallery
  `imageIds`, NO Dexie version bump, NO index changes (parse-on-read
  defaults, the v7/v13/v15/v17 precedent). The rows are free of the artifact
  tables: the reference scans (`referencedImageIds` + global) pin both
  slots, `deleteModule` frees its cover after the row delete,
  `deleteCampaign`'s image sweep frees both, export pins them as
  `module:<id>:cover` / `campaign:<id>:cover`, and the unattended cover
  queue (`src/features/covers/cover-image-queue.ts`) fills them through the
  shared `buildImagePrompt` + `assembleImagePrompt` + `generateImages` +
  `intakeImage` + `createJobQueue` seam with delete-after-replace regen.

### Settings

Add `imageModel: string` (default `'google/gemini-2.5-flash-image'`) and
`imagesEnabled: boolean` (default false). Settings UI: text input + toggle in
a new "Images" section, with a model combobox fetched from
`/models?output_modalities=image` (server-side filter; client-side filtering
on `architecture.output_modalities` remains the fallback for the shared
`listModels` response). A `fallbackImageModel: string` ('' = no fallback)
adds the escalation tier: `generateImages` walks
`[primary, fallbackImageModel]` on ANY failure of the first-try model (owner
2026-09-07: "ANY ERROR, ANY AT ALL should lead to the fallback" — content
filters, congestion, typed OpenRouter error envelopes, empty responses; the
chain is the bound), reports the model that actually produced the images as
`modelUsed`, and image rows persist that. A single-entry chain's failure
names the config gap ("no fallback image model is configured — set one in
Settings → Image generation"); an escalation fallback and partially filtered
candidates surface as persisted step notices. Structure-first edits
(input_references) skip a fallback the cached `/models` data knows is
text-to-image only.

### Generation client (`/src/llm/imageGen.ts`)

OpenRouter's dedicated Image API (current docs — the older chat-completions
`modalities` route is no longer documented): `POST /api/v1/images` with
`{ model, prompt, n, output_format: 'webp' }` →
`{ data: [{ b64_json, media_type }], usage: { cost, … } }`.

```ts
async function generateImages(
  prompt: string,
  n: number,
  opts: { model: string; signal?: AbortSignal },
): Promise<{ images: Blob[]; costUsd: number | null }>;
```

- One call with `n: 2` yields both candidates — no sequential calls. Decode
  each `b64_json` (with its `media_type`) → Blob → `imageIntake`.
- Same retry/error policy as `chat()` (429/5xx, 2s/8s, typed errors). No
  streaming. Separate client, same header set (`Authorization`,
  `HTTP-Referer`, `X-Title`).
- Surface `usage.cost` (USD) on the run so the UI shows what a generation
  spent — same honesty as failed runs saying WHY.

### Illustrator persona (slug `illustrator`)

> **Owner amendment (2026-09-05, c3c021f):** prompt-draft no longer runs an
> LLM call (no chat, no repair retry) — the prompt is assembled
> deterministically from the artifact's own data. Owner, verbatim: "i thought
> we ripped that out… I dont want that extra LLM call. Just use the
> appearance/body."

Not a normal artifact-producing persona — it decorates an **existing**
artifact. Run steps:

1. **prompt-draft** (deterministic, no LLM): assembled from the artifact's own
   data (name, kind, appearance/summary/body — the contract lives in
   `buildImagePrompt`, see 04 §Image personas). The step output keeps the
   `{ prompt, negative, styleNotes }` shape so run history and the editable
   checkpoint are unchanged. This is the checkpoint that matters: in
   `manual`/`review` the user edits the *prompt*, which is far more effective
   than rerolling images.
2. **generate**: produce **2 candidates** in a single `/images` call
   (`n: 2`), store both as StoredImage.
3. **pick** (always `awaiting_user`, all autonomy levels): user picks 0–2 to
   keep; kept ids appended to `artifact.imageIds`, first pick offered as cover.
   Unpicked candidates are deleted.

Engine notes: `PersonaRun.targetArtifactId` **already exists** (review runs
use it — no migration needed); the illustrator reuses it as the decoration
target. The run engine must branch: personas with `producesKind` create
artifacts (existing path); the illustrator requires `targetArtifactId` and
never creates one. `Persona.producesKind` becomes optional
(`persona.ts` — update the zod schema, the seeds, and every consumer); the
illustrator has none and is explicitly **not chainable** — `chainRunner` and
`moduleForge` reject chain steps whose persona lacks `producesKind`.
Update `04-LLM-PERSONAS.md` in the same task: persona table row, the
`producesKind` type, and the autonomy table — the pick step introduces a
pause that applies on **every** autonomy level (04 currently says `auto`
pauses only on `needs_review`; that gets this one documented exception).

### UI

- Artifact editor: "Images" section — cover thumbnail, gallery strip,
  Upload button, "Illustrate…" button (opens persona panel pre-set to
  Illustrator with this artifact as target). Click → lightbox dialog with
  Set-as-cover / Delete.
- Tree rows and (later) Session Mode cards show cover thumbnails when present.

### Export

- JSON/zip export: images go into the zip as `/images/<id>.<ext>` (extension
  per the stored `mimeType`), referenced by id in the JSON; import restores
  them. Plain (non-zip) JSON export omits image binaries and notes that in
  the export dialog.
- pdfmake: images embedded via data URLs (pdfmake accepts them directly);
  downscale to ≤ 1024px for PDF to keep file size sane.

### Acceptance

- Upload a JPG → stored at ≤ 1600px with the *actually encoded* `mimeType`
  (WebP where the browser supports it, PNG otherwise), shown as a thumbnail in
  the tree and the editor's Images section.
- Illustrate an NPC (manual): the prompt-draft checkpoint is editable; one
  `/images` call yields 2 candidates; picking 1 sets the cover and deletes the
  other; the run shows the spent `usage.cost`.
- Deleting an artifact does not delete an image still referenced by one of its
  revisions; deleting the last referencing artifact removes the blob.
- **M4-C amendment (user-initiated deletes)**: `removeImageFromArtifact`
  (shared by the editor's Images section and the module reader's image
  checkboxes) detaches the image AND scrubs the id from the artifact's own
  revision snapshots, so a confirmed delete actually frees the blob while
  other artifacts'/revisions' references still block deletion. Restored
  history shows the entity without the deleted image.
- Zip export/import round-trips an image; plain JSON export omits binaries and
  the dialog says so. Schema-migration defaults are covered by `pnpm test`.

---

## M3-B — Encounters carry real stats

### Schema change (`encounterDataSchema.monsters` entries)

```ts
const monsterSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('npc-ref'),  artifactId: z.uuid() }),   // links an NPC artifact
  z.object({ type: z.literal('inline'),   statBlock: statBlockSchema }), // one-off, embedded
  z.object({ type: z.literal('rulebook'), chunkId: z.uuid() }),      // ingested statblock chunk
  z.object({ type: z.literal('none') }),                             // name-only entry
]);
const monsterEntrySchema = z.object({
  name: z.string(), count: z.number().int().positive(), notes: z.string(),
  source: monsterSourceSchema,
});
```

Dexie upgrade: existing encounter entries get `source: { type: 'none' }`.

### Resolution helper (`/src/domain/encounterResolve.ts` + repo support)

`resolveMonsterEntry(entry): Promise<{ statBlock: StatBlock | null; origin: string }>`
— fetches the NPC artifact / rule chunk as needed; `origin` is a display
string like "NPC: Vexra" / "Bestiary p.132" / "inline". Handle dangling refs
(deleted NPC/book) by returning null stat block + origin "missing ref"; the UI
shows a warning badge, never crashes.

### Encounter editor UI

Each monster row: name/count/notes plus a **source selector**:
- "Link NPC…" → combobox over campaign NPCs (with stat blocks first)
- "From rulebook…" → search dialog restricted to `chunkType:'statblock'`,
  reusing the rules-search components
- "Inline stats" → embeds the stat-block form (same component as NPC editor)
- default "none"

Below the list, a **"Stat blocks" panel** renders every resolved stat block as
cards (count badge, origin badge) — this is what the GM reads in play.

### Encounter Designer persona update

The draft prompt instructs: for each monster, prefer citing a provided
rulebook stat-block excerpt (persona receives chunk ids alongside excerpts and
outputs `{ ..., sourceChunkIndex?: number }` per monster, mapped back to
`{type:'rulebook', chunkId}`); otherwise output a full inline StatBlock. The
retrieve step for this persona adds a second search restricted to
`chunkTypes:['statblock']` using the monster-ish nouns of the brief — the
`chunkTypes` filter **already exists** in `searchRules`, so only the retrieve
step composes a second call.

### Acceptance

- An encounter entry linked to an NPC artifact resolves and renders its stat
  block with origin badge "NPC: <name>"; deleting that NPC leaves a visible
  "missing ref" warning badge instead of a crash.
- A rulebook-sourced entry resolves from the chunk (origin "Bestiary p. N");
  an inline entry embeds the stat block via the NPC editor's stat-block form.
- Migrating pre-M3 encounters yields `source: {type:'none'}` and renders
  name-only rows; the Encounter Designer cites rulebook chunks when the
  retrieve step finds matching statblock chunks.

---

## M3-C — Session Mode (play view)

New route `/c/:campaignId/play`, entered via a prominent "Play" button in the
top bar (rendered only on campaign-scoped routes, resolved via the shared
`campaignIdFromPath`). **Read-first, link-driven, zero forms.** Dark,
high-contrast, larger base font (`text-base`→`text-lg` scale). No autosave
machinery: the only writes are the quick log and scene check-offs.

### Layout

Three zones:

1. **Focus header** (top): the current focus artifact — normally a Location.
   Name, cover image, summary, read-only body (markdown). Breadcrumb trail of
   recent foci (last 5, clickable). "Set focus…" opens the quick-find.
2. **Context grid** (main): everything **one link-hop** from the focus
   (both directions — incoming and outgoing links), grouped by kind:
   - *NPCs here*: card = portrait, name, one-line summary; appearance and
     personality rendered directly (M4-C: no "More" expander — the reader
     scrolls); the stat-block card renders inline when the character has one
     (M4-C: the draft decides `needsStatBlock` — contacts/merchants skip it
     entirely, the run row shows the step as skipped).
   - *Encounters*: card with difficulty badge; resolved stat blocks rendered
     directly (reuse M3-B panel).
   - *Connected locations*: compact cards; **clicking one moves the focus**
     (this is the navigation model — the link graph as a map).
   - *Factions / Notes / Plot arcs*: collapsed rows, expand on click.
   Each card has a small ✎ that opens the artifact in the workspace
   (new-tab-style route change is fine; do not embed editors here).
3. **Session rail** (right, collapsible):
   - Active session selector (Session artifacts, newest first; "New session"
     creates one).
   - **Scenes checklist** — requires extending `sessionDataSchema` with
     `scenes: { title: string; done: boolean; artifactId: Id | null }[]`
     (Dexie upgrade: default `[]`). Checkboxes persist immediately; a scene
     with an artifactId gets a "focus" jump button.
   - **Quick log**: one text input; Enter appends `- HH:MM <text>` to a new
     `log: string` field on session data (upgrade default `''`). Rendered
     below as read-only markdown. This is deliberately dumb and fast.

### Quick-find (`Ctrl+K`, also available in workspace)

Command-palette dialog (`/src/features/quickfind/`), built on the existing
cmdk `Command` primitives (`src/components/ui/command.tsx`, already used by
the settings model combobox): one input searching **artifacts** (name/tags/summary/aliases via a MiniSearch index over the campaign) and
**rule chunks** (existing `searchRules`) in two result groups. Enter on an
artifact: in play mode set focus, in workspace open editor. Enter on a chunk:
inline expandable preview inside the palette (GM checks a rule without losing
the page), with "Pin to Assistant" available.

### State

`playStore` (zustand): `focusArtifactId`, `focusHistory: Id[]`,
`activeSessionId`, `railCollapsed`. Persist focus/session per campaign in
`localStorage` (not Dexie — device-local ephemera).

### Acceptance

- From a campaign with linked Location↔NPC↔Encounter data: open Play, focus a
  location, see its NPCs/encounters/neighbors; click a neighbor → focus moves;
  reveal a secret; check off a scene; add a log line; Ctrl+K finds a grapple
  rule. Reload restores focus and session. No editing forms anywhere in Play.

---

## M3-D — The module PDF (the module IS the document)

Modeled on how commercial adventure modules are actually built — the reference
here is the Age of Ashes hardcover in `Sample rules/` (Zeit der Asche, 554
pages): curated chapter/part hierarchy, area entries with difficulty budgets in
the header, boxed read-aloud prose, inline stat blocks, per-area labeled
sections (Treasure / Development), and auto-generated back matter (NPC gallery,
treasure ledger).

**The document is DERIVED, not authored** (owner's decision, verbatim: *"I think
this can be completely simplified, no need to have 'deliverables' at all, just
export decisions if needed."* — docs/17 row 108). There is no deliverable
entity, no outline, no page, no route and no nav entry: the module row already
carries the premise, the part plan and the parts, and its artifacts are already
in the tree, so the PDF is a RENDER FUNCTION over what exists. A second authored
copy of the module could only drift from it.

### The source of the document

| Printed | Read from |
|---|---|
| Cover (title, concept, system, "Compiled with Campaigner · date") | the module row + optional `coverImageId` |
| Contents | pdfmake `toc` over the chapters below (real page numbers) |
| Premise | `module.spine.premise` |
| Part plan | `module.spine.partPlan` (GM document only) |
| Parts | `module.parts`, assembled with `spine.partPlan` through `assembleModulePartsDocument` and re-split with `splitPartsDocument` |
| Kind chapters (locations, events, encounters, factions, party; plot arcs and notes GM-only) | the artifact pool, restricted to rows the module's own text MENTIONS (`[[…]]`) plus rows owned by the module (`moduleId`) |
| Map plates | `encounter.data.mapImageId`, else the live battle's `board.mapImageId` |
| NPC gallery / Treasure ledger | the printed NPCs / the `treasure` fields of the printed encounters (ledger: GM only) |

The parts are read through the **canvas's own seam** on purpose: the stored
document the canvas edits carries `==========` separators and `[Part n of total]`
scaffold labels, and printing that text would put the app's internal editing
scaffolding on a reader's page. `splitPartsDocument` is what removes it, so the
module PDF and the canvas can never disagree about where a part begins.

### GM and player: ONE code path, audience as an option

`buildModulePdf(module, artifacts, generate, { audience })` — the audience is an
argument to the ONE builder (`ModulePdfAudience = 'gm' | 'player'`), never a
second renderer. The player document omits:

- artifacts tagged `gm-only`;
- every `note` artifact, every `plotArc` artifact;
- faction `methods`; encounter `tactics`, `treasure`, `terrain`; PC `notes`;
- the part plan and the treasure ledger (both are GM planning surfaces).

Maps stay in BOTH documents. Two honest consequences of "the display text of a
token, verbatim":

- **The module's premise and part prose print VERBATIM for both audiences.** A
  gm-only row's NAME can therefore appear inside quoted module prose while its
  body, card and chapter never do. That is the correct behavior — the owner
  wrote that prose and it is the module's own text — but it means the player
  variant is not a redaction of arbitrary names, only of GM-only MATERIAL.
- **The spec's literal list disagreed with the code, in both directions, and the
  code is what a reader sees.** `plotarc` was absent from the list above while
  the renderer prints plot arcs (GM-only today); and the treasure ledger
  rendered for the player audience until this arc. Both are recorded here
  because a spec that quietly differs from the renderer is rot (docs/17 "How to
  veto"): the list above is now the shipped rule.

### Maps: a plate where an image exists, and NOTHING where it does not

**Owner's decision, verbatim:** *"Encounter maps should obviously be part of the
PDF. They need to be included at the right places."*

- The plate is printed **at its anchor** — inside the encounter it belongs to,
  immediately after that encounter's header — never collected into an appendix.
- The image is `encounter.data.mapImageId`, and for a battle with a live board
  the board's `mapImageId` is the fallback (the same row the table shows).
- **No stored image ⇒ NO plate.** No schematic, no room geometry, no outline
  drawing, no placeholder graphic. A `data.layout` a row may carry is geometry
  for the table's own renderer and is **never** drawn in a PDF: an approximate
  map on a printed page is a wrong map, and a wrong map is worse than none.
- Maps decode at `PDF_MAP_MAX_LONG_EDGE = 4096` (print quality; the map
  pipeline's own ceiling), covers at `PDF_COVER_MAX_LONG_EDGE = 1024`, and a
  plate is fitted to the content width so a wide map is scaled, never cropped.
- An image that cannot be read or decoded prints a **named placeholder** and is
  reported in the `problems` list the export surfaces (see below).

### Renderer (`/src/lib/modulePdf.ts` + `/src/lib/pdfImages.ts`)

- Cover page, generated table of contents (pdfmake `toc`), chapters as H1 with
  page breaks. Part headers carry a kicker (`PART 1 OF 2 · LEVELS 1–2`).
- Markdown → pdfmake via `/src/lib/mdToPdfmake.ts`: paragraphs, bold/italic,
  h1–h3, bullet/numbered lists, blockquote (→ read-aloud box); html/tables are
  ignored — that limit is the module's own vocabulary, and it stays honest
  (docs/18 §2.3).
- **Kind data renders**: encounter `difficulty`/`levelHint` kickers, monsters
  with counts and **roster origins**, terrain/tactics/treasure; location/event
  `locationType`, `inhabitants`, `pointsOfInterest`, `hooks`; NPC appearance and
  personality; faction goals/methods/resources/ranks; plot arc stakes, beats,
  hooks, climax; PC summary/notes. A roster entry's origin is printed for every
  source: an `npc-ref` cross-reference (an internal link to that row's
  destination), an `inline` stat box (its own box, no origin line), a `rulebook`
  citation's `(see Bestiary)` form, and a name-only entry's **named missing-ref
  reason** (`isMissingRefOrigin`) — never a bare, unexplained name.
- **Images** (the seam, `loadPdfImages`): the requests are collected from the
  document plan, each id decoded ONCE at the LARGER budget it needs, and every
  failure recorded as `{ id, where, reason }`. `loadPdfImages` never throws; the
  renderer prints a placeholder naming the site; `buildModulePdf` returns the
  deduped `problems` list and the export reports it. `assertPdfmakeImageDataUrl`
  fails LOUDLY for a media type pdfmake cannot embed (`jpeg`/`jpg`/`png` only) —
  a WebP data URL once threw inside pdfmake's measurement pass, i.e. outside any
  error handling, so the format boundary is checked at the seam that owns it.
- Dangling artifact refs render as a visible placeholder box ("missing
  artifact") rather than failing the build.

### The export surface

`ModulePdfButton` (`src/features/modules/module-pdf-button.tsx`), mounted in the
canvas header and in the campaign tree's module-group header — ONE component for
both entry points, offering "GM document" and "Player document". The
destination is acquired first, inside the click's gesture window (the
artifact-PDF export precedent), and the finished blob is written to it. The
problems list is REPORTED: a build that recorded any problem announces them by
site instead of claiming a clean export, and a document is still produced (a
broken image never costs the owner the book). The single-artifact GM/handout
exports in the campaign tree are unchanged.

### What was deleted (docs/17 row 108)

`Deliverable`, `deliverableRepo`, `DeliverablesPage`, the seed-from-module path,
the `/c/:campaignId/deliverables` route and nav entry, the outline node model,
and every `deliverables` reference in export/import, backup, maintenance,
census, orphan sweep and auto-promote. Old data is NOT migrated (no
compatibility requirement) but it never disappears silently:

- an old **export file** reports `Skipped N rows from the retired
  "deliverables" table …` on import and imports everything else;
- an old **database** is upgraded by Dexie v21, which drops the table, stores
  the removed row count in `settings.deliverablesRemoved`, and `AppShell` toasts
  it once.

### Acceptance

- A module becomes a PDF with cover, working ToC, premise, part plan (GM), its
  parts with kickers, kind chapters, an NPC gallery and a treasure ledger —
  with **no** `==========` and no `[Part n of total]` anywhere.
- An encounter whose row carries `data.mapImageId` prints its map INSIDE that
  encounter; an encounter with no image prints no plate and no substitute
  geometry.
- The player variant of the same module contains no GM-only artifact, no note,
  no plot arc, no faction methods, no encounter tactics/treasure/terrain, no
  part plan and no treasure ledger — while every map still prints.
- Every roster entry states its origin or its named missing-ref reason.
- An unreadable image (or a format pdfmake cannot embed) produces a named
  placeholder plus a reported problem; the export never fails silently and never
  claims success for a document with problems.
- **Unproven in the test environment** (declared, not implied — docs/17 row 108
  and docs/18 §4 carry the same list): jsdom has no `createImageBitmap` and no
  real canvas, so the REAL decode/encode of a JPEG or WebP byte stream is not
  exercised by any test. The suite covers the seam with (a) a genuine 1×1 PNG
  rendered through the real pdfmake path (asserted as `/Subtype /Image` in the
  produced bytes) and (b) an injected `PdfImageCodec` for the budget and
  failure branches; the browser codec itself is verified by inspection only.

---

## M3-E — Campaign export v2 with dependency manifest

An export carries everything needed to resume the campaign elsewhere:
the campaign row, artifacts + revisions, modules, battles, runs, referenced
images, plus a `dependencies` manifest describing everything the export cites
but does NOT carry. (The `deliverables` table was a v2 member until Dexie v21
deleted it — docs/17 row 108; an old file's rows are COUNTED and reported on
import rather than dropped in silence.)

### Scope: carried vs excluded (owner-confirmed)

| Carried | Excluded (never in the file) |
|---|---|
| Campaign row, artifacts + revisions | `mobPortraits` cache (regenerable shared blobs) |
| Modules, battles, runs | Embeddings (regenerable vectors) |
| Referenced image blobs (zip) / metadata refs (plain JSON) | `pdfFiles` bytes (original PDFs stay local) |
| `dependencies` manifest + `missingImages` note | Personas, settings |
| | Rulebooks/chunks themselves — the manifest replaces them |

### Format v1 → v2

`CampaignExport.version` is `1 | 2` (`EXPORT_FORMAT_VERSION = 2`,
`src/lib/exportImport.ts`). New writes are v2; every v2 field
(`modules`/`battles`/`runs`/`dependencies`/`missingImages`)
is optional, so v1 files still parse unchanged. v1 imports demote
module-owned artifacts to campaign level when their module is not in the
file (v1 never exported modules) — the only silent-looking migration, stated
here instead of hidden in code.

### The manifest (`collectDependencies`, `src/domain/exportDependencies.ts`)

Pure builder over the exported artifacts + runs with the library reads
injected (`DependencyLibrary` maps — the
`resolveMonsterEntry`/`MonsterLookups` precedent): encounter
`source.type === 'rulebook'` entries join chunk → book; run
`pinnedChunkIds` become advisory entries (pins are grounding context, never
hard stats); encounter `npc-ref` entries pointing outside the exported set
become unmet-library entries (`global` = shared-library NPC, `missing` =
deleted row, `not-exported` = campaign NPC outside a selection export).

Per citation: `{artifactId, artifactName, kind, monsterName, bookTitle,
system, creatureName, chunkType, contentHash, citedChunkId}` (+ `status`:
`resolved` | `missing-chunk` | `missing-book`). Per book: `{title, system,
origin, filename?, pageCount, pack{sourceId, sourceRef?, attemptedRefs?,
entriesImported, itemsImported?, sectionsImported?} | null, chunkCount,
citedChunkIds[]}` (`chunkCount` = the book's total chunks in the source
library — how much is NOT carried).

### L0/L1/L2 identity contract

- **L0 — content identity**: `contentHash` (SHA-256 of the chunk text).
  Verifiable with no library at all; two databases agree a citation is
  satisfiable iff a local statblock chunk hashes equal.
- **L1 — logical identity**: `(system, bookTitle, creatureName)`
  (`creatureName` = `chunk.headingPath[0]`, falling back to the roster
  `monsterName` — the same fallback the resolve origin label uses).
  Resolves against an EQUIVALENT book: a re-ingest under a new row id still
  satisfies the citation.
- **L2 — row identity**: `citedChunkId` (plus the source book row).
  Source-DB-only, carried for audit — never expected to match elsewhere.

Every citation carries all three levels; the per-book rollup carries L1+L2
plus the pack provenance needed to re-fetch the same upstream source.

### Images: metadata refs + the loud missing-binary note

Plain JSON lists image metadata refs with `dataBase64: null` (binaries ride
the zip as `images/<id>.<ext>`, or inline with `images: true`). The sweep
covers artifact galleries/covers incl. revision snapshots (M3-A) plus
encounter `mapImageId` and module/campaign `coverImageId` (M3-E). Known gap:
battle-board `mapImageId`s are not swept separately (in practice they repeat
the encounter's map image, which IS swept) — stated, not hidden.

A referenced id with no image row is never silently dropped: it lands on
`missingImages` with every referrer named (`artifact:<id>`,
`artifact:<id>:map`, `revision:<id>`, `module:<id>:cover`). The import
restore loop's plain-JSON skip (`bytes === undefined → continue`) now
operates on these explicitly-modeled null refs; the manifest field itself is
the loud surface slice B (abort-by-default on missing deps) reports from —
this slice only WRITES the honest manifest.

### Import: re-id with reference rewriting

One rw transaction over all eight tables (array form past Dexie's
five-table variadic cap). Modules re-id first; artifacts follow the module
map; battle tokens/`encounterArtifactId` and run result/target artifacts
follow the artifact map (unknown ids survive verbatim for selection exports). `dependencies`/`missingImages` are
zod-validated metadata, not imported.

### Acceptance

- Golden manifest: a Monster-Core encounter cites `{bookTitle,
  contentHash, …}` with the pack provenance rollup; run pins land as
  advisories.
- Whole-campaign round-trip restores modules/battles/runs with references
  rewritten to the new ids; images restore from zip/inline blobs. Rows for a
  RETIRED table are counted and reported, never silently dropped.
- v1 files import unchanged; `tests/backup.test.ts` stays green (untouched).
- A dangling image ref appears on `missingImages` with its referrers named.

---

## Suggested order & scope guard

A → B → C → D (C depends on nothing from A/B except cover thumbnails and the
stat-block panel, but doing it third means Play mode is complete on arrival).
Each letter is its own task with its own acceptance check and commit — each is
the size of a whole M1 task; run the `00-OVERVIEW` gate
(`pnpm lint && pnpm typecheck && pnpm test`) before every commit.

Out of scope for M3: battle maps, initiative tracking, dice, image editing,
multi-page image layouts, OCR, hazard/environment data blocks. Do not add them.

## References

- OpenRouter Image API: `openrouter.ai/docs/guides/overview/multimodal/image-generation`
  (dedicated `/api/v1/images`; chat-completions `modalities` route no longer
  documented as of 2025-09).
- Professional structure reference: `Sample rules/US57013PDF_Zeit_der_Asche_LZ_meta.pdf`
  (Age of Ashes hardcover) — chapter/parts overview with level checkpoints,
  lettered areas with difficulty budgets, boxed read-aloud prose, inline
  KREATUR stat blocks + GEFAHR hazard blocks, per-area labeled sections, NPC
  gallery / rules elements / treasure ledger back matter.
