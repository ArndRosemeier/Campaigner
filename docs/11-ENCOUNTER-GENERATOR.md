# 11 — Encounter generator: generated battlemaps, room layouts and veils

Adds a **fully generated encounter** to Campaigner: an LLM drafts the design
(rooms, roster, tactics), deterministic code turns it into a **grid layout**
(rooms as rectangle unions, corridors, doors), a canvas renderer draws a
**schematic map**, an OpenRouter image model **stylizes** it under a
structure-preserving contract, and an optional **vision check** flags drift.
The result is an `encounter` artifact whose battles seed with **mobs placed in
their rooms and one veil per room** — the party reveals the fight room by
room, exactly the GM-Cockpit veil mechanic M5 already runs.

Binding conventions from `00-OVERVIEW.md §Global conventions` and `AGENTS.md`
apply throughout (no silent fallbacks; zod at every boundary; failures loud;
progress via the shared dock; one logical task per commit).

## Position in the roadmap

- Builds on **M5**: `encounter` artifacts, battle veils and the table surface.
- Builds on completed **M6**: derived Global/Campaign/Module ownership,
  module-anchored battles, `seedBattleFromEncounter(campaignId, moduleId,
  encounterId)`, and the module reader as the only play view.
- All new designed content stays on the `encounter` artifact (which may be
  global); the battle-row addition is additive. The next schema version is
  **Dexie v12**, after M6's v10 ownership and v11 play-retirement migrations.

## Naming (binding)

The **encounter generator** authors designed content (artifact). The live run
stays **battle**. The new persona is the **Encounter Cartographer** (`slug:
'encounter-cartographer'`); its run mode is `'encounter'` (extends
`personaSchema.mode`). The map+layout data on the artifact is the
**layout**; the room-cover veil on the board is a **room veil**.

## Decisions (binding, settled with the user)

| # | Decision |
|---|---|
| D1 | **Standalone generator**: a run creates a complete `encounter` artifact from a brief — roster included — plus layout, map and room veils. It also runs in a **regenerate** mode against an existing encounter (same or edited roster): name, links and body survive; layout + map are replaced. |
| D2 | **Two autonomies**: interactive runs use the run-engine autonomy (manual/review pause at the checkpoints below; map pick always pauses, M3-A rule). **Unattended auto runs** (module generation) never pause: one stylize candidate, no pick gate — the `entity-image-queue` precedent (08 §M4-C). Any failure fails that encounter loudly; the batch continues. |
| D3 | Rooms are **unions of rectangles** (1 rect = plain, 2–3 rects = L/T shapes). Every room carries a **mob sub-rectangle** (`mobsRect`) inscribed in the union — it is both the mob placement area and the room's veil footprint. |
| D4 | **One veil per room**, kind `fog`, exactly `mobsRect`. Corridors stay open (GM can add fog manually). |
| D5 | **Token art is not generated**: npc-backed tokens use the artifact's cover/portrait, seedFighter tokens use the deterministic initials fallback (M5-D behavior). No image calls for tokens. Amended 2026-09-05 by afa23f4/070d4ba/64b30f9 (mob-artifact arc): *rulebook-cited creatures become real mob artifacts — ONE `npc` artifact per campaign per cited chunk — and gain a one-click owner-ratified portrait batch ("Generate mob portraits"); every other seedFighter token keeps the initials fallback. See "D5 amendment — mob portraits" below.* |
| D6 | **Geometry is layout-anchored, never screen-anchored.** When a battle carries the map layout, every cell metric — veil spans, veil resize quantization, token snapping, the visible grid overlay, token size — derives from `boardWidth / cols` (normalized), never from a fixed CSS-px grid. Without a layout the current behavior is unchanged. |
| D7 | **Structure-first**: geometry exists as data *before* any pixels; the image stylizes a rendered schematic; geometry is **never read back from pixels**. The vision check only flags drift for human review — it can never repair or invent geometry. |
| D8 | **Effect markers are geometric showpieces** (encounter-resume arc, owner-ratified): the battle surface stamps disc/square zones as an additive `board.effects` array — normalized center, `sizeCells` in grid cells (the D6/D7 rules apply verbatim: layout-anchored, never screen pixels), `TOKEN_STAMP_COLORS` fill at ~70% transparency (fill alpha 0x4d, border 0xcc — static, never opacity swings), optional non-stat label. Board material: rendered in BOTH GM and player views; never initiative members, never coverage-hidden (they are not tokens); carried by the stage snapshot; scenery lock gates their moves like veils. |
| D9 | **Room keys & mob treasure are GM-only text that travels with its structure** (owner-ratified, 2026-09-07): every layout room carries additive `key`/`keyTreasure` (persisted ON the room — `packRooms` rotates brief rooms, so a parallel roomId-keyed array would orphan), every roster entry carries additive `treasure` (persisted ON the entry — the editor removes roster rows, so an index-keyed array would orphan). The encounter editor edits them; battle seed freezes roster `treasure` onto each token (frozen-copy precedent, initiativeBonus); the battle surface renders GM-only key markers at room staging points + a rail key card + a GM-only token-treasure block — none of which mounts in player view (M5-D contract, 09 amendment). Map regeneration replaces room keys with the fresh brief's (accepted, stated in UI copy and the prompt clause). |

### D5 amendment — mob portraits (2026-09-05, owner-ratified; afa23f4, 070d4ba, 64b30f9)

The original D5 was written when a rulebook-cited monster had NO artifact
identity to hang art on. The owner ratified the mob-artifact arc, verbatim:

- **Mob artifacts**: finalize (BOTH remap sites — the Cartographer's map
  finalize and the in-place Smith fill) get-or-creates ONE campaign-scoped
  `npc` artifact per cited chunk. Kind `'npc'` + additive
  `data.monsterChunkId` marker — NOT a new kind, and NOT a `links` entry
  (artifact links are artifact→artifact in every consumer; a chunkId there
  renders as a broken node). The artifact holds the roster creature name +
  the marker; **NO stat duplication** — the chunk stays the source of truth
  (`resolveMonsterEntry` keeps reading it). Idempotent across runs and
  encounters (scan-based lookup mirroring `materializeMonsterNpc`'s
  one-entity-per-name scan). Key = chunkId: cross-book duplicate creatures
  get separate artifacts — acceptable v1; the roster disambiguates by book.
- **Token wiring**: additive optional `mobArtifactId` on the rulebook
  `monsterSource` variant (zod `.optional()` — old rows valid). At seed
  time ALL instances of that entry share `artifactId = mobArtifactId` (the
  npc-ref branch shape) and ONE `seedFighters` row freezes the
  chunk-resolved stats under that artifact id (the
  `byArtifactId.get(id) ?? bySeedId.get(id)` fallthrough in fighterStats
  resolves every instance — the mob artifact itself carries no statBlock).
  Portraits then render via the existing `coverImageId` path in TokenView —
  zero BattleSurface changes.
- **Lazy retro-fill**: existing encounters (no `mobArtifactId`) get their
  artifacts at SEED time (get-or-create during battleSeed's monster
  resolution) — no migration, no finalize requirement. The finalize path
  and the seed path share the same get-or-create helper
  (`src/db/mobArtifacts.ts`); finalize also creates, so the batch action
  works right after generation.
- **Third writer — bestiary roster spawn (2026-09-06, owner-ratified
  single placement)**: the Rules screen's Bestiary tab (12-BESTIARY-PACKS
  §12) spawns a creature into a module directly from its stat-block chunk —
  `spawnMobArtifactIntoModule` get-or-creates via the SAME helper and then
  `stampModuleOwnership`s the artifact into the picked module
  (`module:<title>` tag, one placement at a time; same-module spawn is an
  idempotent no-op, a different module MOVES the artifact with the old tag
  kept as history). No encounter artifact is required — the chunk is the
  source of truth exactly as above.
- **Portrait batch (one-click, not auto)**: an encounter-level
  "Generate mob portraits" action in the encounter editor (beside the
  monsters section). It enumerates the encounter's rulebook entries whose
  mob artifact lacks `coverImageId`; for each, generates n=1 portrait and
  attaches it as cover — the entity-image-queue mechanics (pump / intake /
  deterministic prompt draft / attach-cover) keyed by **artifactId** (the
  queue's wiki-link-name resolution does not fit mob artifacts;
  `src/features/campaign/mob-portrait-queue.ts`). **Prompt grounding: the
  chunk's `text`** feeds `buildImagePrompt` — fresh mob artifacts have
  empty appearance/body, so the creature's stat-block text is the only
  source. **Owner amendment (2026-09-05, c3c021f):** the prompt draft is
  deterministic — no LLM call ("I dont want that extra LLM call. Just use
  the appearance/body."). Failures report loud per mob (`{name, message}`
  style, `entity-batch.ts` pattern); skip-if-imaged guard (existing queue
  behavior) — no re-generation of mobs that have covers.

## Pipeline (run-engine steps)

A new run-engine mode with fixed named steps (same architecture as the image
mode: run row per state change, event emitter for streaming, autonomy via
`pauses()`):

| Step | Kind | Pauses (manual/review) | Output |
|---|---|---|---|
| `brief` | LLM + zod | yes (editable) | theme, rooms w/ purpose + roster + adjacency, entry point |
| `layout` | deterministic | yes (review overlay) | `encounterLayout` JSON |
| `schematic` | deterministic (canvas) | never | in-memory data URL, exact pixel size |
| `stylize` | image API + `input_references` | no (candidates land in pick) | 2 image candidates (1 in auto) |
| `verify` | VLM, flagged only | flags `needs_review` above threshold | mismatch ratio + per-cell diff |
| `pick` | UI | **always** (auto: picks candidate 1 by contract) | kept map image id |
| `finalize` | repo writes | — | encounter artifact updated/created |

- `brief` reads the campaign context like other personas (retrieval + linked
  artifacts) and — in regenerate mode — the existing encounter artifact
  (roster verbatim; the LLM may not rename roster entries).
- `brief` validation is **strict on meaning, tolerant on formatting**: numeric
  strings for counts/indexes are coerced, `styleNotes`/`negative`/`notes`/
  `description` default to `''` when omitted (guidance, not data). Roster,
  rooms, index bounds, connectivity and — for fresh encounters — resolvable
  stat-block sources stay hard requirements. A failed parse produces **named
  issues** (`path: message`, or `monsters[i] "Name": …` for sources); the one
  repair turn quotes them to the model, and a still-rejected step persists
  them as `output.issues` (next to `raw`) so the review card lists them.
  A rejected brief cannot be approved (04 §Autonomy); Retry and Edit remain.
- In **regenerate mode** the model's monster entries carry no stat data: the
  roster (with its stat sources) is preserved verbatim from the target, so
  embedded `statBlock`/`sourceChunkIndex` fields are stripped before
  validation and the prompt asks for `name/count/notes` only. The model's
  roster must match the target's length, and every roster entry must belong
  to exactly one room — both checked at the brief boundary (repairable) so
  they never surface later as run-killing layout errors. Fresh encounters
  without rulebook excerpts get the **complete inline stat-block shape** in
  the prompt; a partial block stays a validation failure.
- `layout` is **pure code** (next section): the LLM never emits coordinates.
  A bounded retry ladder (re-pack with jitter, max 3 attempts, shrinking room
  size classes) ends in a failed run — never a placeholder layout.
- `stylize` prompt contract: style guidance from the brief (medium, palette,
  biome, era) + the binding instruction "keep walls, openings and overall
  structure exactly as in the reference image; no text, no labels, no grid
  lines, no numbers, no tokens/minis, no watermark". `negative` and
  `styleNotes` mirror the Illustrator contract (07 §M3-A).
- `verify` overlays a **coarse** grid (every 2nd cell → ≤ ~12×9 classes) on
  the stylized image and asks the VLM to classify each coarse cell
  `floor | wall | void` — classification, not coordinate regression. Mismatch
  ratio > 0.12 (excluding door cells) marks the run `needs_review` with the
  diff overlay in the pick UI; the user may still keep the map.
- `pick` renders each candidate with the **room overlay** (labeled room
  rects + mobs rect) so the user judges alignment, not just looks.
- `finalize` stores the kept image (`role: 'map'`), writes
  `encounterData.layout` + `mapImageId`, and (regenerate mode) keeps
  `name/body/links/monsters` untouched.

## Layout engine (`src/domain/encounterMap/`, pure TS, vitest-covered)

- `packRooms(brief)`: adjacency graph + per-room size classes → rectangles on
  a fixed grid (`gridW × gridH` chosen from the aspect option, see below),
  1-cell corridors between connected rooms, doors on shared edges. Rooms may
  be unions of 2–3 rects; `mobsRect` is the largest inscribed rectangle minus
  a 1-cell border.
- Validation (all loud): rooms disjoint, corridors 1 cell wide and connected
  door-to-door, exactly one `spawn` room, `mobsRect` area ≥ the room's monster
  count, everything inside the grid. Invalid ⇒ retry, then fail.
- `placeMonsters(layout, roster)`: one free cell per instance inside the
  room's `mobsRect` (deterministic scatter, ≥1 cell apart, doors excluded) —
  reused by the seeder; the layout persists only `monsterIndexes`, placement
  is recomputed at seed time so roster edits never desync stored coordinates.
- `veilsFromRooms(layout)`: one `BattleVeil` per room — kind `'fog'`, center
  normalized from `mobsRect`, `widthCells/heightCells` = the rect's cell
  span. Correct under D6 because cell metrics are layout-anchored on the
  surface.
- `renderSchematic(layout, cellPx)` — canvas: walls dark, floor light, doors
  as gaps, subtle per-room fill; **cell px = 96** (e.g. 24×18 → 2304×1728,
  inside the 4096 map cap). Returns a data URL; nothing stored.

Aspect options in the run dialog: **4:3 (24×18, default)**, 16:9 (28×16),
1:1 (20×20). Aspect selection is a genuine user preference, persisted in
`settings` like the generation language.

## Data model (additive Dexie v12)

```ts
// src/domain/encounterMap.ts (new; re-exported from domain index)
export const layoutRectSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0),
  w: z.number().int().min(1), h: z.number().int().min(1),
}); // grid cells, origin top-left

export const layoutRoomSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** Union footprint (1 = plain rect, 2–3 = L/T shapes). */
  rects: z.array(layoutRectSchema).min(1).max(3),
  /** Inscribed mob area: placement source and the room veil's footprint. */
  mobsRect: layoutRectSchema,
  description: z.string(),
  /** Indexes into `encounterData.monsters`. */
  monsterIndexes: z.array(z.number().int().nonnegative()),
  /** Exactly one room per layout. */
  spawn: z.boolean(),
});

export const layoutCorridorSchema = z.object({
  a: z.uuid(), b: z.uuid(),
  rects: z.array(layoutRectSchema).min(1), // 1 cell wide
});

export const encounterLayoutSchema = z.object({
  gridW: z.number().int().min(12).max(40),
  gridH: z.number().int().min(12).max(40),
  theme: z.string(),           // style summary, reused by regeneration prompts
  rooms: z.array(layoutRoomSchema).min(1).max(9),
  corridors: z.array(layoutCorridorSchema),
});
```

- `encounterDataSchema` gains `layout: encounterLayoutSchema.nullable()
  .default(null)` — the encounter's designed map data (upgrade default `null`;
  artifact revisions snapshot it automatically, D2 of M6).
- `battleBoardSchema` gains `mapLayout: z.object({ cols: z.number().int(),
  rows: z.number().int() }).nullable().default(null)` — stamped from the
  encounter's layout at seed time; `null` keeps today's CSS-px behavior for
  GM-drawn veils on uploaded maps.
- No new tables; the map goes through the existing `images` table
  (`role: 'map'`, 4096 cap). Runs/revisions/storage all reuse existing rows.

## Battle surface: layout-anchored metrics (M5-D extension)

When `board.mapLayout !== null` (D6):

- Cell metrics: `cellWidth = boardWidth / cols`, `cellHeight = boardHeight /
  rows` (normalized at capture, same re-capture-on-mount pattern as the
  staging ground). Veil spans, `resizeVeilFromEdge` quantization and token
  snapping use these, so a veil covers the same map area on every viewport.
- The visible grid overlay renders from the layout
  (`background-size: ${100/cols}% ${100/rows}%`) — it aligns with the
  generated map by construction.
- `tokenSize` re-captures from the measured cell size on mount so portrait
  tokens fill a layout cell.
- Veil/token geometry **stored on the battle stays cell-quantized and
  normalized** — no schema change to `battleVeilSchema`; only the cell-size
  *source* changes. GM-added veils on a layout battle quantize to layout
  cells too (consistent, and still screen-size stable).
- Staging ground: seeded at the `spawn` room's `mobsRect` center.

Without `mapLayout` (uploaded maps): exact current behavior, byte-for-byte.

## Room keys & mob treasure (owner-ratified, 2026-09-07; e489a65 → 01a0b5e)

The encounter generator now authors the GM-only text a live table reads:
what the GM says when the party first enters each room (**room keys**),
what treasure sits in each room (**room treasure**), and what ONE instance
of each creature carries (**mob treasure**). All of it is free-text GM
checklist content — never player-facing, never structured loot output.

### Data model (additive defaults, D9)

- `encounterMapRoomBriefSchema` and `layoutRoomSchema` gain
  `key: z.string().default('')` and `keyTreasure: z.string().default('')`.
  Persisted **on the room**: `packRooms` rotates brief rooms
  (`rotate(brief.rooms, attempt % count)`), so a parallel roomId-keyed
  array could orphan on every retry. `packAttempt` copies both onto the
  packed `LayoutRoom`, and `layoutFromStagingMarkers` copies them through
  the staging rebuild — a key survives rotation, review edits and the
  detector round-trip with its room (test: packing-rotation survival).
- `monsterEntrySchema` (domain + the Smith's draft/brief schemas) gains
  `treasure: z.string().default('')`, persisted **on the entry**: the
  editor removes roster rows, so an index-keyed side array would re-key and
  corrupt. Both finalize remap sites (map finalize + in-place Smith fill)
  persist draft treasure; the regenerate contract copies the target roster
  verbatim INCLUDING treasure ("same names, counts and treasure").
- Keys and treasure are *optional enrichment* defaults (AGENTS rule 1) — a
  brief that omits them parses with `''` and is never rejected over their
  absence; a dropped legacy artifact still reads valid.

### Generation (prompt clauses + retrieval)

- `src/llm/treasureGuidance.ts` (new, unit-tested):
  `treasureGuidanceFor(system)` teaches the shared treasure structure
  (one string per roster entry = what ONE instance carries; hoard-level
  finds go to the encounter's top-level `treasure` / the room's
  `keyTreasure`; permanent/magic items come ONLY from the item pool by
  exact name — never re-stating the pool section, only adding structure
  and budget around it) plus a **per-system budget**:
  - **dnd5e** — Campaigner's OWN documented approximation (pocket treasure
    ≈ 5 × CR in mixed gp-equivalent coins; hoards ≈ 50 gp × average
    encounter level; at most one magic item per two encounter levels). The
    **DMG is not licensable** — no DMG text is quoted, paraphrased or
    restated; the doc you are reading IS the shipped approximation.
  - **pathfinder2e** — the GM Core treasure rules are the law: when the
    retrieved excerpts include the treasure chapter the model follows its
    budgets **VERBATIM** under Paizo's Community Use Policy (personal use);
    no Paizo text ships with Campaigner. Without such an excerpt the model
    gives unquantified treasure instead of inventing amounts — a
    paraphrased budget would be a silent fabrication.
  `roomKeyGuidanceFor()` teaches the Cartographer the key contract: a
  1–3-sentence read-aloud-style key per room + a one-item-per-line room
  treasure checklist; outdoor encounters get keys on their staging areas
  too; and the regeneration consequence ("room keys regenerate together
  with the map").
- The Smith's draft prompt carries `treasureGuidanceFor(system)`; the
  Cartographer's brief prompt carries both clauses plus the
  `,key:string,keyTreasure:string` reply fields.
- Encounter retrieval gains a bounded **third search**
  (`'treasure budget by level party wealth hoard coins'`, limit 3,
  `chunkTypes: ['section', 'table']`) merged into the merged context —
  excerpt grounding for the budget, never a citation channel. The frozen
  citable stat-block search is untouched (pinned at 3 calls).

### Editor, seeding and surface

- **Editor** (`kind-forms.tsx`): a per-row treasure textarea in
  `MonsterListEditor`; a **Room keys** section (only when
  `data.layout !== null`) with one key + room-treasure textarea per room,
  labelled `Room <canonical letter> — <name>`. Edits touch only the key
  fields — room rectangles stay regenerate-only (non-goals). The
  battlemap section states the regeneration consequence ("Regenerating the
  layout & map writes fresh room keys"), and the persona panel's
  pre-filled brief says so for map runs.
- **Seeding**: `battleTokenSchema` gains `treasure` (default `''`,
  mirroring the `initiativeBonus` frozen-copy precedent);
  `tokenFromFighter` takes an optional treasure; `expandRosterEntries`
  stamps `entry.treasure` on every instance token (statless tokens
  included). In-battle spawn shares the same expansion path, so a
  mid-fight spawn inherits the checklist.
- **Battle surface**: key markers derive — never stamp — from the
  provenance encounter's CURRENT layout (useLiveQuery), one tappable badge
  per keyed room at its `stagingPoint` (canonical marker letter), rendered
  before the veils so a covered room hides its key marker exactly like it
  hides its mobs. Only rooms with key content get a marker. Tapping opens
  the key card in the right rail (room header, key text, room treasure,
  `whitespace-pre-line`); background tap and the player-safe toggle clear
  the selection. The selection card gains a GM-only treasure block
  (`data-testid="token-treasure"`) for non-empty token treasure.
- **Player-safe DOM contract (09 §M5-D amendment)**: markers, key card and
  treasure text mount ONLY in GM view — pinned by a contract test
  asserting the key/treasure strings are absent from `document.body`.

## Seeding (`seedBattleFromEncounter` extension)

For an encounter with `layout !== null`:

1. Stamp `board.mapLayout` from the layout.
2. Create the room veils (`veilsFromRooms`) — kind `'fog'`, one per room.
3. Place each roster instance on a free cell of its room's `mobsRect`
   (`placeMonsters`), `visible: true` — the room veil removes it from the DOM
   and initiative (the existing player-safe mechanic; **reveal = GM lifts the
   veil**, and reconcile already auto-rolls revealed fighters).
4. Spawn PCs in the spawn room's `mobsRect` instead of the default center.

Roster entries without stats keep today's loud statless path, placed in their
room like everyone else. `layout === null` encounters seed exactly as today.

## LLM/image client changes

- `imageGen.ts`: optional `inputReferences: { dataUrl: string }[]` on
  `POST /api/v1/images` → `input_references: [{ type: 'image_url',
  image_url: { url } }]` (OpenRouter's documented edit contract). The
  deterministic rescale-to-aspect guard runs before intake: a stylized image
  that came back with a different aspect is letterboxed/cropped to the exact
  layout aspect on the canvas **before** `intakeImage`, and the guard's action
  is recorded on the step output (never silent).
- `openrouter.ts`: `ChatMessage.content` widens to `string | content parts`
  (`{ type: 'text' | 'image_url', … }`) for the `verify` call; response
  parsing unchanged (text-only output expected from the verify model).
- Verify model: `settings.encounterVerifyModel` (dedicated setting; its
  browse list only offers models with `input_modalities=image` and text
  output), falling back to `settings.defaultChatModel` when empty. A
  non-vision model fails the step loudly with a pointer to the setting;
  if the model returns invalid JSON the existing one-shot repair retry
  applies, then the step fails loudly.

## Persona + run engine

- New built-in persona `encounter-cartographer`, `mode: 'encounter'`,
  `producesKind: 'encounter'` (mode enum and the `producesKind` refine extend).
- Run engine: step list above; `brief` and `layout` are user-editable
  checkpoints (the layout editor shows the rendered schematic + overlays);
  `stylize`/`verify` never pause; `pick` pauses on every autonomy except the
  unattended queue path (D2). Verify above threshold ⇒ `needs_review`
  (review/manual) — in auto runs a failed verify **fails the run** loudly
  (module generation must not silently accept a broken map).
- Run panel: generic step rendering plus two new step UIs — the layout review
  (schematic + room overlay, **Regenerate layout** button) and the map pick
  (candidates with overlays). Room rects are **not** hand-editable in v1
  (regenerate instead — D2's "later refinements" = edit the roster/brief and
  re-run).
- Standalone entry points: persona panel (new encounter from a brief), the
  encounter editor's Battlemap section (**Generate layout & map** /
  **Regenerate** — sits beside today's Upload battlemap), and the encounter
  editor's **content** section (**Generate with AI** / two-step
  **Regenerate with AI**): a targeted Encounter-Smith run that writes roster,
  terrain, tactics, treasure and prose INTO the existing artifact — preserving
  its name (the model's name becomes an alias), links, tags, images and
  battlemap. This is the intended path for module stubs. The Battlemap section
  refuses an encounter with an empty roster and points at the content run.
  The battlemap section previews the map on file (click → lightbox) with the
  stored layout's room count; the pre-filled brief words the run as
  "Generate…" for a mapless encounter and "Regenerate…" only when a map
  exists.

## Module generation integration (the unattended path)

- The module entity workflow (08 §M4-C) gains `encounter` as a stub kind:
  `ENTITY_KINDS` extends with `'encounter'`, the stub persona map gains an
  Encounter-Smith slug for modules, and the entity panel offers encounter
  generation like the other kinds.
- A batch queue (the `entity-image-queue` pattern: shared progress dock, one
  job per encounter, failures loud per job, queue continues) runs the
  generator in **auto** for every module-owned encounter lacking a layout —
  triggered from the module view ("Generate encounter maps") and available to
  the forge's post-pass. This is the D2 unattended contract; no pick pause.
  The persona panel's "Generate a battlemap" creation extra rides this same
  queue (05-UI §Assistant tab); campaign-level encounters enqueue with a null
  `moduleId` and keep the D2 unattended semantics unchanged.
- Encounters produced here are module-owned (`moduleId`, M6-B semantics) and
  battle-ready via the module view's Run battle.

## Cost & latency (per encounter, indicative)

Manual run: 2–3 chat calls (brief, verify, optional repair) + 2 image calls
(schematic stylize candidates). Auto/module batch: 2 chat + 1 image call per
encounter. Image calls ride the existing 5-minute headers timeout. Progress
docks on the shared `useProgressStore` job for batch, on run steps for
interactive runs.

## Entrance/exit spawn zones (2026-09-05; 4b6db55, 97f8252, aea57a5)

A generated layout carries **one entrance zone** on the spawn room: the gap
in the outer wall the party enters through. The zone exists in four layers,
all anchored to the layout (D7):

- **Geometry** (`LayoutRoom.entrance` — C1, `4b6db55`): the entrance cell +
  outward side, placed deterministically — the outer-wall cell farthest from
  the room's own corridor doors (Manhattan min; ties → nearest grid edge →
  (y, x) → fixed north/west/east/south side order); omitted when no outer
  wall is reachable. The schema rejects entrance-carrying non-spawn rooms,
  cells outside the room union, sides that do not face the outer wall, and
  openings into corridors. `observed {x, y}` (0..1, positions only) is the
  ONLY pixel-derived field — the sanctioned stagingPoint-style exception to
  D7, absorbed at pick review.
- **Marker vocabulary** (schematic + detector, C1/C2): the schematic paints
  the wall gap, a landing pad, and one solid neon triangle (tip 0.30·cellPx
  inward, base 0.60·cellPx ⇒ measured blob circularity ≈ 0.73 at stylize
  scale; room discs ≈ 1.0). The hue is `entranceMarkerConfig(rooms.length)`
  = the canonical palette entry one past the room count — rooms consume
  `CANONICAL_ROOM_MARKERS` strictly in order, so the entrance hue can never
  collide with a room hue. At 10 rooms the palette is exhausted: no marker
  is drawn or detected and detection is skipped (the layout geometry stays
  authoritative; placement is unchanged). The triangle never gets a disc or
  a plaque.
- **Prompt & detection wiring** (C2, `97f8252`): the stylize prompt declares
  the entrance gap + triangle and the keep-structure line names the gap;
  detection pairs triangle-shaped blobs only with the entrance target
  (`MarkerTarget.shape: 'triangle'`, circularity window [0.45, 0.8],
  shape-exact tiebreak in the greedy assignment so a disc target can never
  steal the triangle blob at equal hue distance). ADJUDICATED: entrance-
  carrying layouts KEEP the packed geometry in every candidate — corridor +
  room rects are never replaced by marker-derived staging layouts; only
  `observed` is absorbed. No detected triangle ⇒ no candidate ⇒ finalize
  uses the packed layout verbatim. Layouts WITHOUT an entrance keep
  today's marker-staging candidate path unchanged (their own pins).
- **Verify + seed** (C2/C3): `coarseDriftTolerances` extends the default
  comparison exclusion (door cells) with the entrance gap and its outward
  landing cell — the floor-colored opening is expected drift, not a
  mismatch. Seeding anchors the party at the entrance (see below) and the
  table surface renders an emerald cell overlay with an inward triangle.

### Seeding extension (C3, `aea57a5`)

`seedBattleFromEncounter` anchors the staging ground at the entrance:
`stagingBlockRect` — the spawn room's `mobsRect` slid along the entrance
axis until it hugs the entrance wall while staying inside the room union —
and stamps `board.entrance` (normalized cell center + side) for the
BattleSurface overlay. Retrofitted at seed time — **no migration**: old
battle rows parse with `entrance: null`, and re-seeding any encounter whose
layout lacks an entrance reproduces the pre-entrance behavior byte-identical
(mobsRect ground, no stamp).

### D4 exception — spawn-room fog with an entrance (2026-09-05, adjudicated; implemented in `aea57a5`)

> **D4 amendment:** when the encounter layout carries an entrance, seed
> skips the spawn room's fog veil.
>
> Rationale, verbatim from the adjudication: *"the party is standing in the
> spawn room when the battle opens — the entrance is the way in, so the
> room they occupy cannot begin veiled."* The GM reveals the remaining
> rooms as before.

Layouts without an entrance keep D4 exactly: one fog veil per room, exactly
`mobsRect`, corridors open.

### Exit (non-goal, name reserved)

The party's way OUT is intentionally not modeled in v1 — no exit marker, no
schema field, no prompt clause. The design is RESERVED, symmetric to the
entrance: one outer-wall cell per non-spawn room, a neon triangle pointing
OUT, detected with the same triangle gate, seeded as a `board.exit` overlay.
The entrance arc (C1 geometry → C2 prompt/detection → C3 seed) is the
template to follow when this is ratified.

## Implementation record

Implemented in full on the M6 baseline: deterministic layout and schematic,
Dexie v12, room-aware seeding, reference-image/vision clients, interactive
Cartographer runs, layout-anchored battle metrics, and the unattended module
queue. The gate is 90 test files / 576 tests at completion. The room-keys &
mob-treasure arc (D9, 2026-09-07, e489a65 → 01a0b5e) shipped in five
bounded commits (generation, editor, seed, surface, docs) on top of the
room-key persistence; the gate at completion is 140 test files / 1265
tests.

## Build order (completed)

- **A** — Layout engine (pure) + tests (packing, validation ladder, inscribed
  rect, placement, veil derivation, schematic geometry).
- **B** — Schemas + db version (encounter `layout`, board `mapLayout`) with
  migration goldens; battle seed extension + tests (placement, veils, spawn
  room, layout-less fallback unchanged).
- **C** — Clients: `input_references` on the image client (fetch-mocked),
  multimodal chat parts, verify schema + threshold logic.
- **D** — Run engine mode, persona, run-panel step UIs (layout review, map
  pick with overlay), aspect preference in settings.
- **E** — Battle surface layout-anchored metrics + grid overlay + goldens
  (alignment across viewport sizes).
- **F** — Module integration: encounter stub kind + unattended batch queue.
- **G** — Docs: `00` doc map, `01` data model, `05` UI, `08` testing matrix;
  this document becomes the binding spec of record.

## Acceptance criteria

- From a brief, an auto run produces a complete encounter artifact: roster
  with resolved sources, `layout` (validated rooms/corridors/doors), a
  map-role map image whose aspect matches the layout, and a computed veil set
  (one `fog` per room's `mobsRect`).
- A manual run pauses at `brief` and `layout` (both editable/regeneratable)
  and at map pick; a verify mismatch above threshold forces `needs_review`
  with the diff overlay; a failed layout after the retry ladder fails the run
  with an `errorMessage` — no placeholder encounter anywhere.
- **Run battle** on a generated encounter: every mob token sits in its room's
  area, covered by its room veil and absent from the DOM and initiative;
  lifting the room's veil reveals the mobs and auto-rolls their initiative;
  PCs spawn in the entry room.
- Resizing the window (tablet ↔ desktop) keeps every room veil on its room —
  layout-anchored metrics, golden-tested.
- Regenerating on an edited roster keeps the artifact's identity/links/body,
  replaces `layout` + `mapImageId`, and re-derives placement.
- Module generation with encounters: encounter stubs become full encounters
  with maps unattended; a failing encounter reports loudly and does not stop
  the queue; retry re-runs only the failed job.
- An uploaded-map encounter (no layout) behaves exactly as today.
- Room keys & mob treasure (D9): a generated brief's room keys persist on
  the finalized layout rooms through packing rotation and the staging
  rebuild; the Smith's draft treasure lands on the finalized roster entries;
  a map regeneration replaces keys with the fresh brief's while the roster
  (and its treasure) survives verbatim; seeded tokens freeze their entry's
  treasure (spawn included); GM view shows key markers + rail key card +
  token treasure; player view shows none of it (contract test).
- The dnd5e budget guidance is our own documented approximation and the
  pf2e guidance demands verbatim GM Core grounding — asserted by unit
  tests on `treasureGuidanceFor`.
- `pnpm lint && pnpm typecheck && pnpm test` passes with the layout engine,
  seed and surface-metric modules covered.

## Non-goals (v1)

- Line-of-sight simulation, lighting, dynamic fog reveal by movement.
- Hand-editing room rectangles (regenerate instead); free-form/organic rooms.
- Multiple maps or multiple "floors" per encounter.
- Token art generation (D5 — amended 2026-09-05 for rulebook-cited creatures
  only: the "Generate mob portraits" batch above), token `tracks`, 3D dice.
- Player-facing second render surface / sync (M5 non-goal stands).
- Reading geometry back from stylized images beyond the verify flag.
- PDF export of layouts.
