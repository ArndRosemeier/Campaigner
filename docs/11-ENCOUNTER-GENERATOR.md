# 11 — Encounter generator: generated battlemaps, room layouts and veils

Adds a **fully generated encounter** to Campaigner: an LLM drafts the design
(rooms, roster, tactics), deterministic code turns it into a **grid layout**
(rooms as rectangle unions, corridors, doors), a canvas renderer draws a
**schematic map**, an OpenRouter image model **stylizes** it under a
structure-preserving contract, and **the human picks the candidate** — the
regenerate affordance is the correction path (D14). The result is an
`encounter` artifact whose battles seed with **mobs placed in their rooms and
one fog veil per monster spawn group** — the party reveals the fight group by
group, exactly the GM-Cockpit veil mechanic M5 already runs.

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
**layout**; the spawn-group cover veils on the board are **group veils**.

## Decisions (binding, settled with the user)

| # | Decision |
|---|---|
| D1 | **Standalone generator**: a run creates a complete `encounter` artifact from a brief — roster included — plus layout, map and room veils. It also runs in a **regenerate** mode against an existing encounter (same or edited roster): name, links and body survive; layout + map are replaced. |
| D2 | **Two autonomies**: interactive runs use the run-engine autonomy (manual/review pause at the checkpoints below; map pick always pauses, M3-A rule). **Unattended auto runs** (module generation) never pause: one stylize candidate, no pick gate — the `entity-image-queue` precedent (08 §M4-C). Any failure fails that encounter loudly; the batch continues. |
| D3 | Rooms are **unions of rectangles** (1 rect = plain, 2–3 rects = L/T shapes). Every room carries a **mob sub-rectangle** (`mobsRect`) inscribed in the union — it is both the mob placement area and the source the per-group veil footprints are cut from (D4). |
| D4 | **One fog veil per monster spawn group** (owner-ratified group veils — supersedes the old one-veil-per-room rule): each room's `mobsRect` is split per `monsterIndexes` entry, in the owner's group order, into the minimal cell bounding box of that group's `placeMonsters` cells (`veilsFromSpawnClusters`, beside the legacy `veilsFromRooms`) — kind `fog`, int cells ≥ `VEIL_MIN_CELLS`. Rooms with no monster groups seed no veil. The room's FIRST group keeps `id = room.id` so the Path rail's "Reveal next room" still resolves per room; later groups mint fresh ids and every group veil carries `roomId = room.id` (additive on `battleVeilSchema`). Corridors stay open (GM can add fog manually). Amended (veil-reachability arc): **cover convention** — each seeded group veil covers its spawn area PLUS a one-cell margin on every side, clamped to the board bounds (a 1x1 group seeds at most 3x3), so the GM can grab the veil body and reach the edge handles around the tokens, which stay directly clickable above. GM-created veils are untouched. |
| D5 | **Token art is not generated**: npc-backed tokens use the artifact's cover/portrait, seedFighter tokens use the deterministic initials fallback (M5-D behavior). No image calls for tokens. Amended 2026-09-05 by afa23f4/070d4ba/64b30f9 (mob-artifact arc): *rulebook-cited creatures become real mob artifacts — ONE `npc` artifact per campaign per cited chunk — and gain a one-click owner-ratified portrait batch ("Generate mob portraits"); every other seedFighter token keeps the initials fallback. See "D5 amendment — mob portraits" below. Amended 2026-09-08: uncited entries (`inline` / `none`) gain on-demand creature artifacts + local portraits ("Create creature + portrait", per entry and batch-all); invented covers stay local-only, never the global cache. Amended 2026-09-09: all-imaged batches offer portrait regeneration (canonical slots republished with fresh bytes — future clones everywhere get the new art, other campaigns' existing covers unchanged; flavored/invented regenerate locally). |
| D6 | **Geometry is layout-anchored, never screen-anchored.** When a battle carries the map layout, every cell metric — veil spans, veil resize quantization, token snapping, the visible grid overlay, token size — derives from `boardWidth / cols` (normalized), never from a fixed CSS-px grid. Without a layout the current behavior is unchanged. |
| D7 | **Structure-first**: geometry exists as data *before* any pixels; the image stylizes a rendered schematic; geometry is **never read back from pixels**. Amended 2026-09-08 (D14): the vision check that "only flagged drift for human review" is GONE entirely — no pixel is read back anywhere, and the human is the judge at pick. |
| D8 | **Effect markers are geometric showpieces** (encounter-resume arc, owner-ratified): the battle surface stamps disc/square zones as an additive `board.effects` array — normalized center, `sizeCells` in grid cells (the D6/D7 rules apply verbatim: layout-anchored, never screen pixels), `TOKEN_STAMP_COLORS` fill at ~70% transparency (fill alpha 0x4d, border 0xcc — static, never opacity swings), optional non-stat label. Board material: rendered in BOTH GM and player views; never initiative members, never coverage-hidden (they are not tokens); carried by the stage snapshot; scenery lock gates their moves like veils. |
| D9 | **Room keys & mob treasure are GM-only text that travels with its structure** (owner-ratified, 2026-09-07): every layout room carries additive `key`/`keyTreasure` (persisted ON the room — `packRooms` rotates brief rooms, so a parallel roomId-keyed array would orphan), every roster entry carries additive `treasure` (persisted ON the entry — the editor removes roster rows, so an index-keyed array would orphan). The encounter editor edits them; battle seed freezes roster `treasure` onto each token (frozen-copy precedent, initiativeBonus); the battle surface renders GM-only key markers at room staging points + a rail key card + a GM-only token-treasure block — none of which mounts in player view (M5-D contract, 09 amendment). Map regeneration replaces room keys with the fresh brief's (accepted, stated in UI copy and the prompt clause). |
| D11 | **Encounters have a SHAPE — `siteShape: 'single' \| 'complex'` on the encounter data, additive default `'single'`** (owner-ratified, 2026-09-08): editor labels **"Encounter" (single)** and **"Dungeon" (complex)**. A single site is one arena — `rooms.length === 1`, `corridors: []`, veils for its spawn groups at seed (group-veil policy: the spawn-room exemption is gone), start position = the entrance cell when present else the room's mobsRect center, no room discovery beyond the spawn groups. A complex is a dungeon — multi-room, one board, sequential play along the path, GM-only Path rail + "Reveal next room" as an ADVISORY aid (no locks, no initiative resets; the latecomer auto-roll stays an editable aid; reveal-all — one press lifts EVERY group veil of the next veiled room, resolving per room via `veil.id` AND `veil.roomId`, so no room reads revealed while its mobs stay covered). The derived default: `locationKind === 'dungeon'` ⇒ complex, else single — materialized for legacy rows by `normalizeEncounterShapeData` (parse-on-read) AND the v17 backfill. Hard invariants refine on the ARTIFACT data (single ⇒ 1 room & no corridors; complex ⇒ >1 room); the stricter generation dichotomy — a brief commits to 1 room or 4–10, never 2–3 — is a repairable brief-boundary issue. See "Site shape, per-room challenge and the path" below. |
| D12 | **Asymmetric per-room budget loop (owner-specified)**: each complex room carries `targetLevel` (additive, optional; defaults to the encounter's parsed levelHint) and the assigned creatures' levels are summed against a documented band — **too easy ⇒ ship silently (owner: fine)**; **too hard ⇒ lower that room's targetLevel a step (floor 1) and retry through the encounter brief's EXISTING single repair turn** (budget issues join the issue list like coverage/source issues); **after the bounded retry still over ⇒ LOUD advisory** persisted on the step output AND `data.budgetAdvisory` on the artifact — never silent, never a failed run. The final (possibly lowered) targetLevel persists on the room, visible and owner-editable. dnd5e band = our own documented approximation (verbatim rationale below, mirroring the treasure-ladder licensing stance, docs/12 §13.2/§14); pf2e ships NO numbers — GM Core verbatim from retrieved excerpts when present, else the always-on loud advisory. The in-place Smith content fill runs the same loop over a RECONCILED partition (see below). |
| D13 | **The play path is stored on the layout** — `encounterLayoutSchema.path: z.array(z.uuid()).optional()`, a permutation of the room ids refined by the shared layout schema. The Cartographer brief's room order IS the path (stored explicitly — `packAttempt` ROTATES `brief.rooms`, so the array order cannot be trusted), rotated so the entry room is first: **first path room = spawn room**. Legacy complexes get `path` backfilled as their room-array order (spawn first if derivable) by the v17 migration; the surface falls back to array order when absent. The rail's veiled-room set resolves per ROOM (`veil.id` for the primary group, `veil.roomId` for every group veil), so a room reads veiled until its last group veil lifts and "Reveal next room" reveal-alls the room. |
| D15 | **Auto-promote on second-module use** (owner-ratified, 10 D12): an encounter roster or battle token that cites another module's npc/mob artifact promotes it to campaign level with a loud toast — at run-engine finalize (both remap sites), the editor encounter save, the top of `seedBattleFromEncounter` / `spawnRosterInstance` (before identity freezes), and bestiary `spawnMobArtifactIntoModule` (second-module spawn promotes/shared instead of moving). No separate core state — every path funnels through `adoptIntoCampaign`. |
| D14 | **The user is the judge; regenerate is the correction; NO VLM verification** (owner-directed removal, 2026-09-08): "Nope. Stop the verification altogether. Let the user be the judge with a regenerate option. No need to waste model calls here. Things do not need to be verified in a brittle way. Just have a way to easily regenerate." The verify step (the 5a8f8f2/42db-era machinery: the coarse-grid cell contract, the `arena-verdict` structural check, thresholds, drift overlays, the dedicated verify model) is DELETED — model calls are not spent on brittle self-grading. The manual run pauses at pick; **"Regenerate candidates"** re-runs the stylize step only (same brief, same layout — room keys and geometry untouched) and pauses at pick again. Regenerating the LAYOUT (fresh keys/geometry) stays the separate existing affordance. Old run rows carrying verify steps heal at the run-row parse boundary. |
| D10 | **The Dungeon preset is a generation-time grid tier + brief bias, not a board feature** (owner-ratified, 2026-09-07): choosing Dungeon makes the layout engine pack on a FIXED ×2 tier per aspect (4:3 48×36, 16:9 56×32, 1:1 40×40 — "same cells per room, more cells per map"; room size classes unchanged), biases the brief toward a connected 4–8 room complex, and persists the choice as `preset` on the encounter artifact, the run row and in Settings so regenerations and resumes reproduce the tier. No `battle.gridScale` field ever: cells keep their in-world meaning and every D6 layout-anchored metric derives from `cols/rows`, so half-size cells render everywhere automatically. Exit marker out of v1 (the name stays reserved). **D10 amendment (locationKind, owner-ratified)**: encounters classify themselves — the encounter persona's EXISTING draft call gains a bounded `locationKind` (`'dungeon' | 'building' | 'wilderness' | 'other'`, persisted additively on the encounter artifact, owner-correctable in the editor, no extra LLM call), and the preset resolves per encounter: **explicit per-run choice > the encounter's own `locationKind` (`'dungeon'` → Dungeon tier, `'building'`/`'wilderness'` → Standard) > the Settings fallback** for unclassified (`'other'`) rows. The persona-panel Preset select gains **Auto** as its default (self-classification is the norm; Standard/Dungeon remain explicit overrides). See "D10 amendment — per-encounter locationKind" below. |

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
  `src/features/campaign/mob-portrait-queue.ts`). **Prompt grounding (stat-exempt,
  2026-09-08, owner-ordered):** `portraitGroundingForChunk`
  (`src/llm/imagePromptDraft.ts`) composes the grounding ONLY from stat-free
  material — size + creatureType identity plus the traits / actions /
  reactions / legendary named-text prose (names + texts), capped at 800 chars.
  ALL numeric fields stay out by FIELD (level, ac, acNote, hp, hpFormula,
  speed, abilities, saves, skills, senses, languages, extras, system — `level`
  is borderline and deliberately excluded): smart image models RENDER chunk
  stat text into portraits. When `statBlock` is null (unparsed chunks) the
  helper falls back to raw `chunk.text` verbatim — the loud residual render
  risk, documented on the helper, never silent. Belt and braces: both mob
  drafts set the text-render negative
  (`MOB_PORTRAIT_TEXT_NEGATIVE` → `Avoid: text, letters, …`), while the
  artifact `appearance` shortcut keeps winning when the user filled it and
  the creation-dialog path (artifact's own body — user content, not chunk
  context) stays out of scope. **Owner amendment (2026-09-05, c3c021f):** the prompt draft is
  deterministic — no LLM call ("I dont want that extra LLM call. Just use
  the appearance/body."). Failures report loud per mob (`{name, message}`
  style, `entity-batch.ts` pattern); skip-if-imaged guard (existing queue
  behavior) — no re-generation of mobs that have covers.
- **On-demand invented creatures (2026-09-08)**: uncited roster entries
  (`inline` / `none` — model-invented mobs with no bestiary citation) get a
  per-entry and batch-all **"Create creature + portrait"** action in the
  same editor section (05-UI). It materializes a REAL `npc` artifact per
  entry name (`db/mobArtifacts.materializeInventedCreatureArtifact`:
  roster name, appearance seeded from the entry's notes/treasure text, the
  inline block when present else null, summary noting the encounter;
  scoped to the encounter's `moduleId` when module-owned else
  campaign-level so `deleteModule` cascade/keep disposes them together —
  and the roster entry is NOT rewritten, so battleSeed spawn paths stay
  identical), then flows through the EXISTING portrait queue as a
  LOCAL-only job (no `chunkId`: prompt grounded on the artifact's own
  content, never the cache). With zero rulebook entries the batch stays
  enabled as **"Create creatures + portraits"**. GM-only (editor surface);
  materialize/generation failures surface loudly, never placeholders.

- **Portrait regeneration (owner-ordered, 2026-09-09)**: when a batch would
  enqueue NOTHING because every portrait already exists, the section offers
  a **"Regenerate N portrait(s)?"** confirm (same for the per-entry
  invented action) instead of the old already-generated toast — Confirm
  detaches the existing covers and re-enqueues; Cancel keeps today's
  toasts. Partial batches (some enqueued, some imaged) keep today's silent
  behavior with NO regen offer (05-UI). Mechanics (`regenerateMobPortraits`
  / `regenerateInventedCreaturePortraits`, the one way — docs/18):
  resolve + validate with no side effects (unknown artifacts, unreadable
  chunks throw loud with all old covers intact), republish canonical slots
  with FRESH bytes first (below), detach covers via
  `removeImageFromArtifact` (revision snapshots scrubbed, old blobs freed
  refcount-aware), then enqueue normally. Between detach and the fresh
  cover landing, tokens show initials (the D5 fallback) — accepted and
  stated in the dialog. Flavored and invented covers regenerate locally,
  always; a canonical citation regenerates by REPUBLISH (below) — a plain
  re-enqueue would clone identical bytes, a no-op regen.

- **Battle-card trigger (2026-09-09)**: the battle surface's selection card
  offers per-token **Generate portrait** (cover-less) / **Regenerate
  portrait** (imaged, same confirm) for rulebook-cited mobs, GM-only —
  `enqueueSingleMobPortrait` / `regenerateSingleMobPortrait`
  (`src/features/campaign/mob-portrait-queue.ts`): the SAME queue, dock,
  dedupe, skip, and canonical-republish semantics as the editor batch — no
  second pipeline, no second detach path (docs/18). The token resolves to
  its mob artifact via `data.monsterChunkId`; the citing name comes from the
  provenance encounter's roster entry (chunkId/mobArtifactId match, artifact
  name fallback). Chunk-less tokens (PCs, real NPCs, inline synthetics,
  statless rows) show NO action — no dead affordance — and player-safe view
  never mounts it. The card's portrait image stays a pure lightbox button;
  the action is a separate explicit button.

### Content identity at citation birth (chunk-hash-fallback, owner-observed false 'missing ref')

Import keeps cited `chunkId`s as-is (source-instance uuids) but runtime
resolution only knew uuids — so a byte-identical installed book under new
row ids still showed 'missing ref' + the campaign banner, even though the
banner promises it "clears itself the moment the content is installed".
Rulebook citations now resolve by CONTENT identity, not just source uuid:

- **Stamped at birth**: the rulebook `monsterSource` variant carries
  additive optional `contentHash` (the cited chunk's SHA-256) + `creatureName`
  (`chunk.headingPath[0]`, roster entry-name fallback). Stamped by EVERY
  citation writer through the shared pure `contentIdentityFor`
  (`src/domain/encounterResolve.ts`) so all births agree: runEngine
  finalize (both remap sites, via `rulebookSourceFor` — a chunk that
  vanished between retrieve and finalize throws LOUD instead of writing a
  dangling citation), the editor's rulebook-link dialog (hash + heading ride
  the search hit into `onPick`), and the spawn picker's synthetic mob entry
  (`buildMobPickEntry`). Import heals pre-stamp entries from the v2 manifest
  (`healRulebookSources` in `src/lib/exportImport.ts`, matched by exporting
  artifact + cited chunkId) — old exports resolve too; the cited uuid is
  still KEPT as-is. The bestiary spawn dialog (`mobArtifacts.ts`
  `fillCoverFromCache` source) and the seed retro-fill write NO persisted
  citation, so there is nothing to stamp — they resolve through the same
  fallback below.
- **Resolver fallback, exact-only**: `resolveMonsterEntry`'s rulebook branch
  tries the uuid first, then `getChunkByContentHash` when the uuid misses
  and a hash is stamped (`MonsterLookups` gains the method;
  `resolveMonsterEntryWithRepos` prefers the statful hit when several local
  chunks share one hash — a statless hash hit never satisfies, mirroring the
  import L0 rule). A hit resolves stats + origin from the LOCAL chunk
  exactly as a uuid hit (pack creature label / PDF page label from the local
  row). A miss stays 'missing ref' unchanged.
- **Re-export carries dangling stamps (residual closed)**: `collectDependencies` writes a `missing-chunk` citation WITH the entry's own `contentHash`/`creatureName` when the chunk join misses (chunk data wins when present — the stamp is fallback-only), so re-exporting a healed-but-dangling campaign produces a manifest a second-generation import clears at L0 instead of aborting on.
- **L1 explicitly deferred**: a same-creature chunk under a NEW hash
  (revised printing) still resolves 'missing ref' — the import dep dialog
  already reports that drift (`version-drift`), and the resolver stays
  exact-content. `creatureName` is stamped now but RESERVED (unused by the
  resolver) for that future fuzzy lane.

### Global portrait cache (slice A — owner-ratified)

Core/external bestiary creatures only (NEVER module-generated NPCs):
a portrait is generated ONCE per rulebook chunk and reused across all
campaigns/modules. Dexie v18 `mobPortraits` table (`id, &chunkId`,
additive, no upgrade — starts empty) mapping chunkId → one global-scope
shared-blob image row.

- **Canonical-only (binding).** Encounter rosters flavor core creatures
  ("slimey giant rat" citing the giant-rat chunk) while mechanics spread
  the flavor (first-citer-wins artifact naming). A flavored generation
  entering a chunk-keyed cache would make every giant rat everywhere
  slimey — so the cache holds CANONICAL portraits only: prompt grounded on
  the chunk's stat-exempt portrait grounding (`portraitGroundingForChunk` —
  identity + prose, never raw stat numbers) plus the chunk's canonical
  creature name (last `headingPath` element), never roster/artifact flavor. The cache is
  written ONLY by canonical generations (the citing entry used the
  canonical name, trimmed case-insensitive), so the single normal
  generation serves both cover and cache. A flavored citation gets its
  local flavored cover and NOTHING ELSE: no write, no overwrite, no
  behind-the-back canonical generation (never spend image budget for
  global benefit unsolicited). A chunk cited only ever flavored keeps an
  empty slot and per-campaign behavior is unchanged.
- **Generate-once.** `enqueueMobPortraits` checks the cache first
  (skip-if-cached: the get-or-create read-through clones an already
  populated slot into the cover-less artifact, so no job is enqueued) and
  the queue's canonical branch generates through the dedicated cache
  worker (`ensureCanonicalMobPortrait` — in-memory single-flight per
  chunkId, put-if-absent publish converging on the unique `&chunkId`
  winner). Progress keys stay artifactId-based; generation stays
  manual-only (seed/finalize callers pass no read-through flag).
- **Render = clone.** The shared global row is never attached; each mob
  artifact gets its own campaign-scoped copy of the bytes as
  `coverImageId` through the attach seam — zero BattleSurface changes.
- **NEVER-DELETE.** The cached blob is explicitly immune to campaign
  `pruneUnreferencedImages` (structural: global-scope rows are outside
  every campaign prune's scan) and the global
  `deleteImageIfUnreferenced` path (explicit cache-record check) while
  the cache record exists.
- **Regeneration = REPUBLISH (owner-ordered, 2026-09-09 — the coherent
  canonical consequence).** Regenerating a canonical portrait generates
  FRESH bytes and republishes the global slot (`replaceCanonicalPortrait`,
  the ONLY unconditional slot writer, via
  `regenerateCanonicalMobPortrait`, the ONLY fresh-generation path) — the
  slot IS the canonical portrait, so future clones everywhere render the
  new art. Other campaigns' EXISTING covers are INVARIANT: render-is-clone
  means they carry independent campaign-scoped rows, verified before
  claiming and pinned by tests. The superseded global blob is deleted in
  the republish transaction (referenced by nothing — never a regen leak).
  The regen surfaces a loud toast naming the shared consequence. The
  local-only alternative (a fresh cover diverging from canon) was rejected:
  a silently non-canonical "canonical" portrait is the worse lie —
  regenerating a canonical citation is therefore NEVER local-only.
- **Grandfathering.** Existing per-campaign covers are kept; no backfill.
- **Firewall.** Every cache entry point gates on
  `cacheKeyForMonsterSource`: `source.type === 'rulebook'` with a defined
  `chunkId`. npc-ref / inline / none rows and marker-less module NPCs
  (entity queue) never touch the seam — pinned by tests. On-demand
  invented-creature artifacts carry no `monsterChunkId` marker and their
  portrait jobs carry no `chunkId`, so both the materialize and the
  generate stay structurally off-seam (covers LOCAL ONLY) — pinned by
  tests.

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
  lines, no numbers, no tokens/minis, no watermark" + the anti-hallucination
  negatives (owner-observed 2026-09-08: a jungle map came back with white
  rectangles baked into the floors — the image model read the schematic's
  pale room fills as geometry to preserve): no white/pale boxes,
  rectangles, plaques, discs, signposts or other label-like markers apart
  from the entrance triangle; room floors are painted as continuous natural
  terrain with no discrete light-colored sub-rectangles. `negative` and
  `styleNotes` mirror the Illustrator contract (07 §M3-A).
- **No verify step (D14)**: the former `verify` bullet set — the SHAPE-AWARE
  coarse-grid contract for complexes, the `arena-verdict` structural check
  for single arenas (the 5a8f8f2 fix for the 7/7 auto-run blocker), the 12%
  `needs_review` threshold with named reports, the drift overlays and the
  dedicated vision model — is SUPERSEDED and then DELETED (owner, 2026-09-08,
  verbatim in D14). `src/llm/encounterVision.ts` is gone; nothing reads map
  pixels or spends a chat call grading a stylized image. What replaced the
  correction loop:
  - **"Regenerate candidates"** in the pick view (`runEngine.regenerateEncounterCandidates`)
    truncates the run back to the stylize step — the approved brief and
    layout (room keys included) stay untouched — and re-runs stylize, so the
    user judges a fresh batch at the same pick pause. The discarded batch's
    still-unattached candidates are pruned (`deleteUnreferencedImages`
    re-checks references, so an id that somehow got attached survives).
  - **Regenerate layout** (the pre-existing affordance) remains the full-geometry
    correction: fresh pack (variant ladder), fresh room keys — the ratified
    D9 consequence.
- `pick` renders each candidate with the **room overlay** (labeled room
  rects + mobs rect) so the user judges alignment, not just looks.
- `finalize` stores the kept image (`role: 'map'`), writes
  `encounterData.layout` + `mapImageId`, and (regenerate mode) keeps
  `name/body/links/monsters` untouched. Regenerate mode routes the
  re-anchor + content write through `attachImagesToArtifact` (one
  images+artifacts+revisions tx, cover explicitly kept) — a crash between
  them can no longer strand a library-scoped image while the artifact keeps
  the old map; the fresh-create birth path stays a single-row
  `createArtifact` (no desync window, intentionally off-seam).

## Layout engine (`src/domain/encounterMap/`, pure TS, vitest-covered)

- `packRooms(brief)`: adjacency graph + per-room size classes → rectangles on
  a fixed grid (`gridW × gridH` chosen from the aspect option, see below),
  1-cell corridors between connected rooms, doors on shared edges. Adjacent
  rooms are placed in neighboring grid slots so the connection graph stays
  compact and branching (a central room can fan out instead of forming one
  serial U); twelve deterministic packing candidates are scored for corridor
  length, connected-room distance and one-dimensional chains, and the best
  valid candidate wins. Rooms may be unions of 2–3 rects; `mobsRect` is the
  largest inscribed rectangle minus a 1-cell border.
- Validation (all loud): rooms disjoint, corridors 1 cell wide and connected
  door-to-door, exactly one `spawn` room, `mobsRect` area ≥ the room's monster
  count, everything inside the grid. Invalid ⇒ retry, then fail.
- `placeMonsters(layout, roster)`: one free cell per instance inside the
  room's `mobsRect` (deterministic scatter, ≥1 cell apart, doors excluded) —
  reused by the seeder; the layout persists only `monsterIndexes`, placement
  is recomputed at seed time so roster edits never desync stored coordinates.
- `veilsFromRooms(layout)`: one `BattleVeil` per room — kind `'fog'`, center
  normalized from `mobsRect`, `widthCells/heightCells` = the rect's cell
  span (legacy helper, kept for its pin tests). Battle seed uses
  `veilsFromSpawnClusters(layout, rosterCounts)` (D4): one fog veil per
  `monsterIndexes` entry — the group's `placeMonsters` cells PLUS the
  one-cell cover margin (clamped to the board), first group per room keeping
  `id = room.id`, every group carrying `roomId`. Correct under D6 because
  cell metrics are layout-anchored on the surface.
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
2. Create the spawn-group veils (`veilsFromSpawnClusters`) — kind `'fog'`,
   one per `monsterIndexes` entry (D4); the spawn room's groups are veiled
   too (no exemption).
3. Place each roster instance on a free cell of its room's `mobsRect`
   (`placeMonsters`), `visible: true` — the group's veil removes it from the DOM
   and initiative (the existing player-safe mechanic; **reveal = GM lifts the
   veil**, and reconcile already auto-rolls revealed fighters).
4. Spawn PCs in the spawn room's `mobsRect` instead of the default center.

Roster entries without stats keep today's loud statless path, placed in their
room like everyone else. `layout === null` encounters seed exactly as today.

**Auto-promote (D15):** seeding and in-battle spawning resolve the roster's
token artifact ids against the battle module FIRST — an owner mismatch
promotes the artifact to campaign level (loud toast) before the seed rows
freeze identity, so the first module never loses its monster silently and
both modules share the one row.

### D16 — single-map-slot replace (owner decision, 2026-09-08)

The gallery holds EXACTLY one map per encounter — regenerate REPLACES, never
accumulates (multiple maps per encounter stays a v1 non-goal). The
regenerate finalize rides the attach seam in one transaction: the fresh map
appends, the previous `mapImageId` leaves `imageIds` via `removeImageIds`,
its blob rides `pruneCandidates` (refchecked — freed only when nothing still
pins it), and unpicked candidates stay pruned at pick as before. History
keeps every replaced id: `writeRevision` clones the whole row, so each
revision snapshot's `data.mapImageId` names the map on file at that revision
— and the imageRepo refcount pins exactly those ids (live `data.mapImageId`,
snapshot `data.mapImageId`, frozen `board.mapImageId`), so deleting an old
gallery row can never destroy the blob under a live board. The live
battlemap itself is undeletable: `removeImageFromArtifact` refuses (loud,
with Regenerate guidance) any image that is any encounter's current
`data.mapImageId` — the editor lightbox delete rides the same function.

Board convergence: after the finalize swaps the map, every battle with
`encounterArtifactId` on the target and `board.everLive === false`
converges onto the fresh `mapImageId` + `mapLayout` (repo-level
`convergeBoardsToRegeneratedMap` through the `patchBattle` path — tokens,
veils and everything else ride along untouched). A battle that already went
live stays FROZEN on the board the table actually played — Open battle never
reseeds (docs/18 gotcha) — and the finalize toasts loudly so the GM re-runs
the battle to pick up the new map. Seeding always reads the CURRENT map, so
a seed after a replace picks up the new board copy.

## LLM/image client changes

- `imageGen.ts`: optional `inputReferences: { dataUrl: string }[]` on
  `POST /api/v1/images` → `input_references: [{ type: 'image_url',
  image_url: { url } }]` (OpenRouter's documented edit contract). The
  deterministic rescale-to-aspect guard runs before intake: a stylized image
  that came back with a different aspect is letterboxed/cropped to the exact
  layout aspect on the canvas **before** `intakeImage`, and the guard's action
  is recorded on the step output (never silent).
- `openrouter.ts`: `ChatMessage.content` retains the widened
  `string | content parts` shape (client-level capability; the vision guard
  in `walkModelChain` still consults `requestHasImageInput`). No pipeline
  call sends image parts anymore — the verify call was the only one (D14).

## Persona + run engine

- New built-in persona `encounter-cartographer`, `mode: 'encounter'`,
  `producesKind: 'encounter'` (mode enum and the `producesKind` refine extend).
- Run engine: step list above; `brief` and `layout` are user-editable
  checkpoints (the layout editor shows the rendered schematic + overlays);
  `stylize` never pauses; `pick` pauses on every autonomy except the
  unattended queue path (D2). The **pick view** carries **Regenerate
  candidates** (D14) beside the layout review's Regenerate layout.
- Run panel: generic step rendering plus two new step UIs — the layout review
  (schematic + room overlay, **Regenerate layout** button) and the map pick
  (candidates with overlays + **Regenerate candidates**). Room rects are
  **not** hand-editable in v1
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
  exists. The hand-off rides the persona panel's `start()` ENCOUNTER-TARGET
  branch: the Encounter Smith seeds as a mode-`generate` persona, and the
  panel used to fall through to the fresh-create branch for it — dropping the
  target and DUPLICATING the artifact instead of filling it. Fixed: a
  generate persona with `producesKind: 'encounter'` and a target set starts
  the targeted run (pinned in persona-run-ui).

## Module generation integration (the unattended path)

- The module entity workflow (08 §M4-C) gains `encounter` as a stub kind:
  `ENTITY_KINDS` extends with `'encounter'`, the stub persona map gains an
  Encounter-Smith slug for modules, and the entity panel offers encounter
  generation like the other kinds.
- A batch queue (the `entity-image-queue` pattern: shared progress dock, one
  job per encounter, failures loud per job, queue continues) runs the
  generator in **auto** for every module-owned encounter lacking a layout —
  triggered from the module view ("Generate encounter maps" — UNCHANGED, the
  explicit manual batch), the forge's post-pass, and now AUTOMATICALLY for
  every freshly created encounter (post-run-extras: persona panel, entity
  batch, module post-generation). This is the D2 unattended contract; no
  pick pause. Campaign-level encounters enqueue with a null `moduleId` and
  keep the D2 unattended semantics unchanged.
- **No-double-work guard** (owner-ratified): an encounter that already
  carries its map (layout + map image) or has a queued/active map job is
  NEVER re-enqueued by the automation path (`encounterNeedsMap` /
  `isEncounterMapPending` — the queue's processJob re-checks as a second
  belt). Regenerating an existing map stays an EXPLICIT user action
  (regeneration replaces room keys — the ratified consequence).
- Encounters produced here are module-owned (`moduleId`, M6-B semantics) and
  battle-ready via the module view's Run battle.

## Cost & latency (per encounter, indicative)

Manual run: 1–2 chat calls (brief, optional repair) + 2 image calls
(schematic stylize candidates). Auto/module batch: 1 chat + 1 image call per
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
- **Verify + seed** (C2/C3): seeding anchors the party at the entrance (see
  below) and the table surface renders an emerald cell overlay with an inward
  triangle. The verify half of this arc (the coarse-drift exclusion for
  door/entrance cells, the `arena-verdict` entrance question) died with the
  verify step (D14) — the entrance survives as geometry, prompt clause and
  seed anchor.

### Seeding extension (C3, `aea57a5`)

`seedBattleFromEncounter` anchors the staging ground at the entrance:
`stagingBlockRect` — the spawn room's `mobsRect` slid along the entrance
axis until it hugs the entrance wall while staying inside the room union —
and stamps `board.entrance` (normalized cell center + side) for the
BattleSurface overlay. Retrofitted at seed time — **no migration**: old
battle rows parse with `entrance: null`, and re-seeding any encounter whose
layout lacks an entrance reproduces the pre-entrance behavior byte-identical
(mobsRect ground, no stamp).

### D4 exception — spawn-room fog with an entrance (2026-09-05, adjudicated; implemented in `aea57a5`; SUPERSEDED by group veils)

> **D4 amendment:** when the encounter layout carries an entrance, seed
> skips the spawn room's fog veil.
>
> Rationale, verbatim from the adjudication: *"the party is standing in the
> spawn room when the battle opens — the entrance is the way in, so the
> room they occupy cannot begin veiled."* The GM reveals the remaining
> rooms as before.

SUPERSEDED (group-veil policy, owner-ratified): every monster spawn group is
covered by default, INCLUDING the spawn room's — the exemption is gone, so
single-room sites seed their spawn-group veils instead of zero. The party
still starts in the spawn room (staging is unchanged); its monsters simply
begin veiled. The passage above stays as history; D4 as amended is the rule.

Layouts without an entrance keep D4 exactly: one fog veil per spawn group,
each covering its group's `placeMonsters` cells plus the one-cell margin
(cover convention), corridors open.

### Exit (non-goal, name reserved)

The party's way OUT is intentionally not modeled in v1 — no exit marker, no
schema field, no prompt clause. The design is RESERVED, symmetric to the
entrance: one outer-wall cell per non-spawn room, a neon triangle pointing
OUT, detected with the same triangle gate, seeded as a `board.exit` overlay.
The entrance arc (C1 geometry → C2 prompt/detection → C3 seed) is the
template to follow when this is ratified.

## Dungeon preset (owner-ratified, 2026-09-07; cc2ad02 → d69455e)

The Dungeon preset (D10) is a **generation-time ×2 grid tier + brief bias**,
implemented in six bounded commits. It is deliberately NOT a battle-level
field: the board stays a pure function of the layout, and every D6
layout-anchored metric (veils, snapping, grid tracks, token size — the
cc2ad02 fix makes `TokenView` render `board.tokenSize * token.scale` so
rendered size ≡ coverage size) derives from `mapLayout.cols/rows`, so the
halved cell renders identically on the schematic, the stylized map, and the
live table with no new surface code. The schematic cap scales with the tier
(`schematicCellPx`, 45eed86: `min(96, 4096/gridW, 4096/gridH)` — 48×36
renders at 85px/cell, inside the 4096px map cap).

- **Grid tier** (`GRID_BY_ASPECT_DUNGEON`, 6302804): 4:3 → 48×36,
  16:9 → 56×32, 1:1 → 40×40 — exactly twice the base tier per aspect, FIXED
  (room-count independent; a 1-room dungeon gets the same 48×36 that a
  10-room complex gets). Room size classes are unchanged: same cells per
  room, more cells per map. All tiers stay inside the layout schema's 60 max.
  Deriving the preset from the layout dimensions would be ambiguous (a
  10-room standard 4:3 pack reaches the same 48×36), so the preset is
  **persisted**, not inferred.
- **Persistence** (6302804): `preset: 'standard' | 'dungeon'` on the
  encounter artifact data, `encounterPreset` on the run row (aspect
  pattern), `encounterPreset` in Settings. Dexie **v15** backfills the
  additive defaults (`'standard'` / `null` / `'standard'` — the M5-C
  `mapImageId` pattern).
- **Run-engine threading** (4bf06b6; amended by the locationKind arc): the
  preset resolves **explicit per-run choice → the encounter's locationKind →
  Settings** (`resolveEncounterPreset`); `startRun` persists only an EXPLICIT
  choice (null = Auto) for pauses/resumes;
  the brief step stamps it next to `aspect` and, for Dungeon, adds a soft
  contract clause ("connected dungeon complex of 4–8 rooms joined by
  corridors; the entry room is the party's way in") — the geometry itself
  stays deterministic packer output. `runEncounterLayout` packs on the
  preset's tier, the stylize staging rebuild re-tiers identically, and
  finalize writes the run's preset into the artifact data in BOTH branches
  (fresh create and regenerate — the run is authoritative for the map it
  just produced; an in-place Smith content fill keeps the target's preset —
  it never re-tiers the map on file). The unattended queue passes NO explicit
  choice: the job's preset resolves from the encounter's own `locationKind`,
  with `settings.encounterPreset` backstopping unclassified rows.
- **UI** (d69455e; amended): the persona panel's Settings-backed Preset
  select beside Map aspect defaults to **Auto**; Standard/Dungeon force the
  tier. A **regenerate keeps the target encounter's own preset** — the
  panel passes the target's preset over the Settings value, so an existing
  map is never silently re-tiered (stated in the regenerate-target copy:
  "keeping its map preset"); the images section captions a dungeon map
  "Dungeon layout on file".

## D10 amendment — per-encounter locationKind (owner-ratified)

The Dungeon preset originally resolved from one global Settings value: an
unattended queue run could only produce dungeons when the campaign opted in
for EVERY map, and an encounter's actual setting (a cellar vs. a river
crossing) played no role. The amendment lets encounters classify themselves:

- **Classification rides the EXISTING draft call** — no extra LLM call, no
  verification pass. The Encounter Smith's draft contract gains a bounded
  `locationKind: 'dungeon' | 'building' | 'wilderness' | 'other'`
  (case-insensitive coercion, `'other'` default when the model declines);
  the Cartographer's brief already stages `environment` ('dungeon' |
  'outdoor') and it maps onto the artifact as dungeon/wilderness.
- **Persistence is additive**: `locationKind` on the encounter artifact data
  with the `'other'` zod default — legacy rows parse without a Dexie bump
  (the M5-C `mapImageId` pattern). The encounter editor shows a small
  owner-correctable selector beside the map fields.
- **No-double-work guard**: the automatic battlemap path never re-enqueues
  a mapped encounter or an already-queued/active map job; regenerating an
  existing map stays explicit (and replaces room keys — the ratified
  consequence).
- **Resolution order** (`resolveEncounterPreset`): explicit per-run choice
  (the run row's persisted preset; Auto writes null) → the encounter's own
  `locationKind` ('dungeon' → Dungeon tier; 'building'/'wilderness' →
  Standard) → the Settings fallback for unclassified rows, with 'standard'
  as the terminal default. The persona-panel select writes Settings (null =
  Auto, the default); a fresh panel run passes NO preset so the chain — not
  a coerced Settings value — decides; a regenerate keeps the target's own
  persisted preset (D10's "never silently re-tiered" rule, unchanged).
## Site shape, per-room challenge and the path (owner-ratified, 2026-09-08)

The arc ratified in this section makes the encounter's SHAPE a first-class,
owner-visible choice, gives every dungeon room its own challenge target with
an asymmetric budget loop, stores the play path explicitly, and deletes the
marker path entirely. Commits: schema+migration → generation → surface →
editor → deletion → docs.

### D11 — siteShape (single / complex)

- **Data**: `encounterDataSchema.siteShape = z.enum(['single','complex']).default('single')`
  — additive, no Dexie bump for the field itself (parse-on-read materializes
  the default). One derivation, `normalizeEncounterShapeData` (`src/domain/
  artifact.ts`), is shared by parse-on-read, the v17 backfill and backup/
  revision validation: layout null ⇒ 'single' (uploaded maps stay
  byte-identical in behavior); `rooms.length <= 1` ⇒ 'single' (stray
  corridors cleared — a one-room arena has none); `rooms.length > 1` ⇒
  'complex' with `path` backfilled. A persisted value always wins.
- **Editor labels**: **"Encounter" (single)** / **"Dungeon" (complex)**.
  The selector sits beside Location kind; the option the battlemap on file
  cannot hold is DISABLED with the reason in the hint — the owner is never
  silently re-shaped.
- **Generation dichotomy**: the brief must commit — single = exactly ONE
  room (no corridors), complex = 4–10 rooms. A 2–3-room reply is a
  repairable brief-boundary issue (`rooms: an encounter is either a single
  arena (exactly 1 room) or a dungeon complex (4–10 rooms) — …`). Finalize
  stamps `siteShape` from the produced layout in BOTH branches (fresh
  create and map regenerate): the target's old shape may not match the
  fresh layout's room count.
- **Seeding**: every monster spawn group is covered by default, INCLUDING the
  spawn room's — the group-veil policy ends the spawn-room exemption (which
  the D4 entrance-only exemption above, and then the D11 never-seed rule,
  once granted): a SINGLE site seeds its spawn groups' veils (no more
  zero-veil singles); a COMPLEX veils every group on every room for
  sequential play along the path. Start position on a single site is the
  entrance CELL when the layout carries one, else the room's mobsRect
  center; complexes keep the entrance-hugging staging block. The room's
  first group keeps `id = room.id` so the Path rail still resolves per room.

### D12 — the asymmetric per-room budget loop (`src/llm/roomBudget.ts`)

- **Contract**: every room may carry `targetLevel` (absentable in the LLM
  brief, persisted on the packed room; omitted rooms default to the
  encounter's parsed levelHint via `parseRosterTargetLevel`). The prompt
  clause (`roomBudgetGuidanceFor`) teaches: "every room must ALONE challenge
  the party — a complex is a sequence of fights, not one fight spread thin."
- **Check** (`checkRoomBudget`): sum the assigned creatures' levels × count
  (the SAME parser that orders the bestiary roster, `parseLevelSort` — the
  one level parser in the codebase; fractional levels count fractionally;
  `'—'` CR-less summons count 0; a missing/unreadable level makes the room
  **loud-unverified**, naming the creatures — never silently skipped).
- **The band — dnd5e (our own documented approximation, verbatim rationale):
  the DMG encounter-building tables are not licensable, so Campaigner ships
  its OWN coarse ladder in our own words — nothing is quoted, paraphrased or
  restated numerically from it. A room tuned for target level T is over
  budget when its assigned creatures' levels (CR) sum to MORE than T + 2
  (`ROOM_BUDGET_OVER_MARGIN`) — roughly a hard single fight's worth of
  creature levels; there is NO lower bound (a quiet room ships silently, per
  the owner's asymmetric call). This mirrors the treasure-ladder licensing
  stance (docs/12 §13.2/§14), and this document IS the shipped
  approximation.**
- **pf2e — verbatim from retrieved chunks when present, else loud advisory**:
  creature budgets are Paizo's (GM Core). Campaigner ships NO numeric pf2e
  budget; the prompt directs the model to the retrieved GM Core excerpts
  VERBATIM when they are present. Whether an excerpt actually surfaced is
  not deterministically decidable from the retrieval output, so the
  deterministic check is replaced by an ALWAYS-ON advisory
  (`PF2E_BUDGET_ADVISORY`) persisted on the run and the artifact —
  over-loud by design, never a fabricated paraphrase (AGENTS rule 1).
- **The loop**: first parse over-budget ⇒ each over room's target is lowered
  a step (floor 1) in the ISSUE TEXT and the brief's EXISTING single repair
  turn fires quoting it (`"targetLevel": N and field weaker or fewer
  creatures so it fits its band`). The post-repair pass is FINAL: still over
  ⇒ the target is lowered a step again deterministically (floor 1), the
  final value persists on the room, and the LOUD advisory joins the step
  output (`budgetAdvisory`) and the artifact (`data.budgetAdvisory`). Never
  a failed run; the editor shows the advisory and the owner can correct any
  target.
- **In-place Smith content fill — reconciliation** (`reconcileRoomAssignments`,
  exact rules): the fill rewrites `data.monsters` while the layout stays
  byte-identical, so `room.monsterIndexes` would dangle/shift/skip against
  the new roster. Deterministic re-partition: (1) **preserve by name-match**
  — every existing assignment whose creature name (trim/case-insensitive)
  still exists is kept on its room, remapped to the new index, first room to
  claim a name wins; (2) **append round-robin** — unclaimed new entries, in
  roster order, cycle rooms[0..n-1] (a single-site layout therefore places
  everything in its one room); (3) **drop the gone**. The same budget check
  then runs — no repair turn exists at finalize, so over rooms get the
  deterministic tail only (step-down + advisory). Room CAPACITY is not
  re-derived; an overfull room still fails loudly at seed (layout
  validation).

### D13 — the stored path

`encounterLayoutSchema.path: z.array(z.uuid()).optional()` + superRefine: a
permutation of the room ids. `packAttempt` captures the BRIEF's room order
before its packing rotation and stores it entry-room-first (`spawnFirstPath`),
so **first path room = spawn room** and the play order survives repacking.
The Path rail on the battle surface (GM view, complex sites) lists rooms in
path order with the revealed frontier highlighted and a **"Reveal next
room"** button that lifts the next veiled path room's veil — a plain veil
removal, exactly a manual GM lift. It is an ADVISORY AID: no locks, no
initiative resets, and key markers/badges now sit at each room's mobsRect
CENTER (derived from the live layout — the old `stagingPoint ?? (0.5, 0.5)`
fallback stamped dead-center-of-board badges on every non-staging layout).

### Deletion record — the marker path dies entirely (owner: all pixel
read-back is unnecessary)

With D11's shape contract the marker machinery has no job left. Deleted in
full (each symbol verified consumer-free before deletion):

- The stylize prompt's disc-painting clauses (per-room "solid neon … disc +
  plaque" instructions) and the per-room marker instruction list.
- Room-disc detection + the staging-rebuild candidate branch in the run
  engine — with them, the two AGENTS-rule-1 violations that lived there:
  the SILENT packed-center fallback for undetected rooms and the SWALLOWED
  detection errors (`catch` + debugLog with no user surface).
- `layoutFromStagingMarkers` / `StagingRoomInput` / `StagingLayoutInput` /
  `adaptiveGridDimensions` (the room-count grid ladder — superseded by the
  fixed D10 tiers).
- `markerHue` / `markerColorName` / `stagingPoint` schema fields, and every
  `isStaging` validation escape (schema superRefine, `validateEncounterLayout`
  — overlap/border/connectivity checks are now UNCONDITIONAL — and the
  vision verify's fake 0.5-threshold staging branch).
- The editor marker overlay and the `entrance.observed` write-only field +
  triangle pixel detection. The schematic's PAINTED entrance triangle stays
  as decoration via `drawEntrance`, and the stylize prompt keeps only the
  preserve-clause for it ("keep … exactly as in the reference image").
- `candidateLayouts` plumbing: stylize output, verify and finalize all use
  THE packed layout — a map candidate is now purely a rendering.
- `src/domain/encounterMap/neonDetector.ts` — the whole module — and its
  test. `CANONICAL_ROOM_MARKERS` / `entranceMarkerConfig` / `RoomMarkerConfig`
  MOVE to `schematic.ts`: they are paint/label vocabulary only (room letters
  on the surface and editor, the schematic triangle's hue), and no pixel is
  ever read back (D7 holds unconditionally now).

### Migration v17 (justified backfill)

The v16→v17 upgrade backfills the additive fields on stored encounter rows:
`siteShape` (derived exactly as parse-on-read derives it — layout null ⇒
single; ≤1 room ⇒ single; >1 ⇒ complex with `path` = room-array order,
spawn room first when derivable) and `budgetAdvisory: ''`. It exists so the
STORED rows agree with what every parse materializes — the battle surface
and editor read `layout.path` / `siteShape` / `budgetAdvisory` directly. It
complements, never duplicates, the parse boundary. Legacy multi-room
complexes also gain the under-budget migration note on `budgetAdvisory`
(shown verbatim in the editor): their rooms carry no per-room targets until
the battlemap is regenerated — each room is roughly 1/N of the whole and
under-budget until then.

## Implementation record

Implemented in full on the M6 baseline: deterministic layout and schematic,
Dexie v12, room-aware seeding, reference-image/vision clients, interactive
Cartographer runs, layout-anchored battle metrics, and the unattended module
queue. The gate is 90 test files / 576 tests at completion. The site-shape
arc (D11–D13, 2026-09-08, c0bf5cf → 32db5bb) shipped in six bounded commits
(schema+v17, generation, surface, editor, deletion, docs); the gate at
completion is 149 test files / 1443 tests, and the marker path is fully
deleted (record above). The single-arena verify fix (2026-09-07) replaced
the single-site cell contract with the `arena-verdict` structural check and
named threshold reports after the production blocker (every single-site
verify failed: the graded grid is ~88% `void` periphery for one room) — its
machinery was subsequently DELETED with the verify step (D14, owner-directed:
the user is the judge; regenerate is the correction). The room-keys &
mob-treasure arc (D9, 2026-09-07, e489a65 → 01a0b5e) shipped in five
bounded commits (generation, editor, seed, surface, docs) on top of the
room-key persistence; the gate at completion is 140 test files / 1265
tests. The dungeon preset arc (D10, 2026-09-07, cc2ad02 → d69455e)
shipped in six bounded commits (surface token sizing, schematic cap,
data model, run-engine threading, UI, docs); the gate at completion is
140 test files / 1277 tests.

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
  and at map pick — the LAST pause is the pick, and the pipeline is
  `brief→layout→schematic→stylize→pick→finalize` with NO verify step; the
  pick view's **Regenerate candidates** re-runs stylize only (layout and
  room keys byte-identical, fresh batch, still paused at pick); a failed
  layout after the retry ladder fails the run with an `errorMessage` — no
  placeholder encounter anywhere. An auto run completes unattended: stylize
  → pick picks candidate one by contract → finalize; a failing encounter
  fails loudly and the queue continues.
- **Run battle** on a generated encounter: every mob token sits in its room's
  area, covered by its spawn group's veil and absent from the DOM and initiative;
  lifting the group's veil reveals the mobs and auto-rolls their initiative;
  PCs spawn in the entry room.
- Resizing the window (tablet ↔ desktop) keeps every group veil on its room —
  layout-anchored metrics, golden-tested.
- Regenerating on an edited roster keeps the artifact's identity/links/body,
  replaces `layout` + `mapImageId` under the single-map-slot rule (D16: the
  previous map leaves the gallery in the same attach transaction, never-live
  boards converge, live boards stay frozen with a loud re-run toast),
  and re-derives placement.
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
- Dungeon preset (D10): a `dungeon` brief packs on the fixed ×2 tier per
  aspect (48×36 / 56×32 / 40×40) regardless of room count, deterministically;
  a standard brief stays on the base tier; the run row, artifact data and
  Settings round-trip the choice; the v14→v15 migration backfills the
  defaults. The battle surface needs no preset awareness — the layout's
  `cols/rows` carry the finer grid.
- Site shape (D11): a single encounter seeds its spawn groups' veils (group
  veils — no spawn-room exemption) and starts at
  the entrance cell (else mobsRect center); a complex veils every spawn group
  on every room for sequential play along the path; the editor selector disables the shape
  the map on file cannot hold; the artifact refine rejects single-with-
  corridors and complex-with-one-room rows; legacy rows parse with the
  derived shape (multi-room ⇒ complex with a spawn-first path).
- Budget loop (D12): a too-hard room triggers exactly one repair turn whose
  issue names the room, the sum and the lowered target; after the bounded
  retry the run still COMPLETES with the lowered targetLevel persisted on
  the room and the loud advisory on the step output and artifact; a room
  with unresolvable creature levels is loud-unverified; pf2e runs persist
  the verbatim-advisory instead of any numeric check; the in-place Smith
  fill re-partitions rooms by name-match / round-robin / drop and runs the
  same loop (pin tests in `tests/llm/roomBudget.test.ts`,
  `encounterCartographer.test.ts`, `encounterRun.test.ts`).
- Path (D13): packRooms stores the brief's room order entry-room-first;
  the layout schema rejects a non-permutation path; the surface rail
  follows the stored path and "Reveal next room" lifts EVERY group veil of
  the next veiled room (reveal-all, resolving per room via `veil.id` AND
  `veil.roomId` — advisory only, no locks, no initiative changes; no room
  reads revealed while its mobs stay covered — group-veil seam, §18).
- Marker-path deletion: no module under src/ reads map pixels for
  geometry; the detector module, staging builders and isStaging escapes
  are gone, and validation is unconditional.
- `pnpm lint && pnpm typecheck && pnpm test` passes with the layout engine,
  seed and surface-metric modules covered.

## Non-goals (v1)

- Line-of-sight simulation, lighting, dynamic fog reveal by movement.
- Hand-editing room rectangles (regenerate instead); free-form/organic rooms.
- Multiple maps or multiple "floors" per encounter.
- Token art generation (D5 — amended 2026-09-05 for rulebook-cited creatures
  only: the "Generate mob portraits" batch above), token `tracks`. (3D dice
  left this list 2026-09-06: the M5-D dice-roller amendment — 09-MILESTONE-5
  §M5-D, 4e3de75 — ships `@3d-dice/dice-box` in the battle surface's roller.)
- Player-facing second render surface / sync (M5 non-goal stands).
- Reading geometry back from stylized images (D7 holds unconditionally since
  D14 deleted the verify step).
- PDF export of layouts.
