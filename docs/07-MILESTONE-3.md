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

- `ArtifactBase` gains `imageIds: Id[]` and `coverImageId: Id | null`.
  Migration: default `[]` / `null` on all existing artifacts (upgrade fn).
- **Revision snapshots copy the id references only** — never image data.
  Deleting an artifact deletes images not referenced anywhere else in the
  campaign — the reference check must cover **artifacts and revisions**
  (revision snapshots keep `imageIds` so restored history still renders)
  before deleting a blob.
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

### Settings

Add `imageModel: string` (default `'google/gemini-2.5-flash-image'`) and
`imagesEnabled: boolean` (default false). Settings UI: text input + toggle in
a new "Images" section, with a model combobox fetched from
`/models?output_modalities=image` (server-side filter; client-side filtering
on `architecture.output_modalities` remains the fallback for the shared
`listModels` response).

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

Not a normal artifact-producing persona — it decorates an **existing**
artifact. Run steps:

1. **prompt-draft** (LLM, text): given the artifact (name, summary, kind,
   appearance/description fields, campaign tone), produce
   `{ prompt: string, negative: string, styleNotes: string }` (zod-validated).
   This is the checkpoint that matters: in `manual`/`review` the user edits the
   *prompt*, which is far more effective than rerolling images.
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
   - *NPCs here*: card = portrait, name, role, one-line summary;
     personality/voiceNotes/motivation rendered directly (M4-C: no "More"
     expander — the reader scrolls); **secrets rendered as click-to-reveal
     blurred blocks** (screen-peek safe); the stat-block card renders inline.
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
the settings model combobox): one input searching **artifacts** (name/tags/summary via a MiniSearch index over the campaign) and
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

## M3-D — Module PDF deliverable

Modeled on how commercial adventure modules are actually built — the reference
here is the Age of Ashes hardcover in `Sample rules/` (Zeit der Asche, 554
pages): curated chapter/part hierarchy, area entries with difficulty budgets in
the header, boxed read-aloud prose, inline stat blocks, per-area labeled
sections (Treasure / Development), and auto-generated back matter (NPC gallery,
treasure ledger). A publishable adventure-module PDF built from an explicit,
user-curated outline — **never derived implicitly from the tree**.

### New entity

```ts
interface Deliverable extends BaseEntity {
  campaignId: Id;
  title: string;
  subtitle: string;
  audience: 'gm' | 'player';    // player: secrets/GM-only stripped
  coverImageId: Id | null;
  outline: OutlineNode[];
}
type OutlineNode =
  | { type: 'chapter'; title: string; children: OutlineNode[] }   // page-break banner, ToC entry
  | { type: 'part'; title: string; children: OutlineNode[] }      // group header inside a chapter, no page break
  | { type: 'artifact'; artifactId: Id; include: { body: boolean; data: boolean; statBlocks: boolean; images: boolean } }
  | { type: 'text'; markdown: string }    // interstitial prose
  | { type: 'gallery'; gallery: 'npcs' | 'treasure' };            // auto-generated back matter
// table: deliverables: 'id, campaignId'
```

The node set mirrors the book's skeleton: **chapter** = Kapitel (banner page),
**part** = Teil (grouping header), **gallery nodes** are the back matter the
book puts in appendices — `npcs` is the NSC-Galerie (every NPC artifact, stat
box each), `treasure` is the Schätze appendix (a ledger aggregated from the
`treasure` fields of all included encounter artifacts).

### Rendering conventions (the book's craft, mapped to pdfmake)

- **Read-aloud boxes**: markdown **blockquotes** in any artifact body render as
  bordered, shaded, italic "read aloud" boxes. The book marks player-facing
  prose purely visually (no textual marker); we make the convention explicit
  and reuse it later in Play mode. Document it in the editor's body placeholder.
- **Area headers with difficulty**: an encounter artifact renders its title
  with a difficulty kicker — `difficulty` and `levelHint` already exist in
  `encounterDataSchema`, and the book prints exactly this in area headers
  ("Durchschnittlich 1", "Ernsthaft 2").
- **Labeled sections per kind** (the book's per-area structure: description →
  creatures → treasure → development), rendered from kind data:
  NPC → role / appearance / personality / motivation / voiceNotes / secrets;
  Faction → goals / methods / resources / ranks; Encounter → monsters
  (resolved via M3-B, with count badges), then terrain / tactics / treasure as
  labeled paragraphs; PlotArc → premise / stakes / beats / hooks / climax;
  Session → number / recap / prep / open threads.
- **Inline cross-references**: artifact links render as "see <name>" with a
  pdfmake internal link to that node's ToC destination when the target is in
  the outline; plain italic name otherwise (the book's "siehe Teil 4" pattern).
- **Kicker lines instead of running headers**: pdfmake header callbacks cannot
  know the current chapter, so every part/artifact header carries a small-caps
  kicker with its chapter title; the footer carries
  `<deliverable title> · page N`. Cover page: title, subtitle, cover image,
  "Compiled with Campaigner · <date>".
- **Stat boxes**: bordered two-column box (reuse the export templates' layout
  concepts). Hazard/environment blocks (the book's GEFAHR entries) are out of
  scope until the data model has a hazard type — note for the future.
- **Images**: thumbnails at ≤ 45% width via `columns` (pdfmake has no float);
  an artifact's cover image may span full width when the outline includes
  images and the artifact is a Location.

### Renderer (`/src/lib/modulePdf.ts`, extends the pdfmake setup)

- Cover page, generated table of contents (pdfmake `toc`), chapters as H1 with
  page breaks, parts as H2, artifacts as H3.
- Markdown → pdfmake via `/src/lib/mdToPdfmake.ts`: paragraphs, bold/italic,
  h1–h3, bullet/numbered lists, blockquote (→ read-aloud box); ignore
  html/tables — document this limit.
- `audience:'player'`: omit NPC `secrets`, faction `methods`, encounter
  `tactics`/`treasure`, all Notes, and any outline node whose artifact is
  tagged `gm-only`. Read-aloud boxes and public body prose survive — the
  player variant of an area reads like the book's boxed prose, which is
  exactly what the box convention is for.
- Dangling artifact refs in the outline render as a visible placeholder box
  ("missing artifact") rather than failing the build; a gallery node over an
  empty set renders nothing (the builder UI notes it).

### Builder UI (`/c/:campaignId/deliverables`)

Left: deliverable list (+ create). Right: outline editor — nested list with
add-chapter / add-part / add-text / add-artifact (quick-find picker) /
add-gallery, up/down/indent reordering buttons (no drag-and-drop libs),
per-artifact include toggles, audience switch, cover picker (campaign images).
"Generate PDF" button → progress → download. Also "Seed from Module Forge
output" if a forge run exists: chapter per session group, the arc as lead
artifact, gallery nodes for NPCs and treasure.

### Acceptance

- A 3-chapter outline mixing text nodes, locations with images, NPCs with stat
  blocks, and an encounter produces a PDF with cover, working ToC page numbers,
  chapter banners with kickers, boxed read-aloud quotes, two-column stat boxes,
  images at ≤ 45% width, and NPC-gallery + treasure-ledger appendices rendered
  from campaign data.
- The player variant of the same deliverable contains no secrets, no GM-only
  nodes, and no encounter tactics/treasure — its area prose reads as the boxed
  read-aloud text.
- A dangling artifact reference renders a visible placeholder; the build never
  fails on missing data.

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
